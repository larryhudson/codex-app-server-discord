import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import WebSocket from "ws";
import { DiscordCodexBridge } from "./bridge.js";
import { CodexClient } from "./codex/client.js";
import { loadConfig, type CodexAuthProfile } from "./config.js";
import { DiscordGateway } from "./discord/gateway.js";
import { DiscordRest } from "./discord/rest.js";
import { SessionStore } from "./session-store.js";

try {
  loadEnvFile("/etc/codex-app-server-discord.env");
} catch {
  try {
    loadEnvFile(".env");
  } catch {
    // Running with exported environment variables is fine too.
  }
}

const config = loadConfig();
const codexHome = config.codexHome ?? join(process.env.HOME ?? "/home/larry", ".codex");
const authProfiles = config.codexAuthProfiles;
const codex = new CodexClient(config.codexUrl);
let codexProcess: ChildProcess | undefined;
let shuttingDown = false;
let switchingAuth = false;
let activeAuthProfileIndex = 0;
let switchPromise: Promise<{ authProfileId: string; threadId: string }> | undefined;

if (authProfiles.length > 0) {
  await installAuthProfile(authProfiles[activeAuthProfileIndex]!);
}

await startCodexAppServer();
await codex.connect();

const discordGateway = new DiscordGateway(config.discordToken);
const discordRest = new DiscordRest(config.discordToken);
const sessions = new SessionStore(config.sessionStorePath);
const bridge = new DiscordCodexBridge(discordGateway, discordRest, [{ id: "shared", client: codex }], sessions, {
  allowedChannelId: config.discordChannelId,
  codexCwd: config.codexCwd,
  switchAuthProfile: authProfiles.length > 1 ? switchAuthProfileAndResume : undefined,
});

bridge.start();
discordGateway.connect();

console.log("Codex Discord bridge started");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function switchAuthProfileAndResume(params: { threadId: string; cwd: string }): Promise<{
  authProfileId: string;
  threadId: string;
}> {
  if (switchPromise) {
    return switchPromise;
  }

  switchPromise = doSwitchAuthProfileAndResume(params).finally(() => {
    switchPromise = undefined;
  });
  return switchPromise;
}

async function doSwitchAuthProfileAndResume(params: { threadId: string; cwd: string }): Promise<{
  authProfileId: string;
  threadId: string;
}> {
  if (authProfiles.length < 2) {
    throw new Error("At least two CODEX_AUTH_PROFILES are required for auth switching");
  }

  activeAuthProfileIndex = (activeAuthProfileIndex + 1) % authProfiles.length;
  const profile = authProfiles[activeAuthProfileIndex]!;

  logInfo("codex_auth_switch_started", {
    authProfileId: profile.id,
    codexHome,
    codexThreadId: params.threadId,
  });

  switchingAuth = true;
  try {
    codex.disconnect();
    await stopCodexAppServer();
    await installAuthProfile(profile);
    await startCodexAppServer();
    await codex.reconnect();
    const resumedThreadId = await codex.resumeThread({
      threadId: params.threadId,
      cwd: params.cwd,
    });

    logInfo("codex_auth_switch_completed", {
      authProfileId: profile.id,
      previousCodexThreadId: params.threadId,
      codexThreadId: resumedThreadId,
    });

    return {
      authProfileId: profile.id,
      threadId: resumedThreadId,
    };
  } finally {
    switchingAuth = false;
  }
}

async function installAuthProfile(profile: CodexAuthProfile): Promise<void> {
  const authPath = join(codexHome, "auth.json");
  const tempPath = `${authPath}.tmp`;
  await mkdir(dirname(authPath), { recursive: true });
  await copyFile(profile.authPath, tempPath);
  await rename(tempPath, authPath);
  logInfo("codex_auth_profile_installed", {
    authProfileId: profile.id,
    codexHome,
  });
}

async function startCodexAppServer(): Promise<void> {
  codexProcess = spawn(config.codexBin, ["app-server", "--listen", config.codexUrl], {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
    },
  });

  codexProcess.on("exit", (code, signal) => {
    if (!shuttingDown && !switchingAuth) {
      console.error(`codex app-server exited (${code ?? signal})`);
      shutdown(code ?? 1);
    }
  });
  codexProcess.on("error", (error) => {
    if (!shuttingDown && !switchingAuth) {
      console.error(`failed to start codex app-server with ${config.codexBin}:`, error);
      shutdown(1);
    }
  });

  await waitForWebSocket(config.codexUrl, 15_000);
}

async function stopCodexAppServer(): Promise<void> {
  const processToStop = codexProcess;
  codexProcess = undefined;
  if (!processToStop || processToStop.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    processToStop.once("exit", () => resolve());
    processToStop.kill("SIGTERM");
    setTimeout(() => {
      if (!processToStop.killed) {
        processToStop.kill("SIGKILL");
      }
      resolve();
    }, 5000);
  });
}

function shutdown(exitCode: number | string): void {
  shuttingDown = true;
  codex.disconnect();
  if (codexProcess && !codexProcess.killed) {
    codexProcess.kill("SIGTERM");
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

  throw new Error(`Timed out waiting for Codex app-server at ${url}`);
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

function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}
