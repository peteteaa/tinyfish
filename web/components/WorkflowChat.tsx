"use client";

import { useEffect, useRef, useState } from "react";
import type { Workflow } from "@core/schema.js";
import type { WorkflowDiff } from "@core/store.js";

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
  heading = "Edit with chat",
  intro,
}: {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
  resetKey?: unknown;
  heading?: string;
  intro?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [undo, setUndo] = useState<Workflow[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setUndo([]), [resetKey]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  async function send(text: string) {
    const instruction = text.trim();
    if (!instruction || busy) return;
    const before = workflow;
    const history = turns.filter((t) => !t.error).map(({ role, text }) => ({ role, text }));
    setTurns((t) => [...t, { role: "user", text: instruction }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: before, instruction, history }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errors: string[] = body?.error?.errors ?? [];
        const message = body?.error?.message ?? "The edit didn't go through. Try again.";
        setTurns((t) => [...t, { role: "assistant", text: errors.length ? `${message} ${errors.join("; ")}` : message, error: true }]);
        return;
      }
      const result = body as { workflow: Workflow; reply: string; diff: WorkflowDiff; changed: boolean };
      if (result.changed) {
        setUndo((u) => [...u, before]);
        onChange(result.workflow);
      }
      setTurns((t) => [...t, { role: "assistant", text: result.reply, changes: result.changed ? describe(result.diff) : ["No changes to the workflow."] }]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", text: "Could not reach the server. Check your connection and try again.", error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

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
          {busy && <li className="chat-turn assistant pending"><p className="status status-running">Gemini is editing…</p></li>}
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
