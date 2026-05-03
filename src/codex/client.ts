import WebSocket from "ws";

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type CodexEvents = {
  agentMessageDelta: (event: { threadId?: string; turnId?: string; delta: string }) => void;
  commandStarted: (event: { threadId?: string; turnId?: string; itemId?: string; command: string }) => void;
  commandOutputDelta: (event: { threadId?: string; turnId?: string; itemId?: string; delta: string }) => void;
  toolStarted: (event: { threadId?: string; turnId?: string; itemId?: string; itemType?: string; label: string }) => void;
  toolProgress: (event: { threadId?: string; turnId?: string; itemId?: string; message: string }) => void;
  toolOutputDelta: (event: { threadId?: string; turnId?: string; itemId?: string; delta: string }) => void;
  itemCompleted: (event: { threadId?: string; turnId?: string; itemId?: string; itemType?: string; label?: string }) => void;
  turnCompleted: (event: { threadId?: string; turnId?: string }) => void;
};

export class CodexClient {
  private socket?: WebSocket;
  private nextId = 1;
  private initialized = false;
  private connectPromise?: Promise<void>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners: { [K in keyof CodexEvents]: CodexEvents[K][] } = {
    agentMessageDelta: [],
    commandStarted: [],
    commandOutputDelta: [],
    toolStarted: [],
    toolProgress: [],
    toolOutputDelta: [],
    itemCompleted: [],
    turnCompleted: [],
  };

  constructor(private readonly url: string) {}

  on<K extends keyof CodexEvents>(event: K, listener: CodexEvents[K]): void {
    this.listeners[event].push(listener as never);
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.on("open", async () => {
        try {
          await this.initialize();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.on("message", (data) => this.handleMessage(data.toString()));
      socket.on("close", (code, reason) => {
        this.initialized = false;
        this.connectPromise = undefined;
        this.rejectAll(new Error(`Codex app-server closed: ${code} ${reason.toString()}`));
      });
      socket.on("error", (error) => {
        this.connectPromise = undefined;
        reject(error);
      });
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.initialized = false;
    this.connectPromise = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.close();
    this.rejectAll(new Error("Codex app-server client disconnected"));
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    await this.connect();
  }

  async startThread(params: { cwd: string }): Promise<string> {
    const result = await this.request<{ thread?: { id?: string } }>("thread/start", {
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "codex-app-server-discord",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex did not return a thread id");
    }
    return threadId;
  }

  async resumeThread(params: { threadId: string; cwd: string }): Promise<string> {
    const result = await this.request<{ thread?: { id?: string } }>("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      persistExtendedHistory: false,
    });

    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error("Codex did not return a resumed thread id");
    }
    return threadId;
  }

  async startTurn(threadId: string, text: string): Promise<string | undefined> {
    const result = await this.request<{ turn?: { id?: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    return result.turn?.id;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.request("initialize", {
      clientInfo: {
        name: "codex-app-server-discord",
        title: "Codex Discord Bot",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.send({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send(message);
    });
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification;

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.handleNotification(message);
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === "item/started") {
      const params = message.params ?? {};
      const item = objectValue(params.item);
      if (item?.type === "commandExecution") {
        this.emit("commandStarted", {
          threadId: stringValue(params.threadId),
          turnId: stringValue(params.turnId),
          itemId: stringValue(item.id),
          command: stringValue(item.command) ?? "",
        });
      } else if (item) {
        const label = formatToolLabel(item);
        if (label) {
          this.emit("toolStarted", {
            threadId: stringValue(params.threadId),
            turnId: stringValue(params.turnId),
            itemId: stringValue(item.id),
            itemType: stringValue(item.type),
            label,
          });
        }
      }
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params ?? {};
      this.emit("agentMessageDelta", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        delta: extractDelta(params),
      });
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      const params = message.params ?? {};
      this.emit("commandOutputDelta", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        delta: extractDelta(params),
      });
      return;
    }

    if (message.method === "item/mcpToolCall/progress") {
      const params = message.params ?? {};
      this.emit("toolProgress", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        message: stringValue(params.message) ?? "",
      });
      return;
    }

    if (message.method === "item/fileChange/outputDelta") {
      const params = message.params ?? {};
      this.emit("toolOutputDelta", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        delta: extractDelta(params),
      });
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params ?? {};
      const item = objectValue(params.item);
      this.emit("itemCompleted", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(item?.id),
        itemType: stringValue(item?.type),
        label: item ? formatToolLabel(item) : undefined,
      });
      return;
    }

    if (message.method === "turn/completed" || message.method === "turn/ended") {
      const params = message.params ?? {};
      this.emit("turnCompleted", {
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
      });
    }
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emit<K extends keyof CodexEvents>(event: K, payload: Parameters<CodexEvents[K]>[0]): void {
    for (const listener of this.listeners[event]) {
      listener(payload as never);
    }
  }
}

function extractDelta(params: Record<string, unknown>): string {
  const candidate = params.delta ?? params.text ?? params.content;
  return typeof candidate === "string" ? candidate : "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function formatToolLabel(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "webSearch":
      return formatWebSearchLabel(item);
    case "mcpToolCall":
      return `Tool call: ${stringValue(item.server) ?? "mcp"}.${stringValue(item.tool) ?? "unknown"}${formatArguments(item.arguments)}`;
    case "dynamicToolCall": {
      const namespace = stringValue(item.namespace);
      const tool = stringValue(item.tool) ?? "unknown";
      return `Tool call: ${namespace ? `${namespace}.` : ""}${tool}${formatArguments(item.arguments)}`;
    }
    case "fileChange":
      return "File change";
    case "imageView":
      return `Image view: ${stringValue(item.path) ?? "image"}`;
    case "imageGeneration":
      return "Image generation";
    case "collabAgentToolCall":
      return `Agent tool: ${stringValue(item.tool) ?? "unknown"}`;
    default:
      return undefined;
  }
}

function formatWebSearchLabel(item: Record<string, unknown>): string {
  const action = objectValue(item.action);
  const directQuery = stringValue(item.query);
  if (!action) {
    return directQuery ? `Web search: ${directQuery}` : "Web search";
  }

  if (action.type === "search") {
    const queries = arrayValue(action.queries).filter((query): query is string => typeof query === "string");
    const query = stringValue(action.query) || queries.join(", ") || directQuery;
    return query ? `Web search: ${query}` : "Web search";
  }

  if (action.type === "openPage") {
    return `Open page: ${stringValue(action.url) ?? "web page"}`;
  }

  if (action.type === "findInPage") {
    const pattern = stringValue(action.pattern);
    const url = stringValue(action.url);
    return `Find in page: ${[pattern, url].filter(Boolean).join(" in ") || "web page"}`;
  }

  return directQuery ? `Web search: ${directQuery}` : "Web search";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatArguments(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const json = JSON.stringify(value);
  if (!json || json === "{}") {
    return "";
  }

  return ` ${json.length > 160 ? `${json.slice(0, 157)}...` : json}`;
}
