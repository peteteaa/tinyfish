// Benchmark harness: runs each task as a raw agent run (explore: Gemini + TinyFish tools, from scratch) and as a
// replay of the workflow learned from it, measuring both the same way (src/usage.ts) and grading both with the
// task's expectations (grade.ts). Also: daily replays with automatic repair, and fault injection (faults.ts).
//
// Learned workflows live in bench/workflows/<task>.json and results in bench/results/<kind>/<session>.json, both in
// the repo, so results are reviewable in git and the web dashboard (/bench) reads them without a database.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compile } from "../compile.js";
import { ROOT, log } from "../env.js";
import { runWorkflowDef } from "../executor.js";
import { explore } from "../explore.js";
import { FAST_MODEL, MODEL } from "../llm.js";
import { repairAndVerify } from "../repair.js";
import { validateWorkflow, type Workflow } from "../schema.js";
import { newId, type RunRecord } from "../store.js";
import { geminiCost, meter, type Usage } from "../usage.js";
import { FAULTS, type FaultName } from "./faults.js";
import { gradeOutput, type Grade } from "./grade.js";
import { loadSessions, regrade, RESULTS_DIR } from "./report.js";
import type { BenchTask } from "./tasks.js";

export const BENCH_DIR = path.join(ROOT, "bench");
const WORKFLOWS_DIR = path.join(BENCH_DIR, "workflows");

export type TrialKind = "learn" | "raw" | "replay";

export interface Trial {
  kind: TrialKind;
  task: string;
  category: BenchTask["category"];
  started_at: string;
  duration_ms: number;
  /** raw/learn: "ok" when the agent submitted an answer. replay: the run's status. */
  status: "ok" | "check_failed" | "error" | "no_answer";
  error?: string;
  grade: Grade;
  /** The workflow's own checks (replay only). */
  checks?: { passed: number; total: number };
  usage: Usage;
  cost_usd: number;
  /** TinyFish calls the agent made (raw/learn). */
  tool_calls?: number;
  trace_id?: string;
  run_id?: string;
  workflow_version?: number;
  output?: unknown;
}

export interface RepairRecord {
  task: string;
  category: BenchTask["category"];
  /** "daily" for a scheduled replay, otherwise the injected fault. */
  cause: "daily" | FaultName;
  /** The failing run graded as failed (a fault that didn't hurt the output is benign). */
  broke: boolean;
  /** The workflow noticed: a step errored or a check failed. Undetected breakage can't be repaired. */
  detected: boolean;
  failed_step?: string;
  repair?: {
    changed: boolean;
    verified: boolean | null;
    rounds: number;
    reply: string;
    duration_ms: number;
    usage: Usage;
    cost_usd: number;
    error?: string;
  };
  /** Replay of the repaired workflow, graded. */
  after?: Trial;
  healed: boolean;
  /** The repaired workflow replaced the saved one (daily --accept). */
  accepted?: boolean;
}

export interface Session {
  id: string;
  kind: "learn" | "compare" | "daily" | "drift";
  started_at: string;
  finished_at?: string;
  model: string;
  fast_model: string;
  git_sha?: string;
  options: Record<string, unknown>;
  trials: Trial[];
  repairs: RepairRecord[];
}

// ---------- files ----------

export function workflowFile(task: string) {
  return path.join(WORKFLOWS_DIR, `${task}.json`);
}

export function loadWorkflow(task: string): Workflow | undefined {
  const file = workflowFile(task);
  if (!fs.existsSync(file)) return undefined;
  const result = validateWorkflow(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!result.ok) throw new Error(`${file} is not a valid workflow:\n- ${result.errors.join("\n- ")}`);
  return result.workflow;
}

function saveBenchWorkflow(task: string, wf: Workflow) {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  fs.writeFileSync(workflowFile(task), `${JSON.stringify(wf, null, 2)}\n`);
}

function gitSha(): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function newSession(kind: Session["kind"], options: Record<string, unknown>): Session {
  return {
    id: newId(),
    kind,
    started_at: new Date().toISOString(),
    model: MODEL,
    fast_model: FAST_MODEL,
    git_sha: gitSha(),
    options,
    trials: [],
    repairs: [],
  };
}

/** Written after every task, so a long run that dies still leaves its results. */
export function writeSession(s: Session) {
  const dir = path.join(RESULTS_DIR, s.kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.json`), `${JSON.stringify(s, null, 2)}\n`);
}

// ---------- trials ----------

const MAX_OUTPUT_CHARS = 20_000;
/** Keeps result files reviewable: big outputs are stored as a truncated JSON string. */
function keepOutput(output: unknown): unknown {
  const s = JSON.stringify(output ?? null);
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}...[truncated ${s.length - MAX_OUTPUT_CHARS} chars]` : output;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Explores the task from scratch. For "learn", also compiles the trace into a workflow (counted in the trial). */
async function agentTrial(task: BenchTask, kind: "raw" | "learn"): Promise<{ trial: Trial; workflow?: Workflow }> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let workflow: Workflow | undefined;
  let trace: Awaited<ReturnType<typeof explore>> | undefined;
  let error: string | undefined;
  const { usage } = await meter(async () => {
    try {
      trace = await explore(task.goal);
      if (kind === "learn") workflow = { ...(await compile(trace, { name: `bench_${task.id}` })), version: 1 };
    } catch (err) {
      error = message(err);
    }
  });
  const answered = trace?.answer !== undefined;
  return {
    workflow,
    trial: {
      kind,
      task: task.id,
      category: task.category,
      started_at: startedAt,
      duration_ms: Date.now() - started,
      status: error ? "error" : answered ? "ok" : "no_answer",
      ...(error && { error }),
      grade: gradeOutput(answered ? trace!.answer : null, task.expect),
      usage,
      cost_usd: geminiCost(usage),
      tool_calls: trace?.calls.length ?? 0,
      trace_id: trace?.id,
      output: keepOutput(trace?.answer),
    },
  };
}

export const rawTrial = async (task: BenchTask) => (await agentTrial(task, "raw")).trial;

export async function replayTrial(task: BenchTask, wf: Workflow): Promise<{ trial: Trial; run?: RunRecord }> {
  const started = Date.now();
  let run: RunRecord | undefined;
  let error: string | undefined;
  const { usage } = await meter(async () => {
    try {
      run = await runWorkflowDef(wf, {});
    } catch (err) {
      error = message(err);
    }
  });
  const checks = run?.steps.flatMap((s) => s.checks) ?? [];
  return {
    run,
    trial: {
      kind: "replay",
      task: task.id,
      category: task.category,
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      status: run?.status ?? "error",
      ...((error ?? run?.error) && { error: error ?? run?.error }),
      grade: gradeOutput(run?.status === "error" ? null : run?.output, task.expect),
      checks: { passed: checks.filter((c) => c.passed).length, total: checks.length },
      usage,
      cost_usd: geminiCost(usage),
      run_id: run?.run_id,
      workflow_version: wf.version,
      output: keepOutput(run?.output),
    },
  };
}

/** The step a repair should target: the first that failed, or the last when only the output template failed. */
function failingStep(run: RunRecord): string | undefined {
  const failed = run.steps.find((s) => s.status !== "ok");
  if (failed) return failed.id;
  return run.status === "error" ? run.steps.at(-1)?.id : undefined;
}

/** Repairs a failed replay (repairAndVerify), then replays the fix and grades it. */
async function repairTrial(
  task: BenchTask,
  wf: Workflow,
  failed: { trial: Trial; run?: RunRecord },
  cause: RepairRecord["cause"],
): Promise<{ record: RepairRecord; fixed?: Workflow }> {
  const record: RepairRecord = { task: task.id, category: task.category, cause, broke: !failed.trial.grade.passed, detected: false, healed: false };
  if (!record.broke) return { record };
  const step = failed.run && failingStep(failed.run);
  record.detected = !!step;
  if (!step || !failed.run) return { record };
  record.failed_step = step;

  const started = Date.now();
  let result: Awaited<ReturnType<typeof repairAndVerify>> | undefined;
  let error: string | undefined;
  const { usage } = await meter(async () => {
    try {
      result = await repairAndVerify(wf, failed.run!, step);
    } catch (err) {
      error = message(err);
    }
  });
  record.repair = {
    changed: result?.changed ?? false,
    verified: result?.verified ?? null,
    rounds: result?.rounds ?? 0,
    reply: result?.reply ?? "",
    duration_ms: Date.now() - started,
    usage,
    cost_usd: geminiCost(usage),
    ...(error && { error }),
  };
  if (!result?.changed) return { record };
  const fixed: Workflow = { ...result.workflow, version: (wf.version ?? 1) + 1 };
  record.after = (await replayTrial(task, fixed)).trial;
  record.healed = record.after.grade.passed;
  return { record, fixed };
}

// ---------- commands ----------

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const verdict = (t: Trial) => `${t.grade.passed ? "PASS" : "FAIL"} ${(t.duration_ms / 1000).toFixed(1)}s $${t.cost_usd.toFixed(4)}`;

/** Tasks whose most recent learn produced an answer that failed grading (what a user would see and redo). */
function failedLearns(): Set<string> {
  const latest = new Map<string, boolean>();
  for (const t of regrade(loadSessions()).filter((s) => s.kind === "learn").flatMap((s) => s.trials)) latest.set(t.task, t.grade.passed);
  return new Set([...latest].filter(([, passed]) => !passed).map(([task]) => task));
}

/**
 * Learns a workflow per task, skipping tasks that have one unless `force`, or unless `retryFailed` and the last
 * learn's answer failed grading. The learn trial is graded too; the report adds up every learn attempt's cost.
 */
export async function learnTasks(tasks: BenchTask[], opts: { force?: boolean; retryFailed?: boolean; concurrency: number }) {
  const session = newSession("learn", opts);
  const retry = opts.retryFailed ? failedLearns() : new Set<string>();
  await mapLimit(tasks, opts.concurrency, async (task) => {
    if (!opts.force && !retry.has(task.id) && loadWorkflow(task.id)) return log(`[${task.id}] already learned; --force to relearn`);
    log(`[${task.id}] learning...`);
    const { trial, workflow } = await agentTrial(task, "learn");
    session.trials.push(trial);
    if (workflow) saveBenchWorkflow(task.id, workflow);
    log(`[${task.id}] learn ${verdict(trial)}${workflow ? "" : ` (no workflow: ${trial.error ?? trial.status})`}`);
    writeSession(session);
  });
  session.finished_at = new Date().toISOString();
  writeSession(session);
  return session;
}

/** `trials` rounds per task of raw then replay, interleaved so both see the same pages at about the same time. */
export async function compareTasks(tasks: BenchTask[], opts: { trials: number; concurrency: number }) {
  const session = newSession("compare", opts);
  const ready = tasks.filter((t) => loadWorkflow(t.id) || (log(`[${t.id}] no workflow yet; run "bench learn" first`), false));
  await mapLimit(ready, opts.concurrency, async (task) => {
    const wf = loadWorkflow(task.id)!;
    for (let i = 1; i <= opts.trials; i++) {
      const raw = await rawTrial(task);
      session.trials.push(raw);
      log(`[${task.id}] ${i}/${opts.trials} raw    ${verdict(raw)}`);
      const { trial: replay } = await replayTrial(task, wf);
      session.trials.push(replay);
      log(`[${task.id}] ${i}/${opts.trials} replay ${verdict(replay)}`);
      writeSession(session);
    }
  });
  session.finished_at = new Date().toISOString();
  writeSession(session);
  return session;
}

/** One replay per task; a failed one goes to repair. With `accept`, a fix that passes grading replaces the workflow. */
export async function dailyTasks(tasks: BenchTask[], opts: { accept: boolean; concurrency: number }) {
  const session = newSession("daily", opts);
  const ready = tasks.filter((t) => loadWorkflow(t.id));
  await mapLimit(ready, opts.concurrency, async (task) => {
    const wf = loadWorkflow(task.id)!;
    const replay = await replayTrial(task, wf);
    session.trials.push(replay.trial);
    log(`[${task.id}] replay ${verdict(replay.trial)}`);
    if (!replay.trial.grade.passed) {
      const { record, fixed } = await repairTrial(task, wf, replay, "daily");
      if (fixed && record.healed && opts.accept) {
        saveBenchWorkflow(task.id, fixed);
        record.accepted = true;
      }
      session.repairs.push(record);
      log(`[${task.id}] repair: ${record.detected ? (record.healed ? "healed" : "not healed") : "failure not detected by checks"}`);
    }
    writeSession(session);
  });
  session.finished_at = new Date().toISOString();
  writeSession(session);
  return session;
}

/** Breaks each workflow with each fault, replays it, and lets repair fix it. Saved workflows are never changed. */
export async function driftTasks(tasks: BenchTask[], opts: { faults: FaultName[]; concurrency: number }) {
  const session = newSession("drift", opts);
  const ready = tasks.filter((t) => loadWorkflow(t.id));
  await mapLimit(ready, opts.concurrency, async (task) => {
    const wf = loadWorkflow(task.id)!;
    for (const fault of opts.faults) {
      const broken = FAULTS[fault](wf);
      if (!broken) {
        log(`[${task.id}] ${fault}: not applicable`);
        continue;
      }
      const replay = await replayTrial(task, broken);
      session.trials.push(replay.trial);
      const { record } = await repairTrial(task, broken, replay, fault);
      session.repairs.push(record);
      log(
        `[${task.id}] ${fault}: ${!record.broke ? "benign" : !record.detected ? "undetected" : record.healed ? "healed" : "not healed"}`,
      );
      writeSession(session);
    }
  });
  session.finished_at = new Date().toISOString();
  writeSession(session);
  return session;
}
