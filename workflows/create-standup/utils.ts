import { TIME_ZONE } from "./config";

// Formats a moment as a YYYY-MM-DD calendar date in TIME_ZONE.
export const toLocalIsoDate = (date: Date): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

// Calendar arithmetic on YYYY-MM-DD strings. Working at UTC noon keeps
// daylight saving changes from shifting the date.
export const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const isWeekend = (isoDate: string): boolean => {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

// The standup after a given day: Friday's work goes on Monday's page.
export const nextWorkingDay = (isoDate: string): string => {
  let next = addDays(isoDate, 1);
  while (isWeekend(next)) next = addDays(next, 1);
  return next;
};

// Rejects malformed strings and impossible dates such as 2026-02-30.
export const isValidIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// Azure DevOps comments are stored as HTML. Reduce them to plain text
// before they go into the prompt.
export const htmlToText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n")
    .trim();
