# pi-discord-remote

> Control your [Pi](https://pi.dev) coding-agent session from Discord.

Each time you run `/pi-discord-remote start`, the extension automatically creates a **new Discord text channel** named after your current project + date (e.g. `kaleidoscope-may09`). Messages sent in that channel are injected into Pi as user prompts; Pi's responses are posted back. When you stop, the channel is deleted — keeping your server clean within Discord's channel limit.

## Install

```bash
pi install npm:pi-discord-remote
```

## Bot setup

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content**
3. Invite the bot to your server with these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Add Reactions
   - **Manage Channels** ← required for auto-create/delete

## Usage

```
/pi-discord-remote setup        — configure token, server ID, optional category
/pi-discord-remote start        — create channel + connect
/pi-discord-remote stop         — delete channel + disconnect
/pi-discord-remote status       — show connection state
/pi-discord-remote open-config  — edit config JSON in Pi's editor
```

### Setup prompts

| Field | Where to find it |
|-------|-----------------|
| Bot token | Discord Developer Portal → Bot → Token |
| Guild (Server) ID | Right-click server → Copy Server ID (needs Developer Mode) |
| Category ID | Right-click a category → Copy Category ID (optional — channels go to server root otherwise) |
| Allowed user IDs | Right-click a user → Copy User ID (leave empty to allow everyone) |

Config is stored at `~/.pi/agent/pi-discord-remote/config.json`.

## How it works

- **`/pi-discord-remote start`** — bot logs in, creates a text channel named `<project>-<mon><dd>`, and starts listening there only
- **Incoming message** — injected as a user prompt into the active Pi session; bot reacts ⏳ while Pi works, then posts the full response back
- **`/pi-discord-remote stop`** (or Pi exit) — channel is deleted, bot disconnects

## License

MIT
