import WebSocket from "ws";
import type { GatewayPayload, MessageCreateEvent, ReadyEvent } from "./types.js";

const OPCODE_DISPATCH = 0;
const OPCODE_HEARTBEAT = 1;
const OPCODE_IDENTIFY = 2;
const OPCODE_HELLO = 10;
const OPCODE_HEARTBEAT_ACK = 11;

const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

type DiscordGatewayEvents = {
  ready: (event: ReadyEvent) => void;
  messageCreate: (event: MessageCreateEvent) => void;
};

export class DiscordGateway {
  private socket?: WebSocket;
  private sequence: number | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatAcknowledged = true;
  private readonly listeners: { [K in keyof DiscordGatewayEvents]: DiscordGatewayEvents[K][] } = {
    ready: [],
    messageCreate: [],
  };

  constructor(private readonly token: string) {}

  on<K extends keyof DiscordGatewayEvents>(event: K, listener: DiscordGatewayEvents[K]): void {
    this.listeners[event].push(listener as never);
  }

  connect(): void {
    this.socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");

    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", (code, reason) => {
      this.stopHeartbeat();
      console.error(`Discord gateway closed: ${code} ${reason.toString()}`);
      setTimeout(() => this.connect(), 5000);
    });
    this.socket.on("error", (error) => {
      console.error("Discord gateway error:", error);
    });
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as GatewayPayload;
    if (payload.s !== undefined && payload.s !== null) {
      this.sequence = payload.s;
    }

    if (payload.op === OPCODE_HELLO) {
      const hello = payload.d as { heartbeat_interval: number };
      this.startHeartbeat(hello.heartbeat_interval);
      this.identify();
      return;
    }

    if (payload.op === OPCODE_HEARTBEAT) {
      this.sendHeartbeat();
      return;
    }

    if (payload.op === OPCODE_HEARTBEAT_ACK) {
      this.heartbeatAcknowledged = true;
      return;
    }

    if (payload.op === OPCODE_DISPATCH) {
      this.handleDispatch(payload);
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === "READY") {
      this.emit("ready", payload.d as ReadyEvent);
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      this.emit("messageCreate", payload.d as MessageCreateEvent);
    }
  }

  private identify(): void {
    this.send({
      op: OPCODE_IDENTIFY,
      d: {
        token: this.token,
        intents: INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
        properties: {
          os: process.platform,
          browser: "codex-app-server-discord",
          device: "codex-app-server-discord",
        },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();

    const firstBeatDelay = Math.floor(Math.random() * intervalMs);
    setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    }, firstBeatDelay);
  }

  private sendHeartbeat(): void {
    if (!this.heartbeatAcknowledged) {
      this.socket?.terminate();
      return;
    }

    this.heartbeatAcknowledged = false;
    this.send({ op: OPCODE_HEARTBEAT, d: this.sequence });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private emit<K extends keyof DiscordGatewayEvents>(
    event: K,
    payload: Parameters<DiscordGatewayEvents[K]>[0],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload as never);
    }
  }
}
