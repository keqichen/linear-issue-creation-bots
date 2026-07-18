// ── Daily deadline reminders ─────────────────────────────────────
// Runs at 9am (server local time) every day. Finds Linear issues due
// tomorrow and posts them to the "reminders" Discord channel.
import { linearPost } from "./core.js";

const { LINEAR_TEAM_ID } = process.env;

function msUntilNext9am() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function checkDeadlines(client) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);

  const out = await linearPost(
    `query($filter: IssueFilter) {
      issues(filter: $filter) {
        nodes { identifier title url assignee { name } }
      }
    }`,
    { filter: { dueDate: { eq: dueDate }, team: { id: { eq: LINEAR_TEAM_ID } } } }
  );

  const issues = out.data?.issues?.nodes ?? [];
  if (!issues.length) return;

  const channel = client.channels.cache.find((c) => c.name === "reminders");
  if (!channel) {
    console.warn("reminders: channel not found");
    return;
  }

  const lines = issues.map(
    (i) => `📅 **${i.identifier}** — ${i.title}  ·  ${i.assignee?.name ?? "unassigned"}\n${i.url}`
  );
  await channel.send(`⏰ **Due tomorrow (${dueDate})**\n\n${lines.join("\n\n")}`);
}

export function startDeadlineReminders(client) {
  function schedule() {
    const delay = msUntilNext9am();
    console.log(`Deadline reminders: next check in ${Math.round(delay / 60000)} min`);
    setTimeout(() => {
      checkDeadlines(client).catch((e) => console.error("reminder error:", e));
      schedule();
    }, delay);
  }
  schedule();
}
