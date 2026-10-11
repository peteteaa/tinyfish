import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Isolate storage before any src module loads. API keys come from the real .env.
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-test-"));

const { resolve } = await import("../src/template.js");
const { validateWorkflow } = await import("../src/schema.js");
const { runCheck, resolveParams, runWorkflow } = await import("../src/executor.js");
const { getWorkflow, listRuns, listWorkflows, saveWorkflow } = await import("../src/store.js");
const { geminiSchema } = await import("../src/llm.js");
const { fetchPages, FETCH_MAX_URLS, normalizeSchema } = await import("../src/tinyfish.js");

const ctx = {
  params: { competitors: ["a.com", "b.com"], n: 2 },
  steps: { search: { results: [{ url: "https://x" }, { url: "https://y" }] } },
  previous: { search: { results: [] } },
  item: { text: "hello", final_url: "https://a.com" },
};

test("template: whole-expression keeps raw values", () => {
  assert.deepEqual(resolve("{{params.competitors}}", ctx), ["a.com", "b.com"]);
  assert.deepEqual(resolve("{{steps.search.results.*.url}}", ctx), ["https://x", "https://y"]);
  assert.equal(resolve("{{steps.search.results.1.url}}", ctx), "https://y");
});

test("template: interpolation, nesting, item and previous", () => {
  assert.equal(resolve("From {{item.final_url}}: {{item.text}}", ctx), "From https://a.com: hello");
  assert.equal(resolve("n={{params.n}} list={{params.competitors}}", ctx), 'n=2 list=["a.com","b.com"]');
  assert.deepEqual(resolve({ a: ["{{params.n}}"], b: "{{previous.search.results}}" }, ctx), { a: [2], b: [] });
  assert.equal(resolve("missing: {{params.nope}}", ctx), "missing: ");
});

test("validateWorkflow: catches bad references", () => {
  const bad = validateWorkflow({
    name: "bad",
    description: "x",
    params: { q: { type: "string", description: "q" } },
    steps: [
      { id: "one", type: "search", query: "{{params.missing}}" },
      { id: "two", type: "fetch", urls: "{{steps.three.results}}" },
      { id: "three", type: "extract", input: "{{item.text}}", instruction: "x", output_schema: {} },
    ],
  });
  assert.equal(bad.ok, false);
  const errors = bad.ok ? "" : bad.errors.join("\n");
  assert.match(errors, /unknown param "params.missing"/);
  assert.match(errors, /must reference an earlier step/);
  assert.match(errors, /\{\{item\}\} used outside a forEach/);
});

test("seed workflow is valid and seeded into the store", () => {
  const seed = JSON.parse(fs.readFileSync(new URL("../seeds/competitor_pricing.json", import.meta.url), "utf8"));
  const r = validateWorkflow(seed);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  assert.ok(listWorkflows().some((w) => w.name === "competitor_pricing" && w.latest === 1));
});

test("checks", () => {
  assert.equal(runCheck({ type: "min_items", path: "plans", value: 1 }, { plans: [] }).passed, false);
  assert.equal(runCheck({ type: "min_items", path: "plans", value: 1 }, { plans: [{}] }).passed, true);
  assert.equal(runCheck({ type: "required_keys", keys: ["company"] }, { company: "" }).passed, false);
  assert.equal(runCheck({ type: "not_empty" }, "x").passed, true);
  assert.equal(runCheck({ type: "regex", path: "price", pattern: "\\$\\d+" }, { price: "$20/mo" }).passed, true);
});

test("params: coercion, defaults, required, unknown", () => {
  const wf = getWorkflow("competitor_pricing")!;
  assert.deepEqual(resolveParams(wf, { competitors: "a.com/pricing, b.com/pricing" }), {
    competitors: ["a.com/pricing", "b.com/pricing"],
  });
  assert.throws(() => resolveParams(wf, {}), /Missing required param/);
  assert.throws(() => resolveParams(wf, { competitors: "a", oops: 1 }), /Unknown params: oops/);
});

test("geminiSchema strips $schema at every level and keeps the rest", () => {
  const out = geminiSchema({ $schema: "x", type: "object", properties: { a: { $schema: "y", type: "string" } } }) as any;
  assert.equal(out.$schema, undefined);
  assert.equal(out.properties.a.$schema, undefined);
  assert.equal(out.properties.a.type, "string");
});

test("normalizeSchema lowercases types (TinyFish rejects OBJECT/STRING) without touching property names", () => {
  assert.deepEqual(
    normalizeSchema({ type: "OBJECT", properties: { TYPE: { type: "STRING" }, tags: { type: ["ARRAY", "NULL"], items: { type: "STRING" } } } }),
    { type: "object", properties: { TYPE: { type: "string" }, tags: { type: ["array", "null"], items: { type: "string" } } } },
  );
});

// Live: real TinyFish Fetch calls (free). Skipped, not faked, when no key is configured.
test(
  "executor (live TinyFish): runs steps, records checks, history and {{previous}}",
  { skip: !process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set" },
  async () => {
    saveWorkflow({
      name: "fetch_only",
      description: "test",
      params: { urls: { type: "string[]", description: "urls", default: ["example.com"] } },
      steps: [
        { id: "pages", type: "fetch", urls: "{{params.urls}}", checks: [{ type: "min_items", path: "results", value: 1 }] },
      ],
      output: { titles: "{{steps.pages.results.*.title}}", before: "{{previous.pages.results.*.title}}" },
    });

    const first = await runWorkflow("fetch_only", {});
    assert.equal(first.status, "ok", first.error ?? JSON.stringify(first.steps[0].checks));
    const page = (first.steps[0].output as any).results[0];
    assert.match(page.final_url, /^https:\/\/example\.com/); // scheme was added
    assert.ok(typeof page.text === "string" && page.text.length > 0);
    assert.equal((first.output as any).before, undefined);

    const second = await runWorkflow("fetch_only", {});
    assert.equal(second.status, "ok");
    assert.deepEqual((second.output as any).before, (first.output as any).titles); // previous = last successful run
    assert.equal(listRuns("fetch_only").length, 2);
  },
);

test("checks: * in a path means every element must pass", () => {
  const out = { plans: [{ name: "Free", price: "$0" }, { name: "Pro", price: "$20" }] };
  assert.equal(runCheck({ type: "required_keys", path: "plans.*", keys: ["price"] }, out).passed, true);
  const missing = runCheck({ type: "required_keys", path: "plans.*", keys: ["price"] }, { plans: [{ price: "$0" }, { name: "Team" }] });
  assert.equal(missing.passed, false);
  assert.equal(missing.message, "item 1: missing: price");
  assert.equal(runCheck({ type: "not_empty", path: "plans.*.price" }, { plans: [{ price: null }, { price: "$5" }] }).passed, false);
  assert.equal(runCheck({ type: "regex", path: "plans.*.price", pattern: "^\\$" }, out).passed, true);
  assert.equal(runCheck({ type: "min_items", path: "groups.*.items", value: 1 }, { groups: [{ items: [1] }, { items: [] }] }).passed, false);
  assert.equal(runCheck({ type: "not_empty", path: "plans.*" }, { plans: "x" }).message, "value is not an array");
  assert.equal(runCheck({ type: "required_keys", path: "plans.*", keys: ["price"] }, { plans: [] }).passed, true); // count is min_items' job
});

// Live: Fetch rejects more than 10 URLs per request, so fetchPages splits them. Free calls.
test(
  `fetchPages (live TinyFish): more than ${FETCH_MAX_URLS} URLs are split into batches`,
  { skip: !process.env.TINYFISH_API_KEY && "TINYFISH_API_KEY not set" },
  async () => {
    const urls = ["example.com", "example.org", "example.net", "iana.org", "www.iana.org/domains", "www.iana.org/about",
      "www.iana.org/protocols", "www.iana.org/numbers", "www.iana.org/help", "www.iana.org/contact", "www.iana.org/news"];
    const r = await fetchPages({ urls });
    assert.equal(r.results.length + r.errors.length, urls.length);
    assert.ok(r.results.length >= FETCH_MAX_URLS, JSON.stringify(r.errors));
  },
);
