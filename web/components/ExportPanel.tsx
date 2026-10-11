import type { Param } from "@core/schema.js";
import { CopyBlock } from "./CopyBlock";

function defaultsOf(params: Record<string, Param>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(params)) if (p.default !== undefined) out[k] = p.default;
  return out;
}

function shellQuote(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function ExportPanel({ name, root, params }: { name: string; root: string; params: Record<string, Param> }) {
  const defaults = defaultsOf(params);
  const flags = Object.entries(defaults).map(([k, v]) => {
    const val = Array.isArray(v) ? v.join(",") : String(v);
    return `--${k}=${shellQuote(val)}`;
  });
  const cli = `cd ${shellQuote(root)} && npm run run-wf -- ${[name, ...flags].join(" ")}`;
  const mcpCmd = `claude mcp add workflow-memory -- npx tsx ${root}/src/mcp.ts`;
  const prompt = `Use the workflow-memory MCP server's run_workflow tool to run the "${name}" workflow with params ${JSON.stringify(defaults)}. Report the output and any failed checks. Don't browse the web yourself for this; if the workflow fails, tell me which step failed.`;
  const config = JSON.stringify({ mcpServers: { "workflow-memory": { command: "npx", args: ["tsx", `${root}/src/mcp.ts`] } } }, null, 2);

  return (
    <section className="panel" aria-labelledby="export">
      <h2 id="export">Use this workflow elsewhere</h2>
      <p className="small muted">These use the workflow-memory server on this computer. API keys stay in {root}/.env and are never included here.</p>

      <h3 className="export-heading">Download</h3>
      <p className="small muted">Save the workflow as a JSON file.</p>
      <p><a href={`/api/workflows/${encodeURIComponent(name)}/download`}>Download {name}.workflow.json</a></p>

      <h3 className="export-heading">Command line</h3>
      <p className="small muted">Run it from a terminal using the default values.</p>
      <CopyBlock text={cli} label="command line" />

      <h3 className="export-heading">Claude Code</h3>
      <p className="small muted">Step 1: connect Claude Code to the server (once).</p>
      <CopyBlock text={mcpCmd} label="claude mcp add command" />
      <p className="small muted">Step 2: paste this prompt.</p>
      <CopyBlock text={prompt} label="prompt" />

      <h3 className="export-heading">Other MCP clients</h3>
      <p className="small muted">Add this to the client's MCP server configuration.</p>
      <CopyBlock text={config} label="MCP config" />
    </section>
  );
}
