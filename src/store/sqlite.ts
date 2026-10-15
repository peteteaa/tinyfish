// SQLite backend (built-in node:sqlite) at <data>/workflow-memory.db. Schema versioned with PRAGMA user_version.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded on first use so environments that only use Postgres (Vercel) never load node:sqlite.
const sqlite = () => process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
import type { Workflow } from "../schema.js";
import type { BackendFactory, JobInfo, RunRecord, VersionInfo, VersionSource } from "./types.js";

const MIGRATIONS: string[] = [
  // 1
  `CREATE TABLE workflows (
     name TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
     PRIMARY KEY (name, version)
   );
   CREATE TABLE runs (
     run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, version INTEGER, status TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, json TEXT NOT NULL
   );
   CREATE INDEX runs_workflow_started ON runs (workflow, started_at);
   CREATE TABLE learn_sessions (
     id TEXT PRIMARY KEY, goal TEXT, trace_json TEXT NOT NULL, created_at TEXT NOT NULL
   );`,
  // 2: names deleted by the user, so seeding doesn't recreate them
  `CREATE TABLE deleted_workflows (name TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);`,
  // 3: jobs and their events, so any server instance can stream a job's progress
  `CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE job_events (job_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (job_id, seq));`,
  // 4: owners. Workflow names are unique per owner; existing rows belong to "local" (the CLI's default owner).
  `CREATE TABLE workflows_v4 (
     owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL,
     created_at TEXT NOT NULL, PRIMARY KEY (owner, name, version)
   );
   INSERT INTO workflows_v4 SELECT 'local', name, version, json, source, created_at FROM workflows;
   DROP TABLE workflows;
   ALTER TABLE workflows_v4 RENAME TO workflows;
   CREATE TABLE deleted_workflows_v4 (owner TEXT NOT NULL, name TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (owner, name));
   INSERT INTO deleted_workflows_v4 SELECT 'local', name, deleted_at FROM deleted_workflows;
   DROP TABLE deleted_workflows;
   ALTER TABLE deleted_workflows_v4 RENAME TO deleted_workflows;
   ALTER TABLE runs ADD COLUMN owner TEXT NOT NULL DEFAULT 'local';
   DROP INDEX runs_workflow_started;
   CREATE INDEX runs_owner_workflow_started ON runs (owner, workflow, started_at);
   ALTER TABLE learn_sessions ADD COLUMN owner TEXT NOT NULL DEFAULT 'local';
   ALTER TABLE jobs ADD COLUMN owner TEXT NOT NULL DEFAULT 'local';`,
  // 5: job heartbeat, so a job whose process died (e.g. a serverless time limit) can be told apart from a slow one
  `ALTER TABLE jobs ADD COLUMN updated_at TEXT;`,
];

function migrate(db: DatabaseSyncType) {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function sqliteBackend(dataDir: string): BackendFactory {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new (sqlite().DatabaseSync)(path.join(dataDir, "workflow-memory.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);

  const insertWf = db.prepare("INSERT INTO workflows (owner, name, version, json, source, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const now = () => new Date().toISOString();

  return (owner) => {
    const put = (wf: Workflow, source: VersionSource) => insertWf.run(owner, wf.name, wf.version!, JSON.stringify(wf), source, now());
    return {
      names: () => (db.prepare("SELECT DISTINCT name FROM workflows WHERE owner = ?").all(owner) as { name: string }[]).map((r) => r.name),
      versions: (name) =>
        db
          .prepare("SELECT version, source, created_at FROM workflows WHERE owner = ? AND name = ? ORDER BY version")
          .all(owner, name) as unknown as VersionInfo[],
      read(name, version) {
        const row = db.prepare("SELECT json FROM workflows WHERE owner = ? AND name = ? AND version = ?").get(owner, name, version) as
          | { json: string }
          | undefined;
        return row && (JSON.parse(row.json) as Workflow);
      },
      write(wf, source) {
        put(wf, source);
      },
      writeNext(wf, source) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db.prepare("SELECT MAX(version) AS v FROM workflows WHERE owner = ? AND name = ?").get(owner, wf.name) as { v: number | null };
          const saved: Workflow = { ...wf, version: (row.v ?? 0) + 1 };
          put(saved, source);
          db.exec("COMMIT");
          return saved;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      remove(name) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM workflows WHERE owner = ? AND name = ?").run(owner, name);
          db.prepare("DELETE FROM runs WHERE owner = ? AND workflow = ?").run(owner, name);
          db.prepare("INSERT OR REPLACE INTO deleted_workflows (owner, name, deleted_at) VALUES (?, ?, ?)").run(owner, name, now());
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      removed: (name) => !!db.prepare("SELECT 1 FROM deleted_workflows WHERE owner = ? AND name = ?").get(owner, name),
      saveRun(run) {
        // Run ids are global; the upsert only touches this owner's row.
        db.prepare(
          `INSERT INTO runs (run_id, owner, workflow, version, status, started_at, finished_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET workflow = excluded.workflow, version = excluded.version, status = excluded.status,
             started_at = excluded.started_at, finished_at = excluded.finished_at, json = excluded.json
           WHERE runs.owner = excluded.owner`,
        ).run(run.run_id, owner, run.workflow, run.version, run.status, run.started_at, run.finished_at, JSON.stringify(run));
      },
      getRun(runId) {
        const row = db.prepare("SELECT json FROM runs WHERE run_id = ? AND owner = ?").get(runId, owner) as { json: string } | undefined;
        return row && (JSON.parse(row.json) as RunRecord);
      },
      listRuns(name, limit) {
        return (
          db
            .prepare("SELECT json FROM runs WHERE owner = ? AND workflow = ? ORDER BY started_at DESC, run_id DESC LIMIT ?")
            .all(owner, name, limit) as { json: string }[]
        ).map((r) => JSON.parse(r.json) as RunRecord);
      },
      saveTrace(id, trace) {
        const goal = trace && typeof trace === "object" && typeof (trace as { goal?: unknown }).goal === "string" ? (trace as { goal: string }).goal : null;
        db.prepare(
          `INSERT INTO learn_sessions (id, owner, goal, trace_json, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET goal = excluded.goal, trace_json = excluded.trace_json WHERE learn_sessions.owner = excluded.owner`,
        ).run(id, owner, goal, JSON.stringify(trace), now());
      },
      getTrace(id) {
        const row = db.prepare("SELECT trace_json FROM learn_sessions WHERE id = ? AND owner = ?").get(id, owner) as { trace_json: string } | undefined;
        return row && JSON.parse(row.trace_json);
      },
      createJob(job) {
        db.prepare("INSERT INTO jobs (id, owner, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
          job.id, owner, job.type, job.status, job.created_at, job.updated_at ?? job.created_at,
        );
      },
      setJobStatus(id, status) {
        db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND owner = ?").run(status, now(), id, owner);
      },
      touchJob(id) {
        db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND owner = ?").run(now(), id, owner);
      },
      getJobInfo(id) {
        const row = db.prepare("SELECT id, type, status, created_at, updated_at FROM jobs WHERE id = ? AND owner = ?").get(id, owner) as
          | (JobInfo & { updated_at: string | null })
          | undefined;
        return row && { id: row.id, type: row.type, status: row.status, created_at: row.created_at, ...(row.updated_at && { updated_at: row.updated_at }) };
      },
      appendJobEvent(id, seq, event) {
        // Only into this owner's jobs.
        db.prepare(
          "INSERT OR REPLACE INTO job_events (job_id, seq, json) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND owner = ?)",
        ).run(id, seq, JSON.stringify(event), id, owner);
      },
      jobEvents(id, afterSeq) {
        return (
          db
            .prepare(
              `SELECT e.seq, e.json FROM job_events e JOIN jobs j ON j.id = e.job_id
               WHERE e.job_id = ? AND j.owner = ? AND e.seq > ? ORDER BY e.seq`,
            )
            .all(id, owner, afterSeq) as { seq: number; json: string }[]
        ).map((r) => ({ seq: r.seq, event: JSON.parse(r.json) }));
      },
    };
  };
}
