import { loadEnvFile } from "node:process";
import { DiscordCodexBridge } from "./bridge.js";
import { CodexClient } from "./codex/client.js";
import { loadConfig } from "./config.js";
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
const discordGateway = new DiscordGateway(config.discordToken);
const discordRest = new DiscordRest(config.discordToken);
const codexBackends = [{ id: "shared", client: new CodexClient(config.codexUrl) }];
const sessions = new SessionStore(config.sessionStorePath);

await Promise.all(codexBackends.map((backend) => backend.client.connect()));

const bridge = new DiscordCodexBridge(discordGateway, discordRest, codexBackends, sessions, {
  allowedChannelId: config.discordChannelId,
  codexCwd: config.codexCwd,
});

bridge.start();
discordGateway.connect();

console.log("Codex Discord bridge started");
