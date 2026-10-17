// Usage metering: counts Gemini tokens and TinyFish calls made inside meter(), however deep, without threading a
// counter through every call. llm.ts and tinyfish.ts report here; outside a meter the reports are dropped.
// Used by the benchmark (bench/) to compare a raw agent run with a replayed workflow on equal terms.

import { AsyncLocalStorage } from "node:async_hooks";

export interface Usage {
  gemini: {
    calls: number;
    input: number;
    output: number;
    /** Thinking tokens, billed as output. */
    thoughts: number;
    by_model: Record<string, { calls: number; input: number; output: number; thoughts: number }>;
  };
  tinyfish: { search: number; fetch: number; fetch_urls: number; agent: number; agent_steps: number };
  /** Time spent sleeping on Gemini rate limits and overloads before retrying (not work; missing in older records). */
  wait_ms?: number;
}

export function emptyUsage(): Usage {
  return {
    gemini: { calls: 0, input: 0, output: 0, thoughts: 0, by_model: {} },
    tinyfish: { search: 0, fetch: 0, fetch_urls: 0, agent: 0, agent_steps: 0 },
    wait_ms: 0,
  };
}

const meters = new AsyncLocalStorage<Usage[]>();

/** Runs `fn`, counting every Gemini and TinyFish call it makes. Meters nest: an inner call counts in both. */
export async function meter<T>(fn: () => Promise<T>): Promise<{ value: T; usage: Usage }> {
  const usage = emptyUsage();
  const value = await meters.run([...(meters.getStore() ?? []), usage], fn);
  return { value, usage };
}

export function recordGemini(model: string, u: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined) {
  for (const usage of meters.getStore() ?? []) {
    const add = { calls: 1, input: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0, thoughts: u?.thoughtsTokenCount ?? 0 };
    const g = usage.gemini;
    g.calls += 1;
    g.input += add.input;
    g.output += add.output;
    g.thoughts += add.thoughts;
    const m = (g.by_model[model] ??= { calls: 0, input: 0, output: 0, thoughts: 0 });
    m.calls += 1;
    m.input += add.input;
    m.output += add.output;
    m.thoughts += add.thoughts;
  }
}

export function recordTinyFish(kind: "search" | "fetch" | "agent", n = 1) {
  for (const usage of meters.getStore() ?? []) {
    if (kind === "search") usage.tinyfish.search += 1;
    else if (kind === "fetch") {
      usage.tinyfish.fetch += 1;
      usage.tinyfish.fetch_urls += n;
    } else usage.tinyfish.agent += 1;
  }
}

export function recordWait(ms: number) {
  for (const usage of meters.getStore() ?? []) usage.wait_ms = (usage.wait_ms ?? 0) + ms;
}

export function recordAgentSteps(steps: number) {
  for (const usage of meters.getStore() ?? []) usage.tinyfish.agent_steps += steps;
}

/** USD per 1M tokens. Thinking tokens bill as output. Override with WM_PRICES='{"model":{"input":0.3,"output":2.5}}'. */
// Gemini 3.5 Flash-Lite list price as reported 2026-10 (eesel.ai, pricepertoken.com); check
// https://ai.google.dev/gemini-api/docs/pricing before quoting dollar figures.
const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
};

export function prices(): Record<string, { input: number; output: number }> {
  try {
    return { ...DEFAULT_PRICES, ...(process.env.WM_PRICES ? JSON.parse(process.env.WM_PRICES) : {}) };
  } catch {
    return DEFAULT_PRICES;
  }
}

/** Gemini cost in USD. Models without a price (e.g. fallbacks) use the most specific prefix match, else the default model. */
export function geminiCost(usage: Usage): number {
  const table = prices();
  const fallback = table["gemini-3.5-flash-lite"];
  let usd = 0;
  for (const [model, m] of Object.entries(usage.gemini.by_model)) {
    const key = Object.keys(table)
      .filter((k) => model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const p = key ? table[key] : fallback;
    usd += (m.input * p.input + (m.output + m.thoughts) * p.output) / 1_000_000;
  }
  return usd;
}
