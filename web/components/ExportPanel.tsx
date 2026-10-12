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

const TINYFISH_KEYS_URL = "https://agent.tinyfish.ai/api-keys";
const GEMINI_KEYS_URL = "https://aistudio.google.com/apikey";

/**
 * How to run this workflow outside the web app. `local`: the app runs from a checkout on this computer, so commands
 * use its path. Otherwise (hosted, e.g. Vercel) the reader has nothing installed: clone the repo, install, add a
 * TinyFish (and Gemini) key, import the workflow downloaded from this site, then run it.
 */
export function ExportPanel({
  name,
  params,
  local,
  root,
  repoUrl,
}: {
  name: string;
  params: Record<string, Param>;
  local: boolean;
  root: string;
  repoUrl: string;
}) {
  const defaults = defaultsOf(params);
  const flags = Object.entries(defaults).map(([k, v]) => `--${k}=${shellQuote(Array.isArray(v) ? v.join(",") : String(v))}`);
  const dir = local ? root : "workflow-memory";
  const cd = `cd ${shellQuote(dir)}`;
  const file = `${name}.workflow.json`;
  const downloadPath = `/api/workflows/${encodeURIComponent(name)}/download`;

  const install = `git clone ${repoUrl} workflow-memory\ncd workflow-memory\nnpm install\ncp .env.example .env`;
  const keys = `TINYFISH_API_KEY=your-tinyfish-key\nGEMINI_API_KEY=your-gemini-key`;
  // Hosted downloads need the signed-in browser session, so the hosted import saves the file the browser downloaded.
  const importCmd = `${cd}\nnpx tsx src/cli.ts save ~/Downloads/${file}`;
  const run = `${cd}\nnpm run run-wf -- ${[name, ...flags].join(" ")}`;
  const mcpPath = local ? `${root}/src/mcp.ts` : `"$(pwd)/src/mcp.ts"`;
  const mcpCmd = `${cd}\nclaude mcp add workflow-memory -- npx tsx ${mcpPath}`;
  const prompt = `Use the workflow-memory MCP server's run_workflow tool to run the "${name}" workflow with params ${JSON.stringify(defaults)}. Report the output and any failed checks. Don't browse the web yourself for this; if the workflow fails, tell me which step failed.`;
  const configPath = local ? `${root}/src/mcp.ts` : "/absolute/path/to/workflow-memory/src/mcp.ts";
  const config = JSON.stringify({ mcpServers: { "workflow-memory": { command: "npx", args: ["tsx", configPath] } } }, null, 2);

  return (
    <section className="panel" aria-labelledby="export">
      <h2 id="export">Use this workflow elsewhere</h2>
      {local ? (
        <p className="small muted">
          These use the workflow-memory checkout on this computer ({root}). Its TinyFish and Gemini keys stay in {root}/.env and are never
          included here.
        </p>
      ) : (
        <p className="small muted">
          Run it on your own computer: install workflow-memory, which calls TinyFish for every web step, add your own TinyFish and Gemini
          keys, then import and run this workflow. Needs Node.js 22.13 or newer and git.
        </p>
      )}

      {!local && (
        <>
          <h3 className="export-heading">1. Install workflow-memory (once)</h3>
          <CopyBlock text={install} label="install commands" />

          <h3 className="export-heading">2. Add your API keys (once)</h3>
          <p className="small muted">
            Put these in <code>workflow-memory/.env</code>. Get a TinyFish key from the{" "}
            <a href={TINYFISH_KEYS_URL} target="_blank" rel="noreferrer">TinyFish API keys page</a> (search, fetch and the browser agent all
            run through it) and a Gemini key from{" "}
            <a href={GEMINI_KEYS_URL} target="_blank" rel="noreferrer">Google AI Studio</a> (used for extract steps).
          </p>
          <CopyBlock text={keys} label=".env contents" />

          <h3 className="export-heading">3. Import this workflow</h3>
          <p className="small muted">
            <a href={downloadPath}>Download {file}</a>, then save it as a version on your computer. Change the path if your browser
            saves downloads somewhere else.
          </p>
          <CopyBlock text={importCmd} label="import commands" />
        </>
      )}

      {local && (
        <>
          <h3 className="export-heading">Download</h3>
          <p className="small muted">Save the workflow as a JSON file.</p>
          <p><a href={downloadPath}>Download {file}</a></p>
        </>
      )}

      <h3 className="export-heading">{local ? "Command line" : "4. Run it"}</h3>
      <p className="small muted">Runs it from a terminal with the default values. Results print as JSON.</p>
      <CopyBlock text={run} label="run command" />

      <h3 className="export-heading">Claude Code</h3>
      <p className="small muted">Step 1: connect Claude Code to workflow-memory (once). It reads the keys from the .env file.</p>
      <CopyBlock text={mcpCmd} label="claude mcp add command" />
      <p className="small muted">Step 2: paste this prompt.</p>
      <CopyBlock text={prompt} label="prompt" />

      <h3 className="export-heading">Other MCP clients</h3>
      <p className="small muted">
        Add this to the client&apos;s MCP server configuration{local ? "" : ", with the real path to your workflow-memory folder"}.
      </p>
      <CopyBlock text={config} label="MCP config" />
    </section>
  );
}
