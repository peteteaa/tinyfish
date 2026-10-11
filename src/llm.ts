// Gemini client (reasoning only: explore planning, compile, extract). Never given web tools;
// all web access goes through TinyFish (src/tinyfish.ts).

import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { log, requireEnv } from "./env.js";

/** Explore and compile. */
export const MODEL = process.env.WM_MODEL ?? "gemini-3.5-flash-lite";
/** Per-item work such as extract steps, where cost and latency matter more. */
export const FAST_MODEL = process.env.WM_FAST_MODEL ?? "gemini-3.5-flash-lite";

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

/** Server-suggested wait ("retryDelay":"40s" / "retry in 40.7s"), else exponential backoff. */
function retryDelayMs(err: unknown, attempt: number): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"|retry in (\d+(?:\.\d+)?)s/i);
  const suggested = m ? Number(m[1] ?? m[2]) * 1000 + 500 : 2_000 * 2 ** attempt;
  return Math.min(suggested, MAX_WAIT_MS);
}

/** generateContent with retries on rate limits and transient server errors. Every Gemini call goes through here. */
export async function generate(params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]): Promise<GenerateContentResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gemini().models.generateContent(params);
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isTransientGeminiError(err)) throw err;
      const wait = retryDelayMs(err, attempt);
      log(`  gemini: ${(err as { status?: number }).status ?? "transient error"}, retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
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
