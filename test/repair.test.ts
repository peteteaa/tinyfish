import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Offline tests for repair evidence and the check guard, plus one live Gemini repair (skipped without a key).
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-repair-test-"));

const { guardChecks, repairAndVerify, repairWorkflow, runEvidence, shapeOf } = await import("../src/repair.js");
const { runStep, runWorkflowDef } = await import("../src/executor.js");
const { isTransientGeminiError, quotaExhausted } = await import("../src/llm.js");
const { getWorkflow } = await import("../src/store.js");
const { MODEL } = await import("../src/llm.js");

const noGemini = !process.env.GEMINI_API_KEY && "GEMINI_API_KEY not set";
const noKeys = noGemini || (!process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set");
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

test("shapeOf: outlines forEach outputs so paths can be written against them", () => {
  const out = [{ query: "q", results: [{ title: "t", url: "https://a" }, { title: "u", url: "https://b" }] }];
  assert.equal(shapeOf(out), "array[1] of {query: string, results: array[2] of {title: string, url: string}}");
  assert.equal(shapeOf([]), "array[0]");
  assert.equal(shapeOf(null), "null");
});

test("guardChecks: rejects dropping checks on steps that didn't fail", () => {
  const run = fakeRun([pricing, homepage], [2, 0]);
  const weakened = structuredClone(wf);
  weakened.steps[0].checks = [];
  const errors = guardChecks(wf, run.steps[1], weakened);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /fetch_pages/);
});

test("executor: a fetch whose urls path resolves to nothing fails with the template, not https://undefined", async () => {
  const step = { id: "fetch_pages", type: "fetch" as const, urls: "{{steps.find.results.*.url}}" };
  const ctx = { params: {}, steps: { find: [{ query: "q", results: [{ url: "https://a" }] }] }, previous: {} };
  const record = await runStep(step, ctx);
  assert.equal(record.status, "error");
  assert.match(record.error ?? "", /steps\.find\.results\.\*\.url.*resolved to no URLs/);
});

test("isTransientGeminiError: rate limits and overloads are transient, bad requests aren't", () => {
  assert.ok(isTransientGeminiError(Object.assign(new Error("quota"), { status: 429 })));
  assert.ok(isTransientGeminiError(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')));
  assert.ok(isTransientGeminiError(Object.assign(new Error("overloaded"), { status: 503 })));
  assert.ok(!isTransientGeminiError(Object.assign(new Error("bad schema"), { status: 400 })));
});

test(`repairAndVerify (live TinyFish + Gemini, ${MODEL}): fixes a wrong forEach path and proves it with a test run`, { skip: noKeys, timeout: 600_000 }, async () => {
  // The bug seen in practice: search runs per competitor (forEach), but fetch reads it as if it didn't.
  const broken = {
    name: "pricing_via_search",
    description: "Find each competitor's pricing page with search, then fetch and extract its plans.",
    params: { competitors: { type: "string[]" as const, description: "Competitor domains", default: ["firecrawl.dev"] } },
    steps: [
      { id: "find_pricing_pages", type: "search" as const, forEach: "{{params.competitors}}", query: "{{item}} pricing",
        checks: [{ type: "min_items" as const, path: "results", value: 1 }] },
      { id: "fetch_pages", type: "fetch" as const, urls: "{{steps.find_pricing_pages.results.*.url}}",
        checks: [{ type: "min_items" as const, path: "results", value: 1 }] },
      { id: "extract_plans", type: "extract" as const, forEach: "{{steps.fetch_pages.results}}",
        input: "Title: {{item.title}}\nURL: {{item.final_url}}\n\n{{item.text}}",
        instruction: "Extract every pricing plan with its price.",
        output_schema: { type: "object", properties: { plans: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: { type: ["string", "null"] } } } } } },
        checks: [{ type: "min_items" as const, path: "plans", value: 1 }] },
    ],
  };
  const failed = await runWorkflowDef(broken, {});
  assert.equal(failed.status, "error", "the broken workflow should fail at fetch_pages");
  const result = await repairAndVerify(broken, { ...failed, version: 1 }, "fetch_pages", {
    onEvent: (e) => e.kind === "test_done" && console.error(`  round ${e.round}: ${e.status}${e.failed_step ? ` at ${e.failed_step}` : ""}`),
  });
  console.error(`  reply: ${result.reply}`);
  assert.equal(result.verified, true, `no fix passed: ${JSON.stringify(result.test)}`);
  const urls = result.workflow.steps.find((s) => s.id === "fetch_pages") as { urls: unknown };
  assert.match(String(urls.urls), /find_pricing_pages\.(\*|\d+)\./);
  assert.equal(result.workflow.source?.repaired_from, 1);
});

test("quotaExhausted: a used-up daily quota fails at once with what to do; a per-minute limit is retried", () => {
  const daily = Object.assign(
    new Error('{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 500, model: gemini-3.5-flash-lite","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"},{"retryDelay":"5445s"}]}}'),
    { status: 429 },
  );
  const err = quotaExhausted(daily);
  assert.ok(err, "daily quota should fail fast");
  assert.match(err.message, /daily limit: 500 requests for gemini-3\.5-flash-lite\)\. It resets in about 91 min/);
  assert.ok(isTransientGeminiError(err), "still counted as transient, so repair doesn't edit the workflow over it");
  const perMinute = Object.assign(new Error('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"retryDelay":"40s"}]}}'), { status: 429 });
  assert.equal(quotaExhausted(perMinute), undefined);
  assert.equal(quotaExhausted(Object.assign(new Error("bad request"), { status: 400 })), undefined);
});
