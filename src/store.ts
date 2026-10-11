// Workflow/run/trace storage. Two backends behind one interface (see src/store/):
//   sqlite (default)  <data>/workflow-memory.db
//   files             <data>/workflows, runs, traces as JSON files
// Select with STORAGE=sqlite|files. Workflows in seeds/ are inserted as v1 (source "import") on first touch.

import { DATA_DIR, SEEDS_DIR, STORAGE } from "./env.js";
import type { Workflow } from "./schema.js";
import { makeStore } from "./store/common.js";
import { filesBackend } from "./store/files.js";
import { sqliteBackend } from "./store/sqlite.js";
import type { RunRecord, Store, VersionSource } from "./store/types.js";

export type { CheckResult, RunRecord, StepRecord, Store, VersionInfo, VersionSource, WorkflowDiff, WorkflowSummary } from "./store/types.js";

export function createStore(kind: "sqlite" | "files", dataDir: string): Store {
  return makeStore(kind === "sqlite" ? sqliteBackend(dataDir) : filesBackend(dataDir), SEEDS_DIR);
}

let defaultStore: Store | undefined;
const def = () => (defaultStore ??= createStore(STORAGE, DATA_DIR));

export const listWorkflows = () => def().listWorkflows();
export const getWorkflow = (name: string, version?: number) => def().getWorkflow(name, version);
export const saveWorkflow = (input: unknown, source: VersionSource = "cli"): Workflow => def().saveWorkflow(input, source);
export const deleteWorkflow = (name: string) => def().deleteWorkflow(name);
export const listVersions = (name: string) => def().listVersions(name);
export const diff = (name: string, from: number, to: number) => def().diff(name, from, to);
export const saveRun = (run: RunRecord) => def().saveRun(run);
export const getRun = (runId: string) => def().getRun(runId);
/** Most recent first. */
export const listRuns = (name: string, limit = 20) => def().listRuns(name, limit);
/** The latest successful run, used to resolve {{previous.<step>}}. */
export const lastSuccessfulRun = (name: string) => def().lastSuccessfulRun(name);
export const saveTrace = (id: string, trace: unknown) => def().saveTrace(id, trace);
export function getTrace<T = unknown>(id: string): T | undefined {
  return def().getTrace<T>(id);
}

/** Sortable, filesystem-safe id: 2026-10-11T12-00-00-000Z-ab12cd */
export function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}
