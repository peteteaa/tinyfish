// Gemini client (reasoning only: explore planning, compile, extract). Never given web tools;
// all web access goes through TinyFish (src/tinyfish.ts).

import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { requireEnv } from "./env.js";

/** Explore and compile. */
export const MODEL = process.env.WM_MODEL ?? "gemini-3.5-flash-lite";
/** Per-item work such as extract steps, where cost and latency matter more. */
export const FAST_MODEL = process.env.WM_FAST_MODEL ?? "gemini-3.5-flash-lite";

let client: GoogleGenAI | undefined;
export function gemini(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: requireEnv("GEMINI_API_KEY") });
  return client;
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
  const response = await gemini().models.generateContent({
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
