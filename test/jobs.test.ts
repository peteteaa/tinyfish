import assert from "node:assert/strict";
import { test } from "node:test";
import { getJob, startJob, subscribe, type JobEvent } from "../src/jobs.js";

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
