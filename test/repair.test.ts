import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Offline tests for repair evidence and the check guard, plus one live Gemini repair (skipped without a key).
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-repair-test-"));

const { guardChecks, repairWorkflow, runEvidence } = await import("../src/repair.js");
const { getWorkflow } = await import("../src/store.js");
const { MODEL } = await import("../src/llm.js");

const noGemini = !process.env.GEMINI_API_KEY && "GEMINI_API_KEY not set";
const wf = getWorkflow("competitor_pricing")!;

/** A competitor_pricing run where `pages` were fetched and the extract found `plans[i]` plans on page i. */
function fakeRun(pages: { url: string; title: string; text: string }[], plans: number[]) {
  const extract = plans.map((n, i) => ({ company: pages[i].title, plans: Array.from({ length: n }, (_, j) => ({ name: `Plan ${j}` })) }));
  const checks = plans.flatMap((n, i) => [
    { check: `[${i}] required_keys(company)`, passed: true },
    { check: `[${i}] min_items(1) at plans`, passed: n >= 1, ...(n < 1 && { message: "got 0 items" }) },
  ]);
  return {
    run_id: "run-1",
    workflow: "competitor_pricing",
    version: 1,
    params: { competitors: pages.map((p) => p.url) },
    status: "check_failed" as const,
    started_at: "",
    finished_at: "",
    duration_ms: 0,
    steps: [
      { id: "fetch_pages", type: "fetch", status: "ok" as const, started_at: "", duration_ms: 0, checks: [],
        output: { results: pages.map((p) => ({ ...p, final_url: p.url })), errors: [] } },
      { id: "extract_plans", type: "extract", status: "check_failed" as const, started_at: "", duration_ms: 0, checks, output: extract },
    ],
  };
}

const homepage = { url: "https://www.firecrawl.dev/", title: "Firecrawl", text: "Turn websites into LLM-ready data. Get started." };
const pricing = { url: "https://example.com/pricing", title: "Example pricing", text: "Starter $9/mo. Team $49/mo." };

test("runEvidence: shows the failing forEach item's input and output, plus the upstream step", () => {
  const run = fakeRun([pricing, homepage], [2, 0]);
  const ev = runEvidence(wf, run, "extract_plans");
  const parsed = JSON.parse(ev.replace(/^<run_evidence>\n|\n<\/run_evidence>$/g, ""));
  assert.equal(parsed.failing_items.length, 1);
  assert.equal(parsed.failing_items[0].index, 1);
  assert.equal(parsed.failing_items[0].item.url, homepage.url);
  assert.deepEqual(parsed.failing_items[0].output.plans, []);
  assert.equal(parsed.passing_items, 1);
  assert.deepEqual(parsed.upstream_steps.map((s: { id: string }) => s.id), ["fetch_pages"]);
});

test("guardChecks: rejects dropping a check every item failed, allows it when some passed", () => {
  const weakened = structuredClone(wf);
  weakened.steps[1].checks = weakened.steps[1].checks!.filter((c) => c.type !== "min_items");
  const allFailed = fakeRun([homepage], [0]);
  assert.equal(guardChecks(wf, allFailed.steps[1], weakened).length, 1);
  const someFailed = fakeRun([pricing, homepage], [2, 0]);
  assert.deepEqual(guardChecks(wf, someFailed.steps[1], weakened), []);
  // Adding checks or keeping them is always fine.
  assert.deepEqual(guardChecks(wf, allFailed.steps[1], wf), []);
});

test(`repair (live Gemini, ${MODEL}): a homepage passed as a pricing page keeps the check`, { skip: noGemini, timeout: 120_000 }, async () => {
  const run = fakeRun([homepage], [0]);
  const result = await repairWorkflow(wf, run, "extract_plans");
  const checks = result.workflow.steps.find((s) => s.id === "extract_plans")!.checks ?? [];
  assert.ok(checks.some((c) => c.type === "min_items" && c.path === "plans"), `check was dropped: ${JSON.stringify(checks)}`);
  assert.ok(result.reply.length > 0);
  if (result.changed) assert.equal(result.workflow.source?.repaired_from, 1);
  console.error(`  reply: ${result.reply}`);
});
