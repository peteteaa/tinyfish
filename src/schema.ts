import { z } from "zod";

// A template is a string that may contain {{params.x}}, {{steps.id...}}, {{previous.id...}} or {{item...}}.
// When a string is exactly one {{...}} expression, it resolves to the raw value (array, object, ...).
const Template = z.string();

export const CheckSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("not_empty"),
    path: z.string().optional().describe("Dotted path inside the step output; omit for the whole output"),
  }),
  z.object({
    type: z.literal("min_items"),
    path: z.string().optional(),
    value: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("required_keys"),
    path: z.string().optional(),
    keys: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal("regex"),
    path: z.string().optional(),
    pattern: z.string(),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

const StepBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, "step ids are snake_case"),
  description: z.string().optional(),
  forEach: Template.optional().describe(
    "Template resolving to an array. The step runs once per element, exposed as {{item}}; output is an array.",
  ),
  concurrency: z.number().int().min(1).max(16).optional(),
  checks: z.array(CheckSchema).optional().describe("Run against each output (each item's output for forEach steps)"),
};

export const SearchStepSchema = z.object({
  ...StepBase,
  type: z.literal("search"),
  query: Template,
  purpose: Template.optional(),
  include_domains: Template.optional().describe("Comma-separated domains"),
  domain_type: z.enum(["web", "news", "research_paper"]).optional(),
});

export const FetchStepSchema = z.object({
  ...StepBase,
  type: z.literal("fetch"),
  urls: z.union([Template, z.array(Template)]),
  purpose: Template.optional(),
  format: z.enum(["markdown", "html", "json"]).optional(),
  links: z.boolean().optional(),
});

export const AgentStepSchema = z.object({
  ...StepBase,
  type: z.literal("agent"),
  url: Template,
  goal: Template,
  output_schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema for the agent's result"),
  browser_profile: z.enum(["lite", "stealth"]).optional(),
  max_steps: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Requires TinyFish beta access; other accounts get a 403. Omit unless you know it's enabled."),
});

export const ExtractStepSchema = z.object({
  ...StepBase,
  type: z.literal("extract"),
  input: Template.describe("Text to extract from, usually {{item.text}} or {{steps.fetch_x.results.0.text}}"),
  instruction: Template,
  output_schema: z.record(z.string(), z.unknown()).describe("JSON Schema for the extracted value"),
});

export const StepSchema = z.discriminatedUnion("type", [
  SearchStepSchema,
  FetchStepSchema,
  AgentStepSchema,
  ExtractStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;

export const ParamSchema = z.object({
  type: z.enum(["string", "string[]", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});
export type Param = z.infer<typeof ParamSchema>;

export const WorkflowSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "workflow names are snake_case"),
  version: z.number().int().min(1).optional().describe("Assigned by the store on save"),
  description: z.string(),
  params: z.record(z.string(), ParamSchema).default({}),
  steps: z.array(StepSchema).min(1),
  output: z.unknown().optional().describe("Template (string or object of templates) for the final result"),
  source: z
    .object({
      goal: z.string().optional(),
      trace_id: z.string().optional(),
      created_at: z.string().optional(),
      repaired_from: z.number().optional(),
    })
    .optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

const REF = /\{\{\s*([^}]+?)\s*\}\}/g;

function refsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") for (const m of value.matchAll(REF)) out.push(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => refsIn(v, out));
  return out;
}

/** Structural checks zod can't express: references must point at declared params and earlier steps. */
export function validateWorkflow(input: unknown): { ok: true; workflow: Workflow } | { ok: false; errors: string[] } {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const wf = parsed.data;
  const errors: string[] = [];
  const seen = new Set<string>();

  const checkRefs = (where: string, value: unknown, inForEach: boolean) => {
    for (const ref of refsIn(value)) {
      const [root, head] = ref.split(".");
      if (root === "params") {
        if (!head || !(head in wf.params)) errors.push(`${where}: unknown param "${ref}"`);
      } else if (root === "steps") {
        if (!head || !seen.has(head)) errors.push(`${where}: "${ref}" must reference an earlier step`);
      } else if (root === "previous") {
        if (!head || !wf.steps.some((s) => s.id === head)) errors.push(`${where}: unknown step in "${ref}"`);
      } else if (root === "item") {
        if (!inForEach) errors.push(`${where}: {{item}} used outside a forEach step`);
      } else {
        errors.push(`${where}: unknown reference root in "{{${ref}}}"`);
      }
    }
  };

  for (const step of wf.steps) {
    if (seen.has(step.id)) errors.push(`steps.${step.id}: duplicate step id`);
    const { forEach, checks, id, type, description, concurrency, ...fields } = step;
    if (forEach !== undefined) checkRefs(`steps.${id}.forEach`, forEach, false);
    checkRefs(`steps.${id}`, fields, forEach !== undefined);
    seen.add(step.id);
  }
  if (wf.output !== undefined) checkRefs("output", wf.output, false);

  return errors.length ? { ok: false, errors } : { ok: true, workflow: wf };
}
