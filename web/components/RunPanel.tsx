"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Param } from "@core/schema.js";
import { useJobEvents } from "@/lib/useJobEvents";
import { formatDuration } from "@/lib/learnEvents";
import { countCalls, reduceRunEvents, STATUS_WORD, type RunStepView } from "@/lib/runEvents";

type Values = Record<string, string | boolean>;

function initial(params: Record<string, Param>): Values {
  const v: Values = {};
  for (const [k, p] of Object.entries(params)) {
    if (p.type === "boolean") v[k] = p.default === true;
    else if (Array.isArray(p.default)) v[k] = p.default.join(", ");
    else v[k] = p.default === undefined || p.default === null ? "" : String(p.default);
  }
  return v;
}

function toPayload(params: Record<string, Param>, values: Values): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, p] of Object.entries(params)) {
    const raw = values[k];
    if (p.type === "boolean") out[k] = raw === true;
    else {
      const s = String(raw ?? "").trim();
      if (s === "") continue;
      if (p.type === "number") out[k] = Number(s);
      else if (p.type === "string[]") out[k] = s.split(",").map((x) => x.trim()).filter(Boolean);
      else out[k] = s;
    }
  }
  return out;
}

function StepRow({ step, index, now, failures }: { step: RunStepView; index: number; now: number; failures?: { check: string; passed: boolean; message?: string }[] }) {
  const rec = step.record;
  const secs = step.startedAtClient ? Math.max(0, Math.floor((now - step.startedAtClient) / 1000)) : 0;
  const cls = step.status === "ok" ? "status-ok" : step.status === "running" ? "status-running" : step.status === "pending" ? "muted small" : "status-failed";
  const failed = (rec?.checks ?? []).filter((c) => !c.passed);
  const shown = failed.length > 0 ? failed : failures ?? [];
  return (
    <li className="run-step">
      <div className="run-step-head">
        <span><span className="muted">{index + 1}.</span> <strong>{step.id}</strong> <span className="muted small">{step.type}</span></span>
        <span className={`status ${cls}`}>
          {step.status === "pending" && "Pending"}
          {step.status === "running" && `Running ${secs}s`}
          {step.status === "ok" && `Passed ${formatDuration(rec?.duration_ms ?? 0)}`}
          {step.status === "check_failed" && "Check failed"}
          {step.status === "error" && `Failed: ${rec?.error ?? "unknown error"}`}
        </span>
      </div>
      {shown.length > 0 && (
        <div className="run-failures">
          <ul className="small">
            {shown.map((c, i) => <li key={i} className="error-text"><code>{c.check}</code>{c.message ? `: ${c.message}` : ""}</li>)}
          </ul>
          <button type="button" disabled>Repair this step</button> <span className="small muted">Coming next</span>
        </div>
      )}
      {rec && rec.output !== undefined && (
        <details>
          <summary className="small">Output</summary>
          <pre className="json">{JSON.stringify(rec.output, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

function RunView({ jobId, forEachIds, onDone }: { jobId: string; forEachIds: string[]; onDone: () => void }) {
  const { events, status } = useJobEvents(jobId);
  const state = reduceRunEvents(events);
  const [now, setNow] = useState(() => Date.now());
  const running = !state.finished && status !== "not_found" && status !== "lost";
  const hasRun = state.run !== undefined;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (hasRun) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRun]);

  const run = state.run;
  const counts = countCalls(state.steps, forEachIds);
  return (
    <div className="run-view" aria-live="polite">
      {status === "not_found" && <p className="error-text">This run is no longer available.</p>}
      {status === "lost" && !state.finished && <p className="error-text">Connection lost. Reconnecting…</p>}
      {state.error && <p className="error-text" role="alert">{state.error}</p>}
      {state.steps.length === 0 && !state.error && status !== "not_found" && <p className="muted">Starting…</p>}
      <ol className="plain">
        {state.steps.map((s, i) => <StepRow key={s.id} step={s} index={i} now={now} failures={state.repair[s.id]} />)}
      </ol>
      {run && (
        <div className="run-summary">
          <p>
            <span className={`status ${run.status === "ok" ? "status-ok" : "status-failed"}`}>{STATUS_WORD[run.status]}</span>
            {" in "}{formatDuration(run.duration_ms)} · {counts.free} free calls, {counts.metered} metered
          </p>
          {run.error && <p className="error-text">{run.error}</p>}
          <p className="small muted">Output</p>
          <pre className="json">{JSON.stringify(run.output, null, 2) ?? "No output"}</pre>
        </div>
      )}
    </div>
  );
}

export function RunPanel({ name, params, forEachIds }: { name: string; params: Record<string, Param>; forEachIds: string[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => initial(params));
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [doneIds, setDoneIds] = useState<string[]>([]);
  const busy = submitting || (jobId !== null && !doneIds.includes(jobId));
  const entries = Object.entries(params);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(name)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: toPayload(params, values) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error?.message ?? `Could not start the run (${res.status}).`);
        return;
      }
      setJobId(body.jobId);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="run">
      <h2 id="run">Run</h2>
      <form onSubmit={submit}>
        {entries.length === 0 && <p className="muted">This workflow takes no parameters.</p>}
        {entries.map(([k, p]) => {
          const required = p.required !== false && p.default === undefined;
          const id = `param-${k}`;
          return (
            <div key={k} className="run-field">
              {p.type === "boolean" ? (
                <label className="run-check">
                  <input type="checkbox" checked={values[k] === true} onChange={(e) => setValues({ ...values, [k]: e.target.checked })} /> <strong>{k}</strong>
                </label>
              ) : (
                <>
                  <label className="field-label" htmlFor={id}>{k}{required && <span className="muted"> (required)</span>}</label>
                  <input
                    id={id}
                    className="text-input"
                    type={p.type === "number" ? "number" : "text"}
                    step={p.type === "number" ? "any" : undefined}
                    value={String(values[k] ?? "")}
                    required={required}
                    onChange={(e) => setValues({ ...values, [k]: e.target.value })}
                  />
                </>
              )}
              <p className="small muted">{p.description}{p.type === "string[]" ? " Separate values with commas." : ""}</p>
            </div>
          );
        })}
        <button type="submit" className="primary" disabled={busy}>{busy ? "Running…" : "Run"}</button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </form>
      {jobId && (
        <RunView
          key={jobId}
          jobId={jobId}
          forEachIds={forEachIds}
          onDone={() => {
            setDoneIds((d) => (d.includes(jobId) ? d : [...d, jobId]));
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
