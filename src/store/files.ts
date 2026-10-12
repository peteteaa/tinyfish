// JSON-file backend.
//
//   <data>/workflows/<name>/v<N>.json       versioned workflows (latest = highest N)
//   <data>/workflows/<name>/v<N>.meta.json  { source, created_at }; absent => "import" + file mtime
//   <data>/runs/<name>/<run_id>.json        run history
//   <data>/traces/<trace_id>.json           exploration traces from `learn`
//   <data>/deleted.json                     names deleted by the user, so seeding doesn't recreate them
//   <data>/jobs/<job_id>.json               job info (with its owner); events appended to <data>/jobs/<job_id>.events.jsonl
//
// That layout is the "local" owner's (the CLI's default). Every other owner gets the same layout, minus jobs, under
// <data>/users/<owner>/.

import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "../schema.js";
import type { Backend, BackendFactory, JobInfo, JobEventRow, RunRecord, VersionInfo, VersionSource } from "./types.js";

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function filesBackend(dataDir: string): BackendFactory {
  return (owner) => ownerBackend(dataDir, owner);
}

type StoredJob = JobInfo & { owner?: string };

function ownerBackend(dataDir: string, owner: string): Backend {
  // Dots are encoded too, so "." and ".." can't name a directory outside users/.
  const base = owner === "local" ? dataDir : path.join(dataDir, "users", encodeURIComponent(owner).replaceAll(".", "%2E"));
  const WF = path.join(base, "workflows");
  const RUNS = path.join(base, "runs");
  const TRACES = path.join(base, "traces");
  const DELETED = path.join(base, "deleted.json");
  const JOBS = path.join(dataDir, "jobs");
  /** This owner's job (jobs stored before owners existed are "local"'s). */
  const job = (id: string): StoredJob | undefined => {
    const file = path.join(JOBS, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    const j = readJson<StoredJob>(file);
    return (j.owner ?? "local") === owner ? j : undefined;
  };
  const deletedNames = (): string[] => (fs.existsSync(DELETED) ? readJson<string[]>(DELETED) : []);

  const versionNumbers = (name: string): number[] => {
    const dir = path.join(WF, name);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((f) => f.match(/^v(\d+)\.json$/)?.[1])
      .filter((v): v is string => !!v)
      .map(Number)
      .sort((a, b) => a - b);
  };

  const info = (name: string, version: number): VersionInfo => {
    const file = path.join(WF, name, `v${version}.json`);
    const meta = path.join(WF, name, `v${version}.meta.json`);
    if (fs.existsSync(meta)) {
      const m = readJson<{ source: VersionSource; created_at: string }>(meta);
      return { version, source: m.source, created_at: m.created_at };
    }
    return { version, source: "import", created_at: fs.statSync(file).mtime.toISOString() };
  };

  const put = (wf: Workflow, source: VersionSource) => {
    const dir = path.join(WF, wf.name);
    // meta first so a version is never visible without its metadata
    writeJson(path.join(dir, `v${wf.version}.meta.json`), { source, created_at: new Date().toISOString() });
    writeJson(path.join(dir, `v${wf.version}.json`), wf);
  };

  return {
    names: () => (fs.existsSync(WF) ? fs.readdirSync(WF).filter((n) => versionNumbers(n).length) : []),
    versions: (name) => versionNumbers(name).map((v) => info(name, v)),
    read(name, version) {
      const file = path.join(WF, name, `v${version}.json`);
      return fs.existsSync(file) ? readJson<Workflow>(file) : undefined;
    },
    write(wf, source) {
      put(wf, source);
    },
    writeNext(wf, source) {
      const version = (versionNumbers(wf.name).at(-1) ?? 0) + 1;
      const saved: Workflow = { ...wf, version };
      put(saved, source);
      return saved;
    },
    remove(name) {
      fs.rmSync(path.join(WF, name), { recursive: true, force: true });
      fs.rmSync(path.join(RUNS, name), { recursive: true, force: true });
      writeJson(DELETED, [...new Set([...deletedNames(), name])]);
    },
    removed: (name) => deletedNames().includes(name),
    saveRun: (run) => writeJson(path.join(RUNS, run.workflow, `${run.run_id}.json`), run),
    getRun(runId) {
      if (!fs.existsSync(RUNS)) return undefined;
      for (const wf of fs.readdirSync(RUNS)) {
        const file = path.join(RUNS, wf, `${runId}.json`);
        if (fs.existsSync(file)) return readJson<RunRecord>(file);
      }
      return undefined;
    },
    listRuns(name, limit) {
      const dir = path.join(RUNS, name);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((f) => readJson<RunRecord>(path.join(dir, f)));
    },
    saveTrace: (id, trace) => writeJson(path.join(TRACES, `${id}.json`), trace),
    getTrace(id) {
      const file = path.join(TRACES, `${id}.json`);
      return fs.existsSync(file) ? readJson(file) : undefined;
    },
    createJob: (info) => writeJson(path.join(JOBS, `${info.id}.json`), { ...info, owner }),
    setJobStatus(id, status) {
      const j = job(id);
      if (j) writeJson(path.join(JOBS, `${id}.json`), { ...j, status });
    },
    getJobInfo(id) {
      const j = job(id);
      return j && { id: j.id, type: j.type, status: j.status, created_at: j.created_at };
    },
    appendJobEvent(id, seq, event) {
      if (!job(id)) return;
      fs.appendFileSync(path.join(JOBS, `${id}.events.jsonl`), JSON.stringify({ seq, event }) + "\n");
    },
    jobEvents(id, afterSeq) {
      const file = path.join(JOBS, `${id}.events.jsonl`);
      if (!job(id) || !fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JobEventRow)
        .filter((r) => r.seq > afterSeq);
    },
  };
}
