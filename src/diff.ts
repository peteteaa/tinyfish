// Structural diff between two workflow versions. Pure (no Node APIs) so the web client can use it too.

import type { Workflow } from "./schema.js";
import type { WorkflowDiff } from "./store/types.js";

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}

export function diffWorkflows(name: string, from: Workflow, to: Workflow, fromV: number, toV: number): WorkflowDiff {
  const fp = from.params ?? {};
  const tp = to.params ?? {};
  const fs_ = new Map(from.steps.map((s) => [s.id, s as Record<string, unknown>]));
  const ts = new Map(to.steps.map((s) => [s.id, s as Record<string, unknown>]));
  const changed: { id: string; fields: string[] }[] = [];
  for (const [id, a] of fs_) {
    const b = ts.get(id);
    if (!b) continue;
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => stable(a[k]) !== stable(b[k]))
      .sort();
    if (fields.length) changed.push({ id, fields });
  }
  const common = (steps: Workflow["steps"], other: Map<string, unknown>) => steps.map((s) => s.id).filter((id) => other.has(id));
  return {
    name,
    from: fromV,
    to: toV,
    description_changed: from.description !== to.description,
    output_changed: stable(from.output) !== stable(to.output),
    params: {
      added: Object.keys(tp).filter((k) => !(k in fp)),
      removed: Object.keys(fp).filter((k) => !(k in tp)),
      changed: Object.keys(tp).filter((k) => k in fp && stable(fp[k]) !== stable(tp[k])),
    },
    steps: {
      added: [...ts.keys()].filter((id) => !fs_.has(id)),
      removed: [...fs_.keys()].filter((id) => !ts.has(id)),
      changed,
      reordered: common(from.steps, ts).join("\0") !== common(to.steps, fs_).join("\0"),
    },
  };
}

/** True when the diff has any change at all. */
export function hasChanges(d: WorkflowDiff): boolean {
  return (
    d.description_changed ||
    d.output_changed ||
    d.params.added.length + d.params.removed.length + d.params.changed.length > 0 ||
    d.steps.added.length + d.steps.removed.length + d.steps.changed.length > 0 ||
    d.steps.reordered
  );
}
