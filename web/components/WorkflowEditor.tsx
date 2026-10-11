"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Workflow } from "@core/schema.js";
import { RunView } from "@/components/RunPanel";
import { WorkflowChat } from "@/components/WorkflowChat";
import { WorkflowOutline } from "@/components/WorkflowOutline";
import { useWorkingCopy } from "@/components/WorkingCopy";

/** Saved-workflow editor: chat changes into a working copy, see them in the outline, save as the next version. */
export function WorkflowEditor({ workflow, testParams }: { workflow: Workflow; testParams?: Record<string, unknown> }) {
  const router = useRouter();
  // The working copy lives in WorkingCopyProvider so the run panel runs the same edits.
  const copy = useWorkingCopy();
  if (!copy) throw new Error("WorkflowEditor must be inside WorkingCopyProvider");
  const { working, setWorking, diff, dirty } = copy;
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Test runs of the unsaved copy use the params of the run being repaired, else the latest run's.
  const [repairParams, setRepairParams] = useState<Record<string, unknown> | null>(null);
  const [test, setTest] = useState<{ jobId: string; done: boolean } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // A new saved version (after save + refresh) becomes the baseline. Keyed on the version, not the object, so
  // other refreshes (e.g. after a run) don't wipe unsaved edits.
  useEffect(() => {
    setEpoch((e) => e + 1);
  }, [workflow.version]);

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setMessage(null);
    try {
      const { version: _v, ...draft } = working;
      // A repair in this session sets a new repaired_from; plain edits drop the old one so it isn't inherited.
      const repaired = draft.source?.repaired_from !== undefined && draft.source.repaired_from !== workflow.source?.repaired_from;
      if (!repaired && draft.source?.repaired_from !== undefined) {
        const { repaired_from: _r, ...rest } = draft.source;
        draft.source = rest;
      }
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: draft, source: repaired ? "repair" : "web" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errors: string[] = body?.error?.errors ?? [];
        setMessage({ ok: false, text: [body?.error?.message ?? "The workflow was not saved. Try again.", ...errors].join(" ") });
        return;
      }
      setMessage({ ok: true, text: `Saved as v${body.workflow.version}.` });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not reach the server. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setWorking(workflow);
    setEpoch((e) => e + 1);
    setMessage(null);
    setTest(null);
    setTestError(null);
  }

  async function runTest() {
    if (test && !test.done) return;
    setTestError(null);
    const source = repairParams ?? testParams ?? {};
    // Drop params the changes removed; missing ones fall back to their defaults.
    const params = Object.fromEntries(Object.entries(source).filter(([k, v]) => k in working.params && v !== null && v !== undefined));
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(workflow.name)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: working, params }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errors: string[] = body?.error?.errors ?? [];
        setTestError([body?.error?.message ?? `Could not start the test run (${res.status}).`, ...errors].join(" "));
        return;
      }
      setTest({ jobId: body.jobId, done: false });
    } catch {
      setTestError("Could not reach the server.");
    }
  }
  const testing = test !== null && !test.done;

  return (
    <>
      <WorkflowChat
        workflow={working}
        onChange={(next) => {
          setWorking(next);
          setMessage(null);
        }}
        onRepair={(runId) => {
          fetch(`/api/runs/${encodeURIComponent(runId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((b: { run?: { params?: Record<string, unknown> } } | null) => b?.run?.params && setRepairParams(b.run.params))
            .catch(() => {});
        }}
        resetKey={epoch}
        intro="Describe a change in plain English, or choose Repair on a failed step. Gemini edits the steps below as you go; nothing is saved until you save."
      />
      {(dirty || message) && (
        <div className={`panel save-bar${dirty ? " dirty" : ""}`} role="status">
          {dirty ? (
            <>
              <span><strong>Unsaved changes.</strong> <span className="muted small">The Run panel runs them as a test; save to keep them.</span></span>
              <span className="save-bar-actions">
                <button type="button" onClick={discard} disabled={busy}>Discard</button>
                <button type="button" onClick={runTest} disabled={busy || testing}>{testing ? "Testing…" : "Test changes"}</button>
                <button type="button" className="primary" onClick={save} disabled={busy}>
                  {busy ? "Saving…" : `Save as v${(workflow.version ?? 0) + 1}`}
                </button>
              </span>
            </>
          ) : null}
          {message && <span className={`status ${message.ok ? "status-ok" : "status-failed"}`}>{message.text}</span>}
        </div>
      )}
      {testError && <p className="error-text" role="alert">{testError}</p>}
      {test && dirty && (
        <section className="panel" aria-labelledby="test-run">
          <h2 id="test-run">Test run of unsaved changes</h2>
          <p className="muted small">
            Uses the params {repairParams ? "of the run being repaired" : "of the latest run"}; empty ones use their defaults.
            Not saved to run history.
          </p>
          <RunView
            key={test.jobId}
            jobId={test.jobId}
            forEachIds={working.steps.filter((s) => s.forEach !== undefined).map((s) => s.id)}
            onDone={() => setTest((t) => (t && t.jobId === test.jobId ? { ...t, done: true } : t))}
            trial
          />
        </section>
      )}
      <WorkflowOutline workflow={working} diff={dirty ? diff : undefined} />
    </>
  );
}
