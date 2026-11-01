# pi-discord-remote

> Control your [Pi](https://pi.dev) coding-agent session from Discord.

![pi-discord-remote demo](demo.gif)

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
| Tool responses | Send tool outputs (results/errors) to Discord alongside tool-call labels? (y/n, default: no) |

Config is stored at `~/.pi/agent/pi-discord-remote/config.json`.

### Environment variables (alternative to config file)

For CI or headless setups, you can skip `setup` entirely and set these env vars:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token (overrides config file) |
| `DISCORD_GUILD_ID` | Guild (server) ID |
| `DISCORD_CATEGORY_ID` | Optional category ID |

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Discord bot token |
| `guildId` | string | — | Discord guild (server) ID |
| `categoryId` | string | — | Optional category for auto-created channels |
| `allowedUserIds` | string[] | `[]` | Allow-list of Discord user IDs (empty = everyone) |
| `reactions` | boolean | `true` | React with ⏳ while processing |
| `toolResponses` | boolean | `false` | Also post tool outputs/results alongside tool-call labels (truncated to ≤400 chars) |
| `toolCalls` | boolean | `true` | Post tool-call labels (🔧 bash, ✏️ edit, …) |
| `stream` | boolean | `true` | Stream assistant text/thinking in chunks while the turn runs, instead of posting only at turn end |
| `thinking` | boolean | `true` | Send reasoning/thinking blocks to Discord (prefix `💭`) |
| `steering` | boolean | `true` | Messages sent while Pi is busy steer the running turn instead of being rejected |
| `mirrorLocalInput` | boolean | `true` | Post prompts typed in the local TUI to the Discord channel (prefix `🖥️`) |
| `typing` | boolean | `true` | Show a Discord typing indicator while Pi is working |
| `mention` | boolean | `true` | Tag the user (`<@id>`) on the final response of each turn |
| `chunkChars` | number | `1900` | Soft chunk size for streamed messages (max 1900) |
| `keepChannel` | boolean | `false` | Keep the session channel after stop/shutdown instead of deleting it |
| `autoConnect` | boolean | `false` | Connect on Pi startup (useful for headless/`--print`/RPC sessions) |

Edit config with `/pi-discord-remote open-config`.

## How it works

The extension loads silently on Pi startup — no channel is created until you explicitly run the command.

- **`/pi-discord-remote start`** — bot logs in, creates a text channel named `<project>-<mon><dd>-<HHMM>`, and starts listening there only
- **Incoming message** — injected as a user prompt into the active Pi session; bot reacts ⏳ while Pi works, then posts the full response back
- **Tool calls** — each tool invocation is labeled (🔧 bash, 📄 read, ✏️ edit, etc.) with a detail line; if `toolResponses` is on, results follow as ↩️/❌ code blocks
- **`/pi-discord-remote stop`** (or Pi exit) — channel is deleted, bot disconnects

### Steering and local activity

- **Steering**: while a turn is running, a new Discord message is injected into the
  running turn via `pi.sendUserMessage(..., { deliverAs: "steer" })` (react 📥).
  Set `"steering": false` to go back to the old "please wait" behaviour.
- **Local TUI prompts are mirrored** (`🖥️ …`) so the remote view never goes silent
  when you work at the keyboard — output is posted to the session channel regardless
  of who started the turn.
- **Thinking is streamed** as `💭 …` chunks (disable with `"thinking": false`).
- **Abort from Discord**: react 🛑 on any bot message, send a bare `🛑` / `stop`
  message, or run `/pi-discord-remote abort` in Pi.

### Optional image skill tool

Image forwarding is **not automatic** in `pi-discord-remote`.

If you want to send an image, use the explicit `discord_send_image` tool (opt-in):
- optional `channelId` (recommended for deterministic targeting)
- source by local `path`
- or source by `url`
- or source by `base64` (+ optional `mediaType`)

Exactly one source should be provided per call. If omitted, the tool falls back to the latest `agent_browser` image artifact path.

`/pi-discord-remote status` now shows the active **Channel ID** so you can pass it directly to `discord_send_image`.

The tool returns explicit send errors (for example `unknown_channel:<id>` or timeout/HTTP errors) instead of silently forwarding images.

### `ask_user_question` → Discord

Pi's TUI-only `ask_user_question` dialog (from `@juicesharp/rpiv-ask-user-question`) is invisible over Discord remote. When Discord is connected, pi-discord-remote:

1. **Blocks** the original `ask_user_question` via `tool_call` event interception — the TUI dialog never appears
2. **Registers** `discord_ask_user_question` — a drop-in replacement that formats questions as Discord messages and collects answers from the channel
3. **Hints** the LLM via `before_agent_start` to prefer `discord_ask_user_question` when Discord is connected

When Discord **is not** connected, the original `ask_user_question` (TUI dialog) works normally as a fallback. No need to uninstall `@juicesharp/rpiv-ask-user-question` — the two extensions coexist gracefully.

## Diagnosing connection problems

Every Discord event (connect, gateway disconnect, reconnect attempt, login error, send/mention/reaction failure, 🛑 abort) is appended to:

```text
~/.pi/agent/pi-discord-remote/diagnostics.log     # override with PI_DISCORD_LOG_DIR
```

- `/pi-discord-remote status` — channel, output target, gateway ready state, last posted message id, last error
- `/pi-discord-remote debug 50` — tail the last 50 log lines inside Pi
- The log is plain text, so an agent with shell access can read it directly

## License

MIT
