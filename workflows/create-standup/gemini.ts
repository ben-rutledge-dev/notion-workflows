import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Utils
import type { AIClient } from "utils/ai";
import { logger } from "utils/logger";
// Config
import { AI_MODEL } from "./config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Gemini sometimes returns 429 or 5xx errors when busy. These are retried
// after each of these delays before giving up.
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTemporaryError = (err: unknown): boolean => {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const message = err instanceof Error ? err.message : String(err);
  return /"code":\s*(429|5\d\d)|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed/.test(message);
};

const generateWithRetry = async (ai: AIClient, prompt: string) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent({
        model: AI_MODEL,
        contents: prompt,
        generationConfig: {
          response_mime_type: "application/json",
        },
      });
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTemporaryError(err)) throw err;
      logger.alert(`Gemini is busy, retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
};

// Loads a prompt file from this folder and fills its {{PLACEHOLDERS}}.
export const loadPrompt = async (
  fileName: string,
  replacements: Record<string, string>
): Promise<string> => {
  let prompt = await readFile(join(__dirname, fileName), "utf-8");
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(`{{${key}}}`, value);
  }
  return prompt;
};

// Sends a prompt and parses the JSON reply. An empty, cut-off or malformed
// reply throws, so it can't slip through as half an answer.
export const askForJson = async (ai: AIClient, prompt: string): Promise<Record<string, unknown>> => {
  const response = await generateWithRetry(ai, prompt);

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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`AI did not return a JSON object: ${cleanedText.slice(0, 300)}`);
  }
  return parsed as Record<string, unknown>;
};

// Reads a list of strings from a parsed reply, tidied into single lines.
export const stringList = (reply: Record<string, unknown>, key: string, maxLength: number): string[] => {
  const raw = reply[key];
  if (!Array.isArray(raw)) {
    throw new Error(`AI response has no "${key}" array: ${JSON.stringify(reply).slice(0, 300)}`);
  }
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^[-•*]\s*/, "").replace(/\s+/g, " ").trim().slice(0, maxLength))
    .filter(Boolean);
};

export const bulletList = (lines: string[]): string =>
  lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "(none)";
