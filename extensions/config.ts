/**
 * Config management for pi-discord-remote.
 * Config is persisted to ~/.pi/agent/pi-discord-remote/config.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR =
  process.env.PI_DISCORD_CONFIG_DIR?.trim() || join(homedir(), ".pi", "agent", "pi-discord-remote");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
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
  /** Also send tool responses (output/results) after each tool call (default: false) */
  toolResponses?: boolean;
  /** Send tool-call labels to Discord (default: true) */
  toolCalls?: boolean;
  /** Stream assistant text/thinking in chunks while the turn is running (default: true) */
  stream?: boolean;
  /** Send thinking/reasoning blocks to Discord (default: true) */
  thinking?: boolean;
  /** Let Discord messages steer a running turn instead of being rejected (default: true) */
  steering?: boolean;
  /** Mirror prompts typed in the local TUI to Discord (default: true) */
  mirrorLocalInput?: boolean;
  /** Show a Discord typing indicator while Pi is working (default: true) */
  typing?: boolean;
  /** Mention (tag) the user on the final response of each turn (default: true) */
  mention?: boolean;
  /** Soft chunk size for streamed messages, max 1900 (default: 1900) */
  chunkChars?: number;
  /** Keep the session channel after stop/shutdown instead of deleting it (default: false) */
  keepChannel?: boolean;
  /** Auto-connect when Pi starts, without running /pi-discord-remote start (default: false) */
  autoConnect?: boolean;
  /** "project" (default) reuses one channel per project dir; "session" creates a channel per session */
  channelMode?: "project" | "session";
  /** Project slug → channel ID, maintained automatically in project mode */
  projectChannels?: Record<string, string>;
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Config;
    // Allow DISCORD_TOKEN env var to override the config token
    if (process.env.DISCORD_TOKEN) {
      cfg.token = process.env.DISCORD_TOKEN;
    }
    return cfg;
  } catch {
    // Fall back to env var only (useful for CI / headless setups)
    if (process.env.DISCORD_TOKEN && process.env.DISCORD_GUILD_ID) {
      return {
        token: process.env.DISCORD_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
        categoryId: process.env.DISCORD_CATEGORY_ID,
        reactions: true,
        toolResponses: false,
      };
    }
    return null;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** Default config template shown in the editor when no config exists. */
export function defaultConfigTemplate(): string {
  return (
    JSON.stringify(
      {
        token: "",
        guildId: "",
        categoryId: "",
        allowedUserIds: [],
        reactions: true,
        // Set to true to also post tool outputs/results after each tool call
        toolResponses: false,
        toolCalls: true,
        stream: true,
        thinking: true,
        steering: true,
        mirrorLocalInput: true,
        typing: true,
        mention: true,
        chunkChars: 1900,
        keepChannel: false,
        autoConnect: false,
        channelMode: "project",
        projectChannels: {},
      },
      null,
      2,
    ) + "\n"
  );
}
