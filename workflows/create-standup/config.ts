// Dates are worked out in this timezone, both for "today's" Azure DevOps
// activity and for the standup page's Date property.
export const TIME_ZONE = "Europe/London";

// The page section the summary goes into. Matched as a substring of any
// heading, so "What have I done since yesterday" matches.
export const SECTION_HEADING = "What have I done";

export const AI_MODEL = "gemini-2.5-flash";

// GitHub often starts scheduled runs hours late, sometimes after midnight.
// A scheduled run summarises the day it was due on, found by looking back
// this many hours from when it actually starts.
export const SCHEDULED_RUN_LOOKBACK_HOURS = 12;

// Notion applies templates asynchronously after the page is created, so a
// new page's blocks are polled until the heading shows up.
export const TEMPLATE_WAIT = { retries: 20, delayMs: 1500 };
