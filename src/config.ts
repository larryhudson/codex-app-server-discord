export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:45123";

export type CodexAuthProfile = {
  id: string;
  authPath: string;
};

export type Config = {
  discordToken: string;
  discordChannelId?: string;
  codexUrl: string;
  codexAuthProfiles: CodexAuthProfile[];
  codexHome?: string;
  codexCwd: string;
  codexBin: string;
  sessionStorePath: string;
};

export function loadConfig(): Config {
  const discordToken = requiredEnv("DISCORD_BOT_TOKEN");

  const codexUrl = optionalEnv("CODEX_APP_SERVER_URL") ?? DEFAULT_CODEX_APP_SERVER_URL;

  return {
    discordToken,
    discordChannelId: optionalEnv("DISCORD_CHANNEL_ID"),
    codexUrl,
    codexAuthProfiles: parseCodexAuthProfiles(optionalEnv("CODEX_AUTH_PROFILES")),
    codexHome: optionalEnv("CODEX_HOME"),
    codexCwd: optionalEnv("CODEX_CWD") ?? process.cwd(),
    codexBin: optionalEnv("CODEX_BIN") ?? "codex",
    sessionStorePath: optionalEnv("SESSION_STORE_PATH") ?? ".sessions.json",
  };
}

function parseCodexAuthProfiles(value: string | undefined): CodexAuthProfile[] {
  if (!value) {
    return [];
  }

  const profiles = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCodexAuthProfile);

  if (profiles.length === 0) {
    throw new Error("CODEX_AUTH_PROFILES did not contain any profile entries");
  }

  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new Error(`Duplicate CODEX_AUTH_PROFILES id: ${profile.id}`);
    }
    ids.add(profile.id);
  }

  return profiles;
}

function parseCodexAuthProfile(entry: string): CodexAuthProfile {
  const [id, authPath, extra] = entry.split("|").map((part) => part.trim());
  if (extra !== undefined || !id || !authPath) {
    throw new Error(`Invalid CODEX_AUTH_PROFILES entry: ${entry}`);
  }

  return {
    id,
    authPath,
  };
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
