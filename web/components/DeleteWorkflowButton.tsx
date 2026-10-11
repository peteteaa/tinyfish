"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Deletes a saved workflow (all versions and run history) after a confirm. `redirectTo` navigates on success; otherwise the page refreshes. */
export function DeleteWorkflowButton({ name, redirectTo, compact }: { name: string; redirectTo?: string; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy || !window.confirm(`Delete "${name}"? This removes every version and its run history.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.message ?? "The workflow was not deleted. Try again.");
        setBusy(false);
        return;
      }
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <span className="delete-workflow">
      <button type="button" className={compact ? "link-button danger" : "danger"} onClick={remove} disabled={busy} aria-label={`Delete ${name}`}>
        {busy ? "Deleting..." : "Delete"}
      </button>
      {error && <span className="status status-failed" role="alert">{error}</span>}
    </span>
  );
}
