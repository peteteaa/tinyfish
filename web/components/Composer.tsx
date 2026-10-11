"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLES = [
  "Track pricing changes for firecrawl.dev and browserbase.com",
  "Find recent GitHub issues asking for a headless browser API",
  "Get the latest release notes for Next.js",
];

export function Composer({ initialGoal = "" }: { initialGoal?: string }) {
  const router = useRouter();
  const [goal, setGoal] = useState(initialGoal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/learn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.jobId) {
        setError(body?.error?.message ?? "The request did not go through. Check your connection and try again.");
        setBusy(false);
        return;
      }
      router.push(`/learn/${body.jobId}`);
    } catch {
      setError("Could not reach the server. Check that it is running and try again.");
      setBusy(false);
    }
  }

  return (
    <form className="panel composer" onSubmit={submit}>
      <label htmlFor="goal" className="visually-hidden">Describe a web task</label>
      <textarea
        id="goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Describe a web task…"
        rows={4}
        disabled={busy}
        aria-describedby={error ? "goal-error" : undefined}
      />
      {error && <p id="goal-error" role="alert" className="error-text">{error}</p>}
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={busy || goal.trim() === ""}>
          {busy ? "Starting…" : "Learn a workflow"}
        </button>
      </div>
      <div className="examples">
        <p className="muted small">Or start from an example</p>
        <ul className="plain">
          {EXAMPLES.map((ex) => (
            <li key={ex}>
              <button type="button" className="link-button" disabled={busy} onClick={() => setGoal(ex)}>
                {ex}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}
