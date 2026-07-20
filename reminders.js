// ── Daily deadline reminders ─────────────────────────────────────
// Runs at 9am UK time every day. Finds Linear issues due tomorrow (UK
// calendar day) and posts them to the "reminders" Discord channel.
import { linearPost, londonDateString } from "./core.js";

const { LINEAR_TEAM_ID } = process.env;

// Ms until the wall clock next reads 09:00 in Europe/London, regardless of
// what timezone the server itself is running in (Fly.io defaults to UTC).
function msUntilNext9am() {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/London",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const secondsSinceMidnight = (+parts.hour) * 3600 + (+parts.minute) * 60 + (+parts.second);
  let diffSeconds = 9 * 3600 - secondsSinceMidnight;
  if (diffSeconds <= 0) diffSeconds += 24 * 3600;
  return diffSeconds * 1000;
}

async function checkDeadlines(client) {
  const dueDate = londonDateString(new Date(Date.now() + 24 * 60 * 60 * 1000));

  const out = await linearPost(
    `query($filter: IssueFilter) {
      issues(filter: $filter) {
        nodes { identifier title url assignee { name } }
      }
    }`,
    {
      filter: {
        dueDate: { eq: dueDate },
        team: { id: { eq: LINEAR_TEAM_ID } },
        state: { type: { nin: ["completed", "canceled"] } },
      },
    }
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
