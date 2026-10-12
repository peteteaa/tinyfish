import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@core/store.js";
import { OutputView, summarizeValue } from "@/components/OutputView";
import { formatDuration } from "@/lib/learnEvents";
import { STATUS_WORD } from "@/lib/runEvents";
import { asUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STEP_WORD: Record<string, string> = { ok: "Passed", check_failed: "Check failed", error: "Failed" };

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  return asUser(async () => {
    const { runId } = await params;
    const run = await getRun(runId);
    if (!run) notFound();
    const started = new Date(run.started_at).toISOString().slice(0, 19).replace("T", " ");

    return (
      <main className="column">
        <p className="small"><Link href={`/workflows/${run.workflow}`}>Back to {run.workflow}</Link></p>
        <h1>{run.workflow} <span className="muted">v{run.version}</span></h1>
        <p>
          <span className={`status ${run.status === "ok" ? "status-ok" : "status-failed"}`}>{STATUS_WORD[run.status] ?? run.status}</span>
          {" in "}{formatDuration(run.duration_ms)} · started {started} UTC
        </p>
        {run.error && <p className="error-text" role="alert">{run.error}</p>}

        <section className="panel" aria-labelledby="run-params">
          <h2 id="run-params">Inputs</h2>
          <OutputView value={run.params} raw={false} />
        </section>

        <section className="panel" aria-labelledby="run-output">
          <h2 id="run-output">Output</h2>
          <OutputView value={run.output} />
        </section>

        <section className="panel" aria-labelledby="run-steps">
          <h2 id="run-steps">Steps</h2>
          <ol className="plain">
            {run.steps.map((s, i) => {
              const failed = s.checks.filter((c) => !c.passed);
              const tokens = s.meta?.tokens as { input: number; output: number } | undefined;
              return (
                <li key={s.id} className="run-step">
                  <div className="run-step-head">
                    <span><span className="muted">{i + 1}.</span> <strong>{s.id}</strong> <span className="muted small">{s.type}</span></span>
                    <span className={`status ${s.status === "ok" ? "status-ok" : "status-failed"}`}>
                      {STEP_WORD[s.status] ?? s.status} {formatDuration(s.duration_ms)}
                    </span>
                  </div>
                  <p className="small muted">
                    {s.checks.length - failed.length}/{s.checks.length} checks passed
                    {tokens && <> · {tokens.input.toLocaleString()} input / {tokens.output.toLocaleString()} output tokens</>}
                  </p>
                  {s.error && <p className="error-text">{s.error}</p>}
                  {failed.length > 0 && (
                    <ul className="small run-failures">
                      {failed.map((c, j) => <li key={j} className="error-text"><code>{c.check}</code>{c.message ? `: ${c.message}` : ""}</li>)}
                    </ul>
                  )}
                  {s.output !== undefined && (
                    <details>
                      <summary className="small">Output <span className="muted">· {summarizeValue(s.output)}</span></summary>
                      <OutputView value={s.output} />
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      </main>
    );
  });
}
