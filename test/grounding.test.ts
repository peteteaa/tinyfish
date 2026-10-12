import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Web data must come from TinyFish: Gemini extract steps may only process TinyFish output, and the explorer
// can't answer until a TinyFish call has returned content. Offline tests plus one live explore (skipped without keys).
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-grounding-test-"));

const { validateWorkflow } = await import("../src/schema.js");
const { explore, returnedContent } = await import("../src/explore.js");

const noKeys = (!process.env.GEMINI_API_KEY && "GEMINI_API_KEY not set") || (!process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set");
const schema = { type: "object", properties: { ok: { type: "boolean" } } };

test("validateWorkflow: an extract that only reads params is rejected (it would answer from Gemini's memory)", () => {
  const r = validateWorkflow({
    name: "check_field",
    description: "stub",
    params: { field: { type: "string", description: "field" } },
    steps: [{ id: "check_field", type: "extract", input: "{{params.field}}", instruction: "Is it set?", output_schema: schema }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => /steps\.check_field: an extract step must read the output of a search, fetch or agent step/.test(e)), r.errors.join("\n"));
    assert.ok(r.errors.some((e) => /at least one search, fetch or agent step/.test(e)), r.errors.join("\n"));
  }
});

test("validateWorkflow: extracts reading TinyFish output, directly or through another extract, are fine", () => {
  const r = validateWorkflow({
    name: "compare",
    description: "fetch, extract, then compare",
    params: { urls: { type: "string[]", description: "pages", default: ["example.com"] } },
    steps: [
      { id: "fetch_pages", type: "fetch", urls: "{{params.urls}}" },
      { id: "extract_plans", type: "extract", forEach: "{{steps.fetch_pages.results}}", input: "{{item.text}}", instruction: "plans", output_schema: schema },
      { id: "compare", type: "extract", input: "{{steps.extract_plans}} for {{params.urls}}", instruction: "compare", output_schema: schema },
    ],
  });
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("\n"));
});

test("returnedContent: only TinyFish calls that brought back content count", () => {
  const page = { url: "https://a", final_url: "https://a", title: "A", text: "hello" };
  assert.ok(returnedContent({ tool: "tinyfish_fetch", input: {}, output: { results: [page], errors: [] }, duration_ms: 1 }));
  assert.ok(!returnedContent({ tool: "tinyfish_fetch", input: {}, output: { results: [{ ...page, text: "  " }], errors: [] }, duration_ms: 1 }));
  assert.ok(returnedContent({ tool: "tinyfish_search", input: {}, output: { results: [{ url: "https://a" }] }, duration_ms: 1 }));
  assert.ok(!returnedContent({ tool: "tinyfish_search", input: {}, output: { results: [] }, duration_ms: 1 }));
  assert.ok(!returnedContent({ tool: "tinyfish_fetch", input: {}, error: "timeout", duration_ms: 1 }));
  assert.ok(returnedContent({ tool: "tinyfish_agent", input: {}, output: { status: "COMPLETED", result: { a: 1 } }, duration_ms: 1 }));
  assert.ok(!returnedContent({ tool: "tinyfish_agent", input: {}, output: { status: "FAILED", result: null }, duration_ms: 1 }));
  assert.ok(!returnedContent({ tool: "submit_answer", input: {}, output: {}, duration_ms: 1 }));
});

test("explore (live TinyFish + Gemini): a goal missing its input still reads the web before answering", { skip: noKeys, timeout: 600_000 }, async () => {
  // This exact goal used to end with zero TinyFish calls and a "please tell me your field" reply.
  const trace = await explore("find me qualified internships based on my field");
  const tools = trace.calls.map((c) => c.tool);
  console.error(`  calls: ${tools.join(", ")}`);
  assert.ok(trace.calls.some(returnedContent), `no TinyFish call returned content: ${tools.join(", ") || "(none)"}`);
  assert.ok(trace.answer !== undefined, "explorer never submitted an answer");
});

test("validateWorkflow: paths must match whether the step runs forEach", () => {
  const base = {
    name: "shapes",
    description: "search per company, fetch, extract",
    params: { companies: { type: "string[]" as const, description: "companies", default: ["stripe"] } },
  };
  const steps = (urls: string, output: string) => ({
    steps: [
      { id: "find", type: "search", forEach: "{{params.companies}}", query: "{{item}}" },
      { id: "fetch_pages", type: "fetch", urls },
      { id: "brief", type: "extract", input: "{{steps.fetch_pages.results.0.text}}", instruction: "brief", output_schema: schema },
    ],
    output,
  });
  const good = validateWorkflow({ ...base, ...steps("{{steps.find.*.results.0.url}}", "{{steps.brief}}") });
  assert.equal(good.ok, true, good.ok ? "" : good.errors.join("\n"));
  // The two real bugs: reading a forEach step as if it weren't, and indexing a single object.
  const bad = validateWorkflow({ ...base, ...steps("{{steps.find.results.*.url}}", "{{steps.brief.0}}") });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.some((e) => /"find" runs forEach/.test(e)), bad.errors.join("\n"));
    assert.ok(bad.errors.some((e) => /"brief" has no forEach.*drop "0"/.test(e)), bad.errors.join("\n"));
  }
});

test("validateWorkflow: a declared param no step uses is rejected", () => {
  const r = validateWorkflow({
    name: "unused",
    description: "x",
    params: { url: { type: "string", description: "page", default: "example.com" }, extra: { type: "string", description: "unused", default: "" } },
    steps: [{ id: "fetch_page", type: "fetch", urls: "{{params.url}}" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /params\.extra: declared but no step or output uses it/.test(e)), r.errors.join("\n"));
});

test("validateWorkflow: a param's example value baked into a step is rejected", () => {
  const wf = (instruction: string, prop: string) => ({
    name: "research_signup_company",
    description: "research a signup and compare",
    params: {
      signup_company: { type: "string", description: "who signed up", default: "github.com" },
      comparison_company: { type: "string", description: "compare against", default: "GitLab" },
    },
    steps: [
      { id: "search_company", type: "search", query: "{{params.signup_company}} vs {{params.comparison_company}}" },
      { id: "analysis", type: "extract", input: "{{steps.search_company.results}}", instruction, output_schema: { type: "object", properties: { [prop]: { type: "string" } } } },
    ],
  });
  const good = validateWorkflow(wf("Compare {{params.signup_company}} against {{params.comparison_company}}.", "comparison"));
  assert.equal(good.ok, true, good.ok ? "" : good.errors.join("\n"));
  // The production bug: "(e.g. GitHub)" in the instruction and a schema property named after the example.
  const bad = validateWorkflow(wf("Research the signup company (e.g. GitHub) and compare it against GitLab.", "comparison_with_gitlab"));
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.some((e) => /instruction: contains "github".*params\.signup_company/i.test(e)), bad.errors.join("\n"));
    assert.ok(bad.errors.some((e) => /output_schema property "comparison_with_gitlab".*params\.comparison_company/.test(e)), bad.errors.join("\n"));
  }
});

test("parameterize: literal example values in step text become {{params.x}}; templates, URLs and identifiers stay", async () => {
  const { parameterize } = await import("../src/schema.js");
  const wf = {
    params: {
      signup_company: { type: "string" as const, description: "who signed up", default: "github.com" },
      comparison_company: { type: "string" as const, description: "compare against", default: "GitLab" },
    },
    steps: [
      { id: "search_company", type: "search" as const, query: "github.com overview vs GitLab" },
      { id: "fetch_about", type: "fetch" as const, urls: ["https://github.com/about"] },
      {
        id: "analysis", type: "extract" as const, input: "{{params.signup_company}}: {{steps.search_company.results}}",
        instruction: "Research the signup company (e.g. GitHub) against GitLab. Fill comparison_with_gitlab.",
        output_schema: { type: "object" },
      },
    ],
  };
  const out = parameterize(wf);
  const step = (id: string) => out.steps.find((s) => s.id === id) as unknown as Record<string, unknown>;
  assert.equal(step("search_company").query, "{{params.signup_company}} overview vs {{params.comparison_company}}");
  assert.equal(step("analysis").instruction, "Research the signup company (e.g. {{params.signup_company}}) against {{params.comparison_company}}. Fill comparison_with_gitlab.");
  assert.equal(step("analysis").input, "{{params.signup_company}}: {{steps.search_company.results}}");
  assert.deepEqual(step("fetch_about").urls, ["https://github.com/about"]);
  assert.equal(parameterize(out), out, "already parameterized: returned as-is");
});

test("saveWorkflow: saving parameterizes literal example values", async () => {
  const { saveWorkflow } = await import("../src/store.js");
  const saved = await saveWorkflow({
    name: "follows_params",
    description: "x",
    params: { company: { type: "string", description: "company", default: "Stripe" } },
    steps: [
      { id: "search_company", type: "search", query: "Stripe funding" },
      { id: "brief", type: "extract", input: "{{steps.search_company.results}}", instruction: "Summarize {{params.company}} (e.g. Stripe).", output_schema: { type: "object", properties: { brief: { type: "string" } } } },
    ],
  });
  const steps = saved.steps as unknown as Record<string, unknown>[];
  assert.equal(steps[0].query, "{{params.company}} funding");
  assert.equal(steps[1].instruction, "Summarize {{params.company}} (e.g. {{params.company}}).");
});
