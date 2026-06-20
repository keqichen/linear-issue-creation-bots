// ── Shared judgment core ─────────────────────────────────────────
// Imported by discord-bot.js and notion-bot.js.
// Contains: Claude triage, Linear issue creation, description templates.
import "dotenv/config";

const { ANTHROPIC_API_KEY, LINEAR_API_KEY, LINEAR_TEAM_ID } = process.env;

export const TEAM = {
  Lee: { owns: "engine, ue5, physics, performance, build/CI, UE5 widget/UI implementation, screen ratios, canvas scaling", linearId: "2f995dc1-3685-4ac3-a46a-a781e91b19b4" },
  Keqi: { owns: "gameplay, UI design/UX, level design, asset, art",                                                        linearId: "966ee016-50da-48cb-82e9-26d9ddc9d5b0" },
};

const PRIORITY_MAP = { high: 2, med: 3, low: 4 };

const LEE_REGRESSION = [
  "- [ ] I can progress a dialogue and choose an option by mouse.",
  "- [ ] I can progress a dialogue and choose an option by keyboard.",
  "- [ ] I can open Inventory by clicking Inventory button.",
  "- [ ] I can open Inventory by pressing Tab key.",
].join("\n");

// ── Module state (populated by initCore) ────────────────────────
let ENDLESS_SUMMER_ID = null;
let LABEL_MAP = {};

// ── Linear helpers ───────────────────────────────────────────────
export async function linearPost(query, variables) {
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Authorization": LINEAR_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

async function resolveProject(name) {
  const out = await linearPost(
    `query($filter: ProjectFilter) { projects(filter: $filter) { nodes { id name } } }`,
    { filter: { name: { eq: name } } }
  );
  return out.data?.projects?.nodes?.[0]?.id ?? null;
}

async function resolveLabels() {
  const out = await linearPost(
    `query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`,
    { teamId: LINEAR_TEAM_ID }
  );
  const nodes = out.data?.team?.labels?.nodes ?? [];
  return Object.fromEntries(nodes.map((l) => [l.name, l.id]));
}

// Call once at startup. Returns a log-friendly summary string.
export async function initCore() {
  [ENDLESS_SUMMER_ID, LABEL_MAP] = await Promise.all([
    resolveProject("Endless Summer"),
    resolveLabels(),
  ]);
  return `Project: ${ENDLESS_SUMMER_ID ?? "not found"} · Labels: ${Object.keys(LABEL_MAP).join(", ") || "none"}`;
}

// ── Description builder ──────────────────────────────────────────
export function buildDescription(context, acs, originalText, author, assignee, timestamp) {
  const acLines = acs.map((ac, i) => `**AC${i + 1}**: ${ac}`).join("\n");
  const ts = timestamp ? ` at ${timestamp.toUTCString()}` : "";
  const ref = `> From ${author}${ts}: "${originalText.slice(0, 400)}"`;
  const isLee = assignee === "Lee";
  return [
    "## Context",
    context,
    "\n## ACs",
    acLines,
    ...(isLee ? ["\n## Regression", LEE_REGRESSION] : []),
    "\n## Original Reference",
    ref,
  ].join("\n");
}

// ── Claude triage ────────────────────────────────────────────────
export async function triage(text, author, context = "") {
  const team = Object.entries(TEAM).map(([n, v]) => `- ${n}: ${v.owns}`).join("\n");
  const contextBlock = context ? `\nConversation context (most recent last):\n${context}\n` : "";
  const labelList = Object.keys(LABEL_MAP).join(", ") || "none";

  const prompt = `You triage chat messages for a small game-dev team and draft Linear issues.

Team and what they own:
${team}

Available labels: ${labelList}
${contextBlock}
Message (from ${author}): "${text}"

Classify:
- "work": a concrete actionable task (verb + specific thing)
- "idea": a musing / "what if" — not yet actionable
- "chat": small talk

If "work", first decide the task type:
- "design": output is a Figma file, mockup, or design decision
- "dev": output is working in-game behaviour
- "art": output is an asset (model, texture, animation, audio)
- "other": anything else

Then produce:
- title: imperative, max 8 words
- context: 1-2 sentences framed around the player's experience (what the player sees, does, or expects). Be concise.
- acs: 1-3 acceptance criteria matched to the task type:
  - design → deliverable-focused (e.g. "A Figma screen shows dialogue options beneath the previous line.")
  - dev → player-behaviour-focused (e.g. "The player can open the inventory by pressing Tab.")
  - art → asset-focused (e.g. "The idle animation loops cleanly in-engine.")
- priority: high/med/low
- assignee: named person if mentioned, else infer from who owns the relevant area, else null
- labels: array of label names from the available list that best fit. Empty array if none fit.

Return JSON only, no markdown fences:
{"tag":"work|idea|chat","type":"design|dev|art|other","title":"...","context":"...","acs":["..."],"priority":"high|med|low","assignee":"name or null","labels":[]}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}`);
  const data = await r.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  return JSON.parse(raw.slice(s, e + 1));
}

// ── Linear issue creation ────────────────────────────────────────
export async function createIssue(draft, src, author, timestamp) {
  const resolvedAssignee = TEAM[draft.assignee] ? draft.assignee : "Lee";
  const assigneeId = TEAM[resolvedAssignee].linearId;
  const labelIds = (draft.labels ?? []).map((name) => LABEL_MAP[name]).filter(Boolean);
  const description = buildDescription(draft.context || "", draft.acs || [], src, author, resolvedAssignee, timestamp);

  const query = `
    mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`;
  const input = {
    teamId: LINEAR_TEAM_ID,
    title: draft.title,
    description,
    priority: PRIORITY_MAP[draft.priority] ?? 3,
    ...(assigneeId && !assigneeId.includes("_") ? { assigneeId } : {}),
    ...(ENDLESS_SUMMER_ID ? { projectId: ENDLESS_SUMMER_ID } : {}),
    ...(labelIds.length ? { labelIds } : {}),
    stateId: "5800d11a-0d62-4905-b761-46a895feaaea",
  };

  const out = await linearPost(query, { input });
  if (out.errors) throw new Error(JSON.stringify(out.errors));
  return out.data.issueCreate.issue;
}
