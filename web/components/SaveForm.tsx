"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Workflow } from "@core/schema.js";

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function SaveForm({ workflow, elapsedMs }: { workflow: Workflow; elapsedMs: number }) {
  const router = useRouter();
  const [name, setName] = useState(workflow.name);
  const [existing, setExisting] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((b: { workflows?: { name: string; latest: number }[] }) =>
        setExisting(Object.fromEntries((b.workflows ?? []).map((w) => [w.name, w.latest]))),
      )
      .catch(() => {});
  }, []);

  const valid = NAME_RE.test(name);
  const latest = existing[name];
  const final: Workflow = { ...workflow, name };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setErrors([]);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: final, source: "learned" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const list: string[] = body?.error?.errors ?? [];
        setErrors(list.length ? list : [body?.error?.message ?? "The workflow was not saved. Try again."]);
        setBusy(false);
        return;
      }
      router.push(`/workflows/${name}?learned=${Math.round(elapsedMs / 1000)}`);
    } catch {
      setErrors(["Could not reach the server. Check your connection and try again."]);
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save} aria-labelledby="save-heading">
      <h2 id="save-heading">Save this workflow</h2>
      <label htmlFor="wf-name" className="field-label">Name</label>
      <input
        id="wf-name"
        className="mono text-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-invalid={!valid}
        aria-describedby="wf-name-hint"
        autoComplete="off"
        spellCheck={false}
      />
      <p id="wf-name-hint" className={valid ? "muted small" : "error-text small"}>
        {valid
          ? latest !== undefined
            ? `A workflow with this name exists; saving adds version ${latest + 1}.`
            : "Lowercase letters, digits and underscores."
          : "Start with a lowercase letter, then use only lowercase letters, digits and underscores."}
      </p>
      <p>{workflow.description}</p>
      <details>
        <summary>Workflow JSON</summary>
        <pre className="json">{JSON.stringify(final, null, 2)}</pre>
      </details>
      {errors.length > 0 && (
        <div role="alert" className="error-text">
          <p>The workflow did not pass validation. Fix these and save again:</p>
          <ul>{errors.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={!valid || busy}>
          {busy ? "Saving…" : "Save workflow"}
        </button>
      </div>
    </form>
  );
}
