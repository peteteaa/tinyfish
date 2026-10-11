"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { diffWorkflows, hasChanges } from "@core/diff.js";
import type { Workflow } from "@core/schema.js";
import type { WorkflowDiff } from "@core/store.js";

interface WorkingCopy {
  /** The latest saved version. */
  saved: Workflow;
  /** The copy being edited (chat edits, repairs); equals `saved` until something changes. */
  working: Workflow;
  setWorking: (wf: Workflow) => void;
  diff: WorkflowDiff;
  dirty: boolean;
}

const Ctx = createContext<WorkingCopy | null>(null);

/** Shares the unsaved working copy between the editor and the run panel, so a run uses what you see. */
export function WorkingCopyProvider({ workflow, children }: { workflow: Workflow; children: React.ReactNode }) {
  const [working, setWorking] = useState(workflow);
  // A new saved version becomes the baseline. Keyed on the version so other refreshes (e.g. after a run) keep edits.
  useEffect(() => setWorking(workflow), [workflow.version]);
  const diff = useMemo(() => diffWorkflows(workflow.name, workflow, working, workflow.version ?? 0, 0), [workflow, working]);
  const value = useMemo(() => ({ saved: workflow, working, setWorking, diff, dirty: hasChanges(diff) }), [workflow, working, diff]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkingCopy(): WorkingCopy | null {
  return useContext(Ctx);
}
