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
import { Type } from "typebox";
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
  /** Also send tool responses (output/results) after each tool call (default: false) */
  toolResponses?: boolean;
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

/** Generate a Discord-safe channel name from cwd + short date + time (HH-MM). */
function makeChannelName(cwd: string): string {
  const dir = basename(cwd) || "pi";
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const raw = `${dir}-${month}${day}-${hh}${mm}`;
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
  let pendingReplyUserId: string | null = null;
  let collectedAssistantText: string[] = [];
  let postedThinkingNotice = false;

  // ── Question-answering state (for overriding ask_user_question) ────────
  let questionResolver: ((answer: string) => void) | null = null;
  let questionRejecter: ((reason: Error) => void) | null = null;
  let questionChannelId: string | null = null;
  let questionTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearQuestionState(): void {
    if (questionTimeout) {
      clearTimeout(questionTimeout);
      questionTimeout = null;
    }
    questionResolver = null;
    questionRejecter = null;
    questionChannelId = null;
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  async function sendToActiveChannel(text: string): Promise<void> {
    if (!client || !pendingReplyChannelId) return;
    try {
      const channel = (await client.channels.fetch(pendingReplyChannelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      await (channel as TextChannel).send(text);
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send message:", err);
    }
  }

  async function sendImageToActiveChannel(
    source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string },
  ): Promise<void> {
    if (!client || !pendingReplyChannelId) return;
    try {
      const channel = (await client.channels.fetch(pendingReplyChannelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      if (source.type === "base64") {
        const ext = (source.media_type ?? "image/png").split("/")[1] ?? "png";
        const buffer = Buffer.from(source.data, "base64");
        await (channel as TextChannel).send({ files: [{ attachment: buffer, name: `image.${ext}` }] });
      } else if (source.type === "url") {
        await (channel as TextChannel).send({ files: [{ attachment: source.url }] });
      }
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send image:", err);
    }
  }

  /** Upload a file from disk to the active Discord channel. */
  async function sendFileToActiveChannel(filePath: string): Promise<void> {
    if (!client || !pendingReplyChannelId) return;
    try {
      const channel = (await client.channels.fetch(pendingReplyChannelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      const buffer = await readFile(filePath);
      const filename = basename(filePath);
      await (channel as TextChannel).send({ files: [{ attachment: buffer, name: filename }] });
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send file:", err);
    }
  }

  /** Collect direct image sources from a content block array (assistant messages only). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function extractImages(content: any[]): Array<{ type: "base64"; media_type: string; data: string } | { type: "url"; url: string }> {
    return content
      .filter((block) => block.type === "image" && block.source)
      .map((block) => block.source);
  }

  // ── Tool emoji / detail ───────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toolLabel(toolName: string, args: any): string {
    const emojis: Record<string, string> = {
      bash: "🔧", read: "📄", edit: "✏️", write: "📝",
      grep: "🔍", find: "🔎", ls: "📁",
    };
    const emoji = emojis[toolName] ?? "⚙️";
    let detail = "";
    if (toolName === "bash" && args?.command) {
      const cmd = String(args.command).replace(/\n/g, " ").slice(0, 80);
      detail = `: \`${cmd}${args.command.length > 80 ? "…" : ""}\``;
    } else if (["read", "write"].includes(toolName) && args?.path) {
      detail = `: \`${args.path}\``;
    } else if (toolName === "edit" && args?.path) {
      detail = `: \`${args.path}\``;
    } else if (toolName === "grep" && args?.pattern) {
      detail = `: \`${args.pattern}\`${args.path ? ` in \`${args.path}\`` : ""}`;
    } else if (["find", "ls"].includes(toolName) && args?.path) {
      detail = `: \`${args.path}\``;
    }
    return `${emoji} _${toolName}_${detail}`;
  }

  // ── Collect assistant output ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any) => {
    agentBusy = true;
    collectedAssistantText = [];
    postedThinkingNotice = false;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result", async (event: any) => {
    console.log("[pi-discord-remote] tool_result event keys:", Object.keys(event));
    console.log("[pi-discord-remote] tool_result toolName:", event.toolName);
    console.log("[pi-discord-remote] tool_result pendingReplyChannelId:", pendingReplyChannelId);
    console.log("[pi-discord-remote] tool_result has details:", !!event.details);
    if (event.details) {
      console.log("[pi-discord-remote] tool_result details keys:", Object.keys(event.details));
      console.log("[pi-discord-remote] tool_result details.artifacts:", JSON.stringify(event.details.artifacts?.slice(0, 3)));
    }

    if (!pendingReplyChannelId) {
      console.log("[pi-discord-remote] tool_result SKIPPED — no pendingReplyChannelId");
      return;
    }

    // Always forward embedded image content blocks — not gated by toolResponses
    const images = event.content?.filter((c: any) => c.type === "image") ?? [];
    console.log("[pi-discord-remote] tool_result embedded images in content:", images.length);
    for (const img of images) {
      if (img.source) {
        console.log("[pi-discord-remote] Forwarding embedded image with source type:", img.source.type);
        await sendImageToActiveChannel(img.source);
      }
    }

    // Forward agent_browser file artifacts (screenshots, pdfs, downloads)
    if (event.toolName === "agent_browser") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const artifacts: any[] = event.details?.artifacts ?? [];
      console.log("[pi-discord-remote] agent_browser artifacts count:", artifacts.length);
      const forwarded = new Set<string>();

      for (const artifact of artifacts) {
        console.log("[pi-discord-remote] artifact keys:", Object.keys(artifact));
        console.log("[pi-discord-remote] artifact.kind:", artifact.kind);
        console.log("[pi-discord-remote] artifact:", JSON.stringify(artifact));
        // FileArtifactMetadata uses 'kind' (not 'type'): "image", "download", "pdf", etc.
        if (artifact.kind === "image") {
          const filePath = artifact.absolutePath ?? artifact.path;
          console.log("[pi-discord-remote] image filePath:", filePath);
          console.log("[pi-discord-remote] existsSync:", filePath ? existsSync(filePath) : "N/A");
          if (filePath && !forwarded.has(filePath) && existsSync(filePath)) {
            console.log("[pi-discord-remote] Forwarding image file to Discord:", filePath);
            await sendFileToActiveChannel(filePath);
            forwarded.add(filePath);
          }
        }
      }

      // Fallback: parse text for "Artifact type: image" + "Absolute path: <path>"
      if (forwarded.size === 0) {
        console.log("[pi-discord-remote] No artifacts forwarded via details, trying text fallback");
        const textContent = (event.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => String(c.text ?? ""))
          .join("\n");
        console.log("[pi-discord-remote] textContent (first 500 chars):", textContent.slice(0, 500));
        const matches = [...textContent.matchAll(/Artifact type: image[\s\S]*?Absolute path: ([^\n]+)/g)];
        console.log("[pi-discord-remote] text regex matches:", matches.length);
        for (const match of matches) {
          const filePath = match[1].trim();
          console.log("[pi-discord-remote] text fallback filePath:", filePath);
          console.log("[pi-discord-remote] text fallback existsSync:", existsSync(filePath));
          if (filePath && !forwarded.has(filePath) && existsSync(filePath)) {
            console.log("[pi-discord-remote] Forwarding image file (text fallback) to Discord:", filePath);
            await sendFileToActiveChannel(filePath);
            forwarded.add(filePath);
          }
        }
      } else {
        console.log("[pi-discord-remote] Forwarded", forwarded.size, "images via artifacts");
      }
    }

    // Only send text summaries if toolResponses is enabled
    if (!activeConfig?.toolResponses) return;

    // Build a label like "↩️ bash: ..." or "↩️ read: ..."
    const emoji = event.isError ? "❌" : "↩️";
    const detailLabel = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? "").trim())
      .join("")
      .slice(0, 300) ?? "";

    // Send a compact summary line for each tool result
    const label = `${emoji} _${event.toolName}_`;
    if (detailLabel) {
      const truncated = detailLabel.length > 400 ? detailLabel.slice(0, 400) + "…" : detailLabel;
      await sendToActiveChannel(`${label}:\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      await sendToActiveChannel(label);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_update", async (event: any) => {
    if (!pendingReplyChannelId || postedThinkingNotice) return;
    if (event.message.role !== "assistant") return;
    const hasThinking = (event.message.content as Array<{ type: string }>)
      .some((c) => c.type === "thinking");
    if (hasThinking) {
      postedThinkingNotice = true;
      await sendToActiveChannel("💭 _Thinking…_");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    if (!pendingReplyChannelId) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    if (!pendingReplyChannelId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = event.message.content as Array<any>;

    // Collect text from assistant messages
    if (event.message.role === "assistant") {
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.trim()) collectedAssistantText.push(text);
    }

    // Forward any images from any role (assistant text, tool results, etc.)
    const images = extractImages(content);
    for (const src of images) {
      await sendImageToActiveChannel(src);
    }


  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (_event: any) => {
    agentBusy = false;

    if (!pendingReplyChannelId || !client) {
      pendingReplyChannelId = null;
      collectedAssistantText = [];
      return;
    }

    const text = collectedAssistantText.join("\n\n").trim();
    // Clear state before sending so sendToActiveChannel still sees the channel ID
    collectedAssistantText = [];
    // pendingReplyChannelId cleared after send below

    if (!text) {
      pendingReplyChannelId = null;
      pendingReplyUserId = null;
      return;
    }

    const chunks = splitMessage(text);
    // Prepend a mention to the last chunk so the sender is notified when work is done
    const mention = pendingReplyUserId ? `<@${pendingReplyUserId}> ` : "";
    const lastIdx = chunks.length - 1;
    chunks[lastIdx] = mention + chunks[lastIdx];

    for (const chunk of chunks) {
      await sendToActiveChannel(chunk);
    }
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
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

  pi.on("session_shutdown", async (event: any) => {
    // Reject any pending question so tool execution doesn't hang
    if (questionRejecter) {
      questionRejecter(new Error("Session shut down"));
    }
    clearQuestionState();
    // Don't destroy Discord client on reload — just re-register handlers
    if (event?.reason === "reload") return;
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
    }
  });

  // Auto-connect removed — user must run /pi-discord-remote start explicitly.

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

      // If waiting for a question answer, route this message to the resolver
      if (questionResolver && message.channelId === questionChannelId) {
        if (activeConfig.reactions !== false) {
          await message.react("✅").catch(() => {});
        }
        // Capture before clearing — the resolver clears state
        const resolve = questionResolver;
        resolve(message.content);
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
      pendingReplyUserId = message.author.id;
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

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    if (!client?.isReady()) return; // Discord not ready — let TUI tool work
    return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!client?.isReady()) return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        "When you need to ask the user a clarifying question, use the " +
        "discord_ask_user_question tool instead of ask_user_question. " +
        "The Discord version sends questions to the user's Discord channel. " +
        "If discord_ask_user_question returns an error about no UI, " +
        "fall back to ask_user_question.",
    };
  });

  // ── Tool: discord_ask_user_question → Discord ───────────────────────────

  // Send questions to Discord — avoids the TUI-only dialog from
  // @juicesharp/rpiv-ask-user-question that remote users can't see.
  // When Discord is connected, use this tool instead of ask_user_question.
  pi.registerTool({
    name: "discord_ask_user_question",
    label: "Ask User Question (Discord)",
    description:
      "Ask the user one or more structured clarifying questions via Discord. " +
      "Use this instead of ask_user_question when Discord is connected. " +
      "Questions and options are forwarded to the Discord channel. " +
      "The user replies with the option number, label, or custom text.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
              preview: Type.Optional(Type.String()),
            }),
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const channelId = pendingReplyChannelId;
      if (!client || !channelId) {
        return {
          content: [
            {
              type: "text",
              text: "Discord not connected. Please answer in the Pi TUI directly.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      let channel: TextChannel | null = null;
      try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched?.isTextBased()) channel = fetched as TextChannel;
      } catch {
        // channel fetch failed — fall through
      }
      if (!channel) {
        return {
          content: [
            {
              type: "text",
              text: "Discord channel not available. Use ask_user_question instead for TUI-based questions, or connect Discord first.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      interface Answer {
        questionIndex: number;
        question: string;
        kind: "option" | "custom" | "chat" | "multi";
        answer: string | null;
        selected?: string[];
        notes?: string;
        preview?: string;
      }

      const answers: Answer[] = [];

      for (let qi = 0; qi < params.questions.length; qi++) {
        const q = params.questions[qi];

        // Format question for Discord
        const lines: string[] = [];
        lines.push(`## ${q.header}: ${q.question}`);
        lines.push("");

        if (q.multiSelect) {
          lines.push("*(Multi-select — reply with numbers/labels separated by commas)*");
          lines.push("");
        }

        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          lines.push(`${oi + 1}. **${opt.label}** — ${opt.description}`);
          if (opt.preview) {
            lines.push(`\`\`\`\n${opt.preview}\n\`\`\``);
          }
        }

        lines.push("");
        if (q.multiSelect) {
          lines.push("> Reply with numbers/labels (e.g. \"1,3\") or type \"chat\" to skip.");
        } else {
          lines.push("> Reply with the number or label, type a custom answer, or type \"chat\" to skip.");
        }

        // Send the question
        try {
          await channel.send(lines.join("\n"));
        } catch {
          return {
            content: [{ type: "text", text: "Failed to send question to Discord." }],
            details: { answers: [], cancelled: true, error: "no_ui" },
          };
        }

        // Wait for answer
        questionChannelId = channelId;
        let answerText: string;
        try {
          answerText = await new Promise<string>((resolve, reject) => {
            questionResolver = resolve;
            questionRejecter = reject;

            questionTimeout = setTimeout(() => {
              clearQuestionState();
              reject(new Error("Question timed out — no response in 5 minutes"));
            }, 300_000);

            const onAbort = () => {
              clearQuestionState();
              reject(new Error("Session shut down while waiting for question answer"));
            };
            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        } catch (err: any) {
          clearQuestionState();
          return {
            content: [{ type: "text", text: `Question cancelled: ${err.message}` }],
            details: { answers, cancelled: true },
          };
        }
        clearQuestionState();

        const trimmed = answerText.trim();

        // Check for "chat" escape
        if (trimmed.toLowerCase() === "chat" || trimmed.toLowerCase() === "/chat") {
          answers.push({
            questionIndex: qi,
            question: q.question,
            kind: "chat",
            answer: null,
          });
          continue;
        }

        // Parse answer
        if (q.multiSelect) {
          // Multi-select: try to parse numbers/labels
          const parts = trimmed.split(/[,\s]+/).filter(Boolean);
          const selected: string[] = [];
          for (const part of parts) {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= q.options.length) {
              selected.push(q.options[num - 1].label);
            } else {
              // Try label match
              const match = q.options.find(
                (o: any) => o.label.toLowerCase() === part.toLowerCase(),
              );
              if (match) {
                if (!selected.includes(match.label)) selected.push(match.label);
              }
            }
          }

          if (selected.length > 0) {
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "multi",
              answer: selected.join(", "),
              selected,
            });
          } else {
            // No match — treat as custom
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "custom",
              answer: trimmed,
            });
          }
        } else {
          // Single-select: try number first, then label match, then custom
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= q.options.length) {
            const opt = q.options[num - 1];
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "option",
              answer: opt.label,
              preview: opt.preview,
            });
          } else {
            const match = q.options.find(
              (o: any) => o.label.toLowerCase() === trimmed.toLowerCase(),
            );
            if (match) {
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "option",
                answer: match.label,
                preview: match.preview,
              });
            } else {
              // Custom answer
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "custom",
                answer: trimmed,
              });
            }
          }
        }
      }

      const summary = answers
        .map((a) => {
          if (a.kind === "chat") return `Q${a.questionIndex + 1}: [chat]`;
          if (a.kind === "multi") return `Q${a.questionIndex + 1}: ${a.selected?.join(", ")}`;
          return `Q${a.questionIndex + 1}: ${a.answer}`;
        })
        .join("; ");

      return {
        content: [{ type: "text", text: `User answers: ${summary}` }],
        details: { answers, cancelled: false },
      };
    },
  });

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

          const toolResponsesRaw = await ctx.ui.input(
            "Send tool responses to Discord? (yes/no, default: no):",
            existing?.toolResponses ? "yes" : "no",
          );
          const toolResponses = toolResponsesRaw?.trim().toLowerCase() === "yes";

          const cfg: Config = {
            token,
            guildId,
            ...(categoryId ? { categoryId } : {}),
            ...(allowedUserIds ? { allowedUserIds } : {}),
            reactions: true,
            toolResponses,
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
                  // Set to true to also post tool outputs/results after each tool call
                  toolResponses: false,
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
