// Postgres backend (Neon serverless driver over HTTPS), used when DATABASE_URL is set, e.g. on Vercel where the
// filesystem isn't persistent. Same tables as the SQLite backend. JSON is stored as TEXT, not jsonb: jsonb reorders
// object keys, and key order matters (Gemini fills structured output in schema property order; outputs and params
// display in declared order).
// This is storage, not web access: no web data is read through it (see test/web-boundary.test.ts).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Workflow } from "../schema.js";
import type { Backend, JobInfo, RunRecord, VersionInfo, VersionSource } from "./types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflows (
     name TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (name, version))`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, version INTEGER, status TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS runs_workflow_started ON runs (workflow, started_at)`,
  `CREATE TABLE IF NOT EXISTS learn_sessions (id TEXT PRIMARY KEY, goal TEXT, trace_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deleted_workflows (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS job_events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (job_id, seq))`,
  // Databases created before JSON moved to TEXT: convert jsonb columns in place (no-op once converted).
  `DO $$
   DECLARE c record;
   BEGIN
     FOR c IN SELECT table_name, column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND data_type = 'jsonb'
                AND (table_name, column_name) IN (('workflows','json'), ('runs','json'), ('learn_sessions','trace_json'), ('job_events','json'))
     LOOP
       EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TEXT USING %I::text', c.table_name, c.column_name, c.column_name);
     END LOOP;
   END $$`,
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
      const [row] = await q<{ json: string }>("SELECT json FROM workflows WHERE name = $1 AND version = $2", [name, version]);
      return row && (JSON.parse(row.json) as Workflow);
    },
    async write(wf, source) {
      await q("INSERT INTO workflows (name, version, json, source, created_at) VALUES ($1, $2, $3, $4, $5)", [
        wf.name, wf.version, JSON.stringify(wf), source, now(),
      ]);
    },
    async writeNext(wf, source) {
      // Pick the next version, then insert; a concurrent save of the same name hits the primary key and retries.
      for (let attempt = 0; ; attempt++) {
        const [{ v }] = await q<{ v: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM workflows WHERE name = $1", [wf.name]);
        const saved: Workflow = { ...wf, version: Number(v) };
        try {
          await q("INSERT INTO workflows (name, version, json, source, created_at) VALUES ($1, $2, $3, $4, $5)", [
            saved.name, saved.version, JSON.stringify(saved), source, now(),
          ]);
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
      const [row] = await q<{ json: string }>("SELECT json FROM runs WHERE run_id = $1", [runId]);
      return row && (JSON.parse(row.json) as RunRecord);
    },
    async listRuns(name, limit) {
      const rows = await q<{ json: string }>("SELECT json FROM runs WHERE workflow = $1 ORDER BY started_at DESC, run_id DESC LIMIT $2", [name, limit]);
      return rows.map((r) => JSON.parse(r.json) as RunRecord);
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
      const [row] = await q<{ trace_json: string }>("SELECT trace_json FROM learn_sessions WHERE id = $1", [id]);
      return row && JSON.parse(row.trace_json);
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
      const rows = await q<{ seq: number; json: string }>("SELECT seq, json FROM job_events WHERE job_id = $1 AND seq > $2 ORDER BY seq", [id, afterSeq]);
      return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.json) }));
    },
  };
}
