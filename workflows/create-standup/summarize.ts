import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Utils
import type { AIClient } from "utils/ai";
// Config
import { AI_MODEL } from "./config";
// Types
import type { WorkItemActivity } from "./azureDevOps";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Notion rejects rich text longer than this in a single text object.
const MAX_BULLET_LENGTH = 2000;

const describeItem = (item: WorkItemActivity): string => {
  const lines = [`#${item.id} [${item.type}] "${item.title}" (currently ${item.state})`];
  for (const change of item.stateChanges) {
    lines.push(`  state changed: ${change.from ?? "(new)"} -> ${change.to}`);
  }
  for (const comment of item.comments) {
    lines.push(`  comment added: ${comment}`);
  }
  return lines.join("\n");
};

// Returns standup bullet strings, or [] if there is no activity. An empty,
// cut-off or malformed reply fails to parse and throws, so it can't slip
// through as a half-written summary.
export const summarizeActivity = async (
  ai: AIClient,
  activity: WorkItemActivity[]
): Promise<string[]> => {
  if (activity.length === 0) return [];

  const template = await readFile(join(__dirname, "prompt.md"), "utf-8");
  const prompt = template.replace("{{ACTIVITY}}", activity.map(describeItem).join("\n\n"));

  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    generationConfig: {
      response_mime_type: "application/json",
    },
  });

  let cleanedText = (response.text ?? "").trim();
  if (!cleanedText) {
    throw new Error("AI returned an empty response");
  }
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    throw new Error(`AI did not return valid JSON: ${cleanedText.slice(0, 300)}`);
  }

  const raw = (parsed as { bullets?: unknown }).bullets;
  if (!Array.isArray(raw)) {
    throw new Error(`AI response has no "bullets" array: ${cleanedText.slice(0, 300)}`);
  }

  const bullets = raw
    .filter((b): b is string => typeof b === "string")
    .map((b) => b.replace(/^[-•*]\s*/, "").trim().slice(0, MAX_BULLET_LENGTH))
    .filter(Boolean);

  if (bullets.length === 0) {
    throw new Error("AI returned no bullets for non-empty activity");
  }
  return bullets;
};
