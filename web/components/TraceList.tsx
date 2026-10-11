"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration, summarizeInput, toolInfo, type TraceRow } from "@/lib/learnEvents";

function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2) ?? "undefined"}</pre>;
}

export function TraceList({ rows, active }: { rows: TraceRow[]; active: boolean }) {
  const firstSeen = useRef<Record<number, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const anyRunning = active && rows.some((r) => r.status === "running");

  for (const r of rows) {
    if (r.status === "running" && firstSeen.current[r.index] === undefined) firstSeen.current[r.index] = Date.now();
  }

  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  if (rows.length === 0) return <p className="muted">Waiting for the first TinyFish call…</p>;

  return (
    <ol className="trace-list">
      {rows.map((r) => {
        const info = toolInfo(r.tool);
        const secs = Math.max(0, Math.floor((now - (firstSeen.current[r.index] ?? now)) / 1000));
        return (
          <li key={r.index} className="trace-row">
            <details>
              <summary>
                <span className="trace-tool">
                  <strong>{info.label}</strong>
                  {info.note && <span className="muted small"> {info.note}</span>}
                </span>
                <span className="trace-input mono">{summarizeInput(r.tool, r.input)}</span>
                <span className={`status status-${r.status}`}>
                  {r.status === "running" && `Running ${secs}s`}
                  {r.status === "ok" && `ok ${formatDuration(r.duration_ms ?? 0)}`}
                  {r.status === "failed" && `Failed: ${r.error}`}
                </span>
              </summary>
              <div className="trace-detail">
                <p className="small muted">Input</p>
                <Json value={r.input} />
                {r.status !== "running" && (
                  <>
                    <p className="small muted">{r.status === "failed" ? "Error" : "Output"}</p>
                    <Json value={r.status === "failed" ? r.error : r.output} />
                  </>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
