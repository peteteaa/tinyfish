import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoogleGenAI } from "@google/genai";

// Offline: model fallback in generate(), with a fake Gemini client.
process.env.GEMINI_API_KEY ??= "test-key";
const { FALLBACK_MODELS, generate, resetModelAvailability } = await import("../src/llm.js");

const dailyQuota = () =>
  Object.assign(new Error('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"},{"retryDelay":"3600s"}]}}'), { status: 429 });

function fakeClient(behaviour: (model: string) => Error | undefined) {
  const calls: string[] = [];
  const client = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        calls.push(model);
        const err = behaviour(model);
        if (err) throw err;
        return { candidates: [{ content: { role: "model", parts: [{ text: model }] } }] };
      },
    },
  } as unknown as GoogleGenAI;
  return { client, calls };
}

test("generate: falls back when a model's daily quota is used up, and skips it afterwards", async () => {
  const primary = "model-out-of-quota";
  const { client, calls } = fakeClient((m) => (m === primary ? dailyQuota() : undefined));
  resetModelAvailability(client);
  const first = await generate({ model: primary, contents: "hi" });
  assert.equal(first.candidates?.[0]?.content?.parts?.[0]?.text, FALLBACK_MODELS[0]);
  assert.deepEqual(calls, [primary, FALLBACK_MODELS[0]]);
  await generate({ model: primary, contents: "again" });
  assert.deepEqual(calls.slice(2), [FALLBACK_MODELS[0]], "the exhausted model shouldn't be called again until it resets");
});

test("generate: retired (404) models fall through; other errors are thrown as-is", async () => {
  const gone = Object.assign(new Error("models/x is no longer available"), { status: 404 });
  const { client, calls } = fakeClient((m) => (m === "retired" ? gone : undefined));
  resetModelAvailability(client);
  await generate({ model: "retired", contents: "hi" });
  assert.deepEqual(calls, ["retired", FALLBACK_MODELS[0]]);

  const bad = Object.assign(new Error("invalid schema"), { status: 400 });
  resetModelAvailability(fakeClient(() => bad).client);
  await assert.rejects(generate({ model: "any", contents: "hi" }), /invalid schema/);
});

test("generate: when every model is out of quota, the quota message explains what to do", async () => {
  resetModelAvailability(fakeClient(() => dailyQuota()).client);
  await assert.rejects(generate({ model: "a", contents: "hi" }), /Gemini quota used up \(429, daily limit\)/);
});
