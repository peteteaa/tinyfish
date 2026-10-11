// Phase 1: Gemini solves the task with TinyFish tools while we record every call into a trace.

import type { Content, FunctionCall, Part } from "@google/genai";
import { z } from "zod";
import { log } from "./env.js";
import { candidateContent, generate, geminiSchema, MODEL, textOf } from "./llm.js";
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
  /** When the goal was generic, the concrete example task that was actually explored (see concretize). */
  example?: { task: string; assumed: string; not_done?: string };
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
- The task is often described generically, as a recurring job or for inputs the user will supply later ("for my
  field", "for each new signup", "for {company}"). Don't stop to ask and don't just describe the idea: pick one
  realistic example input (e.g. a well-known company, a common field such as software engineering), do the web part of
  the task for it with the tools, and say in submit_answer's notes which input you assumed so it becomes a parameter.
  Pick the example first and make every call about it: the facts in your answer must come from pages you searched or
  fetched for that input, never from memory. A typical research pattern is search for the subject, then fetch its
  own site (and one or two relevant results), then answer.
- You can only read the web. If the task also asks to post, send or save somewhere (Slack, email, a CRM), do the
  research part, put the finished message in the answer, and note that delivery isn't done by this workflow.
- When you have the answer, call submit_answer exactly once with the structured result, then stop.`;

const CONCRETIZE = `You prepare web tasks for an explorer that solves one concrete task with web search and page fetches,
and whose run is then compiled into a reusable, parameterized workflow.

If the task is already concrete (it names the companies, URLs, fields, places or other inputs it's about), return it
unchanged with generic=false.

If it's generic (a recurring job, "for my field", "for each new signup", "for {company}", or an input the user will
supply later), pick ONE realistic example input and rewrite it as a single concrete task the explorer can do right
now on the public web, e.g. "Research the company at supabase.com: what it does, its size and funding, and whether a
signup from it deserves a sales follow-up. Return a short brief." The example becomes the param default, so pick
something stable and well known.

The explorer can only read the web. Leave out anything else the task asks for (posting to Slack, sending email,
saving to a CRM, triggers like "every time someone signs up") from the task, ask for the finished message/brief in the
answer instead, and list what was left out in not_done.

Reply with JSON: {"generic": boolean, "task": string, "assumed": string (the example input(s) chosen, "" if none),
"not_done": string ("" if nothing was left out)}.`;

/** Turns a generic goal into one concrete example task, so exploration has something to look up. */
export async function concretize(goal: string): Promise<{ generic: boolean; task: string; assumed: string; not_done: string }> {
  const response = await generate({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `<task>\n${goal}\n</task>` }] }],
    config: { systemInstruction: CONCRETIZE, responseMimeType: "application/json" },
  });
  try {
    const r = JSON.parse(textOf(candidateContent(response))) as Record<string, unknown>;
    const task = typeof r.task === "string" && r.task.trim() ? r.task.trim() : goal;
    return {
      generic: r.generic === true && task !== goal,
      task,
      assumed: typeof r.assumed === "string" ? r.assumed : "",
      not_done: typeof r.not_done === "string" ? r.not_done : "",
    };
  } catch {
    return { generic: false, task: goal, assumed: "", not_done: "" };
  }
}

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

/** A TinyFish call that actually brought back web content (not an error, not an empty result). */
export function returnedContent(c: TraceCall): boolean {
  if (c.error || !c.tool.startsWith("tinyfish_") || c.output == null) return false;
  const out = c.output as Record<string, unknown>;
  if (c.tool === "tinyfish_search") return Array.isArray(out.results) && out.results.length > 0;
  if (c.tool === "tinyfish_fetch") {
    const pages = Array.isArray(out.results) ? (out.results as { text?: unknown }[]) : [];
    return pages.some((p) => (typeof p.text === "string" ? p.text.trim().length > 0 : p.text != null));
  }
  if (c.tool === "tinyfish_agent") return out.status === "COMPLETED" && out.result != null;
  return false;
}

const NO_WEB_YET =
  "Not accepted: no TinyFish call has returned web content yet, so this answer would come from memory. " +
  "Use tinyfish_search and/or tinyfish_fetch to read real pages about the task, base every fact on what they " +
  "return, then call submit_answer.";
/** Times the model is told to go use the tools when it tries to finish without them. */
const MAX_NUDGES = 2;

export async function explore(goal: string, opts: ExploreOptions = {}): Promise<Trace> {
  const trace: Trace = { id: newId(), goal, model: MODEL, started_at: new Date().toISOString(), calls: [] };
  let submitted = false;
  const grounded = () => trace.calls.some(returnedContent);

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
        // Answers must come from the web via TinyFish, never from the model's memory.
        if (!grounded()) return { error: NO_WEB_YET };
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

  const concrete = await concretize(goal);
  if (concrete.generic) {
    trace.example = { task: concrete.task, assumed: concrete.assumed, ...(concrete.not_done && { not_done: concrete.not_done }) };
    log(`  generic goal; exploring an example: ${concrete.task}`);
  }
  const prompt = concrete.generic
    ? `${concrete.task}\n\n(This is an example run of a reusable workflow for: "${goal}". Example input: ${concrete.assumed}. ` +
      `Make every call about that input.)`
    : goal;
  const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
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
  let nudges = 0;
  for (let i = 0; i < maxIterations; i++) {
    const response = await generate({ model: MODEL, contents, config });
    const content = candidateContent(response);
    // Append the model turn verbatim: Gemini 3 requires its thought signatures back on the next request.
    contents.push(content);
    const text = textOf(content).trim();
    if (text) {
      finalText = text;
      log(`  model: ${text.slice(0, 300)}`);
    }
    const calls = (content.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : []));
    if (!calls.length) {
      // Stopping (or asking the user a question) without having read the web: send it back to the tools.
      if (!submitted && !grounded() && nudges < MAX_NUDGES) {
        nudges++;
        log(`  no web content yet; nudging the model to use TinyFish (${nudges}/${MAX_NUDGES})`);
        contents.push({ role: "user", parts: [{ text: NO_WEB_YET }] });
        continue;
      }
      break;
    }
    // Parallel calls in one turn: run them together and answer them all in a single user turn.
    contents.push({ role: "user", parts: await Promise.all(calls.map(call)) });
    if (submitted) {
      // Let the model wrap up only if it wants to; the answer is already recorded.
      break;
    }
  }
  if (!submitted) log(`  warning: exploration ended without submit_answer`);
  if (!grounded()) log(`  warning: no TinyFish call returned web content`);

  trace.final_text = finalText;
  trace.finished_at = new Date().toISOString();
  saveTrace(trace.id, trace);
  return trace;
}
