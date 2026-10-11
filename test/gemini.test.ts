import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Live tests: real Gemini (and TinyFish) calls. Skipped, not faked, when keys are missing.
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-gemini-test-"));

const { extract, MODEL, FAST_MODEL } = await import("../src/llm.js");
const { runWorkflow } = await import("../src/executor.js");
const { learn } = await import("../src/compile.js");
const { editWorkflow } = await import("../src/edit.js");
const { getWorkflow } = await import("../src/store.js");
const { startLearnJob, startRunJob, subscribe } = await import("../src/jobs.js");

const noGemini = !process.env.GEMINI_API_KEY && "GEMINI_API_KEY not set";
const noKeys = noGemini || (!process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set");

test(`extract (live Gemini, ${FAST_MODEL}): structured output follows the schema`, { skip: noGemini, timeout: 60_000 }, async () => {
  const { value, usage } = await extract({
    input: "# Pricing\n\n## Starter\n$9/month, 1 seat\n\n## Team\n$49/month, 10 seats, SSO\n\n## Enterprise\nContact sales",
    instruction: "Extract every plan. Use null for the price when there is no listed price.",
    schema: {
      type: "object",
      properties: {
        plans: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, price: { type: ["string", "null"] } },
            required: ["name", "price"],
          },
        },
      },
      required: ["plans"],
    },
  });
  const plans = (value as { plans: { name: string; price: string | null }[] }).plans;
  assert.deepEqual(plans.map((p) => p.name), ["Starter", "Team", "Enterprise"]);
  assert.match(plans[0].price ?? "", /9/);
  assert.equal(plans[2].price, null);
  assert.ok(usage.input > 0 && usage.output > 0, `usage: ${JSON.stringify(usage)}`);
});

test("seed workflow (live TinyFish + Gemini): competitor_pricing on firecrawl.dev", { skip: noKeys, timeout: 180_000 }, async () => {
  const run = await runWorkflow("competitor_pricing", { competitors: "firecrawl.dev/pricing" });
  const failed = run.steps.flatMap((s) => [s.error, ...s.checks.filter((c) => !c.passed).map((c) => `${s.id} ${c.check}: ${c.message}`)]).filter(Boolean);
  assert.equal(run.status, "ok", `${run.error ?? ""} ${failed.join("; ")}`);
  const pricing = (run.output as { pricing: { company: string; plans: { name: string }[] }[] }).pricing;
  assert.equal(pricing.length, 1);
  assert.match(pricing[0].company, /firecrawl/i);
  assert.ok(pricing[0].plans.length >= 1);
  console.error(`  extracted ${pricing[0].plans.length} plans: ${pricing[0].plans.map((p) => p.name).join(", ")}`);
});

test(`learn (live TinyFish + Gemini, ${MODEL}): explore, compile, save, rerun`, { skip: noKeys, timeout: 600_000 }, async () => {
  const { trace, workflow } = await learn("Get the main heading and the first paragraph of example.com", { name: "example_heading" });
  assert.ok(trace.calls.length >= 1, "exploration made no tool calls");
  assert.ok(trace.calls.every((c) => c.tool.startsWith("tinyfish_")), `non-TinyFish tool: ${trace.calls.map((c) => c.tool)}`);
  assert.ok(trace.answer !== undefined, "explorer never called submit_answer");
  assert.equal(workflow.name, "example_heading");
  assert.equal(workflow.version, 1);
  assert.ok(getWorkflow("example_heading"), "workflow was not saved");

  const run = await runWorkflow("example_heading", {});
  assert.equal(run.status, "ok", run.error ?? JSON.stringify(run.steps.map((s) => [s.id, s.status, s.error])));
  // The values must come from the real page, not the model: example.com's heading is "Example Domain".
  const out = JSON.stringify(run.output);
  assert.match(out, /Example Domain/, `heading not taken from the page: ${out}`);
  assert.match(out, /documentation examples/, `paragraph not taken from the page: ${out}`);
  console.error(`  trace: ${trace.calls.map((c) => c.tool).join(" -> ")}`);
  console.error(`  steps: ${workflow.steps.map((s) => `${s.id}(${s.type})`).join(" -> ")}`);
  console.error(`  rerun output: ${JSON.stringify(run.output).slice(0, 300)}`);
});

test("learn job (live): streams trace rows, answer and a draft with provenance, without saving", { skip: noKeys, timeout: 600_000 }, async () => {
  const job = startLearnJob("Get the main heading of example.com", { name: "example_heading_job" });
  const events = await new Promise<{ kind: string; [k: string]: any }[]>((resolve) => {
    const seen: any[] = [];
    subscribe(job, (e) => {
      seen.push(e);
      if (e.kind === "done" || e.kind === "error") resolve(seen);
    });
  });
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds.at(-1), "done", JSON.stringify(events.find((e) => e.kind === "error")));
  assert.equal(kinds[0], "started");
  // Every finished trace row was announced first, and arrives before the answer.
  const traces = events.filter((e) => e.kind === "trace");
  assert.ok(traces.length >= 1);
  for (const t of traces) assert.ok(kinds.indexOf("trace_start") <= kinds.indexOf("trace"));
  assert.ok(kinds.lastIndexOf("trace") < kinds.indexOf("answer"));
  assert.ok(kinds.indexOf("answer") < kinds.indexOf("compiling") && kinds.indexOf("compiling") < kinds.indexOf("draft"));

  const draft = events.find((e) => e.kind === "draft")!;
  assert.equal(draft.workflow.name, "example_heading_job");
  for (const step of draft.workflow.steps) {
    assert.ok(Array.isArray(draft.derived_from[step.id]), `no derived_from for ${step.id}`);
    for (const i of draft.derived_from[step.id]) assert.ok(i >= 0 && i < traces.length);
  }
  assert.equal(getWorkflow("example_heading_job"), undefined, "a draft must not be saved until the user saves it");
});

test("run job (live): streams every step and finishes with a saved run", { skip: noKeys, timeout: 180_000 }, async () => {
  const wf = getWorkflow("competitor_pricing")!;
  const job = startRunJob(wf, { competitors: ["firecrawl.dev/pricing"] });
  const events = await new Promise<{ kind: string; [k: string]: any }[]>((resolve) => {
    const seen: any[] = [];
    subscribe(job, (e) => {
      seen.push(e);
      if (e.kind === "done" || e.kind === "error") resolve(seen);
    });
  });
  assert.equal(events.at(-1)!.kind, "done", JSON.stringify(events.find((e) => e.kind === "error")));
  assert.deepEqual(events[0].steps.map((s: any) => s.id), wf.steps.map((s) => s.id));
  const ends = events.filter((e) => e.kind === "step_end");
  assert.deepEqual(ends.map((e) => e.step), wf.steps.map((s) => s.id));
  const done = events.find((e) => e.kind === "run_done")!;
  assert.equal(done.run.status, "ok");
  const { getRun } = await import("../src/store.js");
  assert.ok(getRun(done.run.run_id), "run record was not saved");
});

test(`edit (live Gemini, ${MODEL}): applies a plain-English change and keeps the name`, { skip: noGemini, timeout: 120_000 }, async () => {
  const wf = getWorkflow("competitor_pricing");
  assert.ok(wf, "seed workflow missing");
  const result = await editWorkflow(wf, "Add an optional string param named currency, default \"USD\", and mention it in the extract instruction.");
  assert.equal(result.changed, true, result.reply);
  assert.equal(result.workflow.name, "competitor_pricing");
  assert.equal(result.workflow.version, wf.version);
  assert.ok(result.workflow.params.currency, `params: ${Object.keys(result.workflow.params)}`);
  assert.deepEqual(result.diff.params.added, ["currency"]);
  assert.deepEqual(result.diff.steps.removed, []);

  const question = await editWorkflow(result.workflow, "What does this workflow do? Don't change anything.");
  assert.equal(question.changed, false, JSON.stringify(question.diff));
  assert.ok(question.reply.length > 0);
});
