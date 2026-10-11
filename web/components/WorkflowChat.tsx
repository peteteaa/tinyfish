"use client";

import { useEffect, useRef, useState } from "react";
import type { Workflow } from "@core/schema.js";
import type { WorkflowDiff } from "@core/store.js";
import { useRepair, type RepairRequest } from "@/components/Repair";

interface Turn {
  role: "user" | "assistant";
  text: string;
  /** What this turn changed, for assistant turns. */
  changes?: string[];
  error?: boolean;
}

const SUGGESTIONS = [
  "Explain what this workflow does, step by step",
  "Add a check that the extraction is never empty",
  "Make the URLs a parameter",
];

interface EditResultBody {
  workflow: Workflow;
  reply: string;
  diff: WorkflowDiff;
  changed: boolean;
}
interface RepairResultBody extends EditResultBody {
  verified: boolean | null;
  rounds: number;
  test?: { status: string; failed_step?: string; failures: string[] };
}

/** Follows a repair job's events, reporting progress, until repair_result (resolves) or error (rejects). */
function followRepair(jobId: string, onProgress: (line: string) => void): Promise<RepairResultBody> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    let result: RepairResultBody | undefined;
    es.onmessage = (m) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      const round = e.round as number;
      if (e.kind === "repair_round") onProgress(`Round ${round}: ${round === 1 ? "diagnosing the failure" : `fixing ${e.step}`}…`);
      else if (e.kind === "repair_proposal" && e.changed) onProgress(`Round ${round}: testing the fix…`);
      else if (e.kind === "test_step" && !e.status) onProgress(`Round ${round}: testing the fix (${e.step})…`);
      else if (e.kind === "test_done" && e.failed_step) onProgress(`Round ${round}: still fails at ${e.failed_step}; trying again…`);
      else if (e.kind === "repair_result") result = e as unknown as RepairResultBody;
      else if (e.kind === "error") {
        es.close();
        reject(new Error(String(e.message ?? "The repair failed.")));
      } else if (e.kind === "done") {
        es.close();
        if (result) resolve(result);
        else reject(new Error("The repair finished without a result."));
      }
    };
    // The server replays history on reconnect; only give up if the job is gone.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) reject(new Error("Lost the connection to the repair. Try again."));
    };
  });
}

/** One line per kind of change, e.g. "Edited step extract_plans (instruction)". */
function describe(d: WorkflowDiff): string[] {
  const out: string[] = [];
  for (const id of d.steps.added) out.push(`Added step ${id}`);
  for (const id of d.steps.removed) out.push(`Removed step ${id}`);
  for (const c of d.steps.changed) out.push(`Edited step ${c.id} (${c.fields.join(", ")})`);
  if (d.steps.reordered) out.push("Reordered steps");
  for (const k of d.params.added) out.push(`Added param ${k}`);
  for (const k of d.params.removed) out.push(`Removed param ${k}`);
  for (const k of d.params.changed) out.push(`Edited param ${k}`);
  if (d.description_changed) out.push("Edited the description");
  if (d.output_changed) out.push("Edited the output");
  return out;
}

/**
 * Chat with Gemini to change a workflow. Each message applies to `workflow` and hands the result to `onChange`
 * right away; saving is up to the parent. `resetKey` changing (e.g. after discard or save) clears the undo stack.
 */
export function WorkflowChat({
  workflow,
  onChange,
  resetKey,
  onRepair,
  heading = "Edit with chat",
  intro,
}: {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  resetKey?: unknown;
  /** Called when a repair for this run starts, so the parent can reuse the run's params. */
  onRepair?: (runId: string) => void;
  heading?: string;
  intro?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [undo, setUndo] = useState<Workflow[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** Live status line while a repair job runs, e.g. "Round 2: testing the fix (fetch_pages)…". */
  const [progress, setProgress] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setUndo([]), [resetKey]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  function apply(before: Workflow, result: EditResultBody, extraLines: string[] = []) {
    if (result.changed) {
      setUndo((u) => [...u, before]);
      onChange(result.workflow);
    }
    const changes = result.changed ? describe(result.diff) : ["No changes to the workflow."];
    setTurns((t) => [...t, { role: "assistant", text: result.reply, changes: [...extraLines, ...changes] }]);
  }

  /** Sends one turn to /api/edit and applies the result. */
  async function ask(userText: string, route: "edit", extra: Record<string, unknown>) {
    if (busy) return;
    const before = workflow;
    const history = turns.filter((t) => !t.error).map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: "user", text: userText }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...extra, workflow: before, history }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errors: string[] = body?.error?.errors ?? [];
        const message = body?.error?.message ?? "The edit didn't go through. Try again.";
        setTurns((t) => [...t, { role: "assistant", text: errors.length ? `${message} ${errors.join("; ")}` : message, error: true }]);
        return;
      }
      apply(before, body as EditResultBody);
    } catch {
      setTurns((t) => [...t, { role: "assistant", text: "Could not reach the server. Check your connection and try again.", error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  /** Starts a repair job (propose, test-run, retry) and follows its events until the result arrives. */
  async function askRepair(runId: string, step: string) {
    if (busy) return;
    const before = workflow;
    const history = turns.filter((t) => !t.error).map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: "user", text: `Repair step ${step} using run ${runId}.` }]);
    setBusy(true);
    setProgress("Round 1: diagnosing the failure…");
    const fail = (text: string) => setTurns((t) => [...t, { role: "assistant", text, error: true }]);
    try {
      const res = await fetch("/api/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId, step, workflow: before, history }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.jobId) return fail(body?.error?.message ?? "The repair didn't start. Try again.");
      const result = await followRepair(body.jobId, setProgress);
      const lines =
        result.verified === true
          ? [`Tested: the run passes with this fix${result.rounds > 1 ? ` (attempt ${result.rounds})` : ""}.`]
          : result.verified === false
            ? [`Tested ${result.rounds > 1 ? "several fixes" : "the fix"}: still fails at ${result.test?.failed_step ?? "a step"}. Review before saving.`]
            : result.test?.status === "invalid_params"
              ? [`Not tested: ${result.test.failures[0] ?? "the failed run's params don't fit the fix"}.`]
              : [];
      apply(before, result, lines);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Lost the connection to the repair. Try again.");
    } finally {
      setBusy(false);
      setProgress(null);
      inputRef.current?.focus();
    }
  }

  function send(text: string) {
    const instruction = text.trim();
    if (!instruction || busy) return;
    setInput("");
    return ask(instruction, "edit", { instruction });
  }

  // Repairs requested from the run panel or run history land in this conversation.
  const repair = useRepair();
  const repairRef = useRef<(r: RepairRequest) => Promise<void>>(async () => {});
  repairRef.current = async ({ runId, step }) => {
    document.getElementById("chat-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    onRepair?.(runId);
    await askRepair(runId, step);
  };
  useEffect(() => {
    if (!repair) return;
    repair.register((r) => repairRef.current(r));
    return () => repair.register(null);
  }, [repair?.register]);

  function undoLast() {
    const prev = undo.at(-1);
    if (!prev || busy) return;
    setUndo((u) => u.slice(0, -1));
    onChange(prev);
    setTurns((t) => [...t, { role: "assistant", text: "Undid the last change." }]);
  }

  return (
    <section className="panel chat" aria-labelledby="chat-heading">
      <div className="chat-head">
        <h2 id="chat-heading">{heading}</h2>
        {undo.length > 0 && (
          <button type="button" className="link-button" onClick={undoLast} disabled={busy}>Undo last change</button>
        )}
      </div>
      {intro && <p className="muted small">{intro}</p>}

      {turns.length > 0 && (
        <ol className="chat-log plain" ref={logRef} aria-live="polite">
          {turns.map((t, i) => (
            <li key={i} className={`chat-turn ${t.role}${t.error ? " error" : ""}`}>
              <span className="visually-hidden">{t.role === "user" ? "You:" : "Gemini:"}</span>
              <p>{t.text}</p>
              {t.changes && t.changes.length > 0 && (
                <ul className="small chat-changes">{t.changes.map((c) => <li key={c}>{c}</li>)}</ul>
              )}
            </li>
          ))}
          {busy && <li className="chat-turn assistant pending"><p className="status status-running">{progress ?? "Gemini is editing…"}</p></li>}
        </ol>
      )}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="visually-hidden">Describe a change</label>
        <textarea
          id="chat-input"
          ref={inputRef}
          className="text-input chat-input"
          rows={2}
          value={input}
          placeholder="e.g. Also extract whether each plan has a free trial"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || input.trim() === ""}>{busy ? "Editing…" : "Send"}</button>
      </form>
      {turns.length === 0 && (
        <ul className="plain chat-suggestions">
          {SUGGESTIONS.map((s) => (
            <li key={s}>
              <button type="button" className="link-button" disabled={busy} onClick={() => void send(s)}>{s}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
