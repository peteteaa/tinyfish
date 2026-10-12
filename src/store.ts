// Workflow/run/trace/job storage. Three backends behind one async interface (see src/store/):
//   sqlite (default)  <data>/workflow-memory.db
//   files             <data>/workflows, runs, traces, jobs as JSON files
//   postgres          DATABASE_URL (Neon); the default when DATABASE_URL is set, e.g. on Vercel
// Select with STORAGE=sqlite|files|postgres. Workflows in seeds/ are inserted as v1 (source "import") on first touch.
//
// Everything is scoped to an owner: each user has their own workflows (names only need to be unique per owner), runs,
// traces and jobs. The functions below act as the current owner: the web app wraps each request in runAs(userId)
// (web/lib/auth.ts), and AsyncLocalStorage carries it into the jobs a request starts. The CLI and MCP server act as
// WM_OWNER, default "local" (which is also who owns data stored before owners existed).

import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_DIR, DATABASE_URL, SEEDS_DIR, STORAGE } from "./env.js";
import type { Workflow } from "./schema.js";
import { makeStore } from "./store/common.js";
import { filesBackend } from "./store/files.js";
import { postgresBackend } from "./store/postgres.js";
import { sqliteBackend } from "./store/sqlite.js";
import type { RunRecord, Store, VersionSource } from "./store/types.js";

export type {
  CheckResult, JobInfo, RunRecord, StepRecord, Store, VersionInfo, VersionSource, WorkflowDiff, WorkflowSummary,
} from "./store/types.js";

export const LOCAL_OWNER = "local";

const owners = new AsyncLocalStorage<string>();

/** Runs `fn` (and everything it starts, including background jobs) as `owner`. */
export function runAs<T>(owner: string, fn: () => T): T {
  if (!owner) throw new Error("runAs needs an owner.");
  return owners.run(owner, fn);
}

export function currentOwner(): string {
  return owners.getStore() ?? (process.env.WM_OWNER || LOCAL_OWNER);
}

/**
 * One connection (or directory) shared by every owner; returns each owner's store, created on first use.
 * `location` is the data directory (sqlite, files) or the connection string (postgres).
 */
export function createStores(kind: "sqlite" | "files" | "postgres", location: string): (owner: string) => Store {
  const backend = kind === "postgres" ? postgresBackend(location) : kind === "sqlite" ? sqliteBackend(location) : filesBackend(location);
  const stores = new Map<string, Store>();
  return (owner) => {
    let s = stores.get(owner);
    if (!s) stores.set(owner, (s = makeStore(backend(owner), SEEDS_DIR)));
    return s;
  };
}

/** One owner's store (see createStores). */
export function createStore(kind: "sqlite" | "files" | "postgres", location: string, owner = LOCAL_OWNER): Store {
  return createStores(kind, location)(owner);
}

let defaultStores: ((owner: string) => Store) | undefined;
const def = () => {
  if (!defaultStores) {
    if (STORAGE === "postgres" && !DATABASE_URL) throw new Error("STORAGE=postgres needs DATABASE_URL.");
    defaultStores = createStores(STORAGE, STORAGE === "postgres" ? DATABASE_URL! : DATA_DIR);
  }
  return defaultStores(currentOwner());
};

export const listWorkflows = () => def().listWorkflows();
export const getWorkflow = (name: string, version?: number) => def().getWorkflow(name, version);
export const saveWorkflow = (input: unknown, source: VersionSource = "cli"): Promise<Workflow> => def().saveWorkflow(input, source);
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
export function getTrace<T = unknown>(id: string): Promise<T | undefined> {
  return def().getTrace<T>(id);
}
export const jobStore = () => def();

/** Sortable, filesystem-safe id: 2026-10-11T12-00-00-000Z-ab12cd */
export function newId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}
