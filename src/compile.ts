// Phase 2: turn an exploration trace into a reusable, parameterized workflow.

import fs from "node:fs";
import path from "node:path";
import type { Content } from "@google/genai";
import { z } from "zod";
import { log, SEEDS_DIR } from "./env.js";
import { explore, returnedContent, type Trace } from "./explore.js";
import { candidateContent, generate, geminiSchema, MODEL, textOf } from "./llm.js";
import { validateWorkflow, WorkflowSchema, type Workflow } from "./schema.js";
import { listWorkflows, saveWorkflow } from "./store.js";

const SUMMARY_TEXT = 1_500; // chars of each tool output shown to the compiler; it needs shapes, not content

/** Truncates long strings anywhere in a value, keeping its shape. */
export function summarize(value: unknown, n = SUMMARY_TEXT): unknown {
  if (typeof value === "string") return value.length > n ? `${value.slice(0, n)}...[${value.length - n} more chars]` : value;
  if (Array.isArray(value)) return value.map((v) => summarize(v, n));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, n)]));
  return value;
}

/** The workflow format, shared by the compiler and the editor (src/edit.ts). */
export const WORKFLOW_FORMAT = `Step types:
- search  {query, purpose?, include_domains?, domain_type?} -> {query, results: [{title, url, snippet, ...}]}
- fetch   {urls (template or list), purpose?, format?, links?} -> {results: [{url, final_url, title, text, links?}], errors: [...]}
          The page's title/main heading is often only in "title", not in "text", so extract inputs built from fetch
          results should include both, e.g. "Title: {{item.title}}\nURL: {{item.final_url}}\n\n{{item.text}}".
- agent   {url, goal, output_schema?, browser_profile?, max_steps?} -> the agent's structured result (slow, costs credits)
- extract {input, instruction, output_schema} -> JSON matching output_schema, produced by a small Gemini call

Every step has: id (snake_case), description?, forEach?, concurrency?, checks?.
forEach is a template resolving to an array; the step runs per element with {{item}} bound, and its output is an array
with one output per element. So a later step reads it with "*" or an index first: if search step "s" has a forEach,
its first result URL per item is {{steps.s.*.results.0.url}} (not {{steps.s.results...}}).

Templates: {{params.name}}, {{steps.<id>.<path>}}, {{previous.<id>.<path>}} (same step's output from the last successful run),
{{item.<path>}}. Paths are dotted, numeric segments index arrays, "*" maps over arrays ({{steps.s.results.*.url}}).
A string that is exactly one {{...}} keeps the raw value (arrays/objects); otherwise values are interpolated as text.

Checks (run on each step output, or each item's output under forEach): not_empty, min_items {value}, required_keys {keys},
regex {pattern}; each takes an optional dotted path. A failed check flags the run for repair, so write checks that catch
real breakage (empty extraction, missing prices), not ones that fail on legitimate variation.`;

const SYSTEM = `You compile a recorded web-task trace into a reusable workflow: a JSON definition that a deterministic
runner executes without an LLM in the loop (except inside "extract" steps). Reruns must be fast and cheap.

${WORKFLOW_FORMAT}

Compile guidelines:
1. Parameterize. Lift the concrete things the user named (companies, URLs, queries, dates, counts) into params,
   with defaults equal to the values in this trace so the workflow reproduces the original task with no arguments.
2. Replay only what produced the answer. Drop dead ends, failed calls and redundant lookups.
3. Make it cheaper than the trace. Batch URLs into one fetch. Prefer fetch + extract over agent. Keep an agent step only
   where the trace showed fetch couldn't get the data. If search was used only to discover a stable URL, fetch that URL
   directly (as a param default) instead of searching on every run.
4. Shape the output with the top-level "output" template so it matches the answer the trace submitted.
5. Reply with only the workflow JSON object, matching <workflow_schema>, plus one extra top-level key
   "derived_from": an object mapping each step id to the trace call indices it was based on (e.g.
   {"fetch_pages": [1, 3], "extract_plans": [3]}). Steps that don't come from a specific call (extract, llm) map to the
   calls whose output they read. If it fails validation you'll get the errors back; reply with the corrected
   complete workflow.`;

const MAX_ATTEMPTS = 3;

/** Step id -> indices into trace.calls that the step was derived from. Kept with the learn session, not the workflow. */
export type DerivedFrom = Record<string, number[]>;

export async function compile(trace: Trace, opts: { name?: string } = {}): Promise<Workflow> {
  return (await compileDetailed(trace, opts)).workflow;
}

function parseDerivedFrom(raw: unknown, workflow: Workflow, callCount: number): DerivedFrom {
  const out: DerivedFrom = {};
  const map = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const step of workflow.steps) {
    const v = map[step.id];
    out[step.id] = Array.isArray(v) ? v.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < callCount) : [];
  }
  return out;
}

export async function compileDetailed(
  trace: Trace,
  opts: { name?: string } = {},
): Promise<{ workflow: Workflow; derivedFrom: DerivedFrom }> {
  // With no TinyFish call that returned content there's nothing to replay; the compiler would only reproduce the explorer's reply
  // (typically "please tell me X") as a workflow that never touches the web.
  if (!trace.calls.some(returnedContent)) {
    const said = trace.notes || (typeof trace.final_text === "string" ? trace.final_text : "");
    throw new Error(
      `The explorer didn't look anything up on the web, so there's nothing to turn into a workflow.` +
        `${said ? ` It said: "${said.slice(0, 300)}"` : ""} Add the missing details to the task and try again.`,
    );
  }
  const example = fs.readFileSync(path.join(SEEDS_DIR, "competitor_pricing.json"), "utf8");
  const existing = listWorkflows().map((w) => w.name);
  const prompt = [
    `<goal>\n${trace.goal}\n</goal>`,
    `<trace>\n${JSON.stringify(summarize(trace.calls.map((c, index) => ({ index, ...c }))), null, 2)}\n</trace>`,
    `<submitted_answer>\n${JSON.stringify(summarize(trace.answer ?? trace.final_text), null, 2)}\n</submitted_answer>`,
    trace.notes ? `<explorer_notes>\n${trace.notes}\n</explorer_notes>` : "",
    trace.example
      ? `<example_run>\nThe goal was generic, so the trace explored one example: "${trace.example.task}" ` +
        `(example input: ${trace.example.assumed}). Make that input a param whose default is the example.` +
        `${trace.example.not_done ? ` Not done by this workflow (the web layer can only read): ${trace.example.not_done}.` : ""}\n</example_run>`
      : "",
    `<workflow_schema>\n${JSON.stringify(geminiSchema(z.toJSONSchema(WorkflowSchema, { io: "input" })))}\n</workflow_schema>`,
    `<example_workflow>\n${example}\n</example_workflow>`,
    opts.name
      ? `Name the workflow "${opts.name}".`
      : `Pick a short snake_case name. Existing workflows: ${existing.join(", ") || "(none)"}. Reuse a name only if this is the same task.`,
    "Compile this trace into a workflow. Reply with the workflow JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
  let compiled: Workflow | undefined;
  let derivedFrom: DerivedFrom = {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !compiled; attempt++) {
    const response = await generate({
      model: MODEL,
      contents,
      config: { systemInstruction: SYSTEM, responseMimeType: "application/json" },
    });
    const content = candidateContent(response);
    contents.push(content);
    let errors: string[];
    try {
      const { derived_from, ...draft } = JSON.parse(textOf(content)) as Record<string, unknown>;
      const result = validateWorkflow(draft);
      if (result.ok) {
        compiled = result.workflow;
        derivedFrom = parseDerivedFrom(derived_from, compiled, trace.calls.length);
        break;
      }
      errors = result.errors;
    } catch (err) {
      errors = [`Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }
    log(`  compile: attempt ${attempt} failed validation (${errors.length} errors)`);
    contents.push({
      role: "user",
      parts: [{ text: `Validation failed:\n- ${errors.join("\n- ")}\n\nReply with the corrected complete workflow JSON.` }],
    });
  }
  if (!compiled) throw new Error(`Compiler didn't produce a valid workflow in ${MAX_ATTEMPTS} attempts.`);

  compiled.source = { goal: trace.goal, trace_id: trace.id, created_at: new Date().toISOString() };
  return { workflow: compiled, derivedFrom };
}

/** explore -> compile -> save. The full "learn" loop used by the CLI and the MCP server. */
export async function learn(goal: string, opts: { name?: string } = {}) {
  log("Exploring...");
  const trace = await explore(goal);
  log(`Explored with ${trace.calls.length} tool calls (trace ${trace.id}). Compiling...`);
  const workflow = saveWorkflow(await compile(trace, opts), "learned");
  log(`Saved ${workflow.name} v${workflow.version}.`);
  return { trace, workflow };
}
