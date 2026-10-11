// Chat-style editing: Gemini rewrites a workflow from a plain-English instruction. Used for saved workflows and
// for drafts before they're saved. Nothing is stored here; the caller decides whether to save the result.

import type { Content } from "@google/genai";
import { z } from "zod";
import { WORKFLOW_FORMAT } from "./compile.js";
import { log } from "./env.js";
import { candidateContent, gemini, geminiSchema, MODEL, textOf } from "./llm.js";
import { validateWorkflow, WorkflowSchema, type Workflow } from "./schema.js";
import { diffWorkflows, hasChanges } from "./diff.js";
import type { WorkflowDiff } from "./store/types.js";

const SYSTEM = `You edit a saved web-task workflow: a JSON definition that a deterministic runner executes without an LLM
in the loop (except inside "extract" steps). The user describes a change in plain English; you apply it.

${WORKFLOW_FORMAT}

Editing rules:
1. Change only what the user asked for, plus whatever that change requires (e.g. a new param needs a declaration;
   renaming a step means updating every {{steps.<id>}} that points at it). Keep everything else byte-for-byte.
2. Keep the workflow name unchanged. Keep step ids stable unless the user asks to rename them.
3. New params get a description and, where the old behaviour had a concrete value, a default equal to that value.
4. When the user asks a question instead of a change, answer it in "reply" and return the workflow unchanged.
   When the workflow already does what they ask, say so in "reply" and return it unchanged.
5. Reply with only a JSON object: {"reply": "<one or two plain sentences saying what you changed, or the answer>",
   "workflow": <the complete workflow, matching <workflow_schema>>}. If it fails validation you'll get the errors
   back; reply again with the corrected complete object.`;

const MAX_ATTEMPTS = 3;
/** Earlier turns sent as context; older ones are dropped. */
const MAX_HISTORY = 10;

export interface EditTurn {
  role: "user" | "assistant";
  text: string;
}

export interface EditResult {
  workflow: Workflow;
  reply: string;
  diff: WorkflowDiff;
  changed: boolean;
}

export async function editWorkflow(current: Workflow, instruction: string, history: EditTurn[] = []): Promise<EditResult> {
  const base = validateWorkflow(current);
  if (!base.ok) throw new Error(`The current workflow is invalid:\n- ${base.errors.join("\n- ")}`);
  const { version, source, ...editable } = base.workflow;

  const earlier = history
    .slice(-MAX_HISTORY)
    .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`)
    .join("\n");
  const prompt = [
    `<workflow_schema>\n${JSON.stringify(geminiSchema(z.toJSONSchema(WorkflowSchema, { io: "input" })))}\n</workflow_schema>`,
    `<current_workflow>\n${JSON.stringify(editable, null, 2)}\n</current_workflow>`,
    source?.goal ? `<original_goal>\n${source.goal}\n</original_goal>` : "",
    earlier ? `<earlier_conversation>\n${earlier}\n</earlier_conversation>` : "",
    `<request>\n${instruction}\n</request>`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await gemini().models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: SYSTEM, responseMimeType: "application/json" },
    });
    const content = candidateContent(response);
    contents.push(content);
    let errors: string[];
    try {
      const parsed = JSON.parse(textOf(content)) as { reply?: unknown; workflow?: unknown };
      const draft = parsed.workflow && typeof parsed.workflow === "object" ? { ...parsed.workflow, name: current.name } : parsed.workflow;
      const result = validateWorkflow(draft);
      if (result.ok) {
        const workflow: Workflow = { ...result.workflow, ...(version !== undefined && { version }), ...(source && { source }) };
        const diff = diffWorkflows(current.name, base.workflow, workflow, version ?? 0, version ?? 0);
        const changed = hasChanges(diff);
        const reply = typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : changed ? "Updated the workflow." : "No changes.";
        return { workflow, reply, diff, changed };
      }
      errors = result.errors;
    } catch (err) {
      errors = [`Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }
    log(`  edit: attempt ${attempt} failed validation (${errors.length} errors)`);
    contents.push({
      role: "user",
      parts: [{ text: `Validation failed:\n- ${errors.join("\n- ")}\n\nReply with the corrected complete {"reply", "workflow"} object.` }],
    });
  }
  throw new Error(`Gemini didn't produce a valid workflow in ${MAX_ATTEMPTS} attempts. Try rephrasing the change.`);
}
