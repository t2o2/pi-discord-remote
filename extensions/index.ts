/**
 * pi-discord-remote — control this Pi session from Discord
 *
 * Each /pi-discord-remote start creates a fresh text channel named after the
 * current working directory + date (e.g. "kaleidoscope-may09").  On stop
 * (or session shutdown) the channel is deleted to stay within Discord's
 * per-server channel limit.
 *
 * Bot permissions required:
 *   • Read/Send Messages, Add Reactions  (existing)
 *   • Manage Channels                    (new — for create + rename)
 *
 * Commands:
 *   /pi-discord-remote setup       — interactive setup (token, guildId, categoryId, allowed users)
 *   /pi-discord-remote start       — create channel + connect
 *   /pi-discord-remote stop        — delete channel + disconnect
 *   /pi-discord-remote status      — show connection state
 *   /pi-discord-remote open-config — edit config.json in the editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".pi", "agent", "pi-discord-remote");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  token: string;
  /** Discord guild (server) ID — required for auto-channel creation */
  guildId: string;
  /** Optional category ID to put new channels under */
  categoryId?: string;
  /** Fallback channel ID when not creating a new channel (legacy) */
  channelId?: string;
  /** Optional allow-list of Discord user IDs. Empty = allow everyone. */
  allowedUserIds?: string[];
  /** React with emoji while processing (default: true) */
  reactions?: boolean;
}

async function loadConfig(): Promise<Config | null> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Config;
  } catch {
    return null;
  }
}

async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a Discord-safe channel name from cwd + short date. */
function makeChannelName(cwd: string): string {
  const dir = basename(cwd) || "pi";
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const raw = `${dir}-${month}${day}`;
  // Discord channel name rules: lowercase, 1-100 chars, only a-z 0-9 - _
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Split a string into ≤maxLen chunks, preferring newline boundaries. */
function splitMessage(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  return chunks;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let client: Client | null = null;
  let activeConfig: Config | null = null;
  /** ID of the channel that was created for this session (so we can archive it). */
  let sessionChannelId: string | null = null;
  /** Channel name at creation time (for archive rename). */
  let sessionChannelName: string | null = null;

  let agentBusy = false;
  let pendingReplyChannelId: string | null = null;
  let collectedAssistantText: string[] = [];

  // ── Collect assistant output ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any) => {
    agentBusy = true;
    collectedAssistantText = [];
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    if (!pendingReplyChannelId) return;
    if (event.message.role !== "assistant") return;

    const content = event.message.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

    if (text.trim()) collectedAssistantText.push(text);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (_event: any) => {
    agentBusy = false;

    if (!pendingReplyChannelId || !client) {
      pendingReplyChannelId = null;
      collectedAssistantText = [];
      return;
    }

    const channelId = pendingReplyChannelId;
    const text = collectedAssistantText.join("\n\n").trim();
    pendingReplyChannelId = null;
    collectedAssistantText = [];

    if (!text) return;

    try {
      const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      for (const chunk of splitMessage(text)) {
        await (channel as TextChannel).send(chunk);
      }
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send response:", err);
    }
  });

  // ── Cleanup helper ───────────────────────────────────────────────────────

  async function deleteSessionChannel(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (!client || !sessionChannelId) return;
    try {
      const channel = (await client.channels.fetch(sessionChannelId)) as TextChannel | null;
      if (channel) await channel.delete("Pi session ended");
    } catch (err) {
      console.error("[pi-discord-remote] Failed to delete channel:", err);
    }
    sessionChannelId = null;
    sessionChannelName = null;
    setStatusFn("pi-discord-remote", undefined);
  }

  // ── Session cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
    }
  });

  // ── Connect + channel-create helper ──────────────────────────────────────

  function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ) {
    if (client) {
      notifyFn("Already connected to Discord.", "warning");
      return;
    }

    activeConfig = cfg;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.once("ready", async (c) => {
      // Create a new channel for this session
      const channelName = makeChannelName(cwd);
      let listeningChannelId: string = cfg.channelId ?? "";

      try {
        const guild = await c.guilds.fetch(cfg.guildId);
        const newChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
          topic: `Pi session — ${cwd}`,
        });
        listeningChannelId = newChannel.id;
        sessionChannelId = newChannel.id;
        sessionChannelName = channelName;
        // Update the in-memory config so messageCreate checks the right channel
        activeConfig = { ...cfg, channelId: listeningChannelId };

        const label = `🔌 Discord: #${channelName}`;
        notifyFn(`Connected as ${c.user.tag} → #${channelName}`, "success");
        setStatusFn("pi-discord-remote", label);
      } catch (err) {
        // Channel creation failed — fall back to configured channelId
        console.error("[pi-discord-remote] Could not create channel:", err);
        notifyFn(
          `⚠️ Could not create channel (check Manage Channels permission). Falling back to configured channelId.`,
          "warning",
        );
        activeConfig = { ...cfg };
        setStatusFn("pi-discord-remote", `🔌 Discord: ${c.user.tag} (fallback)`);
      }
    });

    client.on("messageCreate", async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      if (message.channelId !== activeConfig.channelId) return;

      if (
        activeConfig.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(message.author.id)
      ) {
        await message.reply("❌ Your user ID is not on the allow-list.").catch(() => {});
        return;
      }

      if (agentBusy) {
        await message.reply("⏳ Still processing the previous message — please wait.").catch(() => {});
        return;
      }

      if (activeConfig.reactions !== false) {
        await message.react("⏳").catch(() => {});
      }

      pendingReplyChannelId = message.channelId;
      collectedAssistantText = [];
      pi.sendUserMessage(message.content);
    });

    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatusFn("pi-discord-remote", "⚠️ Discord: error");
    });

    client.login(cfg.token).catch((err) => {
      notifyFn(`Failed to log in: ${err.message}`, "error");
      client = null;
      activeConfig = null;
    });
  }

  // ── Command ───────────────────────────────────────────────────────────────

  pi.registerCommand("pi-discord-remote", {
    description: "Control this Pi session from Discord (creates a new channel per session)",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any, ctx: any) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0] || "help";

      switch (cmd) {
        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          const existing = await loadConfig();

          const token = await ctx.ui.input("Discord Bot Token:", existing?.token ?? "");
          if (!token) return;

          const guildId = await ctx.ui.input(
            "Guild (Server) ID:",
            existing?.guildId ?? "",
          );
          if (!guildId) return;

          const categoryId = await ctx.ui.input(
            "Category ID for new channels (leave empty = server root):",
            existing?.categoryId ?? "",
          );

          const allowedRaw = await ctx.ui.input(
            "Allowed Discord user IDs (comma-separated, leave empty = allow all):",
            existing?.allowedUserIds?.join(", ") ?? "",
          );
          const allowedUserIds = allowedRaw
            ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;

          const cfg: Config = {
            token,
            guildId,
            ...(categoryId ? { categoryId } : {}),
            ...(allowedUserIds ? { allowedUserIds } : {}),
            reactions: true,
          };

          await saveConfig(cfg);
          ctx.ui.notify(`Config saved → ${CONFIG_FILE}`, "success");
          break;
        }

        // ── start ─────────────────────────────────────────────────────────
        case "start": {
          const cfg = await loadConfig();
          if (!cfg) {
            ctx.ui.notify("No config found. Run /pi-discord-remote setup first.", "error");
            return;
          }
          startClient(
            cfg,
            ctx.cwd,
            (msg, level) => ctx.ui.notify(msg, level),
            (key, val) => ctx.ui.setStatus(key, val),
          );
          break;
        }

        // ── stop ──────────────────────────────────────────────────────────
        case "stop": {
          if (!client) {
            ctx.ui.notify("Not connected.", "warning");
            return;
          }
          await deleteSessionChannel((key, val) => ctx.ui.setStatus(key, val));
          await client.destroy().catch(() => {});
          client = null;
          activeConfig = null;
          ctx.ui.notify("Disconnected from Discord. Channel deleted.", "info");
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status": {
          if (client?.isReady()) {
            ctx.ui.notify(
              `✅ Connected as ${client.user.tag}\n` +
                `   Channel: #${sessionChannelName ?? activeConfig?.channelId}\n` +
                `   Allow-list: ${activeConfig?.allowedUserIds?.join(", ") || "everyone"}`,
              "info",
            );
          } else if (client) {
            ctx.ui.notify("⏳ Connecting…", "info");
          } else {
            ctx.ui.notify("❌ Not connected. Run /pi-discord-remote start.", "info");
          }
          break;
        }

        // ── open-config ───────────────────────────────────────────────────
        case "open-config": {
          const raw = existsSync(CONFIG_FILE)
            ? await readFile(CONFIG_FILE, "utf-8")
            : JSON.stringify(
                {
                  token: "",
                  guildId: "",
                  categoryId: "",
                  allowedUserIds: [],
                  reactions: true,
                },
                null,
                2,
              ) + "\n";

          const edited = await ctx.ui.editor("pi-discord-remote config.json", raw);
          if (!edited) return;

          try {
            const parsed = JSON.parse(edited) as Config;
            await saveConfig(parsed);
            ctx.ui.notify("Config saved.", "success");
          } catch {
            ctx.ui.notify("Invalid JSON — config not saved.", "error");
          }
          break;
        }

        // ── help ──────────────────────────────────────────────────────────
        default: {
          ctx.ui.notify(
            [
              "/pi-discord-remote setup       — configure bot token, guild, category",
              "/pi-discord-remote start       — create channel + connect",
              "/pi-discord-remote stop        — delete channel + disconnect",
              "/pi-discord-remote status      — show connection state",
              "/pi-discord-remote open-config — edit config JSON",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
