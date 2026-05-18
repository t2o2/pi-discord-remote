/**
 * Shared helpers for pi-discord-remote.
 */

import { basename } from "node:path";

/** Generate a Discord-safe channel name from cwd + short date + time (HH-MM). */
export function makeChannelName(cwd: string): string {
  const dir = basename(cwd) || "pi";
  const now = new Date();
  const month = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const raw = `${dir}-${month}${day}-${hh}${mm}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Count how many unmatched ``` fences precede a position in the text. */
function countOpenFences(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`" && text.slice(i, i + 3) === "```") {
      count++;
      i += 3;
    } else if (text[i] === "`") {
      // skip inline backticks — they don't affect fence state
      while (i < text.length && text[i] === "`") i++;
    } else {
      i++;
    }
  }
  return count;
}

/** Extract the info string (e.g. language) from an opening ``` fence line. */
function fenceInfo(text: string): string {
  // "```ts" → "ts", "```" → ""
  const match = text.match(/^```(\S*)/);
  return match ? match[1] ?? "" : "";
}

/** Find the info string of the most recent opening ``` fence before pos. */
function lastFenceInfo(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].trimStart();
    if (stripped.startsWith("```")) {
      const info = fenceInfo(stripped);
      // If there's content after ``` on the same line (not just info), it's a opening fence
      // We count it as opening regardless — countOpenFences determines parity
      return info;
    }
  }
  return "";
}

/** Split a string into ≤maxLen chunks, preferring newline boundaries.
 *  Preserves fenced code blocks (```) across chunk boundaries by closing
 *  and reopening them. */
export function splitMessage(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      // Close any unclosed fence in the final chunk
      if (countOpenFences(remaining) % 2 === 1) {
        chunks.push(remaining + "\n```");
      } else {
        chunks.push(remaining);
      }
      break;
    }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    const chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\n/, "");

    // Close any open code fence at the end of this chunk
    if (countOpenFences(chunk) % 2 === 1) {
      const info = lastFenceInfo(chunk);
      chunks.push(chunk + "\n```");
      // Reopen the fence at the start of the next chunk
      remaining = "```" + info + "\n" + remaining;
    } else {
      chunks.push(chunk);
    }
  }
  return chunks;
}

/**
 * Build a Discord-friendly label for a tool invocation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolLabel(toolName: string, args: any): string {
  const emojis: Record<string, string> = {
    bash: "🔧",
    read: "📄",
    edit: "✏️",
    write: "📝",
    grep: "🔍",
    find: "🔎",
    ls: "📁",
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

export function isAbortLikeError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? "").toLowerCase();
  return msg.includes("aborted") || msg.includes("abort");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
