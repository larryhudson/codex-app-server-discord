import { CodexClient } from "./codex/client.js";
import { DiscordGateway } from "./discord/gateway.js";
import { DiscordRest } from "./discord/rest.js";
import type { MessageCreateEvent } from "./discord/types.js";
import { SessionStore } from "./session-store.js";

type BridgeOptions = {
  allowedChannelId?: string;
  codexCwd: string;
};

type ActiveTurn = {
  channelId: string;
  messageId: string;
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

export class DiscordCodexBridge {
  private botUserId?: string;
  private readonly threadByDiscordChannel = new Map<string, string>();
  private readonly activeByThread = new Map<string, ActiveTurn>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly rest: DiscordRest,
    private readonly codex: CodexClient,
    private readonly sessions: SessionStore,
    private readonly options: BridgeOptions,
  ) {}

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

    this.codex.on("agentMessageDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      appendText(active, event.delta);
      this.scheduleEdit(active);
    });

    this.codex.on("commandStarted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      active.openCommandItemId = event.itemId;
      active.openCommandHasOutput = false;
      addOrUpdateCommandBlock(active, event.itemId, event.command);
      this.scheduleEdit(active);
    });

    this.codex.on("commandOutputDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
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

    this.codex.on("toolStarted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      if (shouldRenderToolStart(event.itemType, event.label)) {
        addOrUpdateToolBlock(active, event.itemId, event.label);
      }
      this.scheduleEdit(active);
    });

    this.codex.on("toolProgress", (event) => {
      const threadId = event.threadId;
      if (!threadId || !event.message) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      addToolBlock(active, event.message);
      this.scheduleEdit(active);
    });

    this.codex.on("toolOutputDelta", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      appendText(active, event.delta);
      this.scheduleEdit(active);
    });

    this.codex.on("itemCompleted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
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

    this.codex.on("turnCompleted", (event) => {
      const threadId = event.threadId;
      if (!threadId) {
        return;
      }

      const active = this.activeByThread.get(threadId);
      if (!active) {
        return;
      }

      active.completed = true;
      void this.flushEdit(active).finally(() => {
        this.activeByThread.delete(threadId);
      });
    });
  }

  private async handleDiscordMessage(message: MessageCreateEvent): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (this.options.allowedChannelId && message.channel_id !== this.options.allowedChannelId) {
      return;
    }

    const prompt = this.extractPrompt(message.content);
    if (!prompt) {
      return;
    }

    const threadId = await this.getThreadForChannel(message.channel_id);

    if (this.activeByThread.has(threadId)) {
      await this.rest.createMessage(message.channel_id, "Codex is still working on the previous turn.");
      return;
    }

    await this.rest.triggerTyping(message.channel_id);
    const reply = await this.rest.createMessage(message.channel_id, "Thinking...");
    const active: ActiveTurn = {
      channelId: message.channel_id,
      messageId: reply.id,
      blocks: [],
      blockByItemId: new Map(),
      openCommandHasOutput: false,
      completed: false,
    };
    this.activeByThread.set(threadId, active);

    try {
      await this.codex.startTurn(threadId, prompt);
    } catch (error) {
      this.activeByThread.delete(threadId);
      await this.rest.editMessage(message.channel_id, reply.id, `Codex turn failed: ${formatError(error)}`);
    }
  }

  private extractPrompt(content: string): string | undefined {
    if (this.options.allowedChannelId) {
      return content.trim() || undefined;
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
    return prompt || undefined;
  }

  private async getThreadForChannel(channelId: string): Promise<string> {
    const inMemoryThreadId = this.threadByDiscordChannel.get(channelId);
    if (inMemoryThreadId) {
      return inMemoryThreadId;
    }

    const saved = await this.sessions.get(channelId);
    if (saved) {
      try {
        const resumedThreadId = await this.codex.resumeThread({
          threadId: saved.threadId,
          cwd: saved.cwd || this.options.codexCwd,
        });
        this.threadByDiscordChannel.set(channelId, resumedThreadId);
        if (resumedThreadId !== saved.threadId || saved.cwd !== this.options.codexCwd) {
          await this.sessions.set(channelId, {
            threadId: resumedThreadId,
            cwd: this.options.codexCwd,
          });
        }
        return resumedThreadId;
      } catch (error) {
        console.warn(`Failed to resume Codex thread ${saved.threadId}; starting a new one:`, error);
      }
    }

    const threadId = await this.codex.startThread({ cwd: this.options.codexCwd });
    this.threadByDiscordChannel.set(channelId, threadId);
    await this.sessions.set(channelId, {
      threadId,
      cwd: this.options.codexCwd,
    });
    return threadId;
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

    const content = renderActiveTurn(active) || (active.completed ? "Done." : "Thinking...");
    await this.rest.editMessage(active.channelId, active.messageId, content);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
