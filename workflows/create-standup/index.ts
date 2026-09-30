import 'dotenv/config';
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
// Utils
import { createAIClient, type AIClient } from "utils/ai";
import { createNotionClient } from "utils/notion";
import { logger } from "utils/logger";
// Workflow
import { SCHEDULED_RUN_LOOKBACK_HOURS, SECTIONS, SUMMARY_ADDED_PROPERTY, TEMPLATE_WAIT } from "./config";
import { createAzureDevOpsClient, type TicketStatus } from "./azureDevOps";
import { summarizeActivity } from "./summarize";
import { planBlockers, ticketIds } from "./blockers";
import {
  appendToSection,
  findLatestPageOnOrBefore,
  findOrCreateStandupPage,
  findPagesByDate,
  getDataSourceId,
  isSummaryAdded,
  markSummaryAdded,
  readSection,
  textToRichText,
  type NewItem,
  type Section,
  type WaitOptions,
} from "./standupPage";
import { isValidIsoDate, nextWorkingDay, normalizeLine, toLocalIsoDate } from "./utils";

const PRIVATE_INTEGRATION_TOKEN = process.env.PRIVATE_INTEGRATION_TOKEN;
const DATABASE_ID = process.env.STANDUPS_DATABASE_ID;
const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Optional: summarise a past day instead of today (YYYY-MM-DD).
const ACTIVITY_DATE = process.env.ACTIVITY_DATE || undefined;
// Optional: read everything and log what would be added, without writing
// to Notion.
const DRY_RUN = process.env.DRY_RUN === "true";
// Set by GitHub Actions: "schedule" for the nightly cron run.
const IS_SCHEDULED_RUN = process.env.GITHUB_EVENT_NAME === "schedule";

if (!PRIVATE_INTEGRATION_TOKEN) {
  logger.error("PRIVATE_INTEGRATION_TOKEN is not defined");
  process.exit(1);
}

if (!DATABASE_ID) {
  logger.error("STANDUPS_DATABASE_ID is not defined");
  process.exit(1);
}

if (!ADO_ORG) {
  logger.error("ADO_ORG is not defined");
  process.exit(1);
}

if (!ADO_PROJECT) {
  logger.error("ADO_PROJECT is not defined");
  process.exit(1);
}

if (!ADO_PAT) {
  logger.error("ADO_PAT is not defined");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  logger.error("GEMINI_API_KEY is not defined");
  process.exit(1);
}

if (ACTIVITY_DATE && !isValidIsoDate(ACTIVITY_DATE)) {
  logger.error(`ACTIVITY_DATE must be a YYYY-MM-DD date, got "${ACTIVITY_DATE}"`);
  process.exit(1);
}

const notion = createNotionClient(PRIVATE_INTEGRATION_TOKEN);
const ai: AIClient = await createAIClient();
const azureDevOps = createAzureDevOpsClient({ org: ADO_ORG, project: ADO_PROJECT, pat: ADO_PAT });

const EMPTY_SECTION: Section = { lines: [], blanks: [], parentId: "", insertAfterId: null };
const NO_WAIT: WaitOptions = { retries: 1, delayMs: 0 };

const titleFor = (isoDate: string): string => {
  const [, month, day] = isoDate.split("-");
  return `Standup ${day}/${month}`;
};

const pageTitle = (page: PageObjectResponse): string => {
  const name = page.properties.Name;
  return name?.type === "title" ? name.title.map((t: { plain_text: string }) => t.plain_text).join("") : page.id;
};

// Today, except for a scheduled run, which summarises the day it was due on
// even if GitHub starts it after midnight. An evening run due at 21:07 that
// starts at 01:54 still counts as the previous day.
const defaultActivityDate = (): string => {
  const lookbackMs = IS_SCHEDULED_RUN ? SCHEDULED_RUN_LOOKBACK_HOURS * 60 * 60 * 1000 : 0;
  return toLocalIsoDate(new Date(Date.now() - lookbackMs));
};

const logPlanned = (heading: string, items: NewItem[]): void => {
  logger.info(`"${heading}": ${items.length} item(s) to add`);
  for (const item of items) {
    const box = item.type === "to_do" ? (item.checked ? "[x] " : "[ ] ") : "- ";
    logger.info(`    ${box}${item.richText.map((t) => t.text.content).join("")}`);
  }
};

const readTargetSection = async (page: PageObjectResponse | undefined, heading: string, wait: WaitOptions) => {
  if (!page) return EMPTY_SECTION;
  const section = await readSection(notion, page.id, heading, wait);
  if (!section) throw new Error(`Heading containing "${heading}" not found on "${pageTitle(page)}"`);
  return section;
};

// Fills the standup page for the day after the activity date:
//   - "What have I done": the day's Azure DevOps summary, as ticked to-dos,
//     leaving out anything already written there by hand.
//   - "To-do": unticked to-dos carried over from the previous standup.
//   - "Blockers": the previous standup's blockers that are still open, plus
//     new ones from blocked tickets and comments.
// Items go after anything already in each section. Returns an error if the
// Azure DevOps or AI step failed; the carry-overs are still added then, but
// the page isn't marked as done, so a re-run can add the summary. In a dry
// run, `page` may not exist yet, and nothing is written either way.
const fillStandupPage = async (
  dataSourceId: string,
  page: PageObjectResponse | undefined,
  created: boolean,
  activityDate: string,
  dryRun: boolean
): Promise<Error | undefined> => {
  const wait = created ? TEMPLATE_WAIT : NO_WAIT;
  const target = {
    done: await readTargetSection(page, SECTIONS.done, wait),
    todo: await readTargetSection(page, SECTIONS.todo, NO_WAIT),
    blockers: await readTargetSection(page, SECTIONS.blockers, NO_WAIT),
  };

  const previousPage = await findLatestPageOnOrBefore(notion, dataSourceId, activityDate);
  let previousTodos: Section = EMPTY_SECTION;
  let previousBlockers: Section = EMPTY_SECTION;
  if (previousPage) {
    logger.info(`Carrying over from "${pageTitle(previousPage)}"`);
    previousTodos = (await readSection(notion, previousPage.id, SECTIONS.todo, NO_WAIT)) ?? EMPTY_SECTION;
    previousBlockers = (await readSection(notion, previousPage.id, SECTIONS.blockers, NO_WAIT)) ?? EMPTY_SECTION;
  } else {
    logger.skip(`No standup on or before ${activityDate} to carry over from`);
  }

  // Unticked to-dos, skipping any already on the target page.
  const targetTodoKeys = new Set(target.todo.lines.map((l) => normalizeLine(l.text)));
  const todoItems: NewItem[] = previousTodos.lines
    .filter((l) => l.checked === false && !targetTodoKeys.has(normalizeLine(l.text)))
    .map((l) => ({ type: "to_do", richText: l.richText, checked: false }));

  let doneItems: NewItem[] = [];
  let blockerItems: NewItem[];
  let stepError: Error | undefined;
  try {
    const activity = await azureDevOps.getActivity(activityDate);
    const blockedItems = await azureDevOps.getBlockedItems();
    const tickets = new Map<number, TicketStatus>(blockedItems.map((t) => [t.id, t]));
    const referenced = previousBlockers.lines.flatMap((l) => ticketIds(l.text)).filter((id) => !tickets.has(id));
    for (const [id, status] of await azureDevOps.getTicketStatuses(referenced)) tickets.set(id, status);

    const bullets = await summarizeActivity(ai, activity, target.done.lines.map((l) => l.text));
    doneItems = bullets.map((text) => ({ type: "to_do", richText: textToRichText(text), checked: true }));

    const plan = await planBlockers(ai, {
      previous: previousBlockers.lines.map((l) => l.text),
      existing: target.blockers.lines.map((l) => l.text),
      blockedItems,
      tickets,
      activity,
    });
    blockerItems = [
      ...plan.carried.map((i): NewItem => ({ type: "bulleted_list_item", richText: previousBlockers.lines[i].richText })),
      ...plan.added.map((text): NewItem => ({ type: "bulleted_list_item", richText: textToRichText(text) })),
    ];
  } catch (err) {
    stepError = err instanceof Error ? err : new Error(String(err));
    logger.error("Azure DevOps or AI step failed, so only carry-overs will be added", stepError);
    // Without Azure DevOps, blockers can't be checked, so carry them all.
    const targetBlockerKeys = new Set(target.blockers.lines.map((l) => normalizeLine(l.text)));
    blockerItems = previousBlockers.lines
      .filter((l) => !targetBlockerKeys.has(normalizeLine(l.text)))
      .map((l) => ({ type: "bulleted_list_item", richText: l.richText }));
  }

  logPlanned(SECTIONS.done, doneItems);
  logPlanned(SECTIONS.todo, todoItems);
  logPlanned(SECTIONS.blockers, blockerItems);

  if (dryRun || !page) {
    logger.skip("Dry run, so nothing was written to Notion");
    return stepError;
  }

  await appendToSection(notion, target.done, doneItems);
  await appendToSection(notion, target.todo, todoItems);
  await appendToSection(notion, target.blockers, blockerItems);
  if (stepError) {
    logger.alert(`Left "${SUMMARY_ADDED_PROPERTY}" unticked so a re-run can add the summary`);
  } else {
    await markSummaryAdded(notion, page.id);
    logger.success(`Filled "${pageTitle(page)}" and ticked "${SUMMARY_ADDED_PROPERTY}"`);
  }
  return stepError;
};

const run = async (): Promise<void> => {
  const activityDate = ACTIVITY_DATE ?? defaultActivityDate();
  const targetDate = nextWorkingDay(activityDate);
  const cleanSlateDate = nextWorkingDay(targetDate);
  logger.info(
    `Filling "${titleFor(targetDate)}" with activity from ${activityDate}, ` +
      `and making sure "${titleFor(cleanSlateDate)}" exists${DRY_RUN ? " (dry run)" : ""}`
  );

  const dataSourceId = await getDataSourceId(notion, DATABASE_ID);
  let fillError: Error | undefined;

  // 1. The page for the day after the activity, which you may have been
  //    adding to by hand. A dry run only reads it.
  let page: PageObjectResponse | undefined;
  let created = false;
  if (DRY_RUN) {
    page = (await findPagesByDate(notion, dataSourceId, targetDate))[0];
    logger.info(page ? `Found "${pageTitle(page)}"` : `"${titleFor(targetDate)}" doesn't exist yet and would be created`);
  } else {
    ({ page, created } = await findOrCreateStandupPage(notion, dataSourceId, titleFor(targetDate), targetDate));
    logger.success(`${created ? "Created" : "Found"} "${pageTitle(page)}": ${page.url}`);
  }

  if (page && isSummaryAdded(page)) {
    logger.skip(`"${pageTitle(page)}" already has its summary ("${SUMMARY_ADDED_PROPERTY}" is ticked). Untick it to fill the page again.`);
  } else {
    fillError = await fillStandupPage(dataSourceId, page, created, activityDate, DRY_RUN);
  }

  // 2. A clean page for the working day after, ready to add to by hand.
  if (DRY_RUN) {
    const exists = (await findPagesByDate(notion, dataSourceId, cleanSlateDate)).length > 0;
    logger.info(`"${titleFor(cleanSlateDate)}" ${exists ? "already exists" : "would be created as a clean page"}`);
  } else {
    const next = await findOrCreateStandupPage(notion, dataSourceId, titleFor(cleanSlateDate), cleanSlateDate);
    logger.success(`${next.created ? "Created clean page" : "Found"} "${pageTitle(next.page)}": ${next.page.url}`);
  }

  if (fillError) {
    throw new Error(`Standup summary step failed: ${fillError.message}`);
  }
};

try {
  await run();
} catch (err) {
  logger.error("Unexpected error", err instanceof Error ? err : undefined);
  process.exit(1);
}
