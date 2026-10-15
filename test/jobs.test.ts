import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-jobs-test-"));

const { endedWithoutEvent, followJob, getJob, INTERRUPTED_MESSAGE, startJob, subscribe } = await import("../src/jobs.js");
const { createStore, currentOwner, jobStore, runAs } = await import("../src/store.js");
type JobEvent = import("../src/jobs.js").JobEvent;

const finished = (job: { id: string }) =>
  new Promise<JobEvent[]>((resolve) => {
    const seen: JobEvent[] = [];
    const unsubscribe = subscribe(getJob(job.id)!, (e) => {
      seen.push(e);
      if (e.kind === "done" || e.kind === "error") {
        queueMicrotask(() => unsubscribe());
        resolve(seen);
      }
    });
  });

test("jobs: events are buffered, so a late subscriber gets the full history", async () => {
  const job = startJob("test", async (emit) => {
    emit({ kind: "step", n: 1 });
    await new Promise((r) => setTimeout(r, 20));
    emit({ kind: "step", n: 2 });
  });
  const live = finished(job);
  const liveEvents = await live;
  assert.deepEqual(liveEvents.map((e) => e.kind), ["step", "step", "done"]);
  assert.equal(job.status, "done");

  const late: JobEvent[] = [];
  subscribe(job, (e) => late.push(e));
  assert.deepEqual(late, liveEvents);
});

test("jobs: a thrown error becomes an error event", async () => {
  const job = startJob("test", async () => {
    throw new Error("boom");
  });
  const events = await finished(job);
  assert.deepEqual(events.at(-1), { kind: "error", message: "boom" });
  assert.equal(job.status, "error");
});

test("jobs: unknown ids are not found", () => {
  assert.equal(getJob("nope"), undefined);
});

test("jobs: notice() deep inside a job's async work becomes a notice event for that job only", async () => {
  const { notice } = await import("../src/progress.js");
  const job = startJob("test", async () => {
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([1, 2].map(async (n) => notice(`waiting ${n}`)));
  });
  const other = startJob("test", async () => {});
  const events = await finished(job);
  assert.deepEqual(events.filter((e) => e.kind === "notice").map((e) => e.message), ["waiting 1", "waiting 2"]);
  assert.ok(!(await finished(other)).some((e) => e.kind === "notice"));
  notice("outside any job is a no-op");
});

test("jobs: events and status are persisted to the store in order", async () => {
  const job = startJob("test", async (emit) => {
    emit({ kind: "step", n: 1 });
    emit({ kind: "step", n: 2 });
  });
  await job.done;
  const store = createStore("sqlite", process.env.WM_DATA_DIR!);
  const rows = await store.jobEvents(job.id, 0);
  assert.deepEqual(rows.map((r) => (r.event as JobEvent).kind), job.events.map((e) => e.kind));
  assert.deepEqual(rows.map((r) => r.event), job.events);
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => rows[0].seq + i));
  assert.equal((await store.getJobInfo(job.id))!.status, "done");
});

test("followJob: unknown id is not_found", async () => {
  assert.equal(await followJob("does-not-exist", () => {}), "not_found");
});

test("followJob: streams a job that only exists in the store", async () => {
  const id = `stored-${Date.now()}`;
  const store = jobStore();
  await store.createJob({ id, type: "test", status: "done", created_at: new Date().toISOString() });
  await store.appendJobEvent(id, 1, { kind: "step" });
  await store.appendJobEvent(id, 2, { kind: "done" });
  assert.equal(getJob(id), undefined);
  const seen: JobEvent[] = [];
  const how = await followJob(id, (e) => seen.push(e), { maxMs: 5000 });
  assert.equal(how, "finished");
  assert.deepEqual(seen.map((e) => e.kind), ["step", "done"]);
});

test("jobs: owned by whoever started them; invisible to other owners", async () => {
  let seenBefore: string | undefined;
  let seenAfter: string | undefined;
  const job = runAs("user_a", () =>
    startJob("test", async () => {
      seenBefore = currentOwner();
      await new Promise((r) => setTimeout(r, 5));
      seenAfter = currentOwner();
    }),
  );
  await job.done;
  assert.equal(job.owner, "user_a");
  assert.equal(job.status, "done");
  assert.equal(seenBefore, "user_a");
  assert.equal(seenAfter, "user_a");
  assert.equal(runAs("user_a", () => getJob(job.id)), job);
  assert.equal(runAs("user_b", () => getJob(job.id)), undefined);
  assert.equal(getJob(job.id), undefined);

  const seen: JobEvent[] = [];
  assert.equal(await runAs("user_b", () => followJob(job.id, (e) => seen.push(e), { maxMs: 100 })), "not_found");
  assert.equal(await followJob(job.id, (e) => seen.push(e), { maxMs: 100 }), "not_found");
  assert.equal(seen.length, 0);
  assert.equal(await runAs("user_a", () => followJob(job.id, (e) => seen.push(e), { maxMs: 1000 })), "finished");
  assert.deepEqual(seen.map((e) => e.kind), ["done"]);
});

test("followJob: a running job whose heartbeat stopped ends with an 'interrupted' error", async () => {
  const id = `stale-${Date.now()}`;
  const store = jobStore();
  const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  await store.createJob({ id, type: "run", status: "running", created_at: longAgo });
  await store.appendJobEvent(id, 1, { kind: "run_started" });
  const seen: JobEvent[] = [];
  assert.equal(await followJob(id, (e) => seen.push(e), { maxMs: 5000 }), "finished");
  assert.deepEqual(seen, [{ kind: "run_started" }, { kind: "error", message: INTERRUPTED_MESSAGE, interrupted: true }]);
});

test("followJob: a running job with a fresh heartbeat keeps streaming", async () => {
  const id = `alive-${Date.now()}`;
  const store = jobStore();
  await store.createJob({ id, type: "run", status: "running", created_at: new Date().toISOString() });
  const seen: JobEvent[] = [];
  assert.equal(await followJob(id, (e) => seen.push(e), { maxMs: 1500 }), "stopped");
  assert.deepEqual(seen, []);
});

test("endedWithoutEvent: stale running rows, and finished rows whose last event wasn't stored", () => {
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const row = (status: "running" | "done" | "error", updated_at?: string) => ({ id: "j", type: "run", status, created_at: "2026-01-01T00:00:00.000Z", ...(updated_at && { updated_at }) });
  assert.equal(endedWithoutEvent(row("running", "2026-01-01T00:09:30.000Z"), now), undefined, "heartbeat 30s ago: alive");
  assert.equal(endedWithoutEvent(row("running", "2026-01-01T00:08:00.000Z"), now)?.kind, "error", "heartbeat 2 min ago: died");
  assert.equal(endedWithoutEvent(row("running"), now)?.kind, "error", "rows without a heartbeat fall back to created_at");
  assert.deepEqual(endedWithoutEvent(row("done"), now), { kind: "done" });
  assert.equal(endedWithoutEvent(row("error"), now)?.kind, "error");
});

test("jobs: a running job keeps its heartbeat fresh in the store", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void;
  const job = startJob("test", () => new Promise<void>((r) => (release = r)));
  const store = jobStore();
  await new Promise((r) => setImmediate(r));
  const before = (await store.getJobInfo(job.id))!.updated_at!;
  await new Promise((r) => setTimeout(r, 5)); // real time passes, so the touched timestamp is later
  t.mock.timers.tick(20_000);
  for (let i = 0; i < 5 && (await store.getJobInfo(job.id))!.updated_at === before; i++) await new Promise((r) => setImmediate(r));
  assert.ok((await store.getJobInfo(job.id))!.updated_at! > before);
  release();
  await job.done;
  assert.equal((await store.getJobInfo(job.id))!.status, "done");
});
