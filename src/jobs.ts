// In-process job registry. Long work (learning, runs) runs as a job in the server process; clients subscribe
// to its events. Every event is buffered so late or reconnecting subscribers get the full history first.
// Jobs are dropped from memory 30 minutes after they finish.

import { compileDetailed } from "./compile.js";
import { log } from "./env.js";
import { runWorkflowDef } from "./executor.js";
import { explore } from "./explore.js";
import type { EditTurn } from "./edit.js";
import { repairAndVerify } from "./repair.js";
import type { RunRecord } from "./store/types.js";
import type { Workflow } from "./schema.js";
import { withNotices } from "./progress.js";
import { newId } from "./store.js";

export type JobEvent = { kind: string; [key: string]: unknown };
type Listener = (e: JobEvent) => void;

export interface Job {
  id: string;
  type: "learn" | "run" | "repair" | "test";
  status: "running" | "done" | "error";
  created_at: string;
  events: JobEvent[];
  listeners: Set<Listener>;
  finishedAt?: number;
}

const EXPIRE_MS = 30 * 60_000;

// Kept on globalThis so Next.js dev reloads don't orphan running jobs.
const g = globalThis as typeof globalThis & { __wfmJobs?: Map<string, Job> };
const jobs = (g.__wfmJobs ??= new Map<string, Job>());

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > EXPIRE_MS) jobs.delete(id);
}

export function getJob(id: string): Job | undefined {
  sweep();
  return jobs.get(id);
}

function emit(job: Job, event: JobEvent) {
  job.events.push(event);
  for (const l of job.listeners) l(event);
}

/** Replays buffered events, then streams new ones. Returns an unsubscribe function. */
export function subscribe(job: Job, listener: Listener): () => void {
  for (const e of job.events) listener(e);
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

/** Runs `body` in the background as a job; a thrown error becomes an `error` event, success ends with `done`. */
export function startJob(type: Job["type"], body: (emit: (e: JobEvent) => void) => Promise<void>): Job {
  sweep();
  const job: Job = { id: newId(), type, status: "running", created_at: new Date().toISOString(), events: [], listeners: new Set() };
  jobs.set(job.id, job);
  const send = (e: JobEvent) => emit(job, e);
  // Waits inside Gemini/TinyFish calls (rate limits, model fallback) show up as "notice" events.
  withNotices((message) => send({ kind: "notice", message }), () => body(send))
    .then(() => {
      job.status = "done";
      send({ kind: "done" });
    })
    .catch((err) => {
      job.status = "error";
      const message = err instanceof Error ? err.message : String(err);
      log(`job ${job.id} failed: ${message}`);
      send({ kind: "error", message });
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

/**
 * Learn job: explore with TinyFish, then compile a draft workflow. The draft is not saved; the user reviews it
 * and saves it explicitly (POST /api/workflows).
 *
 * Events: started, trace_start, trace, answer, compiling, draft, error, done.
 */
export function startLearnJob(goal: string, opts: { name?: string } = {}): Job {
  return startJob("learn", async (send) => {
    const startedAt = Date.now();
    send({ kind: "started", goal });
    const trace = await explore(goal, {
      onTraceStart: (index, call) => send({ kind: "trace_start", index, ...call }),
      onTrace: (index, entry) => send({ kind: "trace", index, entry }),
    });
    send({ kind: "answer", answer: trace.answer ?? null, notes: trace.notes ?? null, text: trace.final_text ?? null });
    send({ kind: "compiling" });
    const { workflow, derivedFrom } = await compileDetailed(trace, opts);
    send({ kind: "draft", workflow, derived_from: derivedFrom, trace_id: trace.id, elapsed_ms: Date.now() - startedAt });
  });
}

/**
 * Run job: executes a saved workflow (already resolved and param-checked by the caller) and streams progress.
 *
 * Events: run_started, step_start, step_end, repair_available (a step's checks failed), run_done, error, done.
 */
export function startRunJob(workflow: Workflow, params: Record<string, unknown>): Job {
  return startJob("run", async (send) => {
    send({
      kind: "run_started",
      workflow: workflow.name,
      version: workflow.version ?? null,
      params,
      steps: workflow.steps.map((s) => ({ id: s.id, type: s.type, description: s.description ?? null })),
    });
    const run = await runWorkflowDef(workflow, params, {
      onEvent: (e) => {
        if (e.type === "step_start") send({ kind: "step_start", step: e.step });
        else if (e.record) {
          send({ kind: "step_end", step: e.step, record: e.record });
          // Repair hook (design doc 11.4): the UI offers "Repair this step" once self-repair exists.
          const failures = e.record.checks.filter((c) => !c.passed);
          if (failures.length) send({ kind: "repair_available", step: e.step, failures });
        }
      },
    });
    send({ kind: "run_done", run });
  });
}

/**
 * Repair job: Gemini proposes a fix for a failed step, the fix is test-run with the failed run's params (not saved),
 * and failures go back to Gemini, up to 3 rounds. Nothing is saved; the user reviews the result and saves it.
 *
 * Events: repair_round, repair_proposal, test_step, test_done, repair_result, error, done.
 */
export function startRepairJob(workflow: Workflow, run: RunRecord, step: string, history: EditTurn[] = []): Job {
  return startJob("repair", async (send) => {
    const result = await repairAndVerify(workflow, run, step, { history, onEvent: (e) => send(e) });
    send({ kind: "repair_result", ...result });
  });
}
