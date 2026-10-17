// Benchmark CLI: npm run bench -- <learn|compare|daily|drift|report> [--task=a,b] [--trials=N] [--concurrency=N]
// Every command makes real TinyFish and Gemini calls and writes its results to bench/results/.

import "../env.js";
import { log } from "../env.js";
import { runAs } from "../store.js";
import { FAULTS, type FaultName } from "./faults.js";
import { compareTasks, dailyTasks, driftTasks, learnTasks } from "./harness.js";
import { buildReport, formatReport } from "./report.js";
import { selectTasks } from "./tasks.js";

const USAGE = `bench: measure Workflow Memory (raw agent runs vs replayed workflows)

  learn   [--force|--retry-failed]    explore + compile each task once; saves bench/workflows/<task>.json
                                      (--retry-failed: relearn tasks whose last learned answer failed grading)
  compare [--trials=3]                per task, N rounds of a raw agent run and a workflow replay
  daily   [--accept]                  replay each workflow once; repair failures (--accept: save fixes that pass)
  drift   [--faults=a,b]              break each workflow (${Object.keys(FAULTS).join(", ")}), replay, repair
  report  [--json]                    summarize everything in bench/results/

  All: --task=id1,id2 (default: every task), --concurrency=N (tasks at once, default 3)`;

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(a);
  }
  return { positional, flags };
}

const int = (v: string | true | undefined, fallback: number) => {
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parse(rest);
  const task = typeof flags.task === "string" ? flags.task : undefined;
  const concurrency = int(flags.concurrency, 3);

  switch (cmd) {
    case "learn":
      await learnTasks(selectTasks(task), { force: !!flags.force, retryFailed: !!flags["retry-failed"], concurrency });
      break;
    case "compare":
      await compareTasks(selectTasks(task), { trials: int(flags.trials, 3), concurrency });
      break;
    case "daily":
      await dailyTasks(selectTasks(task), { accept: !!flags.accept, concurrency });
      break;
    case "drift": {
      const faults = (typeof flags.faults === "string" ? flags.faults.split(",") : Object.keys(FAULTS)) as FaultName[];
      const unknown = faults.filter((f) => !(f in FAULTS));
      if (unknown.length) throw new Error(`Unknown fault(s): ${unknown.join(", ")}`);
      await driftTasks(selectTasks(task), { faults, concurrency });
      break;
    }
    case "report":
      break;
    default:
      console.log(USAGE);
      return;
  }
  const report = buildReport();
  if (cmd === "report" && flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}

// Benchmark data (traces, run history) is kept apart from the user's own workflows.
runAs(process.env.WM_OWNER || "bench", main).catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
