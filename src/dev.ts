import { spawn, type ChildProcess } from "node:child_process";
import { loadEnvFile } from "node:process";
import WebSocket from "ws";
import { DEFAULT_CODEX_APP_SERVER_URL } from "./config.js";

try {
  loadEnvFile(".env");
} catch {
  // Running with exported environment variables is fine too.
}

const codexUrl = process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_APP_SERVER_URL;
const codexBin = process.env.CODEX_BIN ?? "codex";
const children: ChildProcess[] = [];
let shuttingDown = false;

const codex = spawn(codexBin, ["app-server", "--listen", codexUrl], {
  stdio: "inherit",
  env: process.env,
});
children.push(codex);

codex.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`codex app-server exited (${code ?? signal})`);
    shutdown(code ?? 1);
  }
});
codex.on("error", (error) => {
  console.error(`failed to start codex app-server with ${codexBin}:`, error);
  shutdown(1);
});

await waitForWebSocket(codexUrl, 15_000);

const bridge = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  stdio: "inherit",
  env: process.env,
});
children.push(bridge);

bridge.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`Discord bridge exited (${code ?? signal})`);
    shutdown(code ?? 1);
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function shutdown(exitCode: number | string): void {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  process.exit(typeof exitCode === "number" ? exitCode : 1);
}

async function waitForWebSocket(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canOpenWebSocket(url)) {
      return;
    }
    await sleep(250);
  }

  shutdown(1);
}

function canOpenWebSocket(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(false);
    }, 1000);

    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
