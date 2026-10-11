// Phase 1: Gemini solves the task with TinyFish tools while we record every call into a trace.

import type { Content, FunctionCall, Part } from "@google/genai";
import { z } from "zod";
import { log } from "./env.js";
import { candidateContent, gemini, geminiSchema, MODEL, textOf } from "./llm.js";
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

const MAX_TOOL_TEXT = 15_000; // chars of page text shown to the model per page
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
- Each fetch result has a "title" field as well as "text". A page's main heading is often only in "title", so read
  both before deciding fetch didn't work. Never re-fetch the same page with tinyfish_agent just to read text that
  fetch already returned.
- Be direct. Don't make exploratory calls you won't need; every call you make may be replayed on every rerun.
- When you have the answer, call submit_answer exactly once with the structured result, then stop.`;

interface Tool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<Record<string, unknown>>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t;

export interface ExploreOptions {
  maxIterations?: number;
  /** Called when a TinyFish call starts (index = its position in trace.calls). */
  onTraceStart?: (index: number, call: { tool: string; input: unknown }) => void;
  /** Called as each TinyFish call completes. */
  onTrace?: (index: number, entry: TraceCall) => void;
}

export async function explore(goal: string, opts: ExploreOptions = {}): Promise<Trace> {
  const trace: Trace = { id: newId(), goal, model: MODEL, started_at: new Date().toISOString(), calls: [] };
  let submitted = false;

  async function recorded<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T>,
    toModel: (out: T) => unknown,
    toTrace: (out: T) => unknown = (o) => o,
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    // Reserve the slot now so parallel calls keep the order they were issued in.
    const index = trace.calls.length;
    trace.calls.push({ tool: name, input, duration_ms: 0 });
    opts.onTraceStart?.(index, { tool: name, input });
    log(`  -> ${name} ${JSON.stringify(input).slice(0, 160)}`);
    try {
      const out = await fn();
      trace.calls[index] = { tool: name, input, output: toTrace(out), duration_ms: Date.now() - started };
      return { output: toModel(out) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.calls[index] = { tool: name, input, error: message, duration_ms: Date.now() - started };
      log(`     error: ${message}`);
      return { error: message };
    } finally {
      opts.onTrace?.(index, trace.calls[index]);
    }
  }

  const tools = [
    tool({
      name: "tinyfish_search",
      description: "Web search. Returns ranked results with title, url and snippet. Free and fast.",
      schema: z.object({
        query: z.string(),
        purpose: z.string().optional().describe("Why you are searching; improves ranking"),
        include_domains: z.string().optional().describe("Comma-separated domains to restrict to"),
      }),
      run: (input) => recorded("tinyfish_search", input, () => search(input), (r) => r.results),
    }),
    tool({
      name: "tinyfish_fetch",
      description:
        "Fetch one or more URLs and return clean page text (markdown by default) plus each page's title " +
        "(often the main heading, which may be missing from the text). Free and fast. " +
        "Does not run interactions; for pages that need clicks or forms use tinyfish_agent.",
      schema: z.object({
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
    tool({
      name: "tinyfish_agent",
      description:
        "Run a browser agent on a URL with a natural-language goal; returns its structured result. " +
        "Slow (often minutes) and costs credits. Use only when the task needs interaction.",
      schema: z.object({
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
    tool({
      name: "submit_answer",
      description: "Submit the final structured answer to the task. Call exactly once, at the end.",
      schema: z.object({
        answer: z.unknown().describe("The final result as structured JSON"),
        notes: z
          .string()
          .optional()
          .describe("Anything a future rerun should know: which sources worked, what failed, caveats"),
      }),
      run: async (input) => {
        trace.answer = input.answer;
        trace.notes = input.notes;
        submitted = true;
        return { output: "Answer recorded. You're done." };
      },
    }),
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function call(fc: FunctionCall): Promise<Part> {
    const t = byName.get(fc.name ?? "");
    let response: Record<string, unknown>;
    if (!t) {
      response = { error: `Unknown tool "${fc.name}". Available: ${[...byName.keys()].join(", ")}` };
    } else {
      // The model's arguments aren't schema-guaranteed; validate before running anything.
      const parsed = t.schema.safeParse(fc.args ?? {});
      response = parsed.success
        ? await (t.run as (i: unknown) => Promise<Record<string, unknown>>)(parsed.data)
        : { error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    }
    return { functionResponse: { id: fc.id, name: fc.name, response } };
  }

  const contents: Content[] = [{ role: "user", parts: [{ text: goal }] }];
  const config = {
    systemInstruction: SYSTEM,
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: geminiSchema(z.toJSONSchema(t.schema, { io: "input" })),
        })),
      },
    ],
  };

  const maxIterations = opts.maxIterations ?? 30;
  let finalText = "";
  for (let i = 0; i < maxIterations; i++) {
    const response = await gemini().models.generateContent({ model: MODEL, contents, config });
    const content = candidateContent(response);
    // Append the model turn verbatim: Gemini 3 requires its thought signatures back on the next request.
    contents.push(content);
    const text = textOf(content).trim();
    if (text) {
      finalText = text;
      log(`  model: ${text.slice(0, 300)}`);
    }
    const calls = (content.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : []));
    if (!calls.length) break;
    // Parallel calls in one turn: run them together and answer them all in a single user turn.
    contents.push({ role: "user", parts: await Promise.all(calls.map(call)) });
    if (submitted) {
      // Let the model wrap up only if it wants to; the answer is already recorded.
      break;
    }
  }
  if (!submitted) log(`  warning: exploration ended without submit_answer`);

  trace.final_text = finalText;
  trace.finished_at = new Date().toISOString();
  saveTrace(trace.id, trace);
  return trace;
}
