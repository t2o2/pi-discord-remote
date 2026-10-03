import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../index.js";

// A Discord client whose login fails before the gateway ever reports ready.
vi.mock("discord.js", () => {
  class Client {
    on() {
      return this;
    }
    once() {
      return this;
    }
    login() {
      return Promise.reject(new Error("An invalid token was provided."));
    }
    destroy() {
      return Promise.resolve();
    }
  }
  const enumStub = new Proxy({}, { get: (_target, key) => String(key) });
  return { Client, ChannelType: enumStub, GatewayIntentBits: enumStub, Partials: enumStub };
});

// pi provides typebox at runtime; the extension only uses it to describe tool schemas.
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));

vi.mock("../config.js", () => ({
  CONFIG_FILE: "/dev/null",
  loadConfig: async () => ({ token: "bad-token", guildId: "1" }),
  saveConfig: async () => {},
  defaultConfigTemplate: () => "{}",
}));

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

/** Load the extension against a stub pi API and return the /pi-discord-remote handler. */
function loadCommandHandler(): CommandHandler {
  let handler: CommandHandler | undefined;
  const registerCommand = (_name: string, def: { handler: CommandHandler }) => {
    handler = def.handler;
  };
  const pi = new Proxy({ registerCommand } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? (() => {}),
  });
  extension(pi as never);
  if (!handler) throw new Error("extension did not register /pi-discord-remote");
  return handler;
}

describe("/pi-discord-remote start when login fails", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports the error and leaves no unhandled rejection once the ready timeout passes", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const notify = vi.fn();
      await loadCommandHandler()("start", {
        cwd: "/tmp/project",
        ui: { notify, setStatus: () => {} },
      });
      expect(notify).toHaveBeenCalledWith("❌ Failed to connect: An invalid token was provided.", "error");

      // Past the 30 s ready timeout; an unhandled rejection here terminates pi.
      await vi.advanceTimersByTimeAsync(31_000);
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
