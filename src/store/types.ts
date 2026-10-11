import type { Workflow } from "../schema.js";

export type VersionSource = "learned" | "web" | "cli" | "import" | "repair";

export interface WorkflowSummary {
  name: string;
  latest: number;
  versions: number[];
  description: string;
  params: Workflow["params"];
  latest_source: VersionSource;
  last_run?: { run_id: string; status: RunRecord["status"]; finished_at: string };
}

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

export interface VersionInfo {
  version: number;
  source: VersionSource;
  created_at: string;
}

export interface WorkflowDiff {
  name: string;
  from: number;
  to: number;
  description_changed: boolean;
  output_changed: boolean;
  params: { added: string[]; removed: string[]; changed: string[] };
  steps: { added: string[]; removed: string[]; changed: { id: string; fields: string[] }[]; reordered: boolean };
}

export interface Store {
  listWorkflows(): WorkflowSummary[];
  getWorkflow(name: string, version?: number): Workflow | undefined;
  saveWorkflow(input: unknown, source?: VersionSource): Workflow;
  /** Removes every version and the run history. Returns false if there was no such workflow. */
  deleteWorkflow(name: string): boolean;
  listVersions(name: string): VersionInfo[];
  diff(name: string, from: number, to: number): WorkflowDiff;
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  listRuns(name: string, limit?: number): RunRecord[];
  lastSuccessfulRun(name: string): RunRecord | undefined;
  saveTrace(id: string, trace: unknown): void;
  getTrace<T = unknown>(id: string): T | undefined;
}

/** What each backend implements; shared logic (validation, summaries, diff, seeding) lives in common.ts. */
export interface Backend {
  names(): string[];
  versions(name: string): VersionInfo[];
  read(name: string, version: number): Workflow | undefined;
  /** Stores wf (version already set) with metadata. Must fail if the version exists. */
  write(wf: Workflow, source: VersionSource): void;
  /** Allocates the next version number and writes atomically where the backend supports it. */
  writeNext(wf: Workflow, source: VersionSource): Workflow;
  /** Deletes all versions and runs of `name` and remembers it so seeding doesn't bring it back. */
  remove(name: string): void;
  /** True if `name` was removed (seeding skips it). */
  removed(name: string): boolean;
  saveRun(run: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  listRuns(name: string, limit: number): RunRecord[];
  saveTrace(id: string, trace: unknown): void;
  getTrace(id: string): unknown | undefined;
}
