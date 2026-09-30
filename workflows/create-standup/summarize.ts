// Utils
import type { AIClient } from "utils/ai";
// Workflow
import { askForJson, bulletList, loadPrompt, stringList } from "./gemini";
// Types
import type { WorkItemActivity } from "./azureDevOps";

// Notion rejects rich text longer than this in a single text object.
export const MAX_LINE_LENGTH = 2000;

export const describeActivity = (activity: WorkItemActivity[]): string =>
  activity.length === 0
    ? "(none)"
    : activity
        .map((item) => {
          const lines = [`#${item.id} [${item.type}] "${item.title}" (currently ${item.state})`];
          for (const change of item.stateChanges) {
            lines.push(`  state changed: ${change.from ?? "(new)"} -> ${change.to}`);
          }
          for (const comment of item.comments) {
            lines.push(`  comment added: ${comment}`);
          }
          return lines.join("\n");
        })
        .join("\n\n");

// Returns standup bullets for the activity, leaving out anything the
// already-written lines cover. Returns [] when there's nothing new.
export const summarizeActivity = async (
  ai: AIClient,
  activity: WorkItemActivity[],
  alreadyWritten: string[]
): Promise<string[]> => {
  if (activity.length === 0) return [];

  const prompt = await loadPrompt("prompt.md", {
    EXISTING: bulletList(alreadyWritten),
    ACTIVITY: describeActivity(activity),
  });
  return stringList(await askForJson(ai, prompt), "bullets", MAX_LINE_LENGTH);
};
