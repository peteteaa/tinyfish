// Postgres backend (Neon serverless driver over HTTPS), used when DATABASE_URL is set, e.g. on Vercel where the
// filesystem isn't persistent. Same tables as the SQLite backend, with JSON in jsonb columns.
// This is storage, not web access: no web data is read through it (see test/web-boundary.test.ts).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Workflow } from "../schema.js";
import type { Backend, JobInfo, RunRecord, VersionInfo, VersionSource } from "./types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflows (
     name TEXT NOT NULL, version INTEGER NOT NULL, json JSONB NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (name, version))`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, version INTEGER, status TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, json JSONB NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS runs_workflow_started ON runs (workflow, started_at)`,
  `CREATE TABLE IF NOT EXISTS learn_sessions (id TEXT PRIMARY KEY, goal TEXT, trace_json JSONB NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deleted_workflows (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS job_events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, json JSONB NOT NULL, PRIMARY KEY (job_id, seq))`,
];

export function postgresBackend(url: string): Backend {
  const sql: NeonQueryFunction<false, false> = neon(url);
  // Create tables once per process, before the first query.
  let ready: Promise<void> | undefined;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    ready ??= (async () => {
      for (const stmt of SCHEMA) await sql.query(stmt);
    })();
    await ready;
    return (await sql.query(text, params)) as T[];
  };
  const now = () => new Date().toISOString();

  return {
    names: async () => (await q<{ name: string }>("SELECT DISTINCT name FROM workflows")).map((r) => r.name),
    versions: (name) => q<VersionInfo>("SELECT version, source, created_at FROM workflows WHERE name = $1 ORDER BY version", [name]),
    async read(name, version) {
      const [row] = await q<{ json: Workflow }>("SELECT json FROM workflows WHERE name = $1 AND version = $2", [name, version]);
      return row?.json;
    },
    async write(wf, source) {
      await q("INSERT INTO workflows (name, version, json, source, created_at) VALUES ($1, $2, $3, $4, $5)", [
        wf.name, wf.version, JSON.stringify(wf), source, now(),
      ]);
    },
    async writeNext(wf, source) {
      // One statement picks the next version and inserts it; a concurrent save of the same name hits the primary
      // key and retries.
      for (let attempt = 0; ; attempt++) {
        try {
          const [row] = await q<{ json: Workflow }>(
            `INSERT INTO workflows (name, version, json, source, created_at)
             SELECT $1, n.v, jsonb_set($2::jsonb, '{version}', to_jsonb(n.v)), $3, $4
             FROM (SELECT COALESCE(MAX(version), 0) + 1 AS v FROM workflows WHERE name = $1) n
             RETURNING json`,
            [wf.name, JSON.stringify(wf), source, now()],
          );
          const saved = row.json;
          return saved;
        } catch (err) {
          if (attempt >= 3 || !/duplicate key|unique/i.test(String(err))) throw err;
        }
      }
    },
    async remove(name) {
      await q("DELETE FROM workflows WHERE name = $1", [name]);
      await q("DELETE FROM runs WHERE workflow = $1", [name]);
      await q("INSERT INTO deleted_workflows (name, deleted_at) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET deleted_at = EXCLUDED.deleted_at", [name, now()]);
    },
    removed: async (name) => (await q("SELECT 1 FROM deleted_workflows WHERE name = $1", [name])).length > 0,
    async saveRun(run) {
      await q(
        `INSERT INTO runs (run_id, workflow, version, status, started_at, finished_at, json) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, finished_at = EXCLUDED.finished_at, json = EXCLUDED.json`,
        [run.run_id, run.workflow, run.version, run.status, run.started_at, run.finished_at, JSON.stringify(run)],
      );
    },
    async getRun(runId) {
      const [row] = await q<{ json: RunRecord }>("SELECT json FROM runs WHERE run_id = $1", [runId]);
      return row?.json;
    },
    async listRuns(name, limit) {
      const rows = await q<{ json: RunRecord }>("SELECT json FROM runs WHERE workflow = $1 ORDER BY started_at DESC, run_id DESC LIMIT $2", [name, limit]);
      return rows.map((r) => r.json);
    },
    async saveTrace(id, trace) {
      const goal = trace && typeof trace === "object" && typeof (trace as { goal?: unknown }).goal === "string" ? (trace as { goal: string }).goal : null;
      await q(
        `INSERT INTO learn_sessions (id, goal, trace_json, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET goal = EXCLUDED.goal, trace_json = EXCLUDED.trace_json`,
        [id, goal, JSON.stringify(trace), now()],
      );
    },
    async getTrace(id) {
      const [row] = await q<{ trace_json: unknown }>("SELECT trace_json FROM learn_sessions WHERE id = $1", [id]);
      return row?.trace_json;
    },
    async createJob(job) {
      await q("INSERT INTO jobs (id, type, status, created_at) VALUES ($1, $2, $3, $4)", [job.id, job.type, job.status, job.created_at]);
    },
    async setJobStatus(id, status) {
      await q("UPDATE jobs SET status = $2 WHERE id = $1", [id, status]);
    },
    async getJobInfo(id) {
      const [row] = await q<JobInfo>("SELECT id, type, status, created_at FROM jobs WHERE id = $1", [id]);
      return row;
    },
    async appendJobEvent(id, seq, event) {
      await q("INSERT INTO job_events (job_id, seq, json) VALUES ($1, $2, $3) ON CONFLICT (job_id, seq) DO NOTHING", [id, seq, JSON.stringify(event)]);
    },
    async jobEvents(id, afterSeq) {
      const rows = await q<{ seq: number; json: unknown }>("SELECT seq, json FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq", [id, afterSeq]);
      return rows.map((r) => ({ seq: r.seq, event: r.json }));
    },
  };
}
