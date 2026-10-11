"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { diffWorkflows, hasChanges } from "@core/diff.js";
import type { Workflow } from "@core/schema.js";
import { WorkflowChat } from "@/components/WorkflowChat";
import { WorkflowOutline } from "@/components/WorkflowOutline";

/** Saved-workflow editor: chat changes into a working copy, see them in the outline, save as the next version. */
export function WorkflowEditor({ workflow }: { workflow: Workflow }) {
  const router = useRouter();
  const [working, setWorking] = useState(workflow);
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // A new saved version (after save + refresh) becomes the baseline. Keyed on the version, not the object, so
  // other refreshes (e.g. after a run) don't wipe unsaved edits.
  useEffect(() => {
    setWorking(workflow);
    setEpoch((e) => e + 1);
  }, [workflow.version]);

  const diff = useMemo(() => diffWorkflows(workflow.name, workflow, working, workflow.version ?? 0, 0), [workflow, working]);
  const dirty = hasChanges(diff);

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setMessage(null);
    try {
      const { version: _v, ...draft } = working;
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: draft, source: "web" }),
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
  }

  return (
    <>
      <WorkflowChat
        workflow={working}
        onChange={(next) => {
          setWorking(next);
          setMessage(null);
        }}
        resetKey={epoch}
        intro="Describe a change in plain English. Gemini edits the steps below as you go; nothing is saved until you save."
      />
      {(dirty || message) && (
        <div className={`panel save-bar${dirty ? " dirty" : ""}`} role="status">
          {dirty ? (
            <>
              <span><strong>Unsaved changes.</strong> <span className="muted small">Runs use v{workflow.version} until you save.</span></span>
              <span className="save-bar-actions">
                <button type="button" onClick={discard} disabled={busy}>Discard</button>
                <button type="button" className="primary" onClick={save} disabled={busy}>
                  {busy ? "Saving…" : `Save as v${(workflow.version ?? 0) + 1}`}
                </button>
              </span>
            </>
          ) : null}
          {message && <span className={`status ${message.ok ? "status-ok" : "status-failed"}`}>{message.text}</span>}
        </div>
      )}
      <WorkflowOutline workflow={working} diff={dirty ? diff : undefined} />
    </>
  );
}
