// Aggregates benchmark sessions (bench/results/) into the numbers the CLI prints and the /bench page shows.
// Raw vs replay figures come from "compare" sessions only; drift trials replay broken workflows on purpose.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../env.js";
import type { Usage } from "../usage.js";
import type { RepairRecord, Session, Trial } from "./harness.js";
import { gradeOutput } from "./grade.js";
import { TASKS } from "./tasks.js";

export interface ModeStats {
  trials: number;
  passed: number;
  success_rate: number;
  /** Median latency excluding rate-limit waits (activeMs). */
  median_ms: number;
  /** Mean time per trial spent waiting on Gemini rate limits. */
  wait_ms: number;
  mean_tokens: number;
  mean_cost_usd: number;
  /** TinyFish browser-agent runs per trial (paid in TinyFish credits, not included in mean_cost_usd). */
  mean_agent_runs: number;
  /** Share of runs where every step ran and every workflow check passed (replay only). */
  check_pass_rate?: number;
}

export interface TaskSummary {
  task: string;
  category: string;
  goal: string;
  raw?: ModeStats;
  replay?: ModeStats;
  /** Summed over every learn attempt for the task. */
  learn?: { cost_usd: number; duration_ms: number; tokens: number; passed: boolean; attempts: number };
  /** raw median latency / replay median latency. */
  speedup?: number;
  /** 1 - replay tokens / raw tokens. */
  token_reduction?: number;
  cost_reduction?: number;
  /** Replays after which learning has paid for itself (learn cost / saving per run). */
  break_even_runs?: number;
}

export interface DailyPoint {
  date: string;
  session: string;
  total: number;
  passed: number;
  broke: number;
  detected: number;
  healed: number;
  accepted: number;
}

export interface FaultStats {
  fault: string;
  applicable: number;
  broke: number;
  detected: number;
  healed: number;
}

export interface BenchReport {
  generated_at: string;
  model?: string;
  sessions: Record<Session["kind"], number>;
  headline?: {
    tasks: number;
    trials: number;
    raw_success: number;
    replay_success: number;
    /** Geometric mean of per-task speedups. */
    speedup: number;
    /** Mean over all trials. */
    raw_tokens: number;
    replay_tokens: number;
    token_reduction: number;
    raw_cost_usd: number;
    replay_cost_usd: number;
    cost_reduction: number;
    raw_agent_runs: number;
    replay_agent_runs: number;
    raw_median_ms: number;
    replay_median_ms: number;
    replay_check_pass_rate: number;
    median_break_even_runs?: number;
  };
  tasks: TaskSummary[];
  daily: DailyPoint[];
  faults: FaultStats[];
  repair: { attempted: number; healed: number; undetected: number; mean_cost_usd: number; mean_ms: number };
  /** Mean rate-limit wait per compare trial, by mode (left out of latency). */
  waits: { raw: number; replay: number };
}

export const RESULTS_DIR = path.join(ROOT, "bench", "results");

export function loadSessions(dir = RESULTS_DIR): Session[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      fs
        .readdirSync(path.join(dir, d.name))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, d.name, f), "utf8")) as Session),
    )
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * Latency without time spent waiting out Gemini rate limits: the free tier's per-minute quota stalls whichever run
 * makes more calls (the raw agent), which would inflate the speedup. Wall-clock time stays in each trial.
 */
export const activeMs = (t: Trial) => Math.max(0, t.duration_ms - (t.usage.wait_ms ?? 0));

export const tokens = (u: Usage) => u.gemini.input + u.gemini.output + u.gemini.thoughts;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const geomean = (xs: number[]) => (xs.length ? Math.exp(mean(xs.map(Math.log))) : 0);

function stats(trials: Trial[]): ModeStats | undefined {
  if (!trials.length) return undefined;
  const passed = trials.filter((t) => t.grade.passed).length;
  const replays = trials.filter((t) => t.kind === "replay");
  return {
    trials: trials.length,
    passed,
    success_rate: passed / trials.length,
    median_ms: median(trials.map(activeMs)),
    wait_ms: mean(trials.map((t) => t.usage.wait_ms ?? 0)),
    mean_tokens: mean(trials.map((t) => tokens(t.usage))),
    mean_cost_usd: mean(trials.map((t) => t.cost_usd)),
    mean_agent_runs: mean(trials.map((t) => t.usage.tinyfish.agent)),
    ...(replays.length && { check_pass_rate: replays.filter((t) => t.status === "ok").length / replays.length }),
  };
}

/**
 * Grades trials again with the current expectations, so a corrected expectation applies to past results too. Outputs
 * stored truncated keep the grade they got at run time.
 */
export function regrade(sessions: Session[]): Session[] {
  const expect = new Map(TASKS.map((t) => [t.id, t.expect]));
  const again = (t: Trial): Trial => {
    const e = expect.get(t.task);
    if (!e || (typeof t.output === "string" && t.output.includes("...[truncated"))) return t;
    return { ...t, grade: gradeOutput(t.output ?? null, e) };
  };
  return sessions.map((s) => ({ ...s, trials: s.trials.map(again) }));
}

export function buildReport(loaded: Session[] = loadSessions()): BenchReport {
  const sessions = regrade(loaded);
  const of = (kind: Session["kind"]) => sessions.filter((s) => s.kind === kind);
  const compareTrials = of("compare").flatMap((s) => s.trials);
  // Learning cost adds up every attempt (relearning a bad answer isn't free); "passed" is the latest attempt.
  const learns = new Map<string, { cost_usd: number; duration_ms: number; tokens: number; passed: boolean; attempts: number }>();
  for (const t of of("learn").flatMap((s) => s.trials)) {
    const prev = learns.get(t.task);
    learns.set(t.task, {
      cost_usd: (prev?.cost_usd ?? 0) + t.cost_usd,
      duration_ms: (prev?.duration_ms ?? 0) + activeMs(t),
      tokens: (prev?.tokens ?? 0) + tokens(t.usage),
      passed: t.grade.passed,
      attempts: (prev?.attempts ?? 0) + 1,
    });
  }

  const tasks: TaskSummary[] = TASKS.flatMap((task) => {
    const raw = stats(compareTrials.filter((t) => t.task === task.id && t.kind === "raw"));
    const replay = stats(compareTrials.filter((t) => t.task === task.id && t.kind === "replay"));
    const l = learns.get(task.id);
    if (!raw && !replay && !l) return [];
    const summary: TaskSummary = {
      task: task.id,
      category: task.category,
      goal: task.goal,
      raw,
      replay,
      ...(l && { learn: l }),
    };
    if (raw && replay) {
      if (replay.median_ms > 0) summary.speedup = raw.median_ms / replay.median_ms;
      if (raw.mean_tokens > 0) summary.token_reduction = 1 - replay.mean_tokens / raw.mean_tokens;
      if (raw.mean_cost_usd > 0) summary.cost_reduction = 1 - replay.mean_cost_usd / raw.mean_cost_usd;
      const saving = raw.mean_cost_usd - replay.mean_cost_usd;
      if (l && saving > 0) summary.break_even_runs = Math.ceil(l.cost_usd / saving);
    }
    return [summary];
  });

  const raws = compareTrials.filter((t) => t.kind === "raw");
  const replays = compareTrials.filter((t) => t.kind === "replay");
  const compared = tasks.filter((t) => t.speedup !== undefined);
  const rawStats = stats(raws);
  const replayStats = stats(replays);
  const breakEvens = tasks.flatMap((t) => (t.break_even_runs !== undefined ? [t.break_even_runs] : []));

  const daily: DailyPoint[] = of("daily").map((s) => ({
    date: s.started_at.slice(0, 10),
    session: s.id,
    total: s.trials.length,
    passed: s.trials.filter((t) => t.grade.passed).length,
    broke: s.repairs.filter((r) => r.broke).length,
    detected: s.repairs.filter((r) => r.detected).length,
    healed: s.repairs.filter((r) => r.healed).length,
    accepted: s.repairs.filter((r) => r.accepted).length,
  }));

  const driftRepairs = of("drift").flatMap((s) => s.repairs);
  const faults: FaultStats[] = [...new Set(driftRepairs.map((r) => r.cause))].map((fault) => {
    const rs = driftRepairs.filter((r) => r.cause === fault);
    return {
      fault,
      applicable: rs.length,
      broke: rs.filter((r) => r.broke).length,
      detected: rs.filter((r) => r.detected).length,
      healed: rs.filter((r) => r.healed).length,
    };
  });

  const broken: RepairRecord[] = sessions.flatMap((s) => s.repairs).filter((r) => r.broke);
  const attempted = broken.filter((r) => r.repair);

  return {
    generated_at: new Date().toISOString(),
    model: sessions.at(-1)?.model,
    sessions: { learn: of("learn").length, compare: of("compare").length, daily: of("daily").length, drift: of("drift").length },
    ...(rawStats &&
      replayStats && {
        headline: {
          tasks: compared.length,
          trials: compareTrials.length,
          raw_success: rawStats.success_rate,
          replay_success: replayStats.success_rate,
          speedup: geomean(compared.map((t) => t.speedup!).filter((x) => x > 0)),
          raw_tokens: rawStats.mean_tokens,
          replay_tokens: replayStats.mean_tokens,
          token_reduction: rawStats.mean_tokens ? 1 - replayStats.mean_tokens / rawStats.mean_tokens : 0,
          raw_cost_usd: rawStats.mean_cost_usd,
          replay_cost_usd: replayStats.mean_cost_usd,
          cost_reduction: rawStats.mean_cost_usd ? 1 - replayStats.mean_cost_usd / rawStats.mean_cost_usd : 0,
          raw_agent_runs: rawStats.mean_agent_runs,
          replay_agent_runs: replayStats.mean_agent_runs,
          raw_median_ms: rawStats.median_ms,
          replay_median_ms: replayStats.median_ms,
          replay_check_pass_rate: replayStats.check_pass_rate ?? 0,
          ...(breakEvens.length && { median_break_even_runs: median(breakEvens) }),
        },
      }),
    tasks,
    daily,
    faults,
    repair: {
      attempted: attempted.length,
      healed: attempted.filter((r) => r.healed).length,
      undetected: broken.filter((r) => !r.detected).length,
      mean_cost_usd: mean(attempted.map((r) => r.repair!.cost_usd)),
      mean_ms: mean(attempted.map((r) => r.repair!.duration_ms)),
    },
    waits: { raw: rawStats?.wait_ms ?? 0, replay: replayStats?.wait_ms ?? 0 },
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Plain-text summary for the terminal. */
export function formatReport(r: BenchReport): string {
  const lines: string[] = [];
  const h = r.headline;
  if (h) {
    lines.push(
      `Workflow Memory benchmark: ${h.tasks} tasks, ${h.trials} trials (${r.model ?? "?"})`,
      `  success      raw ${pct(h.raw_success)}   replay ${pct(h.replay_success)}`,
      `  latency      raw ${secs(h.raw_median_ms)}   replay ${secs(h.replay_median_ms)}   (${h.speedup.toFixed(1)}x faster, geometric mean per task; excludes rate-limit waits)`,
      `  tokens/run   raw ${Math.round(h.raw_tokens)}   replay ${Math.round(h.replay_tokens)}   (${pct(h.token_reduction)} fewer)`,
      `  cost/run     raw $${h.raw_cost_usd.toFixed(4)}   replay $${h.replay_cost_usd.toFixed(4)}   (${pct(h.cost_reduction)} cheaper)`,
      `  checks       ${pct(h.replay_check_pass_rate)} of replays ran clean (every step and workflow check passed)`,
      ...(h.median_break_even_runs !== undefined ? [`  break-even   learning pays for itself after ${h.median_break_even_runs} reruns (median)`] : []),
      "",
    );
  } else {
    lines.push("No compare sessions yet. Run: npm run bench -- learn, then npm run bench -- compare", "");
  }
  for (const t of r.tasks) {
    const f = (m?: ModeStats) => (m ? `${m.passed}/${m.trials} ${secs(m.median_ms)} ${Math.round(m.mean_tokens)}tok` : "-");
    lines.push(
      `  ${t.task.padEnd(22)} raw ${f(t.raw).padEnd(22)} replay ${f(t.replay).padEnd(22)} ${t.speedup ? `${t.speedup.toFixed(1)}x` : ""}`,
    );
  }
  if (r.daily.length) {
    lines.push("", "Daily replays:");
    for (const d of r.daily) lines.push(`  ${d.date}  ${d.passed}/${d.total} passed, ${d.broke} broke, ${d.healed} healed by repair`);
  }
  if (r.faults.length) {
    lines.push("", "Fault injection:");
    for (const f of r.faults) lines.push(`  ${f.fault.padEnd(16)} ${f.broke}/${f.applicable} broke, ${f.detected} detected, ${f.healed} healed`);
  }
  if (r.repair.attempted) {
    lines.push(
      "",
      `Repair: ${r.repair.healed}/${r.repair.attempted} healed (${pct(r.repair.healed / r.repair.attempted)}), ` +
        `${r.repair.undetected} breakages went unnoticed by checks; mean $${r.repair.mean_cost_usd.toFixed(4)}, ${secs(r.repair.mean_ms)}`,
    );
  }
  return lines.join("\n");
}
