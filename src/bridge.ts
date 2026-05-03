import { CodexClient } from "./codex/client.js";
import { DiscordGateway } from "./discord/gateway.js";
import { DISCORD_MESSAGE_LIMIT, DiscordRest } from "./discord/rest.js";
import type { MessageCreateEvent } from "./discord/types.js";
import { SessionStore, type StoredSession } from "./session-store.js";

type BridgeOptions = {
  allowedChannelId?: string;
  codexCwd: string;
  switchAuthProfile?: (params: { threadId: string; cwd: string }) => Promise<{ authProfileId: string; threadId: string }>;
};

type ActiveTurn = {
  channelId: string;
  backendId: string;
  discordMessageId: string;
  discordAuthorId: string;
  codexThreadId: string;
  prompt: string;
  authSwitchRetryCount: number;
  startedAt: number;
  messageIds: string[];
  blocks: RenderBlock[];
  blockByItemId: Map<string, number>;
  openCommandItemId?: string;
  openCommandHasOutput: boolean;
  completed: boolean;
  editTimer?: NodeJS.Timeout;
};

type RenderBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool";
      label: string;
    }
  | {
      type: "command";
      command: string;
      output: string;
      outputClosed: boolean;
    };

type PromptMatch = {
  prompt: string;
  trigger: "mention" | "allowed_channel";
};

export type CodexBackend = {
  id: string;
  client: CodexClient;
};

type ChannelThread = {
  backendId: string;
  threadId: string;
  client: CodexClient;
};

export class DiscordCodexBridge {
  private botUserId?: string;
  private nextBackendIndex = 0;
  private readonly backendById: Map<string, CodexClient>;
  private readonly threadByDiscordChannel = new Map<string, ChannelThread>();
  private readonly activeByThread = new Map<string, ActiveTurn>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly rest: DiscordRest,
    private readonly codexBackends: CodexBackend[],
    private readonly sessions: SessionStore,
    private readonly options: BridgeOptions,
  ) {
    if (codexBackends.length === 0) {
      throw new Error("At least one Codex backend is required");
    }
    this.backendById = new Map(codexBackends.map((backend) => [backend.id, backend.client]));
  }

  start(): void {
    this.gateway.on("ready", (event) => {
      this.botUserId = event.user.id;
      console.log(`Discord ready as ${event.user.username} (${event.user.id})`);
    });

    this.gateway.on("messageCreate", (message) => {
      void this.handleDiscordMessage(message).catch((error) => {
        console.error("Failed to handle Discord message:", error);
      });
    });

    for (const backend of this.codexBackends) {
      this.registerCodexEvents(backend);
    }
  }

  private registerCodexEvents(backend: CodexBackend): void {
    backend.client.on("agentMessageDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      appendText(active, event.delta);
      this.scheduleEdit(active);
    });

    backend.client.on("commandStarted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      active.openCommandItemId = event.itemId;
      active.openCommandHasOutput = false;
      addOrUpdateCommandBlock(active, event.itemId, event.command);
      this.scheduleEdit(active);
    });

    backend.client.on("commandOutputDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      if (!active.openCommandHasOutput || active.openCommandItemId !== event.itemId) {
        active.openCommandItemId = event.itemId;
        active.openCommandHasOutput = true;
        appendCommandOutput(active, event.itemId, event.delta);
      } else {
        appendCommandOutput(active, event.itemId, event.delta);
      }
      this.scheduleEdit(active);
    });

    backend.client.on("toolStarted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      if (shouldRenderToolStart(event.itemType, event.label)) {
        addOrUpdateToolBlock(active, event.itemId, event.label);
      }
      this.scheduleEdit(active);
    });

    backend.client.on("toolProgress", (event) => {
      const threadId = event.threadId;
      if (!threadId || !event.message) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      addToolBlock(active, event.message);
      this.scheduleEdit(active);
    });

    backend.client.on("toolOutputDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      appendText(active, event.delta);
      this.scheduleEdit(active);
    });

    backend.client.on("itemCompleted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(activeTurnKey(backend.id, threadId));
      if (!active) {
        return;
      }

      if (event.itemType === "commandExecution" && active.openCommandHasOutput) {
        closeCommandOutput(active, event.itemId);
        active.openCommandItemId = undefined;
        active.openCommandHasOutput = false;
      }

      if (event.label && isRenderedToolItem(event.itemType)) {
        addOrUpdateToolBlock(active, event.itemId, event.label);
      }
      this.scheduleEdit(active);
    });

    backend.client.on("turnCompleted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const activeKey = activeTurnKey(backend.id, threadId);
      const active = this.activeByThread.get(activeKey);
      if (!active) {
        return;
      }

      active.completed = true;
      void this.retryAfterEmptyTurn(active, backend)
        .then((retried) => {
          if (retried) {
            return undefined;
          }
          return this.flushEdit(active);
        })
        .then(() => {
          if (!active.completed) {
            return;
          }
          logInfo("codex_turn_completed", {
            discordChannelId: active.channelId,
            discordMessageId: active.discordMessageId,
            discordAuthorId: active.discordAuthorId,
            codexBackendId: active.backendId,
            codexThreadId: active.codexThreadId,
            discordReplyMessageIds: active.messageIds,
            replyMessageCount: active.messageIds.length,
            blockCount: active.blocks.length,
            durationMs: Date.now() - active.startedAt,
          });
        })
        .catch((error) => {
          logError("codex_turn_flush_failed", error, {
            discordChannelId: active.channelId,
            discordMessageId: active.discordMessageId,
            codexBackendId: active.backendId,
            codexThreadId: active.codexThreadId,
            discordReplyMessageIds: active.messageIds,
          });
        })
        .finally(() => {
          this.activeByThread.delete(activeKey);
        });
    });
  }

  private async retryAfterEmptyTurn(active: ActiveTurn, backend: CodexBackend): Promise<boolean> {
    if (active.blocks.length > 0 || !this.options.switchAuthProfile || active.authSwitchRetryCount > 0) {
      return false;
    }

    const previousThreadId = active.codexThreadId;
    const previousActiveKey = activeTurnKey(backend.id, previousThreadId);
    this.activeByThread.delete(previousActiveKey);

    const switched = await this.options.switchAuthProfile({
      threadId: previousThreadId,
      cwd: this.options.codexCwd,
    });

    active.codexThreadId = switched.threadId;
    active.authSwitchRetryCount += 1;
    active.startedAt = Date.now();
    active.completed = false;
    active.blocks = [];
    active.blockByItemId = new Map();
    active.openCommandItemId = undefined;
    active.openCommandHasOutput = false;
    this.activeByThread.set(activeTurnKey(backend.id, switched.threadId), active);

    logInfo("codex_turn_empty_auth_switch_retry", {
      discordChannelId: active.channelId,
      discordMessageId: active.discordMessageId,
      discordAuthorId: active.discordAuthorId,
      authProfileId: switched.authProfileId,
      previousCodexThreadId: previousThreadId,
      codexThreadId: switched.threadId,
    });

    await backend.client.startTurn(switched.threadId, active.prompt);
    return true;
  }

  private async handleDiscordMessage(message: MessageCreateEvent): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (this.options.allowedChannelId && message.channel_id !== this.options.allowedChannelId) {
      return;
    }

    const match = this.extractPrompt(message.content);
    if (!match) {
      return;
    }

    logInfo("discord_message_accepted", {
      trigger: match.trigger,
      discordChannelId: message.channel_id,
      discordGuildId: message.guild_id,
      discordMessageId: message.id,
      discordAuthorId: message.author.id,
      discordAuthorUsername: message.author.username,
      promptLength: match.prompt.length,
    });

    const thread = await this.getThreadForChannel(message.channel_id);

    if (this.activeByThread.has(activeTurnKey(thread.backendId, thread.threadId))) {
      logInfo("codex_turn_rejected_busy", {
        discordChannelId: message.channel_id,
        discordMessageId: message.id,
        discordAuthorId: message.author.id,
        codexBackendId: thread.backendId,
        codexThreadId: thread.threadId,
      });
      await this.rest.createMessage(message.channel_id, "Codex is still working on the previous turn.");
      return;
    }

    await this.rest.triggerTyping(message.channel_id);
    const reply = await this.rest.createMessage(message.channel_id, "Thinking...");
    const active: ActiveTurn = {
      channelId: message.channel_id,
      backendId: thread.backendId,
      discordMessageId: message.id,
      discordAuthorId: message.author.id,
      codexThreadId: thread.threadId,
      prompt: match.prompt,
      authSwitchRetryCount: 0,
      startedAt: Date.now(),
      messageIds: [reply.id],
      blocks: [],
      blockByItemId: new Map(),
      openCommandHasOutput: false,
      completed: false,
    };
    this.activeByThread.set(activeTurnKey(thread.backendId, thread.threadId), active);

    try {
      logInfo("codex_turn_started", {
        trigger: match.trigger,
        discordChannelId: message.channel_id,
        discordGuildId: message.guild_id,
        discordMessageId: message.id,
        discordAuthorId: message.author.id,
        discordInitialReplyMessageId: reply.id,
        codexBackendId: thread.backendId,
        codexThreadId: thread.threadId,
        codexCwd: this.options.codexCwd,
        promptLength: match.prompt.length,
      });
      await thread.client.startTurn(thread.threadId, match.prompt);
    } catch (error) {
      this.activeByThread.delete(activeTurnKey(thread.backendId, thread.threadId));
      if (isRateLimitError(error) && this.options.switchAuthProfile) {
        try {
          const switched = await this.options.switchAuthProfile({
            threadId: thread.threadId,
            cwd: this.options.codexCwd,
          });
          const resumedThread = {
            ...thread,
            threadId: switched.threadId,
          };
          this.threadByDiscordChannel.set(message.channel_id, resumedThread);
          await this.sessions.set(message.channel_id, {
            backendId: resumedThread.backendId,
            threadId: resumedThread.threadId,
            cwd: this.options.codexCwd,
          });
          active.codexThreadId = resumedThread.threadId;
          active.startedAt = Date.now();
          this.activeByThread.set(activeTurnKey(resumedThread.backendId, resumedThread.threadId), active);
          logInfo("codex_turn_rate_limit_auth_switch", {
            discordChannelId: message.channel_id,
            discordGuildId: message.guild_id,
            discordMessageId: message.id,
            discordAuthorId: message.author.id,
            discordInitialReplyMessageId: reply.id,
            previousCodexThreadId: thread.threadId,
            authProfileId: switched.authProfileId,
            codexBackendId: resumedThread.backendId,
            codexThreadId: resumedThread.threadId,
            codexCwd: this.options.codexCwd,
          });
          await resumedThread.client.startTurn(resumedThread.threadId, match.prompt);
          return;
        } catch (failoverError) {
          this.activeByThread.delete(activeTurnKey(active.backendId, active.codexThreadId));
          logError("codex_turn_rate_limit_auth_switch_failed", failoverError, {
            discordChannelId: message.channel_id,
            discordMessageId: message.id,
            discordAuthorId: message.author.id,
            previousCodexThreadId: thread.threadId,
            codexBackendId: active.backendId,
            codexThreadId: active.codexThreadId,
          });
          await this.rest.editMessage(
            message.channel_id,
            reply.id,
            `Codex turn failed after auth-profile switch: ${formatError(failoverError)}`,
          );
          return;
        }
      }

      logError("codex_turn_start_failed", error, {
        discordChannelId: message.channel_id,
        discordMessageId: message.id,
        discordAuthorId: message.author.id,
        discordInitialReplyMessageId: reply.id,
        codexBackendId: thread.backendId,
        codexThreadId: thread.threadId,
      });
      await this.rest.editMessage(message.channel_id, reply.id, `Codex turn failed: ${formatError(error)}`);
    }
  }

  private extractPrompt(content: string): PromptMatch | undefined {
    if (this.options.allowedChannelId) {
      const prompt = content.trim();
      return prompt ? { prompt, trigger: "allowed_channel" } : undefined;
    }

    if (!this.botUserId) {
      return undefined;
    }

    const mentionPatterns = [`<@${this.botUserId}>`, `<@!${this.botUserId}>`];
    const hasMention = mentionPatterns.some((mention) => content.includes(mention));
    if (!hasMention) {
      return undefined;
    }

    const prompt = mentionPatterns.reduce((text, mention) => text.replaceAll(mention, ""), content).trim();
    return prompt ? { prompt, trigger: "mention" } : undefined;
  }

  private async getThreadForChannel(channelId: string): Promise<ChannelThread> {
    const inMemoryThread = this.threadByDiscordChannel.get(channelId);
    if (inMemoryThread) {
      logInfo("codex_thread_selected", {
        source: "memory",
        discordChannelId: channelId,
        codexBackendId: inMemoryThread.backendId,
        codexThreadId: inMemoryThread.threadId,
      });
      return inMemoryThread;
    }

    const saved = await this.sessions.get(channelId);
    if (saved) {
      const backend = this.backendForSavedSession(saved);
      try {
        logInfo("codex_thread_resume_attempt", {
          discordChannelId: channelId,
          codexBackendId: backend.id,
          savedCodexThreadId: saved.threadId,
          savedCodexCwd: saved.cwd,
          codexCwd: this.options.codexCwd,
        });
        const resumedThreadId = await backend.client.resumeThread({
          threadId: saved.threadId,
          cwd: saved.cwd || this.options.codexCwd,
        });
        const thread = { backendId: backend.id, threadId: resumedThreadId, client: backend.client };
        this.threadByDiscordChannel.set(channelId, thread);
        if (resumedThreadId !== saved.threadId || saved.cwd !== this.options.codexCwd || saved.backendId !== backend.id) {
          await this.sessions.set(channelId, {
            backendId: backend.id,
            threadId: resumedThreadId,
            cwd: this.options.codexCwd,
          });
        }
        logInfo("codex_thread_selected", {
          source: "session_store",
          discordChannelId: channelId,
          codexBackendId: backend.id,
          savedCodexThreadId: saved.threadId,
          codexThreadId: resumedThreadId,
          codexCwd: this.options.codexCwd,
        });
        return thread;
      } catch (error) {
        logError("codex_thread_resume_failed", error, {
          discordChannelId: channelId,
          codexBackendId: backend.id,
          savedCodexThreadId: saved.threadId,
          codexCwd: this.options.codexCwd,
        });
      }
    }

    const thread = await this.createThreadOnNextBackend(channelId);
    return thread;
  }

  private async createThreadOnNextBackend(channelId: string, skipBackendId?: string): Promise<ChannelThread> {
    let lastError: unknown;
    let attempts = 0;

    while (attempts < this.codexBackends.length) {
      const backend = this.nextBackend();
      if (backend.id === skipBackendId && this.codexBackends.length > 1) {
        continue;
      }
      attempts += 1;

      try {
        const threadId = await backend.client.startThread({ cwd: this.options.codexCwd });
        const thread = { backendId: backend.id, threadId, client: backend.client };
        this.threadByDiscordChannel.set(channelId, thread);
        await this.sessions.set(channelId, {
          backendId: backend.id,
          threadId,
          cwd: this.options.codexCwd,
        });
        logInfo("codex_thread_selected", {
          source: "new",
          discordChannelId: channelId,
          codexBackendId: backend.id,
          codexThreadId: threadId,
          codexCwd: this.options.codexCwd,
        });
        return thread;
      } catch (error) {
        lastError = error;
        logError("codex_thread_start_failed", error, {
          discordChannelId: channelId,
          codexBackendId: backend.id,
          codexCwd: this.options.codexCwd,
        });
        if (!isRateLimitError(error)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to start Codex thread on any backend");
  }

  private backendForSavedSession(session: StoredSession): CodexBackend {
    if (session.backendId) {
      const client = this.backendById.get(session.backendId);
      if (client) {
        return { id: session.backendId, client };
      }
      logInfo("codex_session_backend_missing", {
        savedCodexBackendId: session.backendId,
        savedCodexThreadId: session.threadId,
      });
    }

    return this.codexBackends[0]!;
  }

  private nextBackend(): CodexBackend {
    const backend = this.codexBackends[this.nextBackendIndex % this.codexBackends.length]!;
    this.nextBackendIndex += 1;
    return backend;
  }

  private scheduleEdit(active: ActiveTurn): void {
    if (active.editTimer) {
      return;
    }

    active.editTimer = setTimeout(() => {
      active.editTimer = undefined;
      void this.flushEdit(active);
    }, 1200);
  }

  private async flushEdit(active: ActiveTurn): Promise<void> {
    if (active.editTimer) {
      clearTimeout(active.editTimer);
      active.editTimer = undefined;
    }

    const content = renderActiveTurn(active) || (active.completed ? "Codex completed without a response." : "Thinking...");
    const pages = splitDiscordMessages(content);

    await this.rest.editMessage(active.channelId, active.messageIds[0]!, pages[0]!);

    for (let index = 1; index < pages.length; index += 1) {
      const existingMessageId = active.messageIds[index];
      if (existingMessageId) {
        await this.rest.editMessage(active.channelId, existingMessageId, pages[index]!);
        continue;
      }

      const message = await this.rest.createMessage(active.channelId, pages[index]!);
      active.messageIds.push(message.id);
    }

    while (active.messageIds.length > pages.length) {
      const messageId = active.messageIds.pop();
      if (messageId) {
        await this.rest.deleteMessage(active.channelId, messageId);
      }
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function activeTurnKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

function isRateLimitError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("429") ||
    message.includes("5 hour") ||
    message.includes("five hour")
  );
}

function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

function logError(event: string, error: unknown, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...fields,
      error: formatError(error),
    }),
  );
}

function appendText(active: ActiveTurn, text: string): void {
  const lastBlock = active.blocks.at(-1);
  if (lastBlock?.type === "text") {
    lastBlock.text += text;
    return;
  }
  active.blocks.push({ type: "text", text });
}

function renderActiveTurn(active: ActiveTurn): string {
  const rendered: string[] = [];
  let pendingToolRows: string[] = [];

  for (const block of active.blocks) {
    if (block.type === "tool") {
      pendingToolRows.push(block.label);
      continue;
    }

    flushToolRows();

    if (block.type === "text") {
      const text = block.text.trim();
      if (text) {
        rendered.push(text);
      }
      continue;
    }

    rendered.push(renderCommandBlock(block));
  }

  flushToolRows();
  return rendered.filter(Boolean).join("\n\n").trim();

  function flushToolRows(): void {
    if (pendingToolRows.length === 0) {
      return;
    }
    rendered.push(pendingToolRows.join("\n"));
    pendingToolRows = [];
  }
}

function splitDiscordMessages(content: string): string[] {
  const normalized = content.trim() || " ";
  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const splitAt = findDiscordMessageSplit(remaining);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk || remaining.slice(0, DISCORD_MESSAGE_LIMIT));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findDiscordMessageSplit(content: string): number {
  const paragraphBreak = content.lastIndexOf("\n\n", DISCORD_MESSAGE_LIMIT);
  if (paragraphBreak >= DISCORD_MESSAGE_LIMIT * 0.5) {
    return paragraphBreak;
  }

  const lineBreak = content.lastIndexOf("\n", DISCORD_MESSAGE_LIMIT);
  if (lineBreak >= DISCORD_MESSAGE_LIMIT * 0.5) {
    return lineBreak;
  }

  const space = content.lastIndexOf(" ", DISCORD_MESSAGE_LIMIT);
  if (space >= DISCORD_MESSAGE_LIMIT * 0.5) {
    return space;
  }

  return DISCORD_MESSAGE_LIMIT;
}

function shouldRenderToolStart(itemType: string | undefined, label: string): boolean {
  if (itemType === "webSearch" && label === "Web search") {
    return false;
  }
  return true;
}

function addToolBlock(active: ActiveTurn, label: string): void {
  active.blocks.push({ type: "tool", label });
}

function addOrUpdateToolBlock(active: ActiveTurn, itemId: string | undefined, label: string): void {
  if (!itemId) {
    addToolBlock(active, label);
    return;
  }

  const existingIndex = active.blockByItemId.get(itemId);
  if (existingIndex !== undefined) {
    active.blocks[existingIndex] = { type: "tool", label };
    return;
  }

  active.blockByItemId.set(itemId, active.blocks.length);
  addToolBlock(active, label);
}

function addOrUpdateCommandBlock(active: ActiveTurn, itemId: string | undefined, command: string): void {
  const block: RenderBlock = {
    type: "command",
    command: command.trim(),
    output: "",
    outputClosed: false,
  };

  if (!itemId) {
    active.blocks.push(block);
    return;
  }

  const existingIndex = active.blockByItemId.get(itemId);
  if (existingIndex !== undefined) {
    active.blocks[existingIndex] = block;
    return;
  }

  active.blockByItemId.set(itemId, active.blocks.length);
  active.blocks.push(block);
}

function appendCommandOutput(active: ActiveTurn, itemId: string | undefined, delta: string): void {
  const block = findCommandBlock(active, itemId);
  if (block) {
    block.output += delta;
    return;
  }

  const fallback: RenderBlock = {
    type: "command",
    command: "",
    output: delta,
    outputClosed: false,
  };
  if (itemId) {
    active.blockByItemId.set(itemId, active.blocks.length);
  }
  active.blocks.push(fallback);
}

function closeCommandOutput(active: ActiveTurn, itemId: string | undefined): void {
  const block = findCommandBlock(active, itemId);
  if (block) {
    block.outputClosed = true;
  }
}

function findCommandBlock(active: ActiveTurn, itemId: string | undefined): Extract<RenderBlock, { type: "command" }> | undefined {
  const index = itemId ? active.blockByItemId.get(itemId) : undefined;
  const block = index === undefined ? active.blocks.at(-1) : active.blocks[index];
  return block?.type === "command" ? block : undefined;
}

function renderCommandBlock(block: Extract<RenderBlock, { type: "command" }>): string {
  const sections: string[] = [];
  if (block.command) {
    sections.push(`\`\`\`sh\n${block.command}\n\`\`\``);
  }
  if (block.output) {
    sections.push(`\`\`\`text\n${block.output.trimEnd()}\n\`\`\``);
  }
  return sections.join("\n");
}

function isRenderedToolItem(itemType: string | undefined): boolean {
  return (
    itemType === "webSearch" ||
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "fileChange" ||
    itemType === "imageView" ||
    itemType === "imageGeneration" ||
    itemType === "collabAgentToolCall"
  );
}
