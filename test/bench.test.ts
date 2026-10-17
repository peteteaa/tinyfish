import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-test-"));

const { gradeOutput } = await import("../src/bench/grade.js");
const { FAULTS } = await import("../src/bench/faults.js");
const { buildReport } = await import("../src/bench/report.js");
const { TASKS } = await import("../src/bench/tasks.js");
const { emptyUsage, geminiCost, meter, recordGemini, recordTinyFish } = await import("../src/usage.js");
const { validateWorkflow } = await import("../src/schema.js");

test("grade: same expectations pass for differently shaped outputs", () => {
  const expect = [
    { type: "contains" as const, values: ["Hobby", "Pro"] },
    { type: "pattern" as const, pattern: "\\$\\d", min: 2 },
    { type: "records" as const, min: 2, fields: ["name|plan", "price"] },
  ];
  const agentAnswer = { vercel: { plans: [{ plan_name: "Hobby", monthly_price: "$0" }, { plan_name: "Pro", monthly_price: "$20" }] } };
  const workflowOutput = [{ company: "Vercel", plans: [{ name: "hobby", price: "$0/mo" }, { name: "Pro", price: "$20/mo" }] }];
  assert.equal(gradeOutput(agentAnswer, expect).passed, true);
  assert.equal(gradeOutput(workflowOutput, expect).passed, true);
  // Records returned as JSON strings still count.
  const stringly = { plans: agentAnswer.vercel.plans.map((p) => JSON.stringify(p, null, 2)) };
  assert.equal(gradeOutput(stringly, expect).passed, true);
});

test("grade: records need every field filled; null output fails", () => {
  const expect = [{ type: "records" as const, min: 2, fields: ["title", "location"] }];
  const g = gradeOutput({ jobs: [{ title: "A", location: "SF" }, { title: "B", location: "" }] }, expect);
  assert.equal(g.passed, false);
  assert.match(g.results[0].detail, /1 complete/);
  assert.equal(gradeOutput(null, []).passed, false);
});

test("tasks: ids are unique snake_case and every task has expectations", () => {
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const t of TASKS) {
    assert.match(t.id, /^[a-z][a-z0-9_]*$/);
    assert.ok(t.expect.length > 0, t.id);
    for (const e of t.expect) if (e.type === "pattern") new RegExp(e.pattern);
  }
});

const wf = (urls: unknown, params: Record<string, unknown> = {}) => {
  const r = validateWorkflow({
    name: "w",
    description: "x",
    params,
    steps: [
      { id: "f", type: "fetch", urls },
      { id: "e", type: "extract", forEach: "{{steps.f.results}}", input: "Title: {{item.title}}\n\n{{item.text}}", instruction: "x", output_schema: { type: "object" } },
    ],
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.workflow;
};

test("faults: url_moved and redirected_home rewrite the param default or the literal URL", () => {
  const byParam = wf("{{params.urls}}", { urls: { type: "string[]", description: "x", default: ["vercel.com/pricing", "b.com/x"] } });
  assert.deepEqual(FAULTS.url_moved(byParam)!.params.urls.default, ["https://vercel.com/pricing-old", "b.com/x"]);
  assert.deepEqual(FAULTS.redirected_home(byParam)!.params.urls.default, ["https://vercel.com/", "b.com/x"]);
  const literal = wf(["https://books.toscrape.com/catalogue/category/books/travel_2/index.html"]);
  const moved = FAULTS.url_moved(literal)!.steps[0];
  assert.equal(moved.type === "fetch" && moved.urls[0], "https://books.toscrape.com/catalogue/category/books/travel_2/index-old.html");
  // Already the homepage: nothing to redirect to.
  assert.equal(FAULTS.redirected_home(wf(["https://news.ycombinator.com"])), null);
  // Part of a URL, not the whole URL: not rewritten.
  assert.equal(FAULTS.url_moved(wf("https://{{params.d}}/pricing", { d: { type: "string", description: "x", default: "a.com" } })), null);
});

test("faults: field_renamed breaks the extract input; original is untouched", () => {
  const w = wf(["https://a.com"]);
  const broken = FAULTS.field_renamed(w)!;
  const e = broken.steps[1];
  assert.equal(e.type === "extract" && e.input, "Title: {{item.title}}\n\n{{item.body}}");
  const orig = w.steps[1];
  assert.equal(orig.type === "extract" && orig.input.includes("{{item.text}}"), true);
});

test("usage: meter counts nested calls and prices thinking as output", async () => {
  const { usage: outer } = await meter(async () => {
    recordGemini("gemini-3.5-flash-lite", { promptTokenCount: 1_000_000, candidatesTokenCount: 0, thoughtsTokenCount: 0 });
    const { usage: inner } = await meter(async () => {
      recordGemini("gemini-3.5-flash-lite-001", { promptTokenCount: 0, candidatesTokenCount: 500_000, thoughtsTokenCount: 500_000 });
      recordTinyFish("fetch", 3);
    });
    assert.equal(inner.gemini.calls, 1);
    assert.equal(inner.tinyfish.fetch_urls, 3);
  });
  assert.equal(outer.gemini.calls, 2);
  assert.equal(outer.tinyfish.fetch, 1);
  assert.equal(geminiCost(outer).toFixed(2), (0.3 + 2.5).toFixed(2));
  recordGemini("x", {}); // outside a meter: dropped
  assert.equal(geminiCost(emptyUsage()), 0);
});

test("report: compares raw and replay per task", () => {
  const usage = (input: number) => ({ ...emptyUsage(), gemini: { calls: 1, input, output: 0, thoughts: 0, by_model: { "gemini-3.5-flash-lite": { calls: 1, input, output: 0, thoughts: 0 } } } });
  const trial = (kind: "raw" | "replay" | "learn", ms: number, input: number, passed = true) => ({
    kind, task: "vercel_pricing", category: "pricing" as const, started_at: "2026-10-16T00:00:00Z", duration_ms: ms,
    status: "ok" as const, grade: { passed, results: [] }, usage: usage(input), cost_usd: (input * 0.3) / 1e6,
    // The report grades stored outputs again, so the output decides pass/fail.
    output: passed ? { plans: [{ name: "Hobby", price: "$0" }, { name: "Pro", price: "$20" }, { name: "Enterprise", price: "custom" }] } : { plans: [] },
    ...(kind === "replay" && { checks: { passed: 2, total: 2 } }),
  });
  const base = { model: "m", fast_model: "m", options: {}, repairs: [] };
  const report = buildReport([
    { ...base, id: "a", kind: "learn", started_at: "2026-10-16T00:00:00Z", trials: [trial("learn", 60_000, 200_000)] },
    { ...base, id: "b", kind: "compare", started_at: "2026-10-16T01:00:00Z", trials: [trial("raw", 50_000, 100_000), trial("replay", 5_000, 10_000), trial("raw", 30_000, 100_000, false), trial("replay", 5_000, 10_000)] },
  ]);
  const t = report.tasks[0];
  assert.equal(t.speedup, 8);
  assert.equal(t.token_reduction!.toFixed(2), "0.90");
  assert.equal(t.break_even_runs, 3); // 0.06 learn / 0.027 saved per run
  assert.equal(report.headline!.raw_success, 0.5);
  assert.equal(report.headline!.replay_success, 1);
});

// Live: real TinyFish Fetch (free). Skipped, not faked, when no key is configured.
test(
  "fetchPages (live TinyFish): more than 10 URLs are split into batches",
  { skip: !process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set" },
  async () => {
    const { fetchPages } = await import("../src/tinyfish.js");
    const urls = Array.from({ length: 11 }, (_, i) => `https://books.toscrape.com/catalogue/page-${i + 1}.html`);
    const { value, usage } = await meter(() => fetchPages({ urls }));
    assert.equal(usage.tinyfish.fetch, 2);
    assert.equal(value.results.length + value.errors.length, 11);
    assert.ok(value.results.length >= 10);
  },
);
