"use client";

import Link from "next/link";
import { use, useMemo } from "react";
import { SaveForm } from "@/components/SaveForm";
import { TraceList } from "@/components/TraceList";
import { TraceWorkflowView } from "@/components/TraceWorkflowView";
import { reduceLearnEvents } from "@/lib/learnEvents";
import { useJobEvents } from "@/lib/useJobEvents";

export default function LearnPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const { events, status } = useJobEvents(jobId);
  const s = useMemo(() => reduceLearnEvents(events), [events]);

  if (status === "not_found") {
    return (
      <main className="column">
        <h1>Session not found</h1>
        <p>This session has expired. Start it again from the home page.</p>
        <p><Link href="/">Go to the home page</Link></p>
      </main>
    );
  }

  const lost = status === "lost" && !s.done && !s.error;
  const statusLine = s.error
    ? "Stopped before a draft was ready."
    : s.draft
      ? "Draft ready. Review it and save."
      : s.compiling
        ? "Writing the workflow…"
        : "Exploring with TinyFish…";
  const working = !s.error && !s.draft && !lost;

  return (
    <main className={`column${s.draft ? " wide" : ""}`}>
      <p className="small"><Link href="/">Back to saved workflows</Link></p>
      <h1>{s.goal || "Learning a workflow"}</h1>
      <p className="muted" role="status" aria-live="polite">{working && status === "connecting" ? "Connecting…" : statusLine}</p>

      {s.error && (
        <div className="panel" role="alert">
          <p className="error-text">{s.error}</p>
          <p><Link href={`/?goal=${encodeURIComponent(s.goal)}`}>Try again</Link></p>
        </div>
      )}
      {lost && (
        <div className="panel" role="alert">
          <p>The connection dropped before the draft finished. Reload this page to pick up where it left off.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      <section aria-labelledby="calls">
        <h2 id="calls">TinyFish calls</h2>
        <TraceList rows={s.rows} active={working} />
      </section>

      {s.answer && (
        <section className="panel" aria-labelledby="answer">
          <h2 id="answer">What the agent found</h2>
          <pre className="json">{JSON.stringify(s.answer.answer, null, 2)}</pre>
          {s.answer.notes && <p>{s.answer.notes}</p>}
        </section>
      )}

      {s.draft && (
        <>
          <TraceWorkflowView rows={s.rows} workflow={s.draft.workflow} derivedFrom={s.draft.derived_from} />
          <div className="column-inner">
            <SaveForm workflow={s.draft.workflow} elapsedMs={s.draft.elapsed_ms} />
          </div>
        </>
      )}
    </main>
  );
}
