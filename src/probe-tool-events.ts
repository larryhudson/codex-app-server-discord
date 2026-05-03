import { appendFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import WebSocket from "ws";
import { DEFAULT_CODEX_APP_SERVER_URL } from "./config.js";

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

const interestingMethods = new Set([
  "item/started",
  "item/completed",
  "item/mcpToolCall/progress",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "rawResponseItem/completed",
  "turn/completed",
]);

try {
  loadEnvFile(".env");
} catch {
  // Running with exported environment variables is fine too.
}

const url = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_APP_SERVER_URL;
const cwd = process.env.CODEX_CWD ?? process.cwd();
const outputPath = process.env.TOOL_EVENT_PROBE_PATH ?? "tool-events.jsonl";
const prompt =
  process.argv.slice(2).join(" ") ||
  "Search the web for current references to openclaw-codex-app-server and summarize the best results briefly.";

let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
const socket = new WebSocket(url);

socket.on("message", (data) => {
  const message = JSON.parse(data.toString()) as JsonRpcResponse | JsonRpcNotification;
  if ("id" in message) {
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
    return;
  }

  void handleNotification(message);
});

socket.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

await new Promise<void>((resolve) => socket.once("open", resolve));
await writeFile(outputPath, "", "utf8");

await request("initialize", {
  clientInfo: {
    name: "codex-app-server-discord-probe",
    title: "Codex Discord Tool Event Probe",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
  },
});
send({ method: "initialized", params: {} });

const threadResult = await request<{ thread?: { id?: string } }>("thread/start", {
  cwd,
  approvalPolicy: "never",
  sandbox: "workspace-write",
  serviceName: "codex-app-server-discord-probe",
  experimentalRawEvents: false,
  persistExtendedHistory: false,
});

const threadId = threadResult.thread?.id;
if (!threadId) {
  throw new Error("Codex did not return a thread id");
}

console.log(`Probe thread: ${threadId}`);
console.log(`Writing tool events to ${outputPath}`);

await request("turn/start", {
  threadId,
  input: [{ type: "text", text: prompt }],
});

await new Promise<void>((resolve) => {
  socket.on("probe:turnCompleted", resolve);
});

socket.close();

function request<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  const message = params === undefined ? { method, id } : { method, id, params };
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    send(message);
  });
}

function send(message: unknown): void {
  socket.send(JSON.stringify(message));
}

async function handleNotification(message: JsonRpcNotification): Promise<void> {
  if (!interestingMethods.has(message.method)) {
    return;
  }

  const record = {
    method: message.method,
    summary: summarizeParams(message.params),
    params: message.params,
  };
  await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
  console.log(JSON.stringify(record.summary));

  if (message.method === "turn/completed") {
    socket.emit("probe:turnCompleted");
  }
}

function summarizeParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  const record = params as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  return {
    threadId: record.threadId,
    turnId: record.turnId,
    itemId: record.itemId ?? item?.id,
    itemType: item?.type,
    action: item?.action,
    query: item?.query,
    server: item?.server,
    tool: item?.tool,
    status: item?.status,
    result: summarizeValue(item?.result),
    error: summarizeValue(item?.error),
    message: record.message,
  };
}

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const json = JSON.stringify(value);
  if (json.length <= 300) {
    return value;
  }
  return `${json.slice(0, 300)}...`;
}
