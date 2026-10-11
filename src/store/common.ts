import fs from "node:fs";
import path from "node:path";
import { validateWorkflow, type Workflow } from "../schema.js";
import { diffWorkflows } from "../diff.js";
import type { Backend, Store, VersionSource } from "./types.js";

export { diffWorkflows };

/** Copies seeds/*.json into the backend as v1 (source "import") for names it doesn't have yet and wasn't deleted. */
async function seed(b: Backend, seedsDir: string) {
  if (!fs.existsSync(seedsDir)) return;
  for (const f of fs.readdirSync(seedsDir).filter((f) => f.endsWith(".json"))) {
    const wf = JSON.parse(fs.readFileSync(path.join(seedsDir, f), "utf8")) as Workflow;
    if (!(await b.versions(wf.name)).length && !(await b.removed(wf.name))) {
      try {
        await b.write({ ...wf, version: 1 }, "import");
      } catch {
        // Another instance seeded it first (Postgres, concurrent cold starts).
      }
    }
  }
}

export function makeStore(b: Backend, seedsDir: string): Store {
  let seeded: Promise<void> | undefined;
  const ready = async () => {
    seeded ??= seed(b, seedsDir);
    await seeded;
    return b;
  };

  const store: Store = {
    async listWorkflows() {
      await ready();
      const names = (await b.names()).sort();
      const rows = await Promise.all(
        names.map(async (name) => {
          const versions = await b.versions(name);
          if (!versions.length) return [];
          const latest = versions.at(-1)!;
          const [wf, runs] = await Promise.all([b.read(name, latest.version), b.listRuns(name, 1)]);
          if (!wf) return [];
          const last = runs[0];
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
        }),
      );
      return rows.flat();
    },
    async getWorkflow(name, version) {
      await ready();
      const v = version ?? (await b.versions(name)).at(-1)?.version;
      return v ? b.read(name, v) : undefined;
    },
    async saveWorkflow(input, source: VersionSource = "cli") {
      await ready();
      const result = validateWorkflow(input);
      if (!result.ok) throw new Error(`Invalid workflow:\n- ${result.errors.join("\n- ")}`);
      return b.writeNext(result.workflow, source);
    },
    async deleteWorkflow(name) {
      await ready();
      if (!(await b.versions(name)).length) return false;
      await b.remove(name);
      return true;
    },
    async listVersions(name) {
      await ready();
      return b.versions(name);
    },
    async diff(name, from, to) {
      await ready();
      const a = await b.read(name, from);
      if (!a) throw new Error(`Workflow "${name}" has no version ${from}`);
      const c = await b.read(name, to);
      if (!c) throw new Error(`Workflow "${name}" has no version ${to}`);
      return diffWorkflows(name, a, c, from, to);
    },
    saveRun: async (run) => (await ready()).saveRun(run),
    getRun: async (id) => (await ready()).getRun(id),
    listRuns: async (name, limit = 20) => (await ready()).listRuns(name, limit),
    async lastSuccessfulRun(name) {
      return (await store.listRuns(name, 200)).find((r) => r.status === "ok");
    },
    saveTrace: async (id, trace) => (await ready()).saveTrace(id, trace),
    getTrace: async <T = unknown>(id: string) => (await (await ready()).getTrace(id)) as T | undefined,
    // Jobs don't need seeds.
    createJob: async (job) => b.createJob(job),
    setJobStatus: async (id, status) => b.setJobStatus(id, status),
    getJobInfo: async (id) => b.getJobInfo(id),
    appendJobEvent: async (id, seq, event) => b.appendJobEvent(id, seq, event),
    jobEvents: async (id, afterSeq) => b.jobEvents(id, afterSeq),
  };
  return store;
}
