const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_MESSAGE_LIMIT = 2000;

export class DiscordRest {
  constructor(private readonly token: string) {}

  async createMessage(channelId: string, content: string): Promise<{ id: string }> {
    return this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: validateDiscordMessage(content) }),
    });
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: validateDiscordMessage(content) }),
    });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request(`/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.request(`/channels/${channelId}/typing`, { method: "POST" });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord REST ${response.status} ${response.statusText}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

function validateDiscordMessage(content: string): string {
  if (!content) {
    throw new Error("Discord message content cannot be empty");
  }
  if (content.length > DISCORD_MESSAGE_LIMIT) {
    throw new Error(`Discord message content exceeds ${DISCORD_MESSAGE_LIMIT} characters`);
  }
  return content;
}
