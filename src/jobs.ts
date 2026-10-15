// Job registry. Long work (learning, runs, repairs) runs as a job; clients subscribe to its events.
// Events are kept in memory (fast path when the subscriber is on the same server) and also written to the store,
// so on serverless hosts (Vercel) any instance can stream them. There, the route that starts a job keeps it running
// with after(job.done). In-memory copies are dropped 30 minutes after the job finishes.
// A job belongs to the owner who started it (see runAs in src/store.ts) and is invisible to everyone else; its body
// runs as that owner, so the workflows, runs and traces it saves are theirs.

import { compileDetailed } from "./compile.js";
import { log } from "./env.js";
import { runWorkflowDef } from "./executor.js";
import { explore } from "./explore.js";
import type { EditTurn } from "./edit.js";
import { withNotices } from "./progress.js";
import { repairAndVerify } from "./repair.js";
import type { Workflow } from "./schema.js";
import type { JobInfo, RunRecord } from "./store/types.js";
import { currentOwner, jobStore, newId } from "./store.js";

export type JobEvent = { kind: string; [key: string]: unknown };
type Listener = (e: JobEvent) => void;

export interface Job {
  id: string;
  type: "learn" | "run" | "repair" | "test";
  owner: string;
  status: "running" | "done" | "error";
  created_at: string;
  events: JobEvent[];
  listeners: Set<Listener>;
  finishedAt?: number;
  /** Resolves when the job has finished and every event is stored. Pass to after() in route handlers. */
  done: Promise<void>;
}

const EXPIRE_MS = 30 * 60_000;
const TERMINAL = new Set(["done", "error"]);

// Kept on globalThis so Next.js dev reloads don't orphan running jobs.
const g = globalThis as typeof globalThis & { __wfmJobs?: Map<string, Job> };
const jobs = (g.__wfmJobs ??= new Map<string, Job>());

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > EXPIRE_MS) jobs.delete(id);
}

/** The current owner's in-memory job, if it runs (or recently ran) on this server instance. */
export function getJob(id: string): Job | undefined {
  sweep();
  const job = jobs.get(id);
  return job?.owner === currentOwner() ? job : undefined;
}

/** Replays buffered events, then streams new ones. Returns an unsubscribe function. */
export function subscribe(job: Job, listener: Listener): () => void {
  for (const e of job.events) listener(e);
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

const POLL_MS = 1_000;
/** A running job touches its row this often; see startJob. */
const HEARTBEAT_MS = 20_000;
/**
 * A "running" job with no heartbeat for this long has lost its process (on Vercel: killed at the function's
 * maxDuration, so the done/error event was never written). Several missed heartbeats, so a slow store isn't enough.
 */
const STALE_MS = 90_000;
/** How often a store follower re-reads the job row while no events arrive. */
const CHECK_MS = 10_000;

/**
 * Longest a job may run, or 0 for no limit. On Vercel a function is killed at its maxDuration (300 s for the job
 * routes in web/app/api), so jobs stop themselves a little before that: they record a proper error and cancel any
 * running agent instead of being cut off mid-write. Override with WM_JOB_TIME_LIMIT_MS.
 */
const TIME_LIMIT_MS = Number(process.env.WM_JOB_TIME_LIMIT_MS) || (process.env.VERCEL ? 300_000 : 0);
/** Time kept back from the limit to store the final events and cancel agent runs. */
const WRAP_UP_MS = 20_000;

export const INTERRUPTED_MESSAGE =
  "The server running this stopped before it finished (most likely it hit its time limit), so it won't complete. Start it again.";

/**
 * The event a store follower should end with when the job's row says it's over but no done/error event will come:
 * its process died while "running", or its terminal event failed to store. Undefined while the job is alive.
 * Only call this with a row read before the latest events read: the status is written after the final event.
 */
export function endedWithoutEvent(info: JobInfo, now = Date.now()): JobEvent | undefined {
  if (info.status === "done") return { kind: "done" };
  if (info.status === "error") return { kind: "error", message: "This job failed, but its error wasn't recorded." };
  const lastSeen = Date.parse(info.updated_at ?? info.created_at);
  return now - lastSeen > STALE_MS ? { kind: "error", message: INTERRUPTED_MESSAGE, interrupted: true } : undefined;
}

/**
 * Streams a job's events from the start: from memory when the job is on this instance, otherwise by polling the
 * store. Resolves "not_found" if no such job exists, "finished" after its done/error event, "stopped" when `signal`
 * aborts or `maxMs` passes (clients reconnect and get the history again).
 */
export async function followJob(
  id: string,
  listener: Listener,
  opts: { signal?: AbortSignal; maxMs?: number } = {},
): Promise<"not_found" | "finished" | "stopped"> {
  const deadline = Date.now() + (opts.maxMs ?? Infinity);
  const local = getJob(id);
  if (local) {
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const finish = (how: "finished" | "stopped") => {
        clearTimeout(timer);
        unsubscribe();
        resolve(how);
      };
      const timer = setTimeout(() => finish("stopped"), Math.min(deadline - Date.now(), 2 ** 31 - 1));
      opts.signal?.addEventListener("abort", () => finish("stopped"));
      unsubscribe = subscribe(local, (e) => {
        listener(e);
        if (TERMINAL.has(e.kind)) queueMicrotask(() => finish("finished"));
      });
    });
  }
  const store = jobStore();
  let info = await store.getJobInfo(id);
  if (!info) return "not_found";
  let checkedAt = Date.now();
  let after = 0;
  while (!opts.signal?.aborted && Date.now() < deadline) {
    // Re-read the row before the events: the final status is stored after the final event, so a terminal status seen
    // here means that event (if it was stored at all) is in the read below.
    if (Date.now() - checkedAt >= CHECK_MS) {
      info = (await store.getJobInfo(id)) ?? info;
      checkedAt = Date.now();
    }
    for (const row of await store.jobEvents(id, after)) {
      after = row.seq;
      const e = row.event as JobEvent;
      listener(e);
      if (TERMINAL.has(e.kind)) return "finished";
    }
    const ended = endedWithoutEvent(info);
    if (ended) {
      listener(ended);
      return "finished";
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return "stopped";
}

/**
 * Runs `body` in the background as a job; a thrown error becomes an `error` event, success ends with `done`.
 * Store writes are chained so events land in order; a failed write is logged, not fatal to the job.
 * With a time limit (see TIME_LIMIT_MS; `opts.stopAfterMs` overrides it), the job ends with an error when the limit
 * is reached and its stop signal aborts, so agent runs inside it are cancelled (see jobSignal). Events the body
 * sends after the job has ended are dropped.
 */
export function startJob(
  type: Job["type"],
  body: (emit: (e: JobEvent) => void) => Promise<void>,
  opts: { stopAfterMs?: number } = {},
): Job {
  sweep();
  const created_at = new Date().toISOString();
  const job: Job = {
    id: newId(), type, owner: currentOwner(), status: "running", created_at, events: [], listeners: new Set(), done: Promise.resolve(),
  };
  jobs.set(job.id, job);
  const store = jobStore();
  let persisted: Promise<unknown> = store.createJob({ id: job.id, type, status: "running", created_at });
  const persist = (write: () => Promise<unknown>) => {
    persisted = persisted.then(write).catch((err) => log(`job ${job.id}: couldn't store an event: ${err instanceof Error ? err.message : err}`));
  };
  // While this process runs the job, keep its row fresh; followers on other instances take a stale row to mean the
  // process died (see endedWithoutEvent).
  const heartbeat = setInterval(() => persist(() => store.touchJob(job.id)), HEARTBEAT_MS);
  heartbeat.unref?.();
  const stopAfterMs = opts.stopAfterMs ?? (TIME_LIMIT_MS && Math.max(TIME_LIMIT_MS - WRAP_UP_MS, 1_000));
  const stop = new AbortController();
  const limit = stopAfterMs
    ? setTimeout(() => {
        const minutes = Math.round((TIME_LIMIT_MS || stopAfterMs) / 6_000) / 10;
        stop.abort(
          new Error(
            `This took longer than the ${minutes}-minute limit for one job on this server, so it was stopped (running browser agents were cancelled). ` +
              "Try fewer items, or run it from the CLI, which has no limit.",
          ),
        );
      }, stopAfterMs)
    : undefined;
  limit?.unref?.();
  const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
  stopped.catch(() => {}); // only observed through the race below
  let ended = false;
  const send = (e: JobEvent) => {
    if (ended) return;
    if (TERMINAL.has(e.kind)) ended = true;
    job.events.push(e);
    const seq = job.events.length;
    persist(() => store.appendJobEvent(job.id, seq, e));
    for (const l of job.listeners) l(e);
  };
  // Waits inside Gemini/TinyFish calls (rate limits, model fallback) show up as "notice" events.
  const work = Promise.race([withNotices((message) => send({ kind: "notice", message }), () => body(send), stop.signal), stopped])
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
      clearTimeout(limit);
      clearInterval(heartbeat);
      job.finishedAt = Date.now();
      persist(() => store.setJobStatus(job.id, job.status));
    });
  job.done = work.then(() => persisted).then(() => undefined);
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
