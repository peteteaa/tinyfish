import fs from "node:fs";
import path from "node:path";
import { validateWorkflow, type Workflow } from "../schema.js";
import { diffWorkflows } from "../diff.js";
import type { Backend, Store, VersionSource } from "./types.js";

export { diffWorkflows };

/** Copies seeds/*.json into the backend as v1 (source "import") for names it doesn't have yet and wasn't deleted. */
function seed(b: Backend, seedsDir: string) {
  if (!fs.existsSync(seedsDir)) return;
  for (const f of fs.readdirSync(seedsDir).filter((f) => f.endsWith(".json"))) {
    const wf = JSON.parse(fs.readFileSync(path.join(seedsDir, f), "utf8")) as Workflow;
    if (!b.versions(wf.name).length && !b.removed(wf.name)) b.write({ ...wf, version: 1 }, "import");
  }
}

export function makeStore(b: Backend, seedsDir: string): Store {
  let seeded = false;
  const ready = () => {
    if (!seeded) {
      seeded = true;
      seed(b, seedsDir);
    }
    return b;
  };

  const store: Store = {
    listWorkflows() {
      ready();
      return b
        .names()
        .sort()
        .flatMap((name) => {
          const versions = b.versions(name);
          if (!versions.length) return [];
          const latest = versions.at(-1)!;
          const wf = b.read(name, latest.version);
          if (!wf) return [];
          const last = b.listRuns(name, 1)[0];
          return [
            {
              name,
              latest: latest.version,
              versions: versions.map((v) => v.version),
              description: wf.description,
              params: wf.params,
              latest_source: latest.source,
              last_run: last && { run_id: last.run_id, status: last.status, finished_at: last.finished_at },
            },
          ];
        });
    },
    getWorkflow(name, version) {
      ready();
      const v = version ?? b.versions(name).at(-1)?.version;
      return v ? b.read(name, v) : undefined;
    },
    saveWorkflow(input, source: VersionSource = "cli") {
      ready();
      const result = validateWorkflow(input);
      if (!result.ok) throw new Error(`Invalid workflow:\n- ${result.errors.join("\n- ")}`);
      return b.writeNext(result.workflow, source);
    },
    deleteWorkflow(name) {
      ready();
      if (!b.versions(name).length) return false;
      b.remove(name);
      return true;
    },
    listVersions(name) {
      ready();
      return b.versions(name);
    },
    diff(name, from, to) {
      ready();
      const a = b.read(name, from);
      if (!a) throw new Error(`Workflow "${name}" has no version ${from}`);
      const c = b.read(name, to);
      if (!c) throw new Error(`Workflow "${name}" has no version ${to}`);
      return diffWorkflows(name, a, c, from, to);
    },
    saveRun: (run) => ready().saveRun(run),
    getRun: (id) => ready().getRun(id),
    listRuns: (name, limit = 20) => ready().listRuns(name, limit),
    lastSuccessfulRun(name) {
      return store.listRuns(name, 200).find((r) => r.status === "ok");
    },
    saveTrace: (id, trace) => ready().saveTrace(id, trace),
    getTrace: <T = unknown>(id: string) => ready().getTrace(id) as T | undefined,
  };
  return store;
}
