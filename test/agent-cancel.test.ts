import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Offline: runAgent cancels paid remote runs it stops waiting for, and rides out brief poll failures. TinyFish is a
// stubbed fetch; no network.
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-agent-test-"));
process.env.TINYFISH_API_KEY ||= "test-key";

const { runAgent } = await import("../src/tinyfish.js");
const { startJob } = await import("../src/jobs.js");

/** Stubs TinyFish: run-async starts "r1"; each poll answers with the next entry of `polls` (a status or an HTTP code). */
function stubAgent(polls: (string | number)[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/run-async")) return calls.push("start"), Response.json({ run_id: "r1", error: null });
    if (u.endsWith("/cancel")) return calls.push("cancel"), Response.json({});
    calls.push("poll");
    init?.signal?.throwIfAborted();
    const next = polls.length > 1 ? polls.shift()! : polls[0];
    if (typeof next === "number") return new Response("upstream trouble", { status: next });
    return Response.json({ run_id: "r1", status: next, result: next === "COMPLETED" ? { ok: true } : null, error: null, num_of_steps: 1 });
  }) as typeof fetch;
  return calls;
}

test("runAgent: an aborted signal cancels the remote run and rejects with the signal's reason", async () => {
  const calls = stubAgent(["RUNNING"]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("job time limit")), 30);
  await assert.rejects(runAgent({ url: "example.com", goal: "g" }, { pollMs: 10, signal: stop.signal }), /job time limit/);
  assert.equal(calls.at(-1), "cancel");
});

test("runAgent: a brief poll failure is retried; the run completes without a cancel", async () => {
  const calls = stubAgent([503, "RUNNING", "COMPLETED"]);
  const run = await runAgent({ url: "example.com", goal: "g" }, { pollMs: 1 });
  assert.equal(run.status, "COMPLETED");
  assert.ok(!calls.includes("cancel"));
});

test("runAgent: a poll that keeps failing gives up and cancels the run", async () => {
  const calls = stubAgent([401]);
  await assert.rejects(runAgent({ url: "example.com", goal: "g" }, { pollMs: 1 }), /401/);
  assert.deepEqual(calls, ["start", "poll", "cancel"], "a 401 isn't transient, so no retries");
});

test("runAgent: timing out cancels the run", async () => {
  const calls = stubAgent(["RUNNING"]);
  await assert.rejects(runAgent({ url: "example.com", goal: "g" }, { pollMs: 5, timeoutMs: 20 }), /timed out/);
  assert.equal(calls.at(-1), "cancel");
});

test("jobs: at the time limit a job ends with an error and its agent run is cancelled", async () => {
  const calls = stubAgent(["RUNNING"]);
  const job = startJob(
    "test",
    async (emit) => {
      emit({ kind: "step" });
      try {
        await runAgent({ url: "example.com", goal: "g" }, { pollMs: 10 }); // picks up the job's stop signal
      } finally {
        emit({ kind: "after_limit" }); // the job has ended; this must be dropped
      }
    },
    { stopAfterMs: 50 },
  );
  await job.done;
  assert.equal(job.status, "error");
  assert.deepEqual(job.events.map((e) => e.kind), ["step", "error"]);
  assert.match(String(job.events[1].message), /limit for one job/);
  await new Promise((r) => setTimeout(r, 20)); // the agent loop notices the abort and cancels
  assert.equal(calls.at(-1), "cancel");
});
