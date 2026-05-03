export type GatewayPayload<T = unknown> = {
  op: number;
  d: T;
  s?: number | null;
  t?: string | null;
};

export type ReadyEvent = {
  user: {
    id: string;
    username: string;
  };
};

export type MessageCreateEvent = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    bot?: boolean;
    username: string;
  };
  content: string;
};
