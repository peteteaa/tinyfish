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

/** A job's metadata, persisted so any server instance can stream its events (see src/jobs.ts). */
export interface JobInfo {
  id: string;
  type: string;
  status: "running" | "done" | "error";
  created_at: string;
}

export interface JobEventRow {
  seq: number;
  event: unknown;
}

export interface Store {
  listWorkflows(): Promise<WorkflowSummary[]>;
  getWorkflow(name: string, version?: number): Promise<Workflow | undefined>;
  saveWorkflow(input: unknown, source?: VersionSource): Promise<Workflow>;
  /** Removes every version and the run history. Returns false if there was no such workflow. */
  deleteWorkflow(name: string): Promise<boolean>;
  listVersions(name: string): Promise<VersionInfo[]>;
  diff(name: string, from: number, to: number): Promise<WorkflowDiff>;
  saveRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(name: string, limit?: number): Promise<RunRecord[]>;
  lastSuccessfulRun(name: string): Promise<RunRecord | undefined>;
  saveTrace(id: string, trace: unknown): Promise<void>;
  getTrace<T = unknown>(id: string): Promise<T | undefined>;
  createJob(job: JobInfo): Promise<void>;
  setJobStatus(id: string, status: JobInfo["status"]): Promise<void>;
  getJobInfo(id: string): Promise<JobInfo | undefined>;
  appendJobEvent(id: string, seq: number, event: unknown): Promise<void>;
  /** Events with seq > afterSeq, in order. */
  jobEvents(id: string, afterSeq: number): Promise<JobEventRow[]>;
}

/** Sync (SQLite, files) or async (Postgres). */
type Awaitable<T> = T | Promise<T>;

/** What each backend implements; shared logic (validation, summaries, diff, seeding) lives in common.ts. */
export interface Backend {
  names(): Awaitable<string[]>;
  versions(name: string): Awaitable<VersionInfo[]>;
  read(name: string, version: number): Awaitable<Workflow | undefined>;
  /** Stores wf (version already set) with metadata. Must fail if the version exists. */
  write(wf: Workflow, source: VersionSource): Awaitable<void>;
  /** Allocates the next version number and writes atomically where the backend supports it. */
  writeNext(wf: Workflow, source: VersionSource): Awaitable<Workflow>;
  /** Deletes all versions and runs of `name` and remembers it so seeding doesn't bring it back. */
  remove(name: string): Awaitable<void>;
  /** True if `name` was removed (seeding skips it). */
  removed(name: string): Awaitable<boolean>;
  saveRun(run: RunRecord): Awaitable<void>;
  getRun(runId: string): Awaitable<RunRecord | undefined>;
  listRuns(name: string, limit: number): Awaitable<RunRecord[]>;
  saveTrace(id: string, trace: unknown): Awaitable<void>;
  getTrace(id: string): Awaitable<unknown | undefined>;
  createJob(job: JobInfo): Awaitable<void>;
  setJobStatus(id: string, status: JobInfo["status"]): Awaitable<void>;
  getJobInfo(id: string): Awaitable<JobInfo | undefined>;
  appendJobEvent(id: string, seq: number, event: unknown): Awaitable<void>;
  jobEvents(id: string, afterSeq: number): Awaitable<JobEventRow[]>;
}
