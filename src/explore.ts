// Phase 1: Claude solves the task with TinyFish tools while we record every call into a trace.

import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { anthropic, FALLBACK } from "./claude.js";
import { log, MODEL } from "./env.js";
import { newId, saveTrace } from "./store.js";
import { fetchPages, runAgent, search } from "./tinyfish.js";

export interface TraceCall {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  duration_ms: number;
}

export interface Trace {
  id: string;
  goal: string;
  model: string;
  started_at: string;
  finished_at?: string;
  calls: TraceCall[];
  answer?: unknown;
  notes?: string;
  final_text?: string;
}

const MAX_TOOL_TEXT = 15_000; // chars of page text shown to Claude per page
const MAX_TRACE_TEXT = 50_000; // chars of page text kept in the trace per page

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n...[truncated ${s.length - n} chars]` : s;
}

function clipFetchText<T extends { results: { text: unknown }[] }>(r: T, n: number): T {
  return {
    ...r,
    results: r.results.map((p) => ({ ...p, text: typeof p.text === "string" ? clip(p.text, n) : p.text })),
  };
}

const SYSTEM = `You solve web tasks using TinyFish tools. Your work is recorded and later compiled into a reusable,
parameterized workflow, so solve the task the way you'd want it repeated:

- Prefer the cheapest tool that works: tinyfish_search (find URLs) and tinyfish_fetch (read pages) are fast and free;
  tinyfish_agent drives a real browser and is slow and costs credits. Use the agent only when a page needs
  interaction (clicking, forms, logins, infinite scroll) or fetch returned nothing useful.
- Be direct. Don't make exploratory calls you won't need; every call you make may be replayed on every rerun.
- When you have the answer, call submit_answer exactly once with the structured result, then stop.`;

export async function explore(goal: string, opts: { maxIterations?: number } = {}): Promise<Trace> {
  const trace: Trace = { id: newId(), goal, model: MODEL, started_at: new Date().toISOString(), calls: [] };

  async function recorded<T>(tool: string, input: unknown, fn: () => Promise<T>, toClaude: (out: T) => unknown, toTrace: (out: T) => unknown = (o) => o) {
    const started = Date.now();
    log(`  -> ${tool} ${JSON.stringify(input).slice(0, 160)}`);
    try {
      const out = await fn();
      trace.calls.push({ tool, input, output: toTrace(out), duration_ms: Date.now() - started });
      return JSON.stringify(toClaude(out));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.calls.push({ tool, input, error: message, duration_ms: Date.now() - started });
      log(`     error: ${message}`);
      return `Error: ${message}`;
    }
  }

  const tools = [
    betaZodTool({
      name: "tinyfish_search",
      description: "Web search. Returns ranked results with title, url and snippet. Free and fast.",
      inputSchema: z.object({
        query: z.string(),
        purpose: z.string().optional().describe("Why you are searching; improves ranking"),
        include_domains: z.string().optional().describe("Comma-separated domains to restrict to"),
      }),
      run: (input) => recorded("tinyfish_search", input, () => search(input), (r) => r.results),
    }),
    betaZodTool({
      name: "tinyfish_fetch",
      description:
        "Fetch one or more URLs and return clean page text (markdown by default). Free and fast. " +
        "Does not run interactions; for pages that need clicks or forms use tinyfish_agent.",
      inputSchema: z.object({
        urls: z.array(z.string()).min(1).max(10),
        purpose: z.string().optional(),
        links: z.boolean().optional().describe("Also return outbound links from each page"),
      }),
      run: (input) =>
        recorded(
          "tinyfish_fetch",
          input,
          () => fetchPages(input),
          (r) => clipFetchText(r, MAX_TOOL_TEXT),
          (r) => clipFetchText(r, MAX_TRACE_TEXT),
        ),
    }),
    betaZodTool({
      name: "tinyfish_agent",
      description:
        "Run a browser agent on a URL with a natural-language goal; returns its structured result. " +
        "Slow (often minutes) and costs credits. Use only when the task needs interaction.",
      inputSchema: z.object({
        url: z.string(),
        goal: z.string().describe("Specific instructions, including what to return"),
        output_schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema for the result"),
      }),
      run: (input) =>
        recorded(
          "tinyfish_agent",
          input,
          () => runAgent(input, { onProgress: (r) => log(`     [agent] ${r.status}, ${r.steps?.length ?? 0} steps`) }),
          (r) => ({ status: r.status, result: r.result, error: r.error }),
          (r) => ({ run_id: r.run_id, status: r.status, result: r.result, error: r.error, num_of_steps: r.num_of_steps }),
        ),
    }),
    betaZodTool({
      name: "submit_answer",
      description: "Submit the final structured answer to the task. Call exactly once, at the end.",
      inputSchema: z.object({
        answer: z.unknown().describe("The final result as structured JSON"),
        notes: z
          .string()
          .optional()
          .describe("Anything a future rerun should know: which sources worked, what failed, caveats"),
      }),
      run: async (input) => {
        trace.answer = input.answer;
        trace.notes = input.notes;
        return "Answer recorded. You're done.";
      },
    }),
  ];

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "medium" },
    max_iterations: opts.maxIterations ?? 30,
    system: SYSTEM,
    tools,
    messages: [{ role: "user", content: goal }],
  });

  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    final = message;
    for (const b of message.content) if (b.type === "text" && b.text.trim()) log(`  claude: ${b.text.trim().slice(0, 300)}`);
  }
  if (final?.stop_reason === "refusal") throw new Error("Exploration was declined (refusal).");
  trace.final_text = final?.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  trace.finished_at = new Date().toISOString();
  saveTrace(trace.id, trace);
  return trace;
}
