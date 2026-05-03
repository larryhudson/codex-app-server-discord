import { readFile, rename, writeFile } from "node:fs/promises";

type StoredSession = {
  threadId: string;
  cwd: string;
};

type SessionFile = {
  channels?: Record<string, StoredSession>;
};

export class SessionStore {
  private readonly channels = new Map<string, StoredSession>();
  private loaded = false;

  constructor(private readonly path: string) {}

  async get(channelId: string): Promise<StoredSession | undefined> {
    await this.load();
    return this.channels.get(channelId);
  }

  async set(channelId: string, session: StoredSession): Promise<void> {
    await this.load();
    this.channels.set(channelId, session);
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loaded = true;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as SessionFile;
      for (const [channelId, session] of Object.entries(parsed.channels ?? {})) {
        if (isStoredSession(session)) {
          this.channels.set(channelId, session);
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async save(): Promise<void> {
    const channels = Object.fromEntries([...this.channels.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const content = `${JSON.stringify({ channels }, null, 2)}\n`;
    const tempPath = `${this.path}.tmp`;
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, this.path);
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<StoredSession>;
  return typeof candidate.threadId === "string" && typeof candidate.cwd === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
