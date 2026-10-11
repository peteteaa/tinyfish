import type { RunRecord, StepRecord, CheckResult } from "@core/store/types.js";

export type RunEvent =
  | { kind: "run_started"; workflow: string; version: number; params: Record<string, unknown>; steps: { id: string; type: string; description?: string }[] }
  | { kind: "step_start"; step: string }
  | { kind: "step_end"; step: string; record: StepRecord }
  | { kind: "repair_available"; step: string; failures: CheckResult[] }
  | { kind: "run_done"; run: RunRecord }
  | { kind: "error"; message: string }
  | { kind: "done" };

export type StepStatus = "pending" | "running" | "ok" | "check_failed" | "error";

export interface RunStepView {
  id: string;
  type: string;
  description: string;
  status: StepStatus;
  record?: StepRecord;
  startedAtClient?: number;
}

export interface RunState {
  started?: { workflow: string; version: number; params: Record<string, unknown> };
  steps: RunStepView[];
  repair: Record<string, CheckResult[]>;
  run?: RunRecord;
  error?: string;
  finished: boolean;
}

export function reduceRunEvents(events: unknown[]): RunState {
  const s: RunState = { steps: [], repair: {}, finished: false };
  const find = (id: string) => s.steps.find((x) => x.id === id);
  for (const raw of events) {
    const e = raw as RunEvent;
    switch (e.kind) {
      case "run_started":
        s.started = { workflow: e.workflow, version: e.version, params: e.params };
        s.steps = e.steps.map((st) => ({ id: st.id, type: st.type, description: st.description ?? "", status: "pending" as StepStatus }));
        break;
      case "step_start": {
        const st = find(e.step);
        if (st) {
          st.status = "running";
          st.startedAtClient = Date.now();
        }
        break;
      }
      case "step_end": {
        const st = find(e.step);
        if (st) {
          st.status = e.record.status;
          st.record = e.record;
        }
        break;
      }
      case "repair_available":
        s.repair[e.step] = e.failures;
        break;
      case "run_done":
        s.run = e.run;
        break;
      case "error":
        s.error = e.message;
        s.finished = true;
        break;
      case "done":
        s.finished = true;
        break;
    }
  }
  return s;
}

/** Free = search/fetch calls, metered = agent calls; forEach steps count one per item. */
export function countCalls(steps: RunStepView[], forEachIds: string[] = []): { free: number; metered: number } {
  let free = 0;
  let metered = 0;
  for (const st of steps) {
    if (!st.record) continue;
    if (st.type !== "search" && st.type !== "fetch" && st.type !== "agent") continue;
    const out = st.record.output;
    const n = forEachIds.includes(st.id) && Array.isArray(out) ? out.length : 1;
    if (st.type === "agent") metered += n;
    else free += n;
  }
  return { free, metered };
}

export const STATUS_WORD: Record<string, string> = { ok: "Passed", check_failed: "Check failed", error: "Failed" };
