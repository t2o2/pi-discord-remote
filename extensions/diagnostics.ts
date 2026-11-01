/**
 * Diagnostics for pi-discord-remote.
 *
 * Everything that can go wrong with the Discord connection (login failures,
 * gateway disconnects, reconnect attempts, rate-limit/send failures, mention
 * or reaction errors) is appended to a timestamped log file so it can be
 * inspected after the fact, even when the TUI scrollback is gone.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

function logDir(): string {
  return process.env.PI_DISCORD_LOG_DIR?.trim() || CONFIG_DIR;
}

function logFile(): string {
  return join(logDir(), "diagnostics.log");
}

/** Append a timestamped event line. Never throws. */
export function logEvent(kind: string, message: string): void {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(logFile(), `${new Date().toISOString()} [${kind}] ${message}\n`);
  } catch (err) {
    console.error("[pi-discord-remote] diagnostics write failed:", (err as Error).message);
  }
}

/** Return the last `limit` log lines (empty array if no log exists). */
export function readLog(limit = 40): string[] {
  try {
    const lines = readFileSync(logFile(), "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

export function logPath(): string {
  return logFile();
}
