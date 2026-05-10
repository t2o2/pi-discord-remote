/**
 * Quick diagnostic: send a screenshot to the Discord channel directly.
 * Run: npx tsx extensions/diag-send.ts
 */
import { Client, GatewayIntentBits, Partials, type TextChannel } from "discord.js";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-discord-remote", "config.json");
const SCREENSHOT = process.argv[2] || 
  "/Users/chuanbai/.agent-browser/tmp/screenshots/screenshot-1778409658743.png";

async function main() {
  // Load config
  const raw = await readFile(CONFIG_FILE, "utf-8");
  const cfg = JSON.parse(raw);
  console.log("Config loaded:", { guildId: cfg.guildId, channelId: cfg.channelId, hasToken: !!cfg.token });

  // Connect
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Login timeout")), 10000);
    client.once("ready", () => { clearTimeout(timer); resolve(); });
    client.login(cfg.token).catch(reject);
  });
  console.log("Connected as:", client.user?.tag);

  // Find the session channel: look for channels matching pi-discord-remote-*
  const guild = await client.guilds.fetch(cfg.guildId);
  const channels = await guild.channels.fetch();
  const piChannels = channels.filter(
    (c) => c && "name" in c && (c as any).name?.startsWith("pi-discord-remote")
  );
  console.log("Pi channels found:", piChannels.map((c: any) => `${c.name} (${c.id})`));

  if (piChannels.size === 0) {
    console.error("No pi-discord-remote channels found in guild!");
    return;
  }

  // Use the first one (should be the only active one)
  const channel = piChannels.first() as TextChannel;
  console.log("Using channel:", channel.name, `(${channel.id})`);

  // Check if file exists
  try {
    await readFile(SCREENSHOT);
  } catch {
    console.error("Screenshot file not found:", SCREENSHOT);
    return;
  }

  // Send text + image
  const buffer = await readFile(SCREENSHOT);
  const filename = basename(SCREENSHOT);
  console.log("Sending file:", filename, `(${buffer.length} bytes)`);
  const msg = await channel.send({ 
    content: "🧪 Diagnostic test — can you see this screenshot?",
    files: [{ attachment: buffer, name: filename }] 
  });
  console.log("Sent! Message ID:", msg.id);

  await client.destroy();
  console.log("Done.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
