"use client";

import { useState } from "react";
import type { Workflow } from "@core/schema.js";
import { stepKeyField, summarizeInput, toolInfo, type TraceRow } from "@/lib/learnEvents";

export function TraceWorkflowView({
  rows,
  workflow,
  derivedFrom,
}: {
  rows: TraceRow[];
  workflow: Workflow;
  derivedFrom: Record<string, number[]>;
}) {
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const used = new Set(Object.values(derivedFrom).flat());
  const lit = new Set(activeStep ? derivedFrom[activeStep] ?? [] : []);

  return (
    <section className="trace-workflow" aria-labelledby="tw-heading">
      <h2 id="tw-heading">From exploration to workflow</h2>
      <p className="muted">Hover or focus a saved step to see which calls it came from. Dimmed calls were dead ends.</p>
      <div className="tw-grid">
        <div className="panel">
          <h3>What the agent did</h3>
          <ul className="plain tw-trace">
            {rows.map((r) => (
              <li
                key={r.index}
                className={`tw-row${used.has(r.index) ? "" : " dead"}${lit.has(r.index) ? " lit" : ""}`}
              >
                <span><strong>{toolInfo(r.tool).label}</strong> <span className="mono small">{summarizeInput(r.tool, r.input)}</span></span>
                <span className={`status status-${r.status}`}>{r.status === "failed" ? "failed" : r.status === "ok" ? "ok" : "running"}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3>What we saved</h3>
          <ol className="tw-steps">
            {workflow.steps.map((s) => {
              const rec = s as unknown as Record<string, unknown>;
              const key = stepKeyField(rec);
              const checks = s.checks?.length ?? 0;
              return (
                <li
                  key={s.id}
                  className="tw-step"
                  tabIndex={0}
                  onMouseEnter={() => setActiveStep(s.id)}
                  onMouseLeave={() => setActiveStep((c) => (c === s.id ? null : c))}
                  onFocus={() => setActiveStep(s.id)}
                  onBlur={() => setActiveStep((c) => (c === s.id ? null : c))}
                >
                  <div>
                    <strong>{s.id}</strong> <span className="muted small">{s.type}</span>
                    {checks > 0 && <span className="muted small"> · {checks} {checks === 1 ? "check" : "checks"}</span>}
                  </div>
                  {key && <div className="mono small tw-key">{key}</div>}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
