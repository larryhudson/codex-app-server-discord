# Codex App Server Discord Bot

A tiny Discord bot that bridges Discord Gateway messages to a local Codex app-server WebSocket.

## Setup

Create a Discord bot, enable the `MESSAGE CONTENT INTENT` in the Discord developer portal, then invite it to your server.

Copy `.env.example` to `.env` and set:

```sh
DISCORD_BOT_TOKEN=your_bot_token
CODEX_APP_SERVER_URL=ws://127.0.0.1:4500
CODEX_CWD=/path/to/the/repo/codex/should/work/in
```

Optional:

```sh
DISCORD_CHANNEL_ID=1234567890
```

When `DISCORD_CHANNEL_ID` is set, every non-bot message in that channel is sent to Codex. When it is omitted, the bot responds only when mentioned.

## Run

```sh
npm install
npm run dev
```

`npm run dev` starts both the local Codex app-server and the Discord bridge. To run only the bridge against an already-running app-server:

```sh
npm run bridge
```

## Sessions

The bridge stores Discord channel to Codex thread mappings in `.sessions.json` by default. If the bridge or app-server restarts, the next message in a channel attempts to resume the saved Codex thread before creating a new one.

You can change the path with:

```sh
SESSION_STORE_PATH=/path/to/sessions.json
```

## Notes

The Codex app-server WebSocket transport is experimental. Keep it bound to `127.0.0.1` unless you add authentication and know exactly how you want to expose it.

This first version is intentionally small:

- one Discord Gateway WebSocket
- one Codex app-server WebSocket
- one Codex thread per Discord channel
- one active Codex turn per channel
- Discord REST for typing, sending, and editing replies
