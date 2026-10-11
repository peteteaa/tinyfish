import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "./env.js";

export const anthropic = new Anthropic();

// Opus 5.5: thinking is always on (adaptive); effort is the depth control.
// Server-side fallbacks re-run a refused request on a fallback model inside the same call.
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

/**
 * Turn an arbitrary JSON Schema into one structured outputs accepts:
 * every object gets additionalProperties:false and all its properties listed as required.
 */
export function toStrictSchema(schema: unknown): { schema: Record<string, unknown>; wrapped: boolean } {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if (out.type === "object" || out.properties) {
      out.type = "object";
      const props = (out.properties ?? {}) as Record<string, unknown>;
      out.properties = props;
      out.required = Object.keys(props);
      out.additionalProperties = false;
    }
    return out;
  };
  const root = walk(schema) as Record<string, unknown>;
  // Structured outputs need an object at the root; wrap anything else.
  if (root.type !== "object") {
    return {
      schema: { type: "object", properties: { value: root }, required: ["value"], additionalProperties: false },
      wrapped: true,
    };
  }
  return { schema: root, wrapped: false };
}

/** The `extract` step: pull structured data out of fetched text. */
export async function extract(args: {
  input: string;
  instruction: string;
  schema: Record<string, unknown>;
}): Promise<{ value: unknown; usage: Anthropic.Beta.BetaUsage }> {
  const { schema, wrapped } = toStrictSchema(args.schema);

  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system:
      "You extract structured data from web page content. Use only facts present in the content. " +
      "If a field is not present, use null or an empty list rather than guessing.",
    messages: [
      {
        role: "user",
        content: `<instruction>\n${args.instruction}\n</instruction>\n\n<content>\n${args.input}\n</content>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("Extraction was declined (refusal).");
  if (response.stop_reason === "max_tokens") throw new Error("Extraction hit max_tokens; output incomplete.");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Extraction returned no text.");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return { value: wrapped ? parsed.value : parsed, usage: response.usage };
}
