import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_DISCORD_LOG_DIR = join(tmpdir(), `pdr-log-${process.pid}`);

describe("diagnostics", () => {
  it("appends timestamped events and reads them back", async () => {
    const { logEvent, readLog, logPath } = await import("../diagnostics.js");
    logEvent("send_failed", "boom");
    logEvent("gateway_disconnect", "socket dropped");

    const lines = readLog(10);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[send_failed\] boom$/);
    expect(lines[1]).toMatch(/\[gateway_disconnect\] socket dropped$/);
    expect(logPath().endsWith("diagnostics.log")).toBe(true);
  });

  it("caps the number of returned lines", async () => {
    const { logEvent, readLog } = await import("../diagnostics.js");
    for (let i = 0; i < 20; i++) logEvent("ping", `ping-${i}`);
    const lines = readLog(5);
    expect(lines.length).toBe(5);
    expect(lines[lines.length - 1]).toContain("ping-19");
  });

  it("returns an empty array when no log exists", async () => {
    process.env.PI_DISCORD_LOG_DIR = join(tmpdir(), `pdr-log-empty-${process.pid}-${Date.now()}`);
    const { readLog } = await import("../diagnostics.js");
    expect(readLog()).toEqual([]);
  });
});
