export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:45123";

export type Config = {
  discordToken: string;
  discordChannelId?: string;
  codexUrl: string;
  codexCwd: string;
  codexBin: string;
  sessionStorePath: string;
};

export function loadConfig(): Config {
  const discordToken = requiredEnv("DISCORD_BOT_TOKEN");

  return {
    discordToken,
    discordChannelId: process.env.DISCORD_CHANNEL_ID,
    codexUrl: process.env.CODEX_APP_SERVER_URL ?? DEFAULT_CODEX_APP_SERVER_URL,
    codexCwd: process.env.CODEX_CWD ?? process.cwd(),
    codexBin: process.env.CODEX_BIN ?? "codex",
    sessionStorePath: process.env.SESSION_STORE_PATH ?? ".sessions.json",
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
