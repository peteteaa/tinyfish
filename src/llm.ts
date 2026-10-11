// Gemini client (reasoning only: explore planning, compile, extract). Never given web tools;
// all web access goes through TinyFish (src/tinyfish.ts).

import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { log, requireEnv } from "./env.js";
import { notice } from "./progress.js";

// Calls fall back down WM_FALLBACK_MODELS when a model's quota is used up, it's overloaded, or it's been retired.
// Each model has its own free-tier quota, so pointing WM_MODEL and WM_FAST_MODEL at different models spreads the load.
// (Checked 2026-10-11: the 2.5 models 404 for new keys; Pro models hit free-tier token caps almost at once.)

/** Explore, compile, edit and repair. */
export const MODEL = process.env.WM_MODEL ?? "gemini-3.5-flash-lite";
/** Per-item work such as extract steps, where cost and latency matter more. */
export const FAST_MODEL = process.env.WM_FAST_MODEL ?? "gemini-3.5-flash-lite";
/** Tried in order after the requested model. */
export const FALLBACK_MODELS = (process.env.WM_FALLBACK_MODELS ?? "gemini-3.5-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-3.1-flash-lite-preview")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let client: GoogleGenAI | undefined;
export function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
  return client;
}

const MAX_RETRIES = 4;
const MAX_WAIT_MS = 65_000;

/** Rate limits (429) and overloads (5xx) are worth waiting out; anything else isn't. */
export function isTransientGeminiError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

/** The server's suggested wait in ms ("retryDelay":"40s" / "retry in 40.7s"), if it gave one. */
function suggestedDelayMs(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"|retry in (\d+(?:\.\d+)?)s/i);
  return m ? Number(m[1] ?? m[2]) * 1000 + 500 : undefined;
}

/**
 * A quota that won't come back within MAX_WAIT_MS (the free tier's daily request limit, or a long suggested wait).
 * Waiting it out would stall every call for minutes, so fail at once with what to do instead. The message keeps
 * "429" so isTransientGeminiError still treats it as not the workflow's fault (repair won't try to "fix" it).
 */
export function quotaExhausted(err: unknown): Error | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if ((err as { status?: number } | null)?.status !== 429 && !/\b429\b|RESOURCE_EXHAUSTED/.test(msg)) return undefined;
  const wait = suggestedDelayMs(err);
  const daily = /PerDay/i.test(msg);
  if (!daily && (wait === undefined || wait <= MAX_WAIT_MS)) return undefined;
  const limit = msg.match(/limit: (\d+), model: ([\w.-]+)/);
  const resets = wait ? ` It resets in about ${Math.max(1, Math.round(wait / 60_000))} min.` : "";
  return new Error(
    `Gemini quota used up (429${daily ? ", daily limit" : ""}${limit ? `: ${limit[1]} requests for ${limit[2]}` : ""}).${resets} ` +
      "Wait for it to reset, use a GEMINI_API_KEY with billing enabled, or set WM_MODEL / WM_FAST_MODEL to a model that still has quota.",
  );
}

const OVERLOAD_RETRIES = 2;

/** Overloaded (503/UNAVAILABLE) or retired/unknown (404): another model may well answer. */
function modelUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return status === 503 || status === 404 || /UNAVAILABLE|high demand|overloaded|no longer available|NOT_FOUND/i.test(msg);
}

/** One model: retries short rate limits and brief overloads; throws the raw error otherwise. */
async function generateOnce(params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]): Promise<GenerateContentResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gemini().models.generateContent(params);
    } catch (err) {
      if (quotaExhausted(err)) throw err;
      const overloaded = modelUnavailable(err);
      if (!isTransientGeminiError(err) && !overloaded) throw err;
      if (attempt >= (overloaded ? OVERLOAD_RETRIES : MAX_RETRIES) || (err as { status?: number }).status === 404) throw err;
      const wait = Math.min(suggestedDelayMs(err) ?? 2_000 * 2 ** attempt, MAX_WAIT_MS);
      const status = (err as { status?: number }).status;
      log(`  gemini ${params.model}: ${status ?? "transient error"}, retrying in ${Math.round(wait / 1000)}s`);
      notice(`Gemini (${params.model}) is ${status === 429 ? "rate limited" : "busy"}; retrying in ${Math.round(wait / 1000)}s.`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Models known to be out of quota or down, until when. Skipped without a request until then. */
const unavailableUntil = new Map<string, number>();

/**
 * generateContent with retries, falling back to the next model in FALLBACK_MODELS when the requested one has used up
 * its quota, is overloaded or is gone. Every Gemini call goes through here.
 */
export async function generate(params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]): Promise<GenerateContentResponse> {
  const chain = [params.model, ...FALLBACK_MODELS.filter((m) => m !== params.model)];
  let firstProblem: Error | undefined;
  for (const model of chain) {
    if ((unavailableUntil.get(model) ?? 0) > Date.now()) continue;
    try {
      const response = await generateOnce({ ...params, model });
      if (model !== params.model) log(`  gemini: ${params.model} unavailable, answered by ${model}`);
      return response;
    } catch (err) {
      const exhausted = quotaExhausted(err);
      if (!exhausted && !modelUnavailable(err)) throw err;
      firstProblem ??= exhausted ?? (err instanceof Error ? err : new Error(String(err)));
      // Quota: until it resets. Overload or 404: try it again in a few minutes.
      unavailableUntil.set(model, Date.now() + (exhausted ? (suggestedDelayMs(err) ?? 60 * 60_000) : 5 * 60_000));
      log(`  gemini: ${model} ${exhausted ? "is out of quota" : "is unavailable"}; trying the next model`);
      notice(`Gemini ${model} is ${exhausted ? "out of quota for today" : "unavailable"}; switching to another model.`);
    }
  }
  throw firstProblem ?? new Error(`Every Gemini model (${chain.join(", ")}) is out of quota or unavailable right now. Try again later.`);
}

/** For tests: forget which models were marked unavailable, and optionally swap in a fake client. */
export function resetModelAvailability(fake?: GoogleGenAI) {
  unavailableUntil.clear();
  if (fake) client = fake;
}

/** The candidate's content, or a readable error when the model stopped without one (safety, max tokens, ...). */
export function candidateContent(response: GenerateContentResponse): Content {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    const reason = candidate?.finishReason ?? response.promptFeedback?.blockReason ?? "no candidates";
    throw new Error(`Gemini returned no content (${reason}).`);
  }
  if (candidate.finishReason === "MAX_TOKENS") throw new Error("Gemini hit the output token limit; output incomplete.");
  return candidate.content;
}

/** Text from a response, excluding thought parts. */
export function textOf(content: Content): string {
  return (content.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
}

/** Removes JSON Schema keys Gemini's schema subset rejects (e.g. "$schema" from z.toJSONSchema). */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => k !== "$schema")
      .map(([k, v]) => [k, geminiSchema(v)]),
  );
}

/** The `extract` step: pull structured data out of fetched text. */
export async function extract(args: {
  input: string;
  instruction: string;
  schema: Record<string, unknown>;
}): Promise<{ value: unknown; usage: { input: number; output: number } }> {
  const response = await generate({
    model: FAST_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: `<instruction>\n${args.instruction}\n</instruction>\n\n<content>\n${args.input}\n</content>` }],
      },
    ],
    config: {
      systemInstruction:
        "You extract structured data from web page content. Use only facts present in the content. " +
        "If a field is not present in the content, use null or an empty list. Never invent or paraphrase values; " +
        "copy text as it appears.",
      responseMimeType: "application/json",
      responseJsonSchema: geminiSchema(args.schema),
    },
  });
  const text = textOf(candidateContent(response));
  if (!text) throw new Error("Extraction returned no text.");
  return {
    value: JSON.parse(text),
    usage: {
      input: response.usageMetadata?.promptTokenCount ?? 0,
      output: response.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
