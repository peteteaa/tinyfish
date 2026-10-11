import "./env.js";
import { learn } from "./compile.js";
import { log } from "./env.js";
import { runWorkflow } from "./executor.js";
import { getTrace, getWorkflow, listRuns, listWorkflows, saveWorkflow } from "./store.js";

const USAGE = `workflow-memory

  run <name> [--param=value ...] [--version=N]   run a saved workflow (string[] params are comma-separated)
  learn "<goal>" [--name=snake_name] [--run]     explore with TinyFish + Gemini, compile, save (--run: run it after)
  list                                           list saved workflows
  show <name> [--version=N] [--trace]            print a workflow (and the trace it was learned from)
  runs <name> [--limit=N]                        recent run history
  save <file.json>                               save a hand-written workflow as the next version`;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(a);
  }
  return { positional, flags };
}

function out(value: unknown) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const version = typeof flags.version === "string" ? Number(flags.version) : undefined;

  switch (cmd) {
    case "run": {
      const name = positional[0];
      if (!name) throw new Error("usage: run <name> [--param=value ...]");
      const { version: _v, ...params } = flags;
      const run = await runWorkflow(name, params, {
        version,
        onEvent: (e) => {
          if (e.type === "step_start") log(`> ${e.step}`);
          else if (e.record) {
            const r = e.record;
            const failed = r.checks.filter((c) => !c.passed);
            log(`  ${r.status} in ${(r.duration_ms / 1000).toFixed(1)}s${r.error ? `: ${r.error}` : ""}`);
            for (const c of failed) log(`  check failed: ${c.check}${c.message ? ` (${c.message})` : ""}`);
          }
        },
      });
      log(`\n${run.workflow} v${run.version}: ${run.status} in ${(run.duration_ms / 1000).toFixed(1)}s (run ${run.run_id})`);
      if (run.error) log(run.error);
      out(run.output ?? null);
      if (run.status !== "ok") process.exitCode = 1;
      return;
    }
    case "learn": {
      const goal = positional.join(" ");
      if (!goal) throw new Error('usage: learn "<goal>"');
      const { workflow } = await learn(goal, { name: typeof flags.name === "string" ? flags.name : undefined });
      out(workflow);
      log(`\nRerun with: npm run run-wf -- ${workflow.name}`);
      if (flags.run) {
        log(`\nRunning ${workflow.name} v${workflow.version} with default params...`);
        const run = await runWorkflow(workflow.name, {});
        log(`${run.status} in ${(run.duration_ms / 1000).toFixed(1)}s`);
        out(run.output ?? run.error ?? null);
      }
      return;
    }
    case "list": {
      const wfs = listWorkflows();
      if (!wfs.length) return out("No workflows yet.");
      for (const w of wfs) {
        const params = Object.entries(w.params)
          .map(([k, p]) => `--${k}=<${p.type}>${p.default !== undefined ? "?" : ""}`)
          .join(" ");
        const last = w.last_run ? `  last run: ${w.last_run.status} ${w.last_run.finished_at}` : "";
        out(`${w.name} (v${w.latest})  ${w.description}\n    ${params}${last}`);
      }
      return;
    }
    case "show": {
      const wf = getWorkflow(positional[0] ?? "", version);
      if (!wf) throw new Error(`No workflow named "${positional[0]}"`);
      out(wf);
      if (flags.trace && wf.source?.trace_id) out(getTrace(wf.source.trace_id) ?? "trace not found");
      return;
    }
    case "runs": {
      const name = positional[0];
      if (!name) throw new Error("usage: runs <name>");
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 10;
      for (const r of listRuns(name, limit)) {
        out(`${r.run_id}  v${r.version}  ${r.status}  ${(r.duration_ms / 1000).toFixed(1)}s  ${JSON.stringify(r.params)}`);
      }
      return;
    }
    case "save": {
      const fs = await import("node:fs");
      const wf = saveWorkflow(JSON.parse(fs.readFileSync(positional[0], "utf8")), "cli");
      out(`Saved ${wf.name} v${wf.version}`);
      return;
    }
    default:
      out(USAGE);
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});
