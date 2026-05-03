# systemd

This service runs `npm run serve`, which starts both Codex app-server and the Discord bridge from the compiled `dist/` output.

The checked-in unit at `systemd/codex-app-server-discord.service` is configured for this checkout:

- repo: `/home/larry/github.com/larryhudson/codex-app-server-discord`
- user/group: `larry:larry`
- Node/npm/Codex path: `/home/larry/.nvm/versions/node/v24.14.0/bin`
- env file: `/etc/codex-app-server-discord.env`

## Environment

Create `/etc/codex-app-server-discord.env`, or copy the repo-local `.env` there:

```sh
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CHANNEL_ID=
CODEX_APP_SERVER_URL=ws://127.0.0.1:45123
CODEX_HOME=/home/larry/.codex
CODEX_AUTH_PROFILES=larryhudsonatheydotcom|/home/larry/.codex-subscriptions/larryhudsonatheydotcom/auth.json;harryludsonatgmaildotcom|/home/larry/.codex-subscriptions/harryludsonatgmaildotcom/auth.json
CODEX_CWD=/home/larry/.openclaw/workspace
CODEX_BIN=/home/larry/.nvm/versions/node/v24.14.0/bin/codex
SESSION_STORE_PATH=/home/larry/github.com/larryhudson/codex-app-server-discord/.sessions.json
```

Recommended permissions:

```sh
sudo chown root:root /etc/codex-app-server-discord.env
sudo chmod 600 /etc/codex-app-server-discord.env
```

## Service

Build the production output:

```sh
npm install
npm run build
```

Install and enable the unit:

```sh
sudo cp systemd/codex-app-server-discord.service /etc/systemd/system/codex-app-server-discord.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-app-server-discord
sudo systemctl status codex-app-server-discord
```

View logs:

```sh
journalctl -u codex-app-server-discord -f
```

## Notes

Keep `CODEX_APP_SERVER_URL` on `127.0.0.1` unless you add WebSocket authentication and intentionally expose the app-server. The bridge does not need the app-server to listen on a public interface.
