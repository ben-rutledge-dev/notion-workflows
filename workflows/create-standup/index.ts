import 'dotenv/config';
// Utils
import { createAIClient, type AIClient } from "utils/ai";
import { createNotionClient } from "utils/notion";
import { logger } from "utils/logger";
// Workflow
import { SCHEDULED_RUN_LOOKBACK_HOURS, SECTION_HEADING, TEMPLATE_WAIT } from "./config";
import { createAzureDevOpsClient } from "./azureDevOps";
import { summarizeActivity } from "./summarize";
import { fillSectionIfEmpty, findOrCreateStandupPage, getDataSourceId } from "./standupPage";
import { isValidIsoDate, nextWorkingDay, toLocalIsoDate } from "./utils";

const PRIVATE_INTEGRATION_TOKEN = process.env.PRIVATE_INTEGRATION_TOKEN;
const DATABASE_ID = process.env.STANDUPS_DATABASE_ID;
const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Optional: summarise a past day instead of today (YYYY-MM-DD).
const ACTIVITY_DATE = process.env.ACTIVITY_DATE || undefined;
// Optional: print the summary without touching Notion.
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

// Today, except for a scheduled run, which summarises the day it was due on
// even if GitHub starts it after midnight. An evening run due at 21:07 that
// starts at 01:54 still counts as the previous day.
const defaultActivityDate = (): string => {
  const lookbackMs = IS_SCHEDULED_RUN ? SCHEDULED_RUN_LOOKBACK_HOURS * 60 * 60 * 1000 : 0;
  return toLocalIsoDate(new Date(Date.now() - lookbackMs));
};

const run = async (): Promise<void> => {
  const activityDate = ACTIVITY_DATE ?? defaultActivityDate();
  const standupDate = nextWorkingDay(activityDate);
  const [, month, day] = standupDate.split("-");
  const title = `Standup ${day}/${month}`;
  logger.info(`Summarising activity from ${activityDate} into "${title}" (${standupDate})${DRY_RUN ? " as a dry run" : ""}`);

  // The summary is best-effort: if it fails, the page is still created, and
  // the run is marked as failed at the end so the failure isn't missed.
  let bullets: string[] = [];
  let summaryError: Error | undefined;
  try {
    const activity = await azureDevOps.getActivity(activityDate);
    bullets = await summarizeActivity(ai, activity);
    logger.info(`Summarised into ${bullets.length} bullet(s)`);
    for (const bullet of bullets) logger.info(`  - ${bullet}`);
  } catch (err) {
    summaryError = err instanceof Error ? err : new Error(String(err));
    logger.error("Azure DevOps summary step failed", summaryError);
  }

  if (DRY_RUN) {
    logger.skip("Dry run, so Notion was not touched");
  } else {
    const dataSourceId = await getDataSourceId(notion, DATABASE_ID);
    const { page, created } = await findOrCreateStandupPage(notion, dataSourceId, title, standupDate);
    logger.success(`${created ? "Created" : "Reusing existing page"} "${title}": ${page.url}`);

    if (bullets.length > 0) {
      // A new page's template is applied asynchronously, so wait for it.
      // An existing page already has its content.
      const wait = created ? TEMPLATE_WAIT : { retries: 1, delayMs: 0 };
      const result = await fillSectionIfEmpty(notion, page.id, SECTION_HEADING, bullets, wait);
      if (result === "filled") {
        logger.success(`Added ${bullets.length} bullet(s) under "${SECTION_HEADING}"`);
      } else {
        logger.skip(`"${SECTION_HEADING}" section already has content, left it alone`);
      }
    } else if (!summaryError) {
      logger.skip("No Azure DevOps activity to add");
    }
  }

  if (summaryError) {
    throw new Error(`Azure DevOps summary step failed: ${summaryError.message}`);
  }
};

try {
  await run();
} catch (err) {
  logger.error("Unexpected error", err instanceof Error ? err : undefined);
  process.exit(1);
}
