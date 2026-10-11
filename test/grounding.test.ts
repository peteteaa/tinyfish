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
