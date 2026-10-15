import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { GoogleGenAI } from "@google/genai";

// Offline: repairAndVerify's decisions (what it tests with, when it calls a fix verified, which diff it returns), with
// a fake Gemini client answering both the repair edits and the workflow's extract step, and a stubbed fetch standing in
// for TinyFish Fetch. No network.
process.env.WM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wm-repair-offline-"));
process.env.GEMINI_API_KEY ||= "test-key";
process.env.TINYFISH_API_KEY ||= "test-key";
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
  const results = urls.map((url) => ({ url, final_url: url, title: null, description: null, language: null, format: "markdown", text: `Page ${url}` }));
  return new Response(JSON.stringify({ results, errors: [] }));
}) as typeof fetch;

const { repairAndVerify } = await import("../src/repair.js");
const { runWorkflowDef, runCheck } = await import("../src/executor.js");
const { resetModelAvailability } = await import("../src/llm.js");
const { validateWorkflow } = await import("../src/schema.js");
const { normalizeSchema } = await import("../src/tinyfish.js");
type Workflow = import("../src/schema.js").Workflow;

/** Fetches example.com/{{params.text}}, then extracts; the extract finds a value only on the "GOOD" page. */
function workflow(over: { default?: string; description?: string; output?: unknown } = {}): Workflow {
  return {
    name: "repair_fake",
    version: 1,
    description: "test",
    params: { text: { type: "string", description: "Page to read", default: over.default ?? "OLD" } },
    steps: [
      { id: "get", type: "fetch", urls: "https://example.com/{{params.text}}" },
      {
        id: "pull",
        type: "extract",
        ...(over.description && { description: over.description }),
        input: "{{steps.get.results.0.text}}",
        instruction: "Find the value",
        output_schema: { type: "object", properties: { v: { type: "string" } } },
        checks: [{ type: "not_empty", path: "v" }],
      },
    ],
    output: over.output ?? "{{steps.pull.v}}",
  };
}

/** Fake Gemini: extract calls answer from the content; edit calls return the next queued proposal. */
function fakeGemini(proposals: Workflow[]) {
  const edits: string[] = [];
  const client = {
    models: {
      generateContent: async (params: { contents: { parts: { text: string }[] }[]; config?: { responseJsonSchema?: unknown } }) => {
        const prompt = params.contents[0].parts[0].text;
        let text: string;
        if (params.config?.responseJsonSchema) {
          text = JSON.stringify({ v: prompt.includes("GOOD") ? "found" : null });
        } else {
          edits.push(params.contents.at(-1)!.parts[0].text);
          const { version: _v, ...wf } = proposals.shift() ?? assert.fail("unexpected extra repair round");
          text = JSON.stringify({ reply: "Changed it.", workflow: wf });
        }
        return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
      },
    },
  } as unknown as GoogleGenAI;
  resetModelAvailability(client);
  return { edits };
}

async function failedRun(wf: Workflow) {
  fakeGemini([]);
  const run = await runWorkflowDef({ ...wf, version: undefined }, {});
  return { ...run, version: 1 };
}

test("repair tests a fix that changes a param default with the new default, not the run's old one", async () => {
  const current = workflow();
  const run = await failedRun(current);
  assert.equal(run.steps[1].status, "check_failed");
  assert.deepEqual(run.params, { text: "OLD" }, "the run record holds the resolved default");

  fakeGemini([workflow({ default: "GOOD" })]);
  const result = await repairAndVerify(current, run, "pull");
  assert.equal(result.verified, true);
  assert.equal(result.rounds, 1);
});

test("repair keeps params the user passed explicitly", async () => {
  const current = workflow();
  fakeGemini([]);
  const run = { ...(await runWorkflowDef({ ...current, version: undefined }, { text: "USER" })), version: 1 };
  fakeGemini([workflow({ default: "GOOD" })]);
  const result = await repairAndVerify(current, run, "pull", { maxRounds: 1 });
  assert.equal(result.verified, false, "the user's value still fails, so the fix isn't proven for their input");
});

test("repair doesn't call a fix verified when the run fails at the output template, and repairs the output", async () => {
  const current = workflow({ default: "GOOD", output: "{{steps.pull.missing}}" });
  const run = await failedRun(current);
  assert.equal(run.status, "error");
  assert.ok(run.steps.every((s) => s.status === "ok"), "every step passed; only the output failed");

  // Round 1 touches the step but keeps the broken output; round 2 fixes the output.
  const { edits } = fakeGemini([
    workflow({ default: "GOOD", output: "{{steps.pull.missing}}", description: "tweaked" }),
    workflow({ default: "GOOD", description: "tweaked" }),
  ]);
  const result = await repairAndVerify(current, run, "pull");
  assert.equal(result.verified, true);
  assert.equal(result.rounds, 2);
  assert.match(edits[1], /Repair the workflow's output/);
});

test("a multi-round repair returns the diff against the saved workflow, not the previous proposal", async () => {
  const current = workflow();
  const run = await failedRun(current);
  // Round 1 edits the step's description and still fails; round 2 also changes the default and passes.
  fakeGemini([workflow({ description: "round 1" }), workflow({ description: "round 1", default: "GOOD" })]);
  const result = await repairAndVerify(current, run, "pull");
  assert.equal(result.verified, true);
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.diff.params.changed, ["text"]);
  assert.deepEqual(result.diff.steps.changed, [{ id: "pull", fields: ["description"] }], "round 1's edit is listed too");
});

test("regex checks: invalid patterns fail validation, and a saved bad pattern fails the check instead of the step", () => {
  const wf = workflow();
  const withCheck = (pattern: string) => ({ ...wf, steps: [wf.steps[0], { ...wf.steps[1], checks: [{ type: "regex", pattern }] }] });
  const bad = withCheck("$\\d+(");
  const result = validateWorkflow(bad);
  assert.equal(result.ok, false);
  assert.match((result as { errors: string[] }).errors.join("\n"), /steps\.1\.checks\.0\.pattern: not a valid JavaScript regular expression/);
  assert.equal(validateWorkflow(withCheck("\\$\\d+")).ok, true);

  const check = runCheck({ type: "regex", pattern: "$\\d+(" }, "costs $5");
  assert.equal(check.passed, false);
  assert.match(check.message ?? "", /invalid pattern/);
});

test("normalizeSchema lowercases the types inside a property named \"type\"", () => {
  assert.deepEqual(normalizeSchema({ type: "OBJECT", properties: { type: { type: "STRING" }, name: { type: "STRING" } } }), {
    type: "object",
    properties: { type: { type: "string" }, name: { type: "string" } },
  });
});
