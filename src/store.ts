// JSON-file storage.
//
//   data/workflows/<name>/v<N>.json   versioned workflows (latest = highest N)
//   data/runs/<name>/<run_id>.json    run history
//   data/traces/<trace_id>.json       exploration traces from `learn`
//
// Workflows in seeds/ are copied in as v1 the first time the store is touched.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SEEDS_DIR } from "./env.js";
import { validateWorkflow, type Workflow } from "./schema.js";

const WF_DIR = path.join(DATA_DIR, "workflows");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const TRACES_DIR = path.join(DATA_DIR, "traces");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

let seeded = false;
function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  if (!fs.existsSync(SEEDS_DIR)) return;
  for (const f of fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith(".json"))) {
    const wf = readJson<Workflow>(path.join(SEEDS_DIR, f));
    if (!fs.existsSync(path.join(WF_DIR, wf.name))) writeJson(path.join(WF_DIR, wf.name, "v1.json"), { ...wf, version: 1 });
  }
}

function versionsOf(name: string): number[] {
  const dir = path.join(WF_DIR, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => f.match(/^v(\d+)\.json$/)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => a - b);
}

export interface WorkflowSummary {
  name: string;
  latest: number;
  versions: number[];
  description: string;
  params: Workflow["params"];
  last_run?: { run_id: string; status: RunRecord["status"]; finished_at: string };
}

export function listWorkflows(): WorkflowSummary[] {
  ensureSeeded();
  if (!fs.existsSync(WF_DIR)) return [];
  return fs
    .readdirSync(WF_DIR)
    .filter((n) => versionsOf(n).length)
    .sort()
    .map((name) => {
      const versions = versionsOf(name);
      const wf = getWorkflow(name)!;
      const last = listRuns(name, 1)[0];
      return {
        name,
        latest: versions.at(-1)!,
        versions,
        description: wf.description,
        params: wf.params,
        last_run: last && { run_id: last.run_id, status: last.status, finished_at: last.finished_at },
      };
    });
}

export function getWorkflow(name: string, version?: number): Workflow | undefined {
  ensureSeeded();
  const v = version ?? versionsOf(name).at(-1);
  if (!v) return undefined;
  const file = path.join(WF_DIR, name, `v${v}.json`);
  return fs.existsSync(file) ? readJson<Workflow>(file) : undefined;
}

/** Validates and saves as the next version. Returns the saved workflow (with version set). */
export function saveWorkflow(input: unknown): Workflow {
  ensureSeeded();
  const result = validateWorkflow(input);
  if (!result.ok) throw new Error(`Invalid workflow:\n- ${result.errors.join("\n- ")}`);
  const version = (versionsOf(result.workflow.name).at(-1) ?? 0) + 1;
  const wf: Workflow = { ...result.workflow, version };
  writeJson(path.join(WF_DIR, wf.name, `v${version}.json`), wf);
  return wf;
}

// ---------- Runs ----------

export interface CheckResult {
  check: string;
  passed: boolean;
  message?: string;
}

export interface StepRecord {
  id: string;
  type: string;
  status: "ok" | "check_failed" | "error";
  started_at: string;
  duration_ms: number;
  output?: unknown;
  error?: string;
  checks: CheckResult[];
  meta?: Record<string, unknown>;
}

export interface RunRecord {
  run_id: string;
  workflow: string;
  version: number;
  params: Record<string, unknown>;
  status: "ok" | "check_failed" | "error";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  steps: StepRecord[];
  output?: unknown;
  error?: string;
}

export function saveRun(run: RunRecord) {
  writeJson(path.join(RUNS_DIR, run.workflow, `${run.run_id}.json`), run);
}

/** Most recent first. */
export function listRuns(name: string, limit = 20): RunRecord[] {
  const dir = path.join(RUNS_DIR, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readJson<RunRecord>(path.join(dir, f)));
}

/** The latest successful run, used to resolve {{previous.<step>}}. */
export function lastSuccessfulRun(name: string): RunRecord | undefined {
  return listRuns(name, 200).find((r) => r.status === "ok");
}

// ---------- Traces ----------

export function saveTrace(id: string, trace: unknown) {
  writeJson(path.join(TRACES_DIR, `${id}.json`), trace);
}

export function getTrace<T = unknown>(id: string): T | undefined {
  const file = path.join(TRACES_DIR, `${id}.json`);
  return fs.existsSync(file) ? readJson<T>(file) : undefined;
}

/** Sortable, filesystem-safe id: 2026-10-11T12-00-00-000Z-ab12cd */
export function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}
