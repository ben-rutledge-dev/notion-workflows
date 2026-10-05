// Utils
import type { AIClient } from "utils/ai";
// Workflow
import { BLOCKED_STATE } from "./config";
import { askForJson, bulletList, loadPrompt, stringList } from "./gemini";
import { describeActivity, MAX_LINE_LENGTH } from "./summarize";
import { normalizeLine } from "./utils";
// Types
import type { TicketStatus, WorkItemActivity } from "./azureDevOps";

export interface BlockerInputs {
  // Blockers on the previous standup, in their original wording.
  previous: string[];
  // Blockers already on the page being filled.
  existing: string[];
  // Your tickets that are currently blocked, by state or tag.
  blockedItems: TicketStatus[];
  // Current status of every ticket the previous blockers mention.
  tickets: Map<number, TicketStatus>;
  activity: WorkItemActivity[];
}

export interface BlockerPlan {
  // Indexes into `previous` of blockers to carry over word for word.
  carried: number[];
  // New blocker lines to add.
  added: string[];
}

export const ticketIds = (text: string): number[] =>
  [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

const describeTicket = (t: TicketStatus): string => {
  const lines = [`  #${t.id} [${t.type}] "${t.title}": state ${t.state}${t.tags.length ? `, tags ${t.tags.join(", ")}` : ""}`];
  for (const comment of t.recentComments) lines.push(`    latest comment: ${comment}`);
  return lines.join("\n");
};

// Previous blockers are carried over without asking the AI when they can't
// be checked (no ticket number) or a ticket they name is still blocked. The
// AI judges the rest, and suggests new blockers from the Azure DevOps data.
// Every blocked ticket ends up mentioned, whatever the AI says.
export const planBlockers = async (ai: AIClient, inputs: BlockerInputs): Promise<BlockerPlan> => {
  const { previous, existing, blockedItems, tickets, activity } = inputs;
  const existingKeys = new Set(existing.map(normalizeLine));

  const carried: number[] = [];
  const undecided: number[] = [];
  previous.forEach((text, index) => {
    if (existingKeys.has(normalizeLine(text))) return;
    const ids = ticketIds(text);
    const known = ids.map((id) => tickets.get(id)).filter((t): t is TicketStatus => Boolean(t));
    if (ids.length === 0 || known.length === 0 || known.some((t) => t.blocked)) {
      carried.push(index);
    } else {
      undecided.push(index);
    }
  });

  let added: string[] = [];
  if (undecided.length > 0 || blockedItems.length > 0 || activity.length > 0) {
    const earlier = undecided
      .map((index) => {
        const details = ticketIds(previous[index])
          .map((id) => tickets.get(id))
          .filter((t): t is TicketStatus => Boolean(t))
          .map(describeTicket);
        return [`[${index}] ${previous[index]}`, ...details].join("\n");
      })
      .join("\n\n");

    const prompt = await loadPrompt("blockers-prompt.md", {
      EARLIER: earlier || "(none)",
      CURRENT: bulletList([...existing, ...carried.map((i) => previous[i])]),
      BLOCKED: blockedItems.length > 0 ? blockedItems.map(describeTicket).join("\n") : "(none)",
      ACTIVITY: describeActivity(activity),
    });
    const reply = await askForJson(ai, prompt);

    const stillOpen = Array.isArray(reply.stillOpen) ? reply.stillOpen : [];
    for (const index of undecided) {
      if (stillOpen.includes(index)) carried.push(index);
    }
    added = stringList(reply, "newBlockers", MAX_LINE_LENGTH);
  }

  // Make sure every blocked ticket is mentioned somewhere.
  const allText = [...existing, ...carried.map((i) => previous[i]), ...added].join("\n");
  for (const item of blockedItems) {
    if (!ticketIds(allText).includes(item.id)) {
      const how = item.state.toLowerCase() === BLOCKED_STATE.toLowerCase() ? "is blocked" : "is tagged Blocked";
      added.push(`#${item.id} ${how}`);
    }
  }

  // Drop repeats: lines already on the page or being carried over, and new
  // lines whose tickets all already have a blocker line of their own.
  const seen = new Set([...existingKeys, ...carried.map((i) => normalizeLine(previous[i]))]);
  const coveredIds = new Set(ticketIds([...existing, ...carried.map((i) => previous[i])].join("\n")));
  added = added.filter((line) => {
    const key = normalizeLine(line);
    const ids = ticketIds(line);
    if (seen.has(key) || (ids.length > 0 && ids.every((id) => coveredIds.has(id)))) return false;
    seen.add(key);
    for (const id of ids) coveredIds.add(id);
    return true;
  });

  carried.sort((a, b) => a - b);
  return { carried, added };
};
