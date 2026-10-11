// Phase 2: turn an exploration trace into a reusable, parameterized workflow.

import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { z } from "zod";
import { anthropic, FALLBACK } from "./claude.js";
import { log, MODEL, SEEDS_DIR } from "./env.js";
import { explore, type Trace } from "./explore.js";
import { validateWorkflow, WorkflowSchema, type Workflow } from "./schema.js";
import { listWorkflows, saveWorkflow } from "./store.js";

const SUMMARY_TEXT = 1_500; // chars of each tool output shown to the compiler; it needs shapes, not content

function summarize(value: unknown, n = SUMMARY_TEXT): unknown {
  if (typeof value === "string") return value.length > n ? `${value.slice(0, n)}...[${value.length - n} more chars]` : value;
  if (Array.isArray(value)) return value.map((v) => summarize(v, n));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, n)]));
  return value;
}

const SYSTEM = `You compile a recorded web-task trace into a reusable workflow: a JSON definition that a deterministic
runner executes without an LLM in the loop (except inside "extract" steps). Reruns must be fast and cheap.

Step types:
- search  {query, purpose?, include_domains?, domain_type?} -> {query, results: [{title, url, snippet, ...}]}
- fetch   {urls (template or list), purpose?, format?, links?} -> {results: [{url, final_url, title, text, links?}], errors: [...]}
- agent   {url, goal, output_schema?, browser_profile?, max_steps?} -> the agent's structured result (slow, costs credits)
- extract {input, instruction, output_schema} -> JSON matching output_schema, produced by a small Claude call

Every step has: id (snake_case), description?, forEach?, concurrency?, checks?.
forEach is a template resolving to an array; the step runs per element with {{item}} bound, and its output is an array.

Templates: {{params.name}}, {{steps.<id>.<path>}}, {{previous.<id>.<path>}} (same step's output from the last successful run),
{{item.<path>}}. Paths are dotted, numeric segments index arrays, "*" maps over arrays ({{steps.s.results.*.url}}).
A string that is exactly one {{...}} keeps the raw value (arrays/objects); otherwise values are interpolated as text.

Checks (run on each step output, or each item's output under forEach): not_empty, min_items {value}, required_keys {keys},
regex {pattern}; each takes an optional dotted path. A failed check flags the run for repair, so write checks that catch
real breakage (empty extraction, missing prices), not ones that fail on legitimate variation.

Compile guidelines:
1. Parameterize. Lift the concrete things the user named (companies, URLs, queries, dates, counts) into params,
   with defaults equal to the values in this trace so the workflow reproduces the original task with no arguments.
2. Replay only what produced the answer. Drop dead ends, failed calls and redundant lookups.
3. Make it cheaper than the trace. Batch URLs into one fetch. Prefer fetch + extract over agent. Keep an agent step only
   where the trace showed fetch couldn't get the data. If search was used only to discover a stable URL, fetch that URL
   directly (as a param default) instead of searching on every run.
4. Shape the output with the top-level "output" template so it matches the answer the trace submitted.
5. Call save_workflow with the complete workflow. If it returns validation errors, fix them and call it again.`;

export async function compile(trace: Trace, opts: { name?: string } = {}): Promise<Workflow> {
  const example = fs.readFileSync(path.join(SEEDS_DIR, "competitor_pricing.json"), "utf8");
  const existing = listWorkflows().map((w) => w.name);
  let compiled: Workflow | undefined;

  const saveTool = betaTool({
    name: "save_workflow",
    description: "Validate the compiled workflow. Returns 'saved' or a list of errors to fix.",
    inputSchema: z.toJSONSchema(WorkflowSchema, { io: "input" }) as { type: "object" },
    run: async (input) => {
      const result = validateWorkflow(input);
      if (!result.ok) {
        log(`  compile: validation failed (${result.errors.length} errors), retrying`);
        return `Validation failed:\n- ${result.errors.join("\n- ")}`;
      }
      compiled = result.workflow;
      return "saved";
    },
  });

  const prompt = [
    `<goal>\n${trace.goal}\n</goal>`,
    `<trace>\n${JSON.stringify(summarize(trace.calls), null, 2)}\n</trace>`,
    `<submitted_answer>\n${JSON.stringify(summarize(trace.answer ?? trace.final_text), null, 2)}\n</submitted_answer>`,
    trace.notes ? `<explorer_notes>\n${trace.notes}\n</explorer_notes>` : "",
    `<example_workflow>\n${example}\n</example_workflow>`,
    opts.name
      ? `Name the workflow "${opts.name}".`
      : `Pick a short snake_case name. Existing workflows: ${existing.join(", ") || "(none)"}. Reuse a name only if this is the same task.`,
    "Compile this trace into a workflow and call save_workflow.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "medium" },
    max_iterations: 6,
    system: SYSTEM,
    tools: [saveTool],
    messages: [{ role: "user", content: prompt }],
  });

  let final: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) final = message;
  if (final?.stop_reason === "refusal") throw new Error("Compilation was declined (refusal).");
  if (!compiled) throw new Error("Compiler finished without producing a valid workflow.");

  compiled.source = { goal: trace.goal, trace_id: trace.id, created_at: new Date().toISOString() };
  return compiled;
}

/** explore -> compile -> save. The full "learn" loop used by the CLI and the MCP server. */
export async function learn(goal: string, opts: { name?: string } = {}) {
  log("Exploring...");
  const trace = await explore(goal);
  log(`Explored with ${trace.calls.length} tool calls (trace ${trace.id}). Compiling...`);
  const workflow = saveWorkflow(await compile(trace, opts));
  log(`Saved ${workflow.name} v${workflow.version}.`);
  return { trace, workflow };
}
