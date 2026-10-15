// Postgres backend (Neon serverless driver over HTTPS), used when DATABASE_URL is set, e.g. on Vercel where the
// filesystem isn't persistent. Same tables as the SQLite backend. JSON is stored as TEXT, not jsonb: jsonb reorders
// object keys, and key order matters (Gemini fills structured output in schema property order; outputs and params
// display in declared order).
// This is storage, not web access: no web data is read through it (see test/web-boundary.test.ts).

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Workflow } from "../schema.js";
import type { BackendFactory, JobInfo, RunRecord, VersionInfo } from "./types.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflows (
     owner TEXT NOT NULL DEFAULT 'local', name TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL,
     created_at TEXT NOT NULL, PRIMARY KEY (owner, name, version))`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local', workflow TEXT NOT NULL, version INTEGER, status TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS learn_sessions (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local', goal TEXT, trace_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deleted_workflows (
     owner TEXT NOT NULL DEFAULT 'local', name TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (owner, name))`,
  `CREATE TABLE IF NOT EXISTS jobs (
     id TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'local', type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`,
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
  // Databases created before owners: existing rows belong to "local" (the CLI's default owner), and workflow names
  // become unique per owner (no-op once migrated).
  `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE runs ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE learn_sessions ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE deleted_workflows ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'local'`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'local'`,
  // Job heartbeat, so a job whose process died (e.g. at the function time limit) can be told apart from a slow one.
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  `DO $$
   DECLARE t record;
   BEGIN
     FOR t IN SELECT * FROM (VALUES ('workflows', 'owner, name, version'), ('deleted_workflows', 'owner, name')) AS v(tbl, cols)
     LOOP
       IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                      JOIN information_schema.table_constraints c USING (constraint_schema, constraint_name)
                      WHERE c.table_schema = current_schema() AND c.table_name = t.tbl AND c.constraint_type = 'PRIMARY KEY'
                        AND k.column_name = 'owner') THEN
         EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I, ADD PRIMARY KEY (%s)', t.tbl, t.tbl || '_pkey', t.cols);
       END IF;
     END LOOP;
   END $$`,
  `DROP INDEX IF EXISTS runs_workflow_started`,
  `CREATE INDEX IF NOT EXISTS runs_owner_workflow_started ON runs (owner, workflow, started_at)`,
];

export function postgresBackend(url: string): BackendFactory {
  const sql: NeonQueryFunction<false, false> = neon(url);
  // Create tables once per process, before the first query. A failure (e.g. two cold starts migrating at once) is
  // retried on the next query rather than remembered.
  let ready: Promise<void> | undefined;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    ready ??= (async () => {
      for (const stmt of SCHEMA) await sql.query(stmt);
    })().catch((err) => {
      ready = undefined;
      throw err;
    });
    await ready;
    return (await sql.query(text, params)) as T[];
  };
  const now = () => new Date().toISOString();
  const insertWf = "INSERT INTO workflows (owner, name, version, json, source, created_at) VALUES ($1, $2, $3, $4, $5, $6)";

  return (owner) => ({
    names: async () => (await q<{ name: string }>("SELECT DISTINCT name FROM workflows WHERE owner = $1", [owner])).map((r) => r.name),
    versions: (name) =>
      q<VersionInfo>("SELECT version, source, created_at FROM workflows WHERE owner = $1 AND name = $2 ORDER BY version", [owner, name]),
    async read(name, version) {
      const [row] = await q<{ json: string }>("SELECT json FROM workflows WHERE owner = $1 AND name = $2 AND version = $3", [owner, name, version]);
      return row && (JSON.parse(row.json) as Workflow);
    },
    async write(wf, source) {
      await q(insertWf, [owner, wf.name, wf.version, JSON.stringify(wf), source, now()]);
    },
    async writeNext(wf, source) {
      // Pick the next version, then insert; a concurrent save of the same name hits the primary key and retries.
      for (let attempt = 0; ; attempt++) {
        const [{ v }] = await q<{ v: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM workflows WHERE owner = $1 AND name = $2", [
          owner, wf.name,
        ]);
        const saved: Workflow = { ...wf, version: Number(v) };
        try {
          await q(insertWf, [owner, saved.name, saved.version, JSON.stringify(saved), source, now()]);
          return saved;
        } catch (err) {
          if (attempt >= 3 || !/duplicate key|unique/i.test(String(err))) throw err;
        }
      }
    },
    async remove(name) {
      await q("DELETE FROM workflows WHERE owner = $1 AND name = $2", [owner, name]);
      await q("DELETE FROM runs WHERE owner = $1 AND workflow = $2", [owner, name]);
      await q(
        `INSERT INTO deleted_workflows (owner, name, deleted_at) VALUES ($1, $2, $3)
         ON CONFLICT (owner, name) DO UPDATE SET deleted_at = EXCLUDED.deleted_at`,
        [owner, name, now()],
      );
    },
    removed: async (name) => (await q("SELECT 1 FROM deleted_workflows WHERE owner = $1 AND name = $2", [owner, name])).length > 0,
    async saveRun(run) {
      // Run ids are global; the upsert only touches this owner's row.
      await q(
        `INSERT INTO runs (run_id, owner, workflow, version, status, started_at, finished_at, json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (run_id) DO UPDATE SET workflow = EXCLUDED.workflow, version = EXCLUDED.version, status = EXCLUDED.status,
           started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, json = EXCLUDED.json
         WHERE runs.owner = EXCLUDED.owner`,
        [run.run_id, owner, run.workflow, run.version, run.status, run.started_at, run.finished_at, JSON.stringify(run)],
      );
    },
    async getRun(runId) {
      const [row] = await q<{ json: string }>("SELECT json FROM runs WHERE run_id = $1 AND owner = $2", [runId, owner]);
      return row && (JSON.parse(row.json) as RunRecord);
    },
    async listRuns(name, limit) {
      const rows = await q<{ json: string }>(
        "SELECT json FROM runs WHERE owner = $1 AND workflow = $2 ORDER BY started_at DESC, run_id DESC LIMIT $3",
        [owner, name, limit],
      );
      return rows.map((r) => JSON.parse(r.json) as RunRecord);
    },
    async saveTrace(id, trace) {
      const goal = trace && typeof trace === "object" && typeof (trace as { goal?: unknown }).goal === "string" ? (trace as { goal: string }).goal : null;
      await q(
        `INSERT INTO learn_sessions (id, owner, goal, trace_json, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET goal = EXCLUDED.goal, trace_json = EXCLUDED.trace_json WHERE learn_sessions.owner = EXCLUDED.owner`,
        [id, owner, goal, JSON.stringify(trace), now()],
      );
    },
    async getTrace(id) {
      const [row] = await q<{ trace_json: string }>("SELECT trace_json FROM learn_sessions WHERE id = $1 AND owner = $2", [id, owner]);
      return row && JSON.parse(row.trace_json);
    },
    async createJob(job) {
      await q("INSERT INTO jobs (id, owner, type, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [
        job.id, owner, job.type, job.status, job.created_at, job.updated_at ?? job.created_at,
      ]);
    },
    async setJobStatus(id, status) {
      await q("UPDATE jobs SET status = $3, updated_at = $4 WHERE id = $1 AND owner = $2", [id, owner, status, now()]);
    },
    async touchJob(id) {
      await q("UPDATE jobs SET updated_at = $3 WHERE id = $1 AND owner = $2", [id, owner, now()]);
    },
    async getJobInfo(id) {
      const [row] = await q<JobInfo & { updated_at: string | null }>(
        "SELECT id, type, status, created_at, updated_at FROM jobs WHERE id = $1 AND owner = $2",
        [id, owner],
      );
      return row && { id: row.id, type: row.type, status: row.status, created_at: row.created_at, ...(row.updated_at && { updated_at: row.updated_at }) };
    },
    async appendJobEvent(id, seq, event) {
      // Only into this owner's jobs.
      await q(
        `INSERT INTO job_events (job_id, seq, json) SELECT $1::text, $2::integer, $3::text
         WHERE EXISTS (SELECT 1 FROM jobs WHERE id = $1 AND owner = $4)
         ON CONFLICT (job_id, seq) DO NOTHING`,
        [id, seq, JSON.stringify(event), owner],
      );
    },
    async jobEvents(id, afterSeq) {
      const rows = await q<{ seq: number; json: string }>(
        `SELECT e.seq, e.json FROM job_events e JOIN jobs j ON j.id = e.job_id
         WHERE e.job_id = $1 AND j.owner = $2 AND e.seq > $3 ORDER BY e.seq`,
        [id, owner, afterSeq],
      );
      return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.json) }));
    },
  });
}
