// Deterministic runner: executes a saved workflow step by step, runs checks, records run history.
// No LLM decides anything here; Gemini is only called inside `extract` steps.

import { extract } from "./llm.js";
import { log } from "./env.js";
import { parameterize, type Check, type Param, type Step, type Workflow } from "./schema.js";
import { getWorkflow, lastSuccessfulRun, newId, saveRun, type CheckResult, type RunRecord, type StepRecord } from "./store.js";
import { getPath, resolve, type TemplateContext } from "./template.js";
import { fetchPages, runAgent, search } from "./tinyfish.js";

export interface RunOptions {
  version?: number;
  /** Called as each step starts/finishes, for CLIs and UIs. */
  onEvent?: (e: { type: "step_start" | "step_end"; step: string; record?: StepRecord }) => void;
}

// ---------- params ----------

function coerce(name: string, spec: Param, raw: unknown): unknown {
  if (raw === undefined) return raw;
  switch (spec.type) {
    case "string[]":
      if (Array.isArray(raw)) return raw.map(String);
      return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`Param "${name}" must be a number, got ${JSON.stringify(raw)}`);
      return n;
    }
    case "boolean":
      return raw === true || raw === "true" || raw === "1";
    default:
      return String(raw);
  }
}

export function resolveParams(wf: Workflow, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(wf.params)) {
    const value = coerce(name, spec, input[name] ?? spec.default);
    if (value === undefined && spec.required !== false) {
      throw new Error(`Missing required param "${name}" (${spec.type}): ${spec.description}`);
    }
    out[name] = value;
  }
  const unknown = Object.keys(input).filter((k) => !(k in wf.params));
  if (unknown.length) throw new Error(`Unknown params: ${unknown.join(", ")}. Expected: ${Object.keys(wf.params).join(", ")}`);
  return out;
}

// ---------- checks ----------

function describe(c: Check): string {
  const at = c.path ? ` at ${c.path}` : "";
  switch (c.type) {
    case "not_empty":
      return `not_empty${at}`;
    case "min_items":
      return `min_items(${c.value})${at}`;
    case "required_keys":
      return `required_keys(${c.keys.join(",")})${at}`;
    case "regex":
      return `regex(${c.pattern})${at}`;
  }
}

function isEmpty(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function runCheck(c: Check, output: unknown): CheckResult {
  const v = c.path ? getPath(output, c.path.split(".")) : output;
  const name = describe(c);
  switch (c.type) {
    case "not_empty":
      return isEmpty(v) ? { check: name, passed: false, message: "value is empty" } : { check: name, passed: true };
    case "min_items": {
      const n = Array.isArray(v) ? v.length : -1;
      return n >= c.value
        ? { check: name, passed: true }
        : { check: name, passed: false, message: n < 0 ? "value is not an array" : `got ${n} items` };
    }
    case "required_keys": {
      const missing =
        v && typeof v === "object" ? c.keys.filter((k) => isEmpty((v as Record<string, unknown>)[k])) : c.keys;
      return missing.length ? { check: name, passed: false, message: `missing: ${missing.join(", ")}` } : { check: name, passed: true };
    }
    case "regex": {
      const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
      return new RegExp(c.pattern).test(s)
        ? { check: name, passed: true }
        : { check: name, passed: false, message: "pattern did not match" };
    }
  }
}

// ---------- steps ----------

async function runOnce(step: Step, ctx: TemplateContext, meta: Record<string, unknown>): Promise<unknown> {
  switch (step.type) {
    case "search": {
      const r = await search({
        query: resolve<string>(step.query, ctx),
        purpose: step.purpose && resolve<string>(step.purpose, ctx),
        include_domains: step.include_domains && resolve<string>(step.include_domains, ctx),
        domain_type: step.domain_type,
      });
      return { query: r.query, results: r.results };
    }
    case "fetch": {
      const resolved = resolve<unknown>(step.urls, ctx);
      // Drop empty values before stringifying, so a wrong path fails here instead of fetching "https://undefined".
      const urls = (Array.isArray(resolved) ? resolved.flat() : [resolved])
        .filter((u) => u !== undefined && u !== null && u !== "")
        .map(String);
      if (!urls.length) {
        throw new Error(`fetch urls ${JSON.stringify(step.urls)} resolved to no URLs (got ${JSON.stringify(resolved) ?? "undefined"}); check the template path`);
      }
      const r = await fetchPages({
        urls,
        purpose: step.purpose && resolve<string>(step.purpose, ctx),
        format: step.format,
        links: step.links,
      });
      return { results: r.results, errors: r.errors };
    }
    case "agent": {
      const run = await runAgent(
        {
          url: resolve<string>(step.url, ctx),
          goal: resolve<string>(step.goal, ctx),
          output_schema: step.output_schema,
          browser_profile: step.browser_profile,
          max_steps: step.max_steps,
        },
        { onProgress: (r) => log(`    [agent ${r.run_id}] ${r.status}, ${r.steps?.length ?? 0} steps`) },
      );
      meta.agent_runs = [...((meta.agent_runs as unknown[]) ?? []), { run_id: run.run_id, steps: run.num_of_steps }];
      if (run.status !== "COMPLETED") {
        throw new Error(`agent run ${run.run_id} ${run.status}: ${run.error?.message ?? "no result"}`);
      }
      return run.result;
    }
    case "extract": {
      const input = resolve<unknown>(step.input, ctx);
      const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      if (!text.trim()) throw new Error("extract step input is empty");
      const { value, usage, model } = await extract({
        input: text,
        instruction: resolve<string>(step.instruction, ctx),
        schema: step.output_schema,
      });
      const tokens = (meta.tokens as { input: number; output: number }) ?? { input: 0, output: 0 };
      meta.tokens = { input: tokens.input + usage.input, output: tokens.output + usage.output };
      meta.models = [...new Set([...((meta.models as string[]) ?? []), model])];
      return value;
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runStep(step: Step, ctx: TemplateContext): Promise<StepRecord> {
  const startedAt = Date.now();
  const meta: Record<string, unknown> = {};
  const record: StepRecord = {
    id: step.id,
    type: step.type,
    status: "ok",
    started_at: new Date(startedAt).toISOString(),
    duration_ms: 0,
    checks: [],
  };
  try {
    if (step.forEach !== undefined) {
      const items = resolve<unknown>(step.forEach, ctx);
      if (!Array.isArray(items)) throw new Error(`forEach did not resolve to an array (got ${typeof items})`);
      const outputs = await mapLimit(items, step.concurrency ?? 4, (item) => runOnce(step, { ...ctx, item }, meta));
      record.output = outputs;
      for (const [i, out] of outputs.entries()) {
        for (const c of step.checks ?? []) {
          const r = runCheck(c, out);
          record.checks.push({ ...r, check: `[${i}] ${r.check}` });
        }
      }
    } else {
      record.output = await runOnce(step, ctx, meta);
      record.checks = (step.checks ?? []).map((c) => runCheck(c, record.output));
    }
    if (record.checks.some((c) => !c.passed)) record.status = "check_failed";
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
  }
  record.duration_ms = Date.now() - startedAt;
  if (Object.keys(meta).length) record.meta = meta;
  return record;
}

// ---------- workflow ----------

export async function runWorkflow(name: string, input: Record<string, unknown>, opts: RunOptions = {}): Promise<RunRecord> {
  const wf = await getWorkflow(name, opts.version);
  if (!wf) throw new Error(`No workflow named "${name}"${opts.version ? ` v${opts.version}` : ""}`);
  return runWorkflowDef(wf, input, opts);
}

/** Runs a workflow definition directly (used by `learn --run` before/after saving). */
export async function runWorkflowDef(saved: Workflow, input: Record<string, unknown>, opts: RunOptions = {}): Promise<RunRecord> {
  // Workflows saved before parameterize() existed may still name their example inputs literally; runs follow params.
  const wf = parameterize(saved);
  const params = resolveParams(wf, input);
  const prev = await lastSuccessfulRun(wf.name);
  const ctx: TemplateContext = {
    params,
    steps: {},
    previous: Object.fromEntries((prev?.steps ?? []).map((s) => [s.id, s.output])),
  };

  const started = Date.now();
  const run: RunRecord = {
    run_id: newId(),
    workflow: wf.name,
    version: wf.version ?? 0,
    params,
    status: "ok",
    started_at: new Date(started).toISOString(),
    finished_at: "",
    duration_ms: 0,
    steps: [],
  };

  for (const step of wf.steps) {
    opts.onEvent?.({ type: "step_start", step: step.id });
    const record = await runStep(step, ctx);
    run.steps.push(record);
    ctx.steps[step.id] = record.output;
    opts.onEvent?.({ type: "step_end", step: step.id, record });
    if (record.status === "error") {
      run.status = "error";
      run.error = `step ${step.id}: ${record.error}`;
      break;
    }
    // A failed check doesn't stop the run (later steps may still be useful), but marks it for repair.
    if (record.status === "check_failed") run.status = "check_failed";
  }

  if (run.status !== "error") {
    try {
      run.output = wf.output !== undefined ? resolve(wf.output, ctx) : ctx.steps[wf.steps.at(-1)!.id];
      // Steps produced data but the output template picked none of it: a wrong path, not a passing run.
      const empty = (v: unknown): boolean =>
        v === undefined || v === null || v === "" || (typeof v === "object" && !Array.isArray(v) && Object.values(v).every(empty));
      if (empty(run.output) && run.steps.some((s) => s.output !== undefined && s.output !== null)) {
        run.status = "error";
        run.error = `output: ${JSON.stringify(wf.output)} resolved to nothing although the steps produced data; check the template path`;
      }
    } catch (err) {
      run.status = "error";
      run.error = `output: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  run.finished_at = new Date().toISOString();
  run.duration_ms = Date.now() - started;
  if (wf.version) await saveRun(run);
  return run;
}
