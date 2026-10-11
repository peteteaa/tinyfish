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

    test("seeds are inserted as v1 with source import", () => {
      const s = fresh();
      const cp = s.listWorkflows().find((w) => w.name === "competitor_pricing");
      assert.ok(cp);
      assert.equal(cp.latest, 1);
      assert.equal(cp.latest_source, "import");
      assert.deepEqual(s.listVersions("competitor_pricing").map((v) => v.source), ["import"]);
    });

    test("save creates v1 then next versions with sources", () => {
      const s = fresh();
      assert.equal(s.saveWorkflow(wfInput(), "learned").version, 1);
      assert.equal(s.saveWorkflow(wfInput({ description: "b" }), "web").version, 2);
      assert.equal(s.saveWorkflow(wfInput({ description: "c" })).version, 3); // default "cli"
      const vs = s.listVersions("demo");
      assert.deepEqual(vs.map((v) => [v.version, v.source]), [[1, "learned"], [2, "web"], [3, "cli"]]);
      for (const v of vs) assert.ok(!Number.isNaN(Date.parse(v.created_at)));
      const summary = s.listWorkflows().find((w) => w.name === "demo")!;
      assert.equal(summary.latest, 3);
      assert.deepEqual(summary.versions, [1, 2, 3]);
      assert.equal(summary.latest_source, "cli");
      assert.equal(summary.description, "c");
      assert.deepEqual(s.listVersions("nope"), []);
    });

    test("getWorkflow by version and latest", () => {
      const s = fresh();
      s.saveWorkflow(wfInput());
      s.saveWorkflow(wfInput({ description: "second" }));
      assert.equal(s.getWorkflow("demo")!.description, "second");
      assert.equal(s.getWorkflow("demo")!.version, 2);
      assert.equal(s.getWorkflow("demo", 1)!.description, "demo workflow");
      assert.equal(s.getWorkflow("demo", 9), undefined);
      assert.equal(s.getWorkflow("missing"), undefined);
    });

    test("invalid workflow is rejected with readable errors and not stored", () => {
      const s = fresh();
      assert.throws(() => s.saveWorkflow(wfInput({ name: "Bad Name" })), /Invalid workflow:\n- name: /);
      assert.throws(
        () => s.saveWorkflow(wfInput({ steps: [{ id: "a", type: "search", query: "{{params.nope}}" }] })),
        /unknown param "params.nope"/,
      );
      assert.equal(s.getWorkflow("demo"), undefined);
      assert.equal(s.getWorkflow("Bad Name"), undefined);
    });

    test("runs: ordering, getRun, lastSuccessfulRun", () => {
      const s = fresh();
      s.saveRun(run("demo", "r1", "2026-01-01T00:00:01.000Z", "ok"));
      s.saveRun(run("demo", "r2", "2026-01-01T00:00:02.000Z", "error"));
      s.saveRun(run("demo", "r3", "2026-01-01T00:00:03.000Z", "check_failed"));
      s.saveRun(run("other", "r4", "2026-01-01T00:00:04.000Z", "ok"));
      assert.deepEqual(s.listRuns("demo").map((r) => r.run_id), ["r3", "r2", "r1"]);
      assert.deepEqual(s.listRuns("demo", 2).map((r) => r.run_id), ["r3", "r2"]);
      assert.deepEqual(s.listRuns("none"), []);
      assert.equal(s.getRun("r2")!.status, "error");
      assert.equal(s.getRun("r4")!.workflow, "other");
      assert.equal(s.getRun("nope"), undefined);
      assert.equal(s.lastSuccessfulRun("demo")!.run_id, "r1");
      s.saveRun(run("demo", "r5", "2026-01-01T00:00:05.000Z", "ok"));
      assert.equal(s.lastSuccessfulRun("demo")!.run_id, "r5");
      assert.equal(s.lastSuccessfulRun("none"), undefined);
      s.saveWorkflow(wfInput());
      assert.equal(s.listWorkflows().find((w) => w.name === "demo")!.last_run!.run_id, "r5");
    });

    test("traces round-trip", () => {
      const s = fresh();
      const trace = { goal: "find prices", steps: [{ n: 1, nested: { a: [1, 2, { b: null }] } }] };
      s.saveTrace("t1", trace);
      assert.deepEqual(s.getTrace("t1"), trace);
      s.saveTrace("t2", ["no", "goal"]);
      assert.deepEqual(s.getTrace("t2"), ["no", "goal"]);
      assert.equal(s.getTrace("missing"), undefined);
    });

    test("diff: steps added/removed/changed/reordered and params", () => {
      const s = fresh();
      s.saveWorkflow(wfInput());
      s.saveWorkflow(
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
      const d = s.diff("demo", 1, 2);
      assert.equal(d.name, "demo");
      assert.deepEqual([d.from, d.to], [1, 2]);
      assert.equal(d.description_changed, true);
      assert.equal(d.output_changed, true);
      assert.deepEqual(d.params, { added: ["n"], removed: [], changed: ["q"] });
      assert.deepEqual(d.steps.added, ["pull"]);
      assert.deepEqual(d.steps.removed, ["grab"]);
      assert.deepEqual(d.steps.changed, [{ id: "find", fields: ["purpose", "query"] }]);
      assert.equal(d.steps.reordered, false);

      const same = s.diff("demo", 1, 1);
      assert.equal(same.description_changed, false);
      assert.deepEqual(same.steps, { added: [], removed: [], changed: [], reordered: false });

      s.saveWorkflow(
        wfInput({
          steps: [
            { id: "find", type: "search", query: "{{params.q}}" },
            { id: "grab", type: "fetch", urls: "{{steps.find.results.*.url}}" },
            { id: "again", type: "search", query: "{{params.q}}" },
          ],
        }),
      );
      s.saveWorkflow(
        wfInput({
          steps: [
            { id: "again", type: "search", query: "{{params.q}}" },
            { id: "find", type: "search", query: "{{params.q}}" },
            { id: "grab", type: "fetch", urls: "{{steps.find.results.*.url}}" },
          ],
        }),
      );
      const r = s.diff("demo", 3, 4);
      assert.equal(r.steps.reordered, true);
      assert.deepEqual(r.steps.added, []);
      assert.deepEqual(r.steps.changed, []);
    });

    test("diff: missing version throws a clear error", () => {
      const s = fresh();
      s.saveWorkflow(wfInput());
      assert.throws(() => s.diff("demo", 1, 7), /Workflow "demo" has no version 7/);
      assert.throws(() => s.diff("ghost", 1, 2), /Workflow "ghost" has no version 1/);
    });
  });
}

test("files backend: version without sidecar reports import + mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-legacy-"));
  const s = createStore("files", dir);
  s.saveWorkflow(wfInput(), "web");
  fs.unlinkSync(path.join(dir, "workflows", "demo", "v1.meta.json"));
  const [v] = s.listVersions("demo");
  assert.equal(v.source, "import");
  assert.equal(v.created_at, fs.statSync(path.join(dir, "workflows", "demo", "v1.json")).mtime.toISOString());
});

test("sqlite backend: db file, WAL and user_version", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-store-db-"));
  createStore("sqlite", dir).saveWorkflow(wfInput());
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "workflow-memory.db"));
  assert.equal((db.prepare("PRAGMA user_version").get() as any).user_version, 1);
  assert.equal((db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
  db.close();
});
