import { describe, it, expect } from "vitest";
import {
  makeChannelName,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
} from "../helpers.js";

// ─── makeChannelName ──────────────────────────────────────────────────────────

describe("makeChannelName", () => {
  it("uses the basename of cwd", () => {
    const name = makeChannelName("/home/user/my-project");
    expect(name).toMatch(/^my-project-/);
  });

  it("falls back to 'pi' for empty basename", () => {
    const name = makeChannelName("/");
    expect(name).toMatch(/^pi-/);
  });

  it("lowercases everything", () => {
    const name = makeChannelName("/path/MyApp");
    expect(name).toBe(name.toLowerCase());
  });

  it("replaces non-alphanumeric chars with dashes", () => {
    const name = makeChannelName("/path/hello world!");
    // Only a-z, 0-9, - and _ should remain
    expect(name).not.toContain(" ");
    expect(name).not.toContain("!");
  });

  it("collapses multiple dashes", () => {
    const name = makeChannelName("/path/foo---bar");
    expect(name).not.toContain("---");
    expect(name).not.toMatch(/--/);
  });

  it("trims leading/trailing dashes", () => {
    const name = makeChannelName("/path/-hello-");
    expect(name).not.toMatch(/^-|-$/);
  });

  it("truncates to 100 chars max", () => {
    const name = makeChannelName("/a/" + "x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("includes month+day+time in the suffix", () => {
    const name = makeChannelName("/my-project");
    // Should match pattern like "my-project-may18-1430"
    expect(name).toMatch(/^my-project-[a-z]{3}\d{2}-\d{4}$/);
  });
});

// ─── splitMessage ─────────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns a single chunk for short text", () => {
    const result = splitMessage("hello", 1900);
    expect(result).toEqual(["hello"]);
  });

  it("splits at newline boundaries when possible", () => {
    const line = "a".repeat(100);
    const text = `${line}\n${line}\n${line}`; // 302 chars
    const chunks = splitMessage(text, 150);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should start with content, not a bare newline
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\n/);
    }
  });

  it("hard-splits when no newline is found within maxLen", () => {
    const text = "a".repeat(300);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("reassembles to the original text", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 200);
    // Reassembly should be close — split strips leading newlines from chunk boundaries
    const reassembled = chunks.join("\n");
    // The text content should be preserved (newlines may differ slightly at boundaries)
    expect(reassembled.replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
  });

  it("handles empty string", () => {
    expect(splitMessage("", 1900)).toEqual([""]);
  });

  it("respects custom maxLen", () => {
    const text = "a".repeat(50);
    expect(splitMessage(text, 100)).toEqual([text]);
    expect(splitMessage(text, 10).length).toBeGreaterThan(1);
  });
});

// ─── toolLabel ────────────────────────────────────────────────────────────────

describe("toolLabel", () => {
  it("uses mapped emoji for known tools", () => {
    expect(toolLabel("bash", { command: "ls" })).toContain("🔧");
    expect(toolLabel("read", { path: "/foo" })).toContain("📄");
    expect(toolLabel("edit", { path: "/foo" })).toContain("✏️");
    expect(toolLabel("write", { path: "/foo" })).toContain("📝");
    expect(toolLabel("grep", { pattern: "TODO" })).toContain("🔍");
  });

  it("uses gear emoji for unknown tools", () => {
    expect(toolLabel("custom_tool", {})).toContain("⚙️");
  });

  it("shows command for bash", () => {
    const label = toolLabel("bash", { command: "npm test" });
    expect(label).toContain("`npm test`");
  });

  it("truncates long bash commands", () => {
    const longCmd = "x".repeat(200);
    const label = toolLabel("bash", { command: longCmd });
    expect(label).toContain("…");
    expect(label).not.toContain(longCmd);
  });

  it("shows path for read/write/edit", () => {
    expect(toolLabel("read", { path: "/src/index.ts" })).toContain("`/src/index.ts`");
    expect(toolLabel("write", { path: "/out.txt" })).toContain("`/out.txt`");
    expect(toolLabel("edit", { path: "/edit.ts" })).toContain("`/edit.ts`");
  });

  it("shows pattern and path for grep", () => {
    const label = toolLabel("grep", { pattern: "TODO", path: "/src" });
    expect(label).toContain("`TODO`");
    expect(label).toContain("`/src`");
  });

  it("shows path for find/ls", () => {
    expect(toolLabel("find", { path: "/home" })).toContain("`/home`");
  });

  it("formats as italic tool name", () => {
    const label = toolLabel("bash", { command: "echo hi" });
    expect(label).toContain("_bash_");
  });

  it("handles null/undefined args gracefully", () => {
    const label = toolLabel("bash", null);
    expect(label).toContain("🔧");
    expect(label).toContain("_bash_");
  });
});

// ─── isAbortLikeError ─────────────────────────────────────────────────────────

describe("isAbortLikeError", () => {
  it("detects 'aborted' in message", () => {
    expect(isAbortLikeError(new Error("Request aborted"))).toBe(true);
    expect(isAbortLikeError(new Error("aborted by user"))).toBe(true);
  });

  it("detects 'abort' in message", () => {
    expect(isAbortLikeError(new Error("Abort signal"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAbortLikeError(new Error("ABORTED"))).toBe(true);
    expect(isAbortLikeError(new Error("AbOrT"))).toBe(true);
  });

  it("returns false for non-abort errors", () => {
    expect(isAbortLikeError(new Error("Network timeout"))).toBe(false);
    expect(isAbortLikeError(new Error("File not found"))).toBe(false);
  });

  it("handles non-Error objects", () => {
    expect(isAbortLikeError("string error")).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(undefined)).toBe(false);
    expect(isAbortLikeError({})).toBe(false);
  });
});

// ─── sleep ────────────────────────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after the given duration", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow minor variance
  });

  it("resolves with undefined", async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("resolves when the promise finishes in time", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with timeout error when promise is too slow", async () => {
    const slow = new Promise(() => {}); // never resolves
    await expect(withTimeout(slow, 50, "slow_op")).rejects.toThrow("timeout:slow_op:50ms");
  });

  it("preserves the original rejection reason", async () => {
    const fail = new Promise((_resolve, reject) => reject(new Error("boom")));
    await expect(withTimeout(fail, 1000, "test")).rejects.toThrow("boom");
  });

  it("cleans up the timer on success", async () => {
    // Should not throw or leak — just verifies no unhandled timer
    await withTimeout(Promise.resolve("ok"), 10_000, "timer_cleanup");
  });
});
