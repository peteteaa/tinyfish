import "./env.js";
import { learn } from "./compile.js";
import { editWorkflow } from "./edit.js";
import { repairAndVerify, repairWorkflow } from "./repair.js";
import { log } from "./env.js";
import { runWorkflow } from "./executor.js";
import { deleteWorkflow, getRun, getTrace, getWorkflow, listRuns, listWorkflows, saveWorkflow } from "./store.js";

const USAGE = `workflow-memory

  run <name> [--param=value ...] [--version=N]   run a saved workflow (string[] params are comma-separated)
  learn "<goal>" [--name=snake_name] [--run]     explore with TinyFish + Gemini, compile, save (--run: run it after)
  list                                           list saved workflows
  show <name> [--version=N] [--trace]            print a workflow (and the trace it was learned from)
  runs <name> [--limit=N]                        recent run history
  save <file.json>                               save a hand-written workflow as the next version
  edit <name> "<change>" [--dry-run]             have Gemini apply a plain-English change, save as the next version
  repair <run_id> [step] [--dry-run] [--no-test] have Gemini fix a failed step, test-run the fix (up to 3 rounds),
                                                 save it as the next version if a test passes (--force: save anyway)
  delete <name>                                  delete a workflow, all its versions and its run history`;

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
      const wfs = await listWorkflows();
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
      const wf = await getWorkflow(positional[0] ?? "", version);
      if (!wf) throw new Error(`No workflow named "${positional[0]}"`);
      out(wf);
      if (flags.trace && wf.source?.trace_id) out((await getTrace(wf.source.trace_id)) ?? "trace not found");
      return;
    }
    case "runs": {
      const name = positional[0];
      if (!name) throw new Error("usage: runs <name>");
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 10;
      for (const r of await listRuns(name, limit)) {
        out(`${r.run_id}  v${r.version}  ${r.status}  ${(r.duration_ms / 1000).toFixed(1)}s  ${JSON.stringify(r.params)}`);
      }
      return;
    }
    case "save": {
      const fs = await import("node:fs");
      const wf = await saveWorkflow(JSON.parse(fs.readFileSync(positional[0], "utf8")), "cli");
      out(`Saved ${wf.name} v${wf.version}`);
      return;
    }
    case "edit": {
      const [name, ...words] = positional;
      const instruction = words.join(" ");
      if (!name || !instruction) throw new Error('usage: edit <name> "<change>" [--dry-run]');
      const wf = await getWorkflow(name, version);
      if (!wf) throw new Error(`No workflow named "${name}"`);
      const result = await editWorkflow(wf, instruction);
      log(result.reply);
      if (!result.changed) return;
      if (flags["dry-run"]) return out(result.workflow);
      const { version: _v, ...draft } = result.workflow;
      const saved = await saveWorkflow(draft, "cli");
      out(`Saved ${saved.name} v${saved.version}`);
      return;
    }
    case "repair": {
      const run = await getRun(positional[0] ?? "");
      if (!run) throw new Error("usage: repair <run_id> [step]  (run ids are listed by `runs <name>`)");
      const stepId = positional[1] ?? run.steps.find((s) => s.status !== "ok")?.id;
      if (!stepId) throw new Error(`Every step passed in run ${run.run_id}; there's nothing to repair.`);
      const wf = await getWorkflow(run.workflow);
      if (!wf) throw new Error(`No workflow named "${run.workflow}"`);
      if (flags["no-test"]) {
        const result = await repairWorkflow(wf, run, stepId);
        log(result.reply);
        if (!result.changed) return;
        if (flags["dry-run"]) return out(result.workflow);
        const { version: _v, ...draft } = result.workflow;
        const saved = await saveWorkflow(draft, "repair");
        out(`Saved ${saved.name} v${saved.version} (repaired from v${run.version}, untested)`);
        return;
      }
      const result = await repairAndVerify(wf, run, stepId, {
        onEvent: (e) => {
          if (e.kind === "repair_round") log(`Round ${e.round}: fixing ${e.step}...`);
          else if (e.kind === "repair_proposal") log(`  ${e.reply}`);
          else if (e.kind === "test_done") log(`  test: ${e.status}${e.failed_step ? ` at ${e.failed_step}: ${e.failures.join("; ")}` : ""}`);
        },
      });
      log(result.reply);
      if (!result.changed) return;
      if (result.verified !== true && !flags.force && !flags["dry-run"]) {
        process.exitCode = 1;
        return log("Not saved: no fix passed its test run. Rerun with --dry-run to see it, or --force to save it anyway.");
      }
      if (flags["dry-run"]) return out(result.workflow);
      const { version: _v, ...draft } = result.workflow;
      const saved = await saveWorkflow(draft, "repair");
      out(`Saved ${saved.name} v${saved.version} (repaired from v${run.version})`);
      return;
    }
    case "delete": {
      const name = positional[0];
      if (!name) throw new Error("usage: delete <name>");
      if (!(await deleteWorkflow(name))) throw new Error(`No workflow named "${name}"`);
      out(`Deleted ${name}`);
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
