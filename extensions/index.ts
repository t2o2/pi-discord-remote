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
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import { loadConfig, saveConfig, CONFIG_FILE, defaultConfigTemplate } from "./config.js";
import type { Config } from "./config.js";
import { logEvent, readLog, logPath } from "./diagnostics.js";
import {
  makeChannelName,
  projectChannelName,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
  drainChunks,
  inboundAction,
} from "./helpers.js";

// ─── Reconnection constants ──────────────────────────────────────────────────
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

// ─── Extension ────────────────────────────────────────────────────────────────

// Connection state lives at module scope so `/reload` re-attaches to the live
// Discord client instead of starting a fresh, unconnected instance.
let client: Client | null = null;
let activeConfig: Config | null = null;
let runtime: {
  activeChannelId: string | null;
  sessionChannelName: string | null;
} = { activeChannelId: null, sessionChannelName: null };

export default function (pi: ExtensionAPI) {

  let agentBusy = false;
  let pendingReplyChannelId: string | null = null;
  let pendingReplyUserId: string | null = null;
  let lastImageArtifactPath: string | null = null;

  // ── Output-streaming state ────────────────────────────────────────────
  /** Latest ExtensionContext seen — used for Discord-side abort. */
  let lastCtx: any = null;
  const channelCache = new Map<string, TextChannel>();
  let lastPostedMessageId: string | null = null;
  let lastTextMessageId: string | null = null;
  let turnPosted = false;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  interface StreamBuf {
    messageId: string;
    sentThinking: number;
    sentText: number;
    pendingThinking: string;
    pendingText: string;
  }
  let streamBuf: StreamBuf | null = null;

  // ── Reconnection state ────────────────────────────────────────────────
  let reconnectAttempt = 0;
  let lastError: string | null = null;

  function noteError(kind: string, message: string): void {
    lastError = `${new Date().toISOString()} ${kind}: ${message}`;
    logEvent(kind, message);
    console.error(`[pi-discord-remote] ${kind}: ${message}`);
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  let reconnectFailed = false;
  // Captured at connect time so reconnect can reuse them
  let connectNotify: ((msg: string, level: "success" | "error" | "warning" | "info") => void) | null = null;
  let connectSetStatus: ((key: string, val: string | undefined) => void) | null = null;

  // ── Question-answering state (for overriding ask_user_question) ────────
  let questionResolver: ((answer: string) => void) | null = null;
  let questionRejecter: ((reason: Error) => void) | null = null;
  let questionChannelId: string | null = null;
  let questionTimeout: ReturnType<typeof setTimeout> | null = null;
  let questionAbortListener: (() => void) | null = null;
  let questionAbortSignal: AbortSignal | null = null;

  function clearQuestionState(): void {
    if (questionTimeout) {
      clearTimeout(questionTimeout);
      questionTimeout = null;
    }
    // Remove abort listener to prevent leak
    if (questionAbortListener && questionAbortSignal) {
      questionAbortSignal.removeEventListener("abort", questionAbortListener);
    }
    questionAbortListener = null;
    questionAbortSignal = null;
    questionResolver = null;
    questionRejecter = null;
    questionChannelId = null;
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  /** Where Pi output goes: the session channel, not just the last reply target. */
  function outputChannelId(): string | null {
    return runtime.activeChannelId || pendingReplyChannelId || activeConfig?.channelId || null;
  }

  async function getOutputChannel(): Promise<TextChannel | null> {
    const id = outputChannelId();
    if (!id || !client) return null;
    const cached = channelCache.get(id);
    // A cached channel is bound to the client that fetched it. After a reload,
    // reconnect or manual stop that client is destroyed, and using it throws
    // "Expected token to be set for this request". Refetch in that case.
    if (cached && cached.client === client) return cached;
    try {
      const channel = (await client.channels.fetch(id)) as TextChannel | null;
      if (channel?.isTextBased()) {
        channelCache.set(id, channel);
        return channel;
      }
    } catch (err) {
      noteError("channel_fetch_failed", String(err));
    }
    return null;
  }

  async function sendToActiveChannel(text: string): Promise<void> {
    if (!client || !outputChannelId()) return;
    try {
      const channel = await getOutputChannel();
      if (!channel) return;
      const msg = await channel.send(text);
      lastPostedMessageId = msg.id;
      turnPosted = true;
    } catch (err) {
      noteError("send_failed", String(err));
    }
  }

  function getTargetChannelId(overrideChannelId?: string): string | null {
    const override = overrideChannelId?.trim();
    return override || outputChannelId();
  }

  function chunkLimit(): number {
    const n = activeConfig?.chunkChars ?? 1900;
    return Math.min(1900, Math.max(500, n));
  }

  async function sendMessageViaDiscordRest(params: {
    channelId: string;
    token: string;
    content?: string;
    filename?: string;
    mediaType?: string;
    bytes?: Buffer;
  }): Promise<{ ok: boolean; error?: string }> {
    const url = `https://discord.com/api/v10/channels/${params.channelId}/messages`;
    const form = new FormData();

    if (params.bytes) {
      const fileName = params.filename ?? "image.png";
      const type = params.mediaType ?? "image/png";
      const payload = {
        content: params.content ?? "",
        attachments: [{ id: 0, filename: fileName }],
      };
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([new Uint8Array(params.bytes)], { type }), fileName);
    } else {
      form.append("content", params.content ?? "");
    }

    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${params.token}`,
        },
        body: form,
      }),
      20_000,
      "discord_rest_send",
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 404) return { ok: false, error: `unknown_channel:${params.channelId}` };
      return { ok: false, error: `discord_http_${resp.status}:${body.slice(0, 200)}` };
    }

    return { ok: true };
  }

  async function sendAttachmentToActiveChannel(params: {
    channelId?: string;
    path?: string;
    url?: string;
    base64?: string;
    mediaType?: string;
    filename?: string;
    caption?: string;
  }): Promise<{ ok: boolean; sentAs?: string; error?: string }> {
    const targetChannelId = getTargetChannelId(params.channelId);
    if (!client?.isReady()) {
      return { ok: false, error: "discord_not_connected" };
    }
    if (!targetChannelId) {
      return { ok: false, error: "no_active_channel" };
    }

    const sendOnce = async (): Promise<{ ok: boolean; sentAs?: string; error?: string }> => {
      const channel = (await withTimeout(
        client!.channels.fetch(targetChannelId),
        15_000,
        "fetch_channel",
      )) as TextChannel | null;
      if (!channel?.isTextBased()) return { ok: false, error: "channel_unavailable" };
      if (activeConfig?.guildId && "guildId" in channel && channel.guildId !== activeConfig.guildId) {
        return { ok: false, error: `wrong_guild:${targetChannelId}` };
      }

      const content = params.caption?.trim() || undefined;
      const token = activeConfig?.token?.trim();
      if (!token) return { ok: false, error: "missing_bot_token" };

      if (params.path) {
        const filePath = params.path.trim();
        if (!existsSync(filePath)) return { ok: false, error: `file_not_found:${filePath}` };
        const buffer = await withTimeout(readFile(filePath), 5_000, "read_file");
        const name = params.filename?.trim() || basename(filePath);
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType: "image/png",
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_path_failed" };
        return { ok: true, sentAs: "path" };
      }

      if (params.url) {
        const body = content ? `${content}\n${params.url.trim()}` : params.url.trim();
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content: body,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_url_failed" };
        return { ok: true, sentAs: "url" };
      }

      if (params.base64) {
        const mediaType = params.mediaType?.trim() || "image/png";
        const ext = mediaType.split("/")[1] ?? "png";
        const buffer = Buffer.from(params.base64.trim(), "base64");
        const name = params.filename?.trim() || `image.${ext}`;
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType,
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_base64_failed" };
        return { ok: true, sentAs: "base64" };
      }

      return { ok: false, error: "missing_source" };
    };

    const toError = (err: any): string => {
      const msg = String(err?.message ?? "send_failed");
      const code = String(err?.code ?? "");
      if (code === "10003" || msg.toLowerCase().includes("unknown channel")) {
        return `unknown_channel:${targetChannelId}`;
      }
      return msg;
    };

    try {
      return await sendOnce();
    } catch (err: any) {
      if (isAbortLikeError(err)) {
        try {
          await sleep(300);
          return await sendOnce();
        } catch (retryErr: any) {
          return { ok: false, error: toError(retryErr) };
        }
      }
      return { ok: false, error: toError(err) };
    }
  }

  // ── Output pipeline: stream everything to the session channel ─────────

  function streamEnabled(): boolean {
    return activeConfig?.stream !== false;
  }

  function thinkingText(content: any[]): string {
    return content
      .filter((c) => c.type === "thinking" && typeof c.thinking === "string")
      .map((c) => c.thinking as string)
      .join("");
  }

  function plainText(content: any[]): string {
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
  }

  async function postThinking(chunk: string): Promise<void> {
    if (!chunk.trim()) return;
    for (const part of splitMessage(`💭 ${chunk.trim()}`)) await sendToActiveChannel(part);
  }

  async function postText(chunk: string): Promise<void> {
    if (!chunk.trim()) return;
    for (const part of splitMessage(chunk)) {
      await sendToActiveChannel(part);
      lastTextMessageId = lastPostedMessageId;
    }
  }

  function getStreamBuf(messageId: string): StreamBuf {
    if (!streamBuf || streamBuf.messageId !== messageId) {
      streamBuf = { messageId, sentThinking: 0, sentText: 0, pendingThinking: "", pendingText: "" };
    }
    return streamBuf;
  }

  function startTypingIndicator(): void {
    if (activeConfig?.typing === false) return;
    stopTypingIndicator();
    typingTimer = setInterval(async () => {
      const channel = await getOutputChannel();
      channel?.sendTyping().catch(() => {});
    }, 8000);
  }

  function stopTypingIndicator(): void {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any, ctx: any) => {
    lastCtx = ctx ?? lastCtx;
    agentBusy = true;
    streamBuf = null;
    lastPostedMessageId = null;
    lastTextMessageId = null;
    turnPosted = false;
    lastImageArtifactPath = null;
    startTypingIndicator();
  });

  // Mirror prompts typed locally in the TUI so the remote view stays in sync.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("input", async (event: any, ctx: any) => {
    lastCtx = ctx ?? lastCtx;
    if (event.source !== "interactive") return { action: "continue" };
    if (!client || !outputChannelId() || activeConfig?.mirrorLocalInput === false) {
      return { action: "continue" };
    }
    const text = (event.text ?? "").trim();
    if (!text || text.startsWith("/")) return { action: "continue" };
    await sendToActiveChannel(`🖥️ ${text.slice(0, 1900)}`);
    return { action: "continue" };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result", async (event: any) => {
    // Capture latest browser image artifact path for follow-up discord_send_image calls.
    if (event.toolName === "agent_browser") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const artifacts: any[] = event.details?.artifacts ?? [];
      for (const artifact of artifacts) {
        if (artifact?.kind === "image") {
          const candidate = artifact.absolutePath ?? artifact.path;
          if (candidate && existsSync(candidate)) {
            lastImageArtifactPath = candidate;
          }
        }
      }
    }

    if (!client || !outputChannelId()) return;

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
  pi.on("message_update", async (event: any, ctx: any) => {
    lastCtx = ctx ?? lastCtx;
    if (!client || !outputChannelId() || !streamEnabled()) return;
    const message = event.message;
    if (message?.role !== "assistant") return;

    const buf = getStreamBuf(message.id);
    const content = message.content as any[];
    const thinking = thinkingText(content);
    const text = plainText(content);

    if (activeConfig?.thinking !== false && thinking.length > buf.sentThinking) {
      buf.pendingThinking += thinking.slice(buf.sentThinking);
      buf.sentThinking = thinking.length;
      const { chunks, rest } = drainChunks(buf.pendingThinking, chunkLimit(), false);
      buf.pendingThinking = rest;
      for (const chunk of chunks) await postThinking(chunk);
    }

    if (text.length > buf.sentText) {
      buf.pendingText += text.slice(buf.sentText);
      buf.sentText = text.length;
      const { chunks, rest } = drainChunks(buf.pendingText, chunkLimit(), false);
      buf.pendingText = rest;
      for (const chunk of chunks) await postText(chunk);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    if (!client || !outputChannelId()) return;
    if (activeConfig?.toolCalls === false) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any, ctx: any) => {
    lastCtx = ctx ?? lastCtx;
    if (!client || !outputChannelId()) return;
    const message = event.message;
    if (message?.role !== "assistant") return;

    const content = message.content as Array<any>;

    if (streamEnabled() && streamBuf && streamBuf.messageId === message.id) {
      const buf = streamBuf;
      const thinking = drainChunks(buf.pendingThinking, chunkLimit(), true);
      buf.pendingThinking = thinking.rest;
      for (const chunk of thinking.chunks) await postThinking(chunk);

      const text = drainChunks(buf.pendingText, chunkLimit(), true);
      buf.pendingText = text.rest;
      for (const chunk of text.chunks) await postText(chunk);
      streamBuf = null;
      return;
    }

    if (activeConfig?.thinking !== false) await postThinking(thinkingText(content));
    await postText(plainText(content));
    streamBuf = null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (_event: any, ctx: any) => {
    lastCtx = ctx ?? lastCtx;
    agentBusy = false;
    streamBuf = null;
    stopTypingIndicator();

    if (!client) return;

    // Tag the user on the final response (not on thinking/tool chunks).
    const mentionUser = pendingReplyUserId || activeConfig?.allowedUserIds?.[0] || null;
    if (activeConfig?.mention !== false && mentionUser && lastTextMessageId) {
      try {
        const channel = await getOutputChannel();
        const msg = channel ? await channel.messages.fetch(lastTextMessageId) : null;
        const prefix = `<@${mentionUser}> `;
        if (msg && msg.content.length + prefix.length <= 2000) {
          await msg.edit(prefix + msg.content);
        } else {
          await sendToActiveChannel(`✅ <@${mentionUser}>`);
        }
      } catch (err) {
        logEvent("mention_failed", String(err));
      }
    }

    // Signal end of turn: react ✅ on the last posted message of this turn.
    if (activeConfig?.reactions !== false && lastPostedMessageId && turnPosted) {
      try {
        const channel = await getOutputChannel();
        const msg = channel ? await channel.messages.fetch(lastPostedMessageId) : null;
        if (msg) await msg.react("✅");
      } catch (err) {
        logEvent("reaction_failed", String(err));
      }
    } else if (pendingReplyUserId) {
      await sendToActiveChannel(`✅ done <@${pendingReplyUserId}>`);
    }
    pendingReplyUserId = null;
  });

  // ── Cleanup helper ───────────────────────────────────────────────────────

  async function deleteSessionChannel(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (!client || !runtime.activeChannelId) return;
    if (activeConfig?.keepChannel || (activeConfig?.channelMode ?? "project") === "project") {
      console.error(
        `[pi-discord-remote] Keeping channel #${runtime.sessionChannelName ?? runtime.activeChannelId} (persistent mode).`,
      );
      return;
    }
    try {
      const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
      if (channel) await channel.delete("Pi session ended");
    } catch (err) {
      noteError("channel_delete_failed", String(err));
    }
    channelCache.delete(runtime.activeChannelId);
    lastPostedMessageId = null;
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    setStatusFn("pi-discord-remote", undefined);
  }

  // ── Reconnect logic ────────────────────────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    reconnectAttempt++;

    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[pi-discord-remote] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`,
      );
      reconnectFailed = true;
      logEvent("reconnect_gave_up", `after ${RECONNECT_MAX_ATTEMPTS} attempts`);
      connectNotify?.(
        `❌ Discord reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote start to retry.`,
        "error",
      );
      connectSetStatus?.("pi-discord-remote", "❌ Discord: reconnect failed");
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, … up to 60s
    const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 1_000;
    const delay = baseDelay + jitter;

    logEvent("reconnect_attempt", `${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`);
    console.log(
      `[pi-discord-remote] Reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    connectSetStatus?.("pi-discord-remote", `🔄 Discord: reconnecting (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`);

    reconnectTimer = setTimeout(async () => {
      if (isShuttingDown) return;
      await attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (!activeConfig) return;

    // Destroy the old client if it still exists
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
      channelCache.clear();
    }

    const cfg = activeConfig;
    const notify = connectNotify ?? ((_m: string, _l: any) => {});
    const setStatus = connectSetStatus ?? ((_k: string, _v: any) => {});

    console.log("[pi-discord-remote] Reconnecting to Discord…");

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    attachAbortReactionListener(client);
    client.on("error", (err) => {
      noteError("client_error", err?.message ?? String(err));
      setStatus("pi-discord-remote", "⚠️ Discord: error");
    });
    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      logEvent("gateway_disconnect", "socket dropped during reconnect, retrying");
      setStatus("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    try {
      await client.login(cfg.token);
      // Wait for ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ready timeout")), 30_000);
        client!.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Successfully reconnected — restore channel reference
      reconnectAttempt = 0;
      const channelLabel = runtime.sessionChannelName ?? runtime.activeChannelId ?? "unknown";
      console.log(`[pi-discord-remote] Reconnected successfully → #${channelLabel}`);
      notify(`✅ Discord reconnected → #${channelLabel}`, "success");
      setStatus("pi-discord-remote", `🔌 Discord: #${channelLabel}`);

      // Post a notice in the channel so the user knows we're back
      if (runtime.activeChannelId) {
        try {
          const ch = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (ch?.isTextBased()) {
            await ch.send("🔌 _Reconnected — ready for commands._").catch(() => {});
          }
        } catch {
          // Channel may have been deleted — that's fine
        }
      }
    } catch (err: any) {
      noteError("reconnect_failed", err.message);
      scheduleReconnect();
    }
  }

  function buildMessageHandler() {
    return async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      if (message.channelId !== runtime.activeChannelId) return;

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
        const resolve = questionResolver;
        resolve(message.content);
        return;
      }

      // A bare "🛑" (or :stop:) sent as a message also aborts the running turn.
      const normalized = message.content.trim().toLowerCase();
      if (normalized === "🛑" || normalized === ":stop:" || normalized === "stop") {
        if (!agentBusy) {
          await message.reply("Nothing is running to abort.").catch(() => {});
          return;
        }
        if (lastCtx?.abort) {
          logEvent("abort", "abort requested from Discord stop message");
          lastCtx.abort();
          await message.react("🛑").catch(() => {});
        } else {
          await message.reply("⚠️ Abort context not available.").catch(() => {});
        }
        return;
      }

      const action = inboundAction(agentBusy, activeConfig.steering !== false);

      if (action === "reject") {
        await message.reply("⏳ Still processing the previous message — please wait.").catch(() => {});
        return;
      }

      if (action === "steer") {
        // Steering: inject into the running turn instead of rejecting.
        try {
          await pi.sendUserMessage(message.content, { deliverAs: "steer" });
          if (activeConfig.reactions !== false) {
            await message.react("📥").catch(() => {});
          }
        } catch (err: any) {
          await message.reply(`❌ Steering failed: ${err.message}`).catch(() => {});
        }
        return;
      }

      if (activeConfig.reactions !== false) {
        await message.react("⏳").catch(() => {});
      }

      pendingReplyChannelId = message.channelId;
      pendingReplyUserId = message.author.id;
      pi.sendUserMessage(message.content);
    };
  }

  // 🛑 on any bot message in the session channel aborts the running turn.
  function attachAbortReactionListener(c: Client): void {
    c.on("messageReactionAdd", async (reaction, user) => {
      if (user.bot || reaction.emoji.name !== "🛑") return;
      if (reaction.message.channelId !== runtime.activeChannelId) return;
      if (
        activeConfig?.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(user.id)
      ) {
        return;
      }
      if (!agentBusy) return;
      if (lastCtx?.abort) {
        logEvent("abort", "abort requested from Discord reaction");
        lastCtx.abort();
      }
    });
  }

  // ── Session cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async (event: any) => {
    // Reject any pending question so tool execution doesn't hang
    if (questionRejecter) {
      questionRejecter(new Error("Session shut down"));
    }
    clearQuestionState();
    clearReconnectTimer();
    isShuttingDown = true;
    logEvent("session_shutdown", `reason=${event?.reason ?? "unknown"}`);
    // Don't destroy Discord client on reload — just re-register handlers
    if (event?.reason === "reload") {
      isShuttingDown = false;
      channelCache.clear();
      return;
    }
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      channelCache.clear();
      activeConfig = null;
      runtime.activeChannelId = null;
      runtime.sessionChannelName = null;
    }
  });

  // Auto-connect removed — user must run /pi-discord-remote start explicitly.

  // ── Connect + channel-create helper ──────────────────────────────────────

  async function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    activeConfig = cfg;

    if (client?.isReady()) {
      // Reload: re-attach the new instance's handlers to the live client.
      client.removeAllListeners("messageCreate");
      client.removeAllListeners("messageReactionAdd");
      client.on("messageCreate", buildMessageHandler());
      attachAbortReactionListener(client);
      notifyFn(
        `Re-attached to Discord #${runtime.sessionChannelName ?? runtime.activeChannelId}`,
        "success",
      );
      setStatusFn(
        "pi-discord-remote",
        `🔌 Discord: #${runtime.sessionChannelName ?? runtime.activeChannelId ?? "(fallback)"}`,
      );
      return;
    }

    isShuttingDown = false;
    reconnectAttempt = 0;
    reconnectFailed = false;
    clearReconnectTimer();

    // Capture closures for reconnect reuse
    connectNotify = notifyFn;
    connectSetStatus = setStatusFn;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    attachAbortReactionListener(client);

    // ── Reconnection handling (for post-connect disconnects only) ──────
    client.on("error", (err) => {
      noteError("client_error", err?.message ?? String(err));
      setStatusFn("pi-discord-remote", "⚠️ Discord: error");
    });

    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      logEvent("gateway_disconnect", "socket dropped, starting reconnect");
      setStatusFn("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // ── Await login + ready so we can surface immediate errors ─────────
    // Register the ready listener BEFORE login to avoid a race window
    // where ready fires before the Promise is constructed.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ready timeout (30s)")), 30_000);
      client!.once("ready", async (c) => {
        clearTimeout(timeout);
        // Channel selection happens inside this single ready handler
        const mode = cfg.channelMode ?? "project";
        const projectKey = projectChannelName(cwd);
        try {
          const guild = await c.guilds.fetch(cfg.guildId);
          let channel: TextChannel | null = null;

          if (mode === "project") {
            const knownId = cfg.projectChannels?.[projectKey];
            if (knownId) {
              try {
                const fetched = (await c.channels.fetch(knownId)) as TextChannel | null;
                if (fetched?.isTextBased()) channel = fetched;
              } catch { /* stale mapping — recreate below */ }
            }
            if (!channel) {
              channel =
                (guild.channels.cache.find(
                  (ch) => ch.name === projectKey && ch.type === ChannelType.GuildText,
                ) as TextChannel | null) ?? null;
            }
            if (!channel) {
              channel = await guild.channels.create({
                name: projectKey,
                type: ChannelType.GuildText,
                ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
                topic: `Pi sessions — ${cwd}`,
              });
            }
            await saveConfig({
              ...cfg,
              projectChannels: { ...(cfg.projectChannels ?? {}), [projectKey]: channel.id },
            }).catch(() => {});
          } else {
            channel = await guild.channels.create({
              name: makeChannelName(cwd),
              type: ChannelType.GuildText,
              ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
              topic: `Pi session — ${cwd}`,
            });
          }

          runtime.activeChannelId = channel.id;
          runtime.sessionChannelName = channel.name;

          const label = `🔌 Discord: #${channel.name}`;
          logEvent(
            "connect",
            `connected as ${c.user.tag} channel=#${channel.name} id=${channel.id} mode=${mode}`,
          );
          notifyFn(`Connected as ${c.user.tag} → #${channel.name}`, "success");
          setStatusFn("pi-discord-remote", label);
        } catch (err) {
          // Channel selection failed — fall back to configured channelId
          noteError("channel_select_failed", String(err));
          notifyFn(
            `⚠️ Could not select channel (check Manage Channels permission). Falling back to configured channelId.`,
            "warning",
          );
          runtime.activeChannelId = cfg.channelId ?? null;
          setStatusFn("pi-discord-remote", `🔌 Discord: ${c.user.tag} (fallback)`);
        }
        resolve();
      });
    });

    try {
      setStatusFn("pi-discord-remote", "🔌 Discord: connecting…");
      await client.login(cfg.token);
      await readyPromise;
    } catch (err: any) {
      // Initial login failure — clean up and notify immediately
      noteError("login_failed", err.message);
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      connectNotify = null;
      connectSetStatus = null;
      notifyFn(`❌ Failed to connect: ${err.message}`, "error");
      setStatusFn("pi-discord-remote", undefined);
    }
  }

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    // Only block the TUI tool when the Discord path can actually be used,
    // otherwise both tools refuse and the agent deadlocks.
    if (client?.isReady() && (pendingReplyChannelId || outputChannelId())) {
      return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
    }
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!client?.isReady()) return;
    const activeChannelId = runtime.activeChannelId ?? activeConfig?.channelId;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        (activeChannelId
          ? `Active Discord session channel ID: ${activeChannelId}. ` +
            "When using discord_send_image, pass this as channelId.\n\n"
          : "") +
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
      // pendingReplyChannelId is only set when a Discord message started the turn.
      // For locally started turns fall back to the project/session channel.
      const channelId = pendingReplyChannelId ?? outputChannelId();
      if (!client?.isReady()) {
        return {
          content: [
            {
              type: "text",
              text: "Discord gateway is not ready. Use ask_user_question (TUI) instead.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }
      if (!channelId) {
        return {
          content: [
            {
              type: "text",
              text: "No Discord channel is bound to this session. Use ask_user_question (TUI) instead.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_channel" },
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
              if (signal.aborted) {
                onAbort();
                return;
              }
              questionAbortListener = onAbort;
              questionAbortSignal = signal;
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

  // ── Tool: discord_send_image (opt-in; no automatic forwarding) ──────────
  pi.registerTool({
    name: "discord_send_image",
    label: "Send Image To Discord",
    description:
      "Send a single image to the active Discord session channel. " +
      "Use only when the user explicitly asks to send an image. " +
      "Provide exactly one source: local file path, URL, or base64.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      base64: Type.Optional(Type.String()),
      mediaType: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const normalized = { ...params };
      let provided = [normalized.path, normalized.url, normalized.base64].filter(Boolean).length;
      if (provided === 0 && lastImageArtifactPath) {
        normalized.path = lastImageArtifactPath;
        provided = 1;
      }

      if (provided !== 1) {
        return {
          content: [{ type: "text", text: "Provide exactly one image source: path, url, or base64." }],
          details: { ok: false, error: "invalid_source_count" },
        };
      }

      let result: { ok: boolean; sentAs?: string; error?: string };
      try {
        result = await withTimeout(
          sendAttachmentToActiveChannel(normalized),
          30_000,
          "discord_send_image_total",
        );
      } catch (err: any) {
        const msg = String(err?.message ?? "send_failed");
        result = { ok: false, error: msg };
      }
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send image to Discord: ${result.error}` }],
          details: result,
        };
      }

      return {
        content: [{ type: "text", text: `Image sent to Discord (${result.sentAs}).` }],
        details: result,
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
            toolCalls: true,
            stream: true,
            thinking: true,
            steering: true,
            mirrorLocalInput: true,
            typing: true,
            chunkChars: 1900,
            keepChannel: existing?.keepChannel ?? false,
            autoConnect: existing?.autoConnect ?? false,
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
          await startClient(
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
          isShuttingDown = true;
          clearReconnectTimer();
          reconnectAttempt = 0;
          reconnectFailed = false;
          await deleteSessionChannel((key, val) => ctx.ui.setStatus(key, val));
          await client.destroy().catch(() => {});
          client = null;
          channelCache.clear();
          activeConfig = null;
          runtime.activeChannelId = null;
          runtime.sessionChannelName = null;
          connectNotify = null;
          connectSetStatus = null;
          streamBuf = null;
          turnPosted = false;
          lastPostedMessageId = null;
          lastTextMessageId = null;
          ctx.ui.setStatus("pi-discord-remote", undefined);
          logEvent("disconnect", "manual /pi-discord-remote stop");
          ctx.ui.notify("Disconnected from Discord.", "info");
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status": {
          if (client?.isReady()) {
            ctx.ui.notify(
              `✅ Connected as ${client.user.tag}\n` +
                `   Channel: #${runtime.sessionChannelName ?? runtime.activeChannelId ?? "(fallback)"}\n` +
                `   Channel ID: ${runtime.activeChannelId ?? "(unknown)"}\n` +
                `   Output target: ${outputChannelId() ?? "(none)"}\n` +
                `   Mode: ${activeConfig?.channelMode ?? "project"}\n` +
                `   Gateway ready: ${client.isReady()}\n` +
                `   Last posted message: ${lastPostedMessageId ?? "(none)"}\n` +
                `   Last error: ${lastError ?? "none"}\n` +
                `   Allow-list: ${activeConfig?.allowedUserIds?.join(", ") || "everyone"}`,
              "info",
            );
          } else if (client) {
            ctx.ui.notify("⏳ Connecting…", "info");
          } else if (reconnectTimer) {
            ctx.ui.notify(
              `🔄 Reconnecting (attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`,
              "info",
            );
          } else if (reconnectFailed) {
            ctx.ui.notify(
              `❌ Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote stop then start to retry.`,
              "error",
            );
          } else {
            ctx.ui.notify("❌ Not connected. Run /pi-discord-remote start.", "info");
          }
          break;
        }

        // ── abort ─────────────────────────────────────────────────────────
        case "abort": {
          if (!agentBusy) {
            ctx.ui.notify("Nothing is running.", "info");
            return;
          }
          ctx.abort();
          ctx.ui.notify("Aborted the current turn.", "info");
          break;
        }

        // ── debug ─────────────────────────────────────────────────────────
        case "debug": {
          const n = Math.min(200, Math.max(1, parseInt(parts[1] ?? "30", 10) || 30));
          const lines = readLog(n);
          ctx.ui.notify(
            lines.length
              ? `📄 ${logPath()} (last ${lines.length})\n${lines.join("\n")}`
              : `📄 No diagnostics logged yet (${logPath()})`,
            "info",
          );
          break;
        }

        // ── open-config ───────────────────────────────────────────────────
        case "open-config": {
          const raw = existsSync(CONFIG_FILE)
            ? await readFile(CONFIG_FILE, "utf-8")
            : defaultConfigTemplate();

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
              "/pi-discord-remote abort       — abort the running turn",
              "/pi-discord-remote debug [n]   — show the last n diagnostic log lines",
              "/pi-discord-remote open-config — edit config JSON",
              "Config options: steering, thinking, stream, toolCalls, mirrorLocalInput, typing, chunkChars, mention, channelMode (project|session), keepChannel, autoConnect",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });

  // ── Optional auto-connect (headless / RPC / --print sessions) ───────────
  void (async () => {
    const cfg = await loadConfig();
    if (!cfg?.autoConnect) return;
    await startClient(
      cfg,
      process.cwd(),
      (msg, level) => console.error(`[pi-discord-remote] ${level}: ${msg}`),
      () => {},
    );
  })();
}
