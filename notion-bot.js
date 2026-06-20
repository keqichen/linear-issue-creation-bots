// ───────────────────────────────────────────────────────────────
//  NOTION adapter — #task in a comment triggers a Linear issue.
//  Notion replies to the same comment thread with the issue link.
//
//  Setup (one-time):
//    1. notion.so/profile/integrations → New integration
//       Capabilities: Read comments, Insert comments, Read content
//    2. Share the root page with your integration (child pages inherit)
//    3. Add a webhook: integration settings → Add webhook
//       URL: https://<your-ngrok-url>/notion-webhook
//       Events: comment.created
//    4. Copy the signing secret → NOTION_SIGNING_SECRET in .env
//
//  Run:
//    npx ngrok http 3000        (copy the https URL → paste into Notion webhook)
//    node notion-bot.js
// ───────────────────────────────────────────────────────────────
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { initCore, triage, createIssue } from "./core.js";

const { NOTION_TOKEN, NOTION_SIGNING_SECRET } = process.env;
const TRIGGER_TAG = "#task";
const PORT = process.env.PORT || 3000;

// ── Notion API helpers ───────────────────────────────────────────
const NOTION_HEADERS = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

async function notionGet(path) {
  const r = await fetch(`https://api.notion.com/v1${path}`, { headers: NOTION_HEADERS });
  return r.json();
}

async function notionPost(path, body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method: "POST",
    headers: NOTION_HEADERS,
    body: JSON.stringify(body),
  });
  return r.json();
}

function richTextToPlain(richText = []) {
  return richText.map((b) => b.plain_text ?? b.text?.content ?? "").join("");
}

// Reply in the same Notion comment thread with plain text.
async function replyComment(discussionId, text) {
  return notionPost("/comments", {
    discussion_id: discussionId,
    rich_text: [{ type: "text", text: { content: text } }],
  });
}

// Reply with the Linear issue as an inline link.
async function replyIssueLink(discussionId, issue, draft) {
  return notionPost("/comments", {
    discussion_id: discussionId,
    rich_text: [
      { type: "text", text: { content: "📌 Created " } },
      { type: "text", text: { content: `${issue.identifier} — ${draft.title}`, link: { url: issue.url } } },
      { type: "text", text: { content: `\nPriority: ${draft.priority} · Owner: ${draft.assignee || "unassigned"}` } },
    ],
  });
}

// ── Context gathering ────────────────────────────────────────────
async function gatherNotionContext(pageId, parentBlockId, currentCommentId) {
  const lines = [];

  // 1. Page title
  try {
    const page = await notionGet(`/pages/${pageId}`);
    const titleProp = Object.values(page.properties ?? {}).find((p) => p.type === "title");
    const title = richTextToPlain(titleProp?.title ?? []);
    if (title) lines.push(`[Notion page: "${title}"]`);
  } catch { /* ignore */ }

  // 2. The block text being commented on
  try {
    const block = await notionGet(`/blocks/${parentBlockId}`);
    const blockText = richTextToPlain(block[block.type]?.rich_text ?? []);
    if (blockText) lines.push(`[Commented on: "${blockText}"]`);
  } catch { /* ignore */ }

  // 3. Previous comments in the same thread (excluding the current one)
  try {
    const res = await notionGet(`/comments?block_id=${parentBlockId}`);
    const prior = (res.results ?? []).filter((c) => c.id !== currentCommentId);
    for (const c of prior) {
      const author = c.created_by?.name ?? "someone";
      const text = richTextToPlain(c.rich_text);
      if (text) lines.push(`${author}: ${text}`);
    }
  } catch { /* ignore */ }

  return lines.join("\n");
}

// ── Webhook signature verification ──────────────────────────────
function verifySignature(req) {
  if (!NOTION_SIGNING_SECRET) return true;
  const sig = req.headers["x-notion-signature"] ?? "";
  const expected = "sha256=" + crypto
    .createHmac("sha256", NOTION_SIGNING_SECRET)
    .update(req.rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Express server ───────────────────────────────────────────────
const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.post("/notion-webhook", async (req, res) => {
  if (!verifySignature(req)) return res.status(401).send("Invalid signature");

  // Notion sends a verification challenge on first registration.
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  if (req.body.type !== "comment.created") return res.sendStatus(200);

  res.sendStatus(200); // acknowledge immediately; process async

  const commentId = req.body.entity?.id;
  const pageId    = req.body.data?.page_id;
  const blockId   = req.body.data?.parent?.id ?? pageId;

  if (!commentId || !pageId) return;

  // Fetch the full comment to get its text and discussion_id.
  let comment;
  try {
    const res2 = await notionGet(`/comments?block_id=${blockId}`);
    comment = (res2.results ?? []).find((c) => c.id === commentId);
  } catch (e) {
    console.error("Failed to fetch comment:", e);
    return;
  }

  if (!comment) return;

  const text = richTextToPlain(comment.rich_text);
  if (!text.toLowerCase().includes(TRIGGER_TAG)) return;

  const discussionId = comment.discussion_id;
  const authorId     = req.body.authors?.[0]?.id;
  let author = "Notion user";
  if (authorId) {
    try {
      const u = await notionGet(`/users/${authorId}`);
      author = u.name ?? author;
    } catch { /* ignore */ }
  }
  const timestamp    = comment.created_time ? new Date(comment.created_time) : new Date();
  const cleanText    = text.replace(new RegExp(TRIGGER_TAG, "gi"), "").trim();

  // Gather page + thread context for Claude.
  const context = await gatherNotionContext(pageId, blockId, commentId);

  try {
    const draft = await triage(cleanText, author, context);
    if (draft.tag !== "work") {
      await replyComment(discussionId, "💭 Noted — doesn't look like an actionable task yet.");
      return;
    }
    const issue = await createIssue(draft, cleanText, `Notion (${author})`, timestamp);
    await replyIssueLink(discussionId, issue, draft);
  } catch (e) {
    console.error("pipeline error:", e);
    await replyComment(discussionId, `⚠️ Couldn't create the issue: ${e.message}`);
  }
});

app.listen(PORT, async () => {
  const summary = await initCore();
  console.log(`Notion bot listening on :${PORT}. ${summary}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/notion-webhook`);
});
