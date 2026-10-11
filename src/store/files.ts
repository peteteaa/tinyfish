// JSON-file backend.
//
//   <data>/workflows/<name>/v<N>.json       versioned workflows (latest = highest N)
//   <data>/workflows/<name>/v<N>.meta.json  { source, created_at }; absent => "import" + file mtime
//   <data>/runs/<name>/<run_id>.json        run history
//   <data>/traces/<trace_id>.json           exploration traces from `learn`
//   <data>/deleted.json                     names deleted by the user, so seeding doesn't recreate them

import fs from "node:fs";
import path from "node:path";
import type { Workflow } from "../schema.js";
import type { Backend, RunRecord, VersionInfo, VersionSource } from "./types.js";

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function filesBackend(dataDir: string): Backend {
  const WF = path.join(dataDir, "workflows");
  const RUNS = path.join(dataDir, "runs");
  const TRACES = path.join(dataDir, "traces");
  const DELETED = path.join(dataDir, "deleted.json");
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
  };
}
