# systemd

This example runs `npm run dev`, which starts both Codex app-server and the Discord bridge. It assumes the repo lives at `/opt/codex-app-server-discord` and the environment file lives at `/etc/codex-app-server-discord.env`.

## Environment

Create `/etc/codex-app-server-discord.env`:

```sh
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_CHANNEL_ID=
CODEX_APP_SERVER_URL=ws://127.0.0.1:45123
CODEX_CWD=/opt/codex-app-server-discord/workspace
CODEX_BIN=/usr/local/bin/codex
SESSION_STORE_PATH=/var/lib/codex-app-server-discord/sessions.json
```

Adjust `CODEX_BIN` to the output of `which codex` on the target machine. If `codex` is installed under a user home directory, use that absolute path.

Create the state directory:

```sh
sudo mkdir -p /var/lib/codex-app-server-discord
sudo chown -R codex-discord:codex-discord /var/lib/codex-app-server-discord
```

## Service

Create `/etc/systemd/system/codex-app-server-discord.service`:

```ini
[Unit]
Description=Codex app-server Discord bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-discord
Group=codex-discord
WorkingDirectory=/opt/codex-app-server-discord
EnvironmentFile=/etc/codex-app-server-discord.env
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npm run dev
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable it:

```sh
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
