import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-default-"));

const { createStore } = await import("../src/store.js");
type RunRecord = import("../src/store.js").RunRecord;

const wfInput = (over: Record<string, unknown> = {}) => ({
  name: "demo",
  description: "demo workflow",
  params: { q: { type: "string", description: "query", default: "x" } },
  steps: [
    { id: "find", type: "search", query: "{{params.q}}" },
    { id: "grab", type: "fetch", urls: "{{steps.find.results.*.url}}" },
  ],
  output: "{{steps.grab.results}}",
  ...over,
});

const run = (workflow: string, run_id: string, started_at: string, status: RunRecord["status"]): RunRecord => ({
  run_id,
  workflow,
  version: 1,
  params: {},
  status,
  started_at,
  finished_at: started_at,
  duration_ms: 1,
  steps: [],
});

for (const kind of ["sqlite", "files"] as const) {
  describe(`store (${kind})`, () => {
    const fresh = () => createStore(kind, fs.mkdtempSync(path.join(os.tmpdir(), `wm-store-${kind}-`)));

    test("seeds are inserted as v1 with source import", async () => {
      const s = fresh();
      const cp = (await s.listWorkflows()).find((w) => w.name === "competitor_pricing");
      assert.ok(cp);
      assert.equal(cp.latest, 1);
      assert.equal(cp.latest_source, "import");
      assert.deepEqual((await s.listVersions("competitor_pricing")).map((v) => v.source), ["import"]);
    });

    test("save creates v1 then next versions with sources", async () => {
      const s = fresh();
      assert.equal((await s.saveWorkflow(wfInput(), "learned")).version, 1);
      assert.equal((await s.saveWorkflow(wfInput({ description: "b" }), "web")).version, 2);
      assert.equal((await s.saveWorkflow(wfInput({ description: "c" }))).version, 3); // default "cli"
      const vs = await s.listVersions("demo");
      assert.deepEqual(vs.map((v) => [v.version, v.source]), [[1, "learned"], [2, "web"], [3, "cli"]]);
      for (const v of vs) assert.ok(!Number.isNaN(Date.parse(v.created_at)));
      const summary = (await s.listWorkflows()).find((w) => w.name === "demo")!;
      assert.equal(summary.latest, 3);
      assert.deepEqual(summary.versions, [1, 2, 3]);
      assert.equal(summary.latest_source, "cli");
      assert.equal(summary.description, "c");
      assert.deepEqual(await s.listVersions("nope"), []);
    });

    test("getWorkflow by version and latest", async () => {
      const s = fresh();
      await s.saveWorkflow(wfInput());
      await s.saveWorkflow(wfInput({ description: "second" }));
      assert.equal((await s.getWorkflow("demo"))!.description, "second");
      assert.equal((await s.getWorkflow("demo"))!.version, 2);
      assert.equal((await s.getWorkflow("demo", 1))!.description, "demo workflow");
      assert.equal(await s.getWorkflow("demo", 9), undefined);
      assert.equal(await s.getWorkflow("missing"), undefined);
    });

    test("invalid workflow is rejected with readable errors and not stored", async () => {
      const s = fresh();
      await assert.rejects(() => s.saveWorkflow(wfInput({ name: "Bad Name" })), /Invalid workflow:\n- name: /);
      await assert.rejects(
        () => s.saveWorkflow(wfInput({ steps: [{ id: "a", type: "search", query: "{{params.nope}}" }] })),
        /unknown param "params.nope"/,
      );
      assert.equal(await s.getWorkflow("demo"), undefined);
      assert.equal(await s.getWorkflow("Bad Name"), undefined);
    });

    test("runs: ordering, getRun, lastSuccessfulRun", async () => {
      const s = fresh();
      await s.saveRun(run("demo", "r1", "2026-01-01T00:00:01.000Z", "ok"));
      await s.saveRun(run("demo", "r2", "2026-01-01T00:00:02.000Z", "error"));
      await s.saveRun(run("demo", "r3", "2026-01-01T00:00:03.000Z", "check_failed"));
      await s.saveRun(run("other", "r4", "2026-01-01T00:00:04.000Z", "ok"));
      assert.deepEqual((await s.listRuns("demo")).map((r) => r.run_id), ["r3", "r2", "r1"]);
      assert.deepEqual((await s.listRuns("demo", 2)).map((r) => r.run_id), ["r3", "r2"]);
      assert.deepEqual(await s.listRuns("none"), []);
      assert.equal((await s.getRun("r2"))!.status, "error");
      assert.equal((await s.getRun("r4"))!.workflow, "other");
      assert.equal(await s.getRun("nope"), undefined);
      assert.equal((await s.lastSuccessfulRun("demo"))!.run_id, "r1");
      await s.saveRun(run("demo", "r5", "2026-01-01T00:00:05.000Z", "ok"));
      assert.equal((await s.lastSuccessfulRun("demo"))!.run_id, "r5");
      assert.equal(await s.lastSuccessfulRun("none"), undefined);
      await s.saveWorkflow(wfInput());
      assert.equal((await s.listWorkflows()).find((w) => w.name === "demo")!.last_run!.run_id, "r5");
    });

    test("traces round-trip", async () => {
      const s = fresh();
      const trace = { goal: "find prices", steps: [{ n: 1, nested: { a: [1, 2, { b: null }] } }] };
      await s.saveTrace("t1", trace);
      assert.deepEqual(await s.getTrace("t1"), trace);
      await s.saveTrace("t2", ["no", "goal"]);
      assert.deepEqual(await s.getTrace("t2"), ["no", "goal"]);
      assert.equal(await s.getTrace("missing"), undefined);
    });

    test("diff: steps added/removed/changed/reordered and params", async () => {
      const s = fresh();
      await s.saveWorkflow(wfInput());
      await s.saveWorkflow(
        wfInput({
          description: "changed",
          params: {
            q: { type: "string", description: "query", default: "y" },
            n: { type: "number", description: "count" },
          },
          steps: [
            { id: "find", type: "search", query: "{{params.q}} {{params.n}}", purpose: "p" },
            { id: "pull", type: "fetch", urls: "{{steps.find.results.*.url}}" },
          ],
          output: "{{steps.pull.results}}",
        }),
      );
      const d = await s.diff("demo", 1, 2);
      assert.equal(d.name, "demo");
      assert.deepEqual([d.from, d.to], [1, 2]);
      assert.equal(d.description_changed, true);
      assert.equal(d.output_changed, true);
      assert.deepEqual(d.params, { added: ["n"], removed: [], changed: ["q"] });
      assert.deepEqual(d.steps.added, ["pull"]);
      assert.deepEqual(d.steps.removed, ["grab"]);
      assert.deepEqual(d.steps.changed, [{ id: "find", fields: ["purpose", "query"] }]);
      assert.equal(d.steps.reordered, false);

      const same = await s.diff("demo", 1, 1);
      assert.equal(same.description_changed, false);
      assert.deepEqual(same.steps, { added: [], removed: [], changed: [], reordered: false });

      await s.saveWorkflow(
        wfInput({
          steps: [
            { id: "find", type: "search", query: "{{params.q}}" },
            { id: "grab", type: "fetch", urls: "{{steps.find.results.*.url}}" },
            { id: "again", type: "search", query: "{{params.q}}" },
          ],
        }),
      );
      await s.saveWorkflow(
        wfInput({
          steps: [
            { id: "again", type: "search", query: "{{params.q}}" },
            { id: "find", type: "search", query: "{{params.q}}" },
            { id: "grab", type: "fetch", urls: "{{steps.find.results.*.url}}" },
          ],
        }),
      );
      const r = await s.diff("demo", 3, 4);
      assert.equal(r.steps.reordered, true);
      assert.deepEqual(r.steps.added, []);
      assert.deepEqual(r.steps.changed, []);
    });

    test("jobs: create, append, read after seq, status", async () => {
      const s = fresh();
      const created_at = "2026-01-01T00:00:00.000Z";
      await s.createJob({ id: "j1", type: "test", status: "running", created_at });
      assert.deepEqual({ ...(await s.getJobInfo("j1")) }, { id: "j1", type: "test", status: "running", created_at });
      assert.equal(await s.getJobInfo("nope"), undefined);
      await s.appendJobEvent("j1", 1, { kind: "step", n: 1 });
      await s.appendJobEvent("j1", 2, { kind: "step", n: 2 });
      await s.appendJobEvent("j1", 3, { kind: "done" });
      assert.deepEqual(await s.jobEvents("j1", 0), [
        { seq: 1, event: { kind: "step", n: 1 } },
        { seq: 2, event: { kind: "step", n: 2 } },
        { seq: 3, event: { kind: "done" } },
      ]);
      assert.deepEqual((await s.jobEvents("j1", 1)).map((r) => r.seq), [2, 3]);
      assert.deepEqual(await s.jobEvents("j1", 3), []);
      assert.deepEqual(await s.jobEvents("nope", 0), []);
      await s.setJobStatus("j1", "done");
      assert.equal((await s.getJobInfo("j1"))!.status, "done");
    });

    test("diff: missing version throws a clear error", async () => {
      const s = fresh();
      await s.saveWorkflow(wfInput());
      await assert.rejects(() => s.diff("demo", 1, 7), /Workflow "demo" has no version 7/);
      await assert.rejects(() => s.diff("ghost", 1, 2), /Workflow "ghost" has no version 1/);
    });

    test("deleteWorkflow removes versions and runs; seeds stay deleted", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wm-store-${kind}-del-`));
      const s = createStore(kind, dir);
      await s.saveWorkflow(wfInput());
      await s.saveWorkflow(wfInput());
      await s.saveRun(run("demo", "r1", "2026-01-01T00:00:00Z", "ok"));
      assert.equal(await s.deleteWorkflow("demo"), true);
      assert.equal(await s.getWorkflow("demo"), undefined);
      assert.deepEqual(await s.listVersions("demo"), []);
      assert.deepEqual(await s.listRuns("demo"), []);
      assert.ok(!(await s.listWorkflows()).some((w) => w.name === "demo"));
      assert.equal(await s.deleteWorkflow("demo"), false);
      assert.equal(await s.deleteWorkflow("ghost"), false);

      // re-saving the name starts over at v1
      assert.equal((await s.saveWorkflow(wfInput())).version, 1);

      // a deleted seed isn't re-seeded by a fresh store on the same data dir
      assert.equal(await s.deleteWorkflow("competitor_pricing"), true);
      assert.ok(!(await createStore(kind, dir).listWorkflows()).some((w) => w.name === "competitor_pricing"));
    });
  });
}

test("files backend: version without sidecar reports import + mtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-legacy-"));
  const s = createStore("files", dir);
  await s.saveWorkflow(wfInput(), "web");
  fs.unlinkSync(path.join(dir, "workflows", "demo", "v1.meta.json"));
  const [v] = await s.listVersions("demo");
  assert.equal(v.source, "import");
  assert.equal(v.created_at, fs.statSync(path.join(dir, "workflows", "demo", "v1.json")).mtime.toISOString());
});

test("sqlite backend: db file, WAL and user_version", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-db-"));
  await createStore("sqlite", dir).saveWorkflow(wfInput());
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "workflow-memory.db"));
  assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, 3);
  assert.equal((db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
  db.close();
});
