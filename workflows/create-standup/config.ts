// Dates are worked out in this timezone, both for "today's" Azure DevOps
// activity and for the standup page's Date property.
export const TIME_ZONE = "Europe/London";

// The page sections, matched case-insensitively as part of any heading, so
// "Blocker" matches "Blockers/issues".
export const SECTIONS = {
  done: "What have I done",
  todo: "To-do",
  blockers: "Blocker",
} as const;

// Checkbox property on the Standups database. The job ticks it once a page
// is filled and skips pages where it's already ticked, so re-runs (local or
// on GitHub) never add things twice. Untick it to fill a page again.
export const SUMMARY_ADDED_PROPERTY = "Summary added";

export const AI_MODEL = "gemini-2.5-flash";

// A work item counts as blocked if it's in this state or has this tag.
// Only your own items in the current sprint count, and finished items are
// ignored even if they still carry the tag.
export const BLOCKED_STATE = "Blocked";
export const BLOCKED_TAG = "Blocked";
export const FINISHED_STATES = ["Closed", "Done", "Removed"];
// How many of a ticket's latest comments are shown to the AI.
export const RECENT_COMMENTS_PER_ITEM = 3;

// GitHub often starts scheduled runs hours late, sometimes after midnight.
// A scheduled run summarises the day it was due on, found by looking back
// this many hours from when it actually starts.
export const SCHEDULED_RUN_LOOKBACK_HOURS = 12;

// Notion applies templates asynchronously after the page is created, so a
// new page's blocks are polled until the headings show up.
export const TEMPLATE_WAIT = { retries: 20, delayMs: 1500 };
