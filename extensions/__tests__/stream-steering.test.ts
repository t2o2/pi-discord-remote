import { describe, it, expect } from "vitest";
import { drainChunks, inboundAction, projectChannelName } from "../helpers.js";

// ─── drainChunks: streaming output into Discord-sized pieces ─────────────────

describe("drainChunks", () => {
  it("buffers text below the chunk limit", () => {
    const { chunks, rest } = drainChunks("short answer", 1900, false);
    expect(chunks).toEqual([]);
    expect(rest).toBe("short answer");
  });

  it("emits a chunk once the limit is crossed and keeps the remainder", () => {
    const text = "a".repeat(2000);
    const { chunks, rest } = drainChunks(text, 1900, false);
    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(1900);
    expect(rest).toBe("a".repeat(100));
  });

  it("prefers a paragraph boundary over a mid-paragraph cut", () => {
    const para = "x".repeat(900);
    const text = `${para}\n\n${para}\n\n${para}`;
    const { chunks, rest } = drainChunks(text, 1000, false);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n\n")).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
    expect(chunks.join("") + rest).toBe(text);
  });

  it("does not emit a boundary cut when it is too early (<40% of limit)", () => {
    const text = "a\n\n" + "b".repeat(997);
    const { chunks, rest } = drainChunks(text, 1000, false);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text.slice(0, 1000));
    expect(rest).toBe(text.slice(1000));
  });

  it("force-flushes the remainder at the end of a message", () => {
    const { chunks, rest } = drainChunks("tail text", 1900, true);
    expect(chunks).toEqual(["tail text"]);
    expect(rest).toBe("");
  });

  it("emits nothing for whitespace-only remainder when forcing", () => {
    const { chunks } = drainChunks("   \n\n  ", 1900, true);
    expect(chunks).toEqual([]);
  });
});

describe("projectChannelName", () => {
  it("slugifies the project directory into a stable channel name", () => {
    expect(projectChannelName("/media/user/Dev/repos/gtr2-recompile")).toBe("gtr2-recompile");
    expect(projectChannelName("/home/user/Temp (weird) [x]")).toBe("temp-weird-x");
    expect(projectChannelName("/")).toBe("pi");
  });

  it("has no date/time so the same project reuses one channel", () => {
    const a = projectChannelName("/home/user/Temp");
    const b = projectChannelName("/home/user/Temp");
    expect(a).toBe(b);
    expect(a).toBe("temp");
  });
});

describe("inboundAction", () => {
  it("queues a normal turn when Pi is idle", () => {
    expect(inboundAction(false, true)).toBe("queue");
    expect(inboundAction(false, false)).toBe("queue");
  });

  it("steers into a running turn when steering is enabled", () => {
    expect(inboundAction(true, true)).toBe("steer");
  });

  it("rejects inbound messages when steering is disabled", () => {
    expect(inboundAction(true, false)).toBe("reject");
  });
});
