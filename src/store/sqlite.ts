// SQLite backend (built-in node:sqlite) at <data>/workflow-memory.db. Schema versioned with PRAGMA user_version.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded on first use so environments that only use Postgres (Vercel) never load node:sqlite.
const sqlite = () => process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
import type { Workflow } from "../schema.js";
import type { Backend, JobInfo, RunRecord, VersionInfo, VersionSource } from "./types.js";

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

export function sqliteBackend(dataDir: string): Backend {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new (sqlite().DatabaseSync)(path.join(dataDir, "workflow-memory.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);

  const insertWf = db.prepare("INSERT INTO workflows (name, version, json, source, created_at) VALUES (?, ?, ?, ?, ?)");
  const put = (wf: Workflow, source: VersionSource) =>
    insertWf.run(wf.name, wf.version!, JSON.stringify(wf), source, new Date().toISOString());

  return {
    names: () => (db.prepare("SELECT DISTINCT name FROM workflows").all() as { name: string }[]).map((r) => r.name),
    versions: (name) =>
      db
        .prepare("SELECT version, source, created_at FROM workflows WHERE name = ? ORDER BY version")
        .all(name) as unknown as VersionInfo[],
    read(name, version) {
      const row = db.prepare("SELECT json FROM workflows WHERE name = ? AND version = ?").get(name, version) as
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
        const row = db.prepare("SELECT MAX(version) AS v FROM workflows WHERE name = ?").get(wf.name) as { v: number | null };
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
        db.prepare("DELETE FROM workflows WHERE name = ?").run(name);
        db.prepare("DELETE FROM runs WHERE workflow = ?").run(name);
        db.prepare("INSERT OR REPLACE INTO deleted_workflows (name, deleted_at) VALUES (?, ?)").run(name, new Date().toISOString());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    removed: (name) => !!db.prepare("SELECT 1 FROM deleted_workflows WHERE name = ?").get(name),
    saveRun(run) {
      db.prepare(
        "INSERT OR REPLACE INTO runs (run_id, workflow, version, status, started_at, finished_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(run.run_id, run.workflow, run.version, run.status, run.started_at, run.finished_at, JSON.stringify(run));
    },
    getRun(runId) {
      const row = db.prepare("SELECT json FROM runs WHERE run_id = ?").get(runId) as { json: string } | undefined;
      return row && (JSON.parse(row.json) as RunRecord);
    },
    listRuns(name, limit) {
      return (
        db
          .prepare("SELECT json FROM runs WHERE workflow = ? ORDER BY started_at DESC, run_id DESC LIMIT ?")
          .all(name, limit) as { json: string }[]
      ).map((r) => JSON.parse(r.json) as RunRecord);
    },
    saveTrace(id, trace) {
      const goal = trace && typeof trace === "object" && typeof (trace as { goal?: unknown }).goal === "string" ? (trace as { goal: string }).goal : null;
      db.prepare("INSERT OR REPLACE INTO learn_sessions (id, goal, trace_json, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        goal,
        JSON.stringify(trace),
        new Date().toISOString(),
      );
    },
    getTrace(id) {
      const row = db.prepare("SELECT trace_json FROM learn_sessions WHERE id = ?").get(id) as { trace_json: string } | undefined;
      return row && JSON.parse(row.trace_json);
    },
    createJob(job) {
      db.prepare("INSERT INTO jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)").run(job.id, job.type, job.status, job.created_at);
    },
    setJobStatus(id, status) {
      db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
    },
    getJobInfo(id) {
      return db.prepare("SELECT id, type, status, created_at FROM jobs WHERE id = ?").get(id) as JobInfo | undefined;
    },
    appendJobEvent(id, seq, event) {
      db.prepare("INSERT OR REPLACE INTO job_events (job_id, seq, json) VALUES (?, ?, ?)").run(id, seq, JSON.stringify(event));
    },
    jobEvents(id, afterSeq) {
      return (
        db.prepare("SELECT seq, json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq").all(id, afterSeq) as { seq: number; json: string }[]
      ).map((r) => ({ seq: r.seq, event: JSON.parse(r.json) }));
    },
  };
}
