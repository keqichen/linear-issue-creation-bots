// ───────────────────────────────────────────────────────────────
//  DISCORD adapter — react with 📌 (or send "!task ...") to turn a
//  message into a Linear issue.
//
//  Run:  node discord-bot.js
// ───────────────────────────────────────────────────────────────
import "dotenv/config";
import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import { initCore, triage, createIssue } from "./core.js";

const { DISCORD_TOKEN } = process.env;
const TRIGGER_EMOJI = "📌";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, async (c) => {
  const summary = await initCore();
  console.log(`Discord bot online as ${c.user.tag}. ${summary}`);
});

// ── Fetch surrounding context for a message ──────────────────────
async function gatherContext(msg, limit = 5) {
  const lines = [];

  if (msg.channel.isThread?.()) {
    try {
      const starter = await msg.channel.fetchStarterMessage();
      if (starter) lines.push(`[thread started by ${starter.author?.username}: "${starter.content}"]`);
    } catch { /* ignore */ }
  }

  if (msg.reference?.messageId) {
    try {
      const parent = await msg.channel.messages.fetch(msg.reference.messageId);
      lines.push(`[replying to ${parent.author?.username}: "${parent.content}"]`);
    } catch { /* ignore */ }
  }

  try {
    const before = await msg.channel.messages.fetch({ limit, before: msg.id });
    before
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .forEach((m) => lines.push(`${m.author?.username}: ${m.content}`));
  } catch { /* ignore */ }

  return lines.join("\n");
}

// ── Trigger 1: emoji reaction ────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== TRIGGER_EMOJI) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const msg = reaction.message;
  const context = await gatherContext(msg);
  await handle(msg.content, msg.author?.username, msg, context);
});

// ── Trigger 2: "!task ..." prefix ───────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!task")) return;
  const text = msg.content.replace(/^!task\s*/, "").trim() || msg.content;
  const context = await gatherContext(msg);
  await handle(text, msg.author.username, msg, context);
});

// ── Pipeline ─────────────────────────────────────────────────────
async function handle(text, author, msg, context = "") {
  if (!text) return;
  try {
    const draft = await triage(text, author, context);
    if (draft.tag !== "work") {
      await msg.react("🤷");
      return;
    }
    const issue = await createIssue(draft, text, author, msg.createdAt);
    await msg.reply(
      `📌 Created **${issue.identifier}** — ${draft.title}\n` +
      `Priority: ${draft.priority} · Owner: ${issue.resolvedAssignee || "unassigned"}\n${issue.url}`
    );
  } catch (e) {
    console.error("pipeline error:", e);
    await msg.reply(`⚠️ Couldn't create the issue: ${e.message}`);
  }
}

client.login(DISCORD_TOKEN);
