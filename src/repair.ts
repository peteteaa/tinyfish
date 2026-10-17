// Repair: a run's checks failed (or a step errored). Gemini reads the evidence from the run record (the failing
// step's inputs and outputs) and proposes a fixed workflow. Like edits, nothing is saved here; the caller reviews
// the proposal and saves it as the next version with source.repaired_from set.

import { summarize } from "./compile.js";
import { diffWorkflows, hasChanges } from "./diff.js";
import { editWorkflow, type EditResult, type EditTurn } from "./edit.js";
import { log } from "./env.js";
import { isTransientGeminiError } from "./llm.js";
import { coerce, resolveParams, runWorkflowDef } from "./executor.js";
import type { Step, Workflow } from "./schema.js";
import type { RunRecord, StepRecord } from "./store/types.js";
import { resolve, type TemplateContext } from "./template.js";

const RULES = `Repairing a failed run:
You also get <run_evidence> from a run where a step's checks failed or the step errored: the failing step, the
failed checks, the inputs it read and what it produced. Diagnose why it failed, then fix the workflow so the next
run passes for the right reason.
- Bad inputs (a URL that isn't the page with the data, a landing page with no listings, a 404, a page whose fetched
  text doesn't contain the data): fix the upstream step or the param default, e.g. point at the page that has the
  data or drop a source that can't work. Use an agent step only if fetched text clearly can't contain the data.
- A wrong step (instruction too narrow, input template missing fields such as the title, schema that doesn't fit the
  content): fix that step.
- Data that is legitimately absent for some items (e.g. most sources returned listings but one careers page has no
  openings today): relax that check so it tolerates the variation, but keep checks that catch real breakage. Relax
  a check only when other items passed it; if every item failed, the workflow or its inputs are broken.
- The check was right and the run's params were wrong (e.g. the user passed a homepage instead of a pricing page):
  keep the check exactly as it is. Improve the param description (and its default, if the default is the bad
  value) so the right input is clear, and say plainly in "reply" what to pass instead.
- Never weaken or delete a check just to make a run pass, on any step.
- Write template paths against the real output shapes in <run_evidence> ("shape" on each upstream step). A step with
  forEach outputs an array with one entry per item, so paths into it start with "*" or an index.
- If <run_evidence> comes from a test of your previous fix, that fix did not work: read the new failure and change
  your approach rather than repeating it.
In "reply", say in one or two plain sentences what went wrong and what you changed.`;

const TEXT_LIMIT = 1_200; // chars of each string in evidence; enough to see whether the data is on the page
const MAX_ITEMS = 6; // failing forEach items shown

function refsTo(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const m of value.matchAll(/\{\{\s*steps\.([a-z][a-z0-9_]*)/g)) out.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => refsTo(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => refsTo(v, out));
  return out;
}

/** Compact type outline of a value, e.g. 'array[1] of {query: string, results: array[5] of {title: string, url: string}}'. */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return value.length ? `array[${value.length}] of ${shapeOf(value[0], depth + 1)}` : "array[0]";
  if (typeof value === "object") {
    if (depth >= 4) return "{...}";
    const entries = Object.entries(value).slice(0, 12);
    return `{${entries.map(([k, v]) => `${k}: ${shapeOf(v, depth + 1)}`).join(", ")}}`;
  }
  return typeof value;
}

/** Indices of forEach items with a failed check; check names look like "[3] min_items(1) at plans". */
function failedIndices(record: RunRecord["steps"][number]): number[] {
  const out = new Set<number>();
  for (const c of record.checks) {
    const m = !c.passed && c.check.match(/^\[(\d+)\]/);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

export function runEvidence(workflow: Workflow, run: RunRecord, stepId: string): string {
  const record = run.steps.find((s) => s.id === stepId);
  if (!record) throw new Error(`Run ${run.run_id} has no step "${stepId}".`);
  const step: Step | undefined = workflow.steps.find((s) => s.id === stepId);
  const ctx: TemplateContext = { params: run.params, steps: Object.fromEntries(run.steps.map((s) => [s.id, s.output])), previous: {} };
  const upstream = [...refsTo(step ?? {})].map((id) => run.steps.find((s) => s.id === id)).filter((s) => s !== undefined);

  const evidence: Record<string, unknown> = {
    run: { run_id: run.run_id, version: run.version, params: run.params, status: run.status, error: run.error },
    step: { id: record.id, type: record.type, status: record.status, error: record.error },
    failed_checks: record.checks.filter((c) => !c.passed),
  };

  const failed = failedIndices(record);
  if (step?.forEach && failed.length && Array.isArray(record.output)) {
    let items: unknown[] = [];
    try {
      const resolved = resolve<unknown>(step.forEach, ctx);
      if (Array.isArray(resolved)) items = resolved;
    } catch {
      // Evidence is best effort; the outputs below still show what happened.
    }
    evidence.failing_items = failed.slice(0, MAX_ITEMS).map((i) => ({ index: i, item: items[i], output: (record.output as unknown[])[i] }));
    evidence.passing_items = record.output.length - failed.length;
  } else {
    evidence.output = record.output;
  }
  evidence.upstream_steps = upstream.map((s) => {
    const def = workflow.steps.find((d) => d.id === s.id);
    return { id: s.id, type: s.type, for_each: def?.forEach !== undefined, status: s.status, shape: shapeOf(s.output), output: s.output, error: s.error };
  });

  return `<run_evidence>\n${JSON.stringify(summarize(evidence, TEXT_LIMIT), null, 2)}\n</run_evidence>`;
}

/**
 * Rejects proposals that weaken the failing step's checks when no item passed them: then the check is doing its
 * job and the fix belongs in the inputs or the step. (Gemini tends to take the shortcut of relaxing the check.)
 */
export function guardChecks(before: Workflow, record: RunRecord["steps"][number], proposed: Workflow): string[] {
  const key = (c: unknown) => JSON.stringify(c, Object.keys((c ?? {}) as object).sort());
  // Checks on other steps aren't what failed, so a repair has no reason to drop them.
  const elsewhere = before.steps.flatMap((step) => {
    const after = workflowStep(proposed, step.id);
    if (step.id === record.id || !after) return [];
    const kept = new Set((after.checks ?? []).map(key));
    const dropped = (step.checks ?? []).filter((c) => !kept.has(key(c)));
    return dropped.length
      ? [`Keep the checks on "${step.id}" exactly as they were (they didn't fail): ${dropped.map((c) => JSON.stringify(c)).join(", ")}.`]
      : [];
  });
  if (elsewhere.length) return elsewhere;
  if (record.status !== "check_failed") return [];
  const items = Array.isArray(record.output) && workflowStep(before, record.id)?.forEach ? record.output.length : 1;
  const passing = items - failedIndices(record).length;
  if (record.checks.some((c) => !c.passed && !/^\[\d+\]/.test(c.check)) || passing <= 0) {
    const kept = new Set((workflowStep(proposed, record.id)?.checks ?? []).map(key));
    const dropped = (workflowStep(before, record.id)?.checks ?? []).filter((c) => !kept.has(key(c)));
    if (dropped.length) {
      return [
        `Every item failed the checks on "${record.id}", so the checks are catching real breakage. Keep these checks ` +
          `exactly as they were: ${dropped.map((c) => JSON.stringify(c)).join(", ")}. Fix the inputs, the step or the ` +
          `param descriptions instead, and if the run's params were the problem, say what to pass in "reply".`,
      ];
    }
  }
  return [];
}

const workflowStep = (wf: Workflow, id: string) => wf.steps.find((s) => s.id === id);

/** Proposes a fixed workflow for a failed step. `current` may carry unsaved edits; the run supplies the evidence. */
export async function repairWorkflow(current: Workflow, run: RunRecord, stepId: string, history: EditTurn[] = []): Promise<EditResult> {
  const record = run.steps.find((s) => s.id === stepId);
  if (!record) throw new Error(`Run ${run.run_id} has no step "${stepId}".`);
  // Every step passed but the run still errored: the workflow's output template picked nothing (or threw).
  const outputFailed = record.status === "ok" && run.status === "error" && run.steps.every((s) => s.status === "ok");
  if (record.status === "ok" && !outputFailed) throw new Error(`Step "${stepId}" passed in that run; there's nothing to repair.`);
  const where = run.version ? `In run ${run.run_id} (v${run.version})` : "In a test run of your previous fix";
  const request = outputFailed
    ? `Repair the workflow's output. ${where} every step passed, but the output failed: ${run.error ?? "unknown error"}. ` +
      `Fix the "output" template so it reads the real shape of "${stepId}".`
    : `Repair step "${stepId}". ${where} it ${record.status === "error" ? `errored: ${record.error ?? "unknown error"}` : "failed its checks"}.`;
  const result = await editWorkflow(current, request, history, {
    rules: RULES,
    context: runEvidence(current, run, stepId),
    validate: (proposed) => guardChecks(current, record, proposed),
  });
  if (result.changed) result.workflow.source = { ...result.workflow.source, repaired_from: run.version };
  return result;
}

// ---------- verified repair: propose, test-run, retry with the new evidence ----------

export type RepairEvent =
  | { kind: "repair_round"; round: number; step: string }
  | { kind: "repair_proposal"; round: number; reply: string; changed: boolean }
  | { kind: "test_step"; round: number; step: string; status?: StepRecord["status"] }
  | { kind: "test_done"; round: number; status: RunRecord["status"] | "invalid_params"; failed_step?: string; failures: string[] };

export interface VerifiedRepair extends EditResult {
  /** true: a test run passed. false: every fix tried still failed. null: not tested (no change proposed). */
  verified: boolean | null;
  rounds: number;
  test?: { status: string; failed_step?: string; failures: string[] };
  /** The test run of the returned fix (not saved to run history). */
  test_run?: RunRecord;
}

const firstFailed = (run: RunRecord) => run.steps.find((s) => s.status !== "ok");
const failureLines = (rec?: StepRecord) =>
  rec ? (rec.error ? [rec.error] : rec.checks.filter((c) => !c.passed).map((c) => `${c.check}${c.message ? `: ${c.message}` : ""}`)) : [];

/** How far a test run got: steps that passed before the first failure, then fewer failed checks. Higher is better. */
function progress(wf: Workflow, run: RunRecord): number {
  const failed = firstFailed(run);
  if (!failed) return run.status === "ok" ? Infinity : wf.steps.length * 1000 - 1; // every step passed, the output failed
  const at = wf.steps.findIndex((s) => s.id === failed.id);
  return at * 1000 - failureLines(failed).length;
}

/**
 * Proposes a fix, test-runs it with the failed run's params (not saved to run history), and if it still fails,
 * hands Gemini the test run as new evidence. Stops at the first passing fix or after `maxRounds`, returning the
 * fix that got furthest. Test runs make real TinyFish calls (agent steps cost credits).
 */
export async function repairAndVerify(
  current: Workflow,
  run: RunRecord,
  stepId: string,
  opts: { history?: EditTurn[]; maxRounds?: number; onEvent?: (e: RepairEvent) => void } = {},
): Promise<VerifiedRepair> {
  const maxRounds = opts.maxRounds ?? 3;
  const emit = opts.onEvent ?? (() => {});
  const history = [...(opts.history ?? [])];
  let base = current;
  let evidenceRun = run;
  let step = stepId;
  let best: { result: EditResult; score: number; test: VerifiedRepair["test"]; run: RunRecord; round: number } | undefined;
  // Later rounds edit the previous proposal, so their diff covers only that round; the user reviews every change.
  const againstCurrent = (r: EditResult): EditResult => {
    const diff = diffWorkflows(current.name, current, r.workflow, current.version ?? 0, current.version ?? 0);
    return { ...r, diff, changed: hasChanges(diff) };
  };
  // run.params holds resolved values, defaults included. Passing an old default back as explicit input would override
  // a fix that changes that default, so leave defaults out and let the proposal's own apply.
  const isDefault = (name: string, value: unknown) => {
    const spec = current.params[name];
    if (!spec || spec.default === undefined) return false;
    try {
      return JSON.stringify(coerce(name, spec, spec.default)) === JSON.stringify(value);
    } catch {
      return false;
    }
  };
  const runInput = Object.entries(run.params).filter(([k, v]) => v !== undefined && v !== null && !isDefault(k, v));

  for (let round = 1; round <= maxRounds; round++) {
    emit({ kind: "repair_round", round, step });
    const result = await repairWorkflow(base, evidenceRun, step, history);
    // Later rounds use a test run (version 0) as evidence; the fix is still for the run's version.
    if (result.changed) result.workflow.source = { ...result.workflow.source, repaired_from: run.version };
    emit({ kind: "repair_proposal", round, reply: result.reply, changed: result.changed });
    if (!result.changed) {
      // Gemini judged the workflow fine (e.g. the run's params were wrong). Return the previous best fix if any.
      if (best) break;
      return { ...againstCurrent(result), verified: null, rounds: round };
    }
    history.push({ role: "user", text: `Repair step "${step}".` }, { role: "assistant", text: result.reply });

    const { version: _v, ...unsaved } = result.workflow;
    const input = Object.fromEntries(runInput.filter(([k]) => k in unsaved.params));
    let test: RunRecord;
    try {
      resolveParams(unsaved, input);
      test = await runWorkflowDef(unsaved, input, {
        onEvent: (e) => emit({ kind: "test_step", round, step: e.step, status: e.record?.status }),
      });
    } catch (err) {
      // The fix needs a param the failed run didn't have; it can't be tested with those params.
      const message = err instanceof Error ? err.message : String(err);
      emit({ kind: "test_done", round, status: "invalid_params", failures: [message] });
      return { ...againstCurrent(result), verified: null, rounds: round, test: { status: "invalid_params", failures: [message] } };
    }
    const failed = firstFailed(test);
    // Every step can pass while the run errors at the output template; that's a failure too.
    const outputFailed = !failed && test.status !== "ok";
    const summary = outputFailed
      ? { status: test.status, failed_step: "output", failures: [test.error ?? "the output failed"] }
      : { status: test.status, failed_step: failed?.id, failures: failureLines(failed) };
    emit({ kind: "test_done", round, ...summary });
    // A rate limit or outage during the test says nothing about the fix; don't let Gemini "repair" it.
    if (failed?.error && (isTransientGeminiError(failed.error) || /\b(429|5\d\d)\b|rate.?limit|timed? ?out/i.test(failed.error))) {
      return {
        ...againstCurrent(result),
        reply: `${result.reply} I couldn't finish testing it: "${failed.id}" hit a temporary error (${failed.error.slice(0, 120)}). Try Test changes again in a minute.`,
        verified: null,
        rounds: round,
        test: summary,
      };
    }
    log(`  repair round ${round}: test ${test.status}${summary.failed_step ? ` at ${summary.failed_step}` : ""}`);

    const score = progress(unsaved, test);
    if (!best || score > best.score) best = { result, score, test: summary, run: test, round };
    if (test.status === "ok") return { ...againstCurrent(result), verified: true, rounds: round, test: summary, test_run: test };

    base = result.workflow;
    evidenceRun = test;
    // An output failure is repaired from the last step's evidence (repairWorkflow sees that every step passed).
    step = failed?.id ?? test.steps.at(-1)!.id;
  }

  const b = best!;
  const where = b.test?.failed_step ? ` at "${b.test.failed_step}" (${b.test.failures.slice(0, 2).join("; ")})` : "";
  return {
    ...againstCurrent(b.result),
    reply: `${b.result.reply} I tested this fix and it still fails${where}, so review it before saving.`,
    verified: false,
    rounds: b.round,
    test: b.test,
    test_run: b.run,
  };
}
