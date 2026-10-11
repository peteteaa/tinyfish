// MCP server (stdio). Never write to stdout here except through the transport; env.log goes to stderr.

import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { learn } from "./compile.js";
import { runWorkflow } from "./executor.js";
import { getWorkflow, listWorkflows, saveWorkflow } from "./store.js";

const server = new McpServer({ name: "workflow-memory", version: "0.1.0" });

const json = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function guarded(fn: () => Promise<unknown> | unknown) {
  try {
    return json(await fn());
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, true);
  }
}

server.registerTool(
  "list_workflows",
  {
    description:
      "List saved web workflows (name, description, params, last run). Check here before solving a web task from scratch: " +
      "if a workflow already covers it, run_workflow is much faster and cheaper.",
    inputSchema: {},
  },
  () => guarded(() => listWorkflows()),
);

server.registerTool(
  "run_workflow",
  {
    description: "Run a saved workflow with params. Returns the run status, output, and per-step check results.",
    inputSchema: {
      name: z.string(),
      params: z.record(z.string(), z.unknown()).optional().describe("Param values; see list_workflows for each workflow's params"),
      version: z.number().int().optional().describe("Defaults to the latest version"),
    },
  },
  ({ name, params, version }) =>
    guarded(async () => {
      const run = await runWorkflow(name, params ?? {}, { version });
      return {
        run_id: run.run_id,
        workflow: `${run.workflow}@v${run.version}`,
        status: run.status,
        error: run.error,
        output: run.output,
        steps: run.steps.map((s) => ({
          id: s.id,
          status: s.status,
          duration_ms: s.duration_ms,
          error: s.error,
          failed_checks: s.checks.filter((c) => !c.passed),
        })),
      };
    }),
);

server.registerTool(
  "learn_workflow",
  {
    description:
      "Solve a new web task from a plain-English goal using TinyFish (search, fetch, browser agent), then compile what worked " +
      "into a saved, parameterized workflow. Slow (minutes). Use only when list_workflows has nothing suitable.",
    inputSchema: {
      goal: z.string().describe("e.g. 'Get the pricing plans for firecrawl.dev and browserbase.com'"),
      name: z.string().optional().describe("snake_case workflow name; chosen automatically if omitted"),
    },
  },
  ({ goal, name }) =>
    guarded(async () => {
      const { trace, workflow } = await learn(goal, { name });
      return { workflow, answer: trace.answer, trace_id: trace.id };
    }),
);

server.registerTool(
  "save_workflow",
  {
    description:
      "Save a workflow definition (JSON) as the next version of its name. Use to hand-edit a workflow: fetch it with " +
      "get_workflow, change it, save it back. Returns validation errors if it is malformed.",
    inputSchema: { workflow: z.record(z.string(), z.unknown()) },
  },
  ({ workflow }) =>
    guarded(() => {
      const saved = saveWorkflow(workflow);
      return { saved: `${saved.name}@v${saved.version}` };
    }),
);

server.registerTool(
  "get_workflow",
  {
    description: "Get a workflow's full JSON definition.",
    inputSchema: { name: z.string(), version: z.number().int().optional() },
  },
  ({ name, version }) =>
    guarded(() => getWorkflow(name, version) ?? Promise.reject(new Error(`No workflow named "${name}"`))),
);

await server.connect(new StdioServerTransport());
