// Raw vs replay per task on one log axis: a dot for each mode, joined by a line. Plain HTML positioned in percent,
// so labels stay at text size on any width. Each row is focusable and shows its exact values on hover or focus.

export interface DumbbellRow {
  label: string;
  sub?: string;
  raw?: number;
  replay?: number;
}

const pow10 = (x: number) => 10 ** x;
/** 1-2-5 ticks per decade; a narrow range (under 3 of those) gets 1-1.5-2-3-5-7 instead. */
function ticks(lo: number, hi: number): number[] {
  const at = (steps: number[]) => {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
      for (const m of steps) {
        const v = m * pow10(e);
        if (v >= lo && v <= hi) out.push(v);
      }
    }
    return out;
  };
  const coarse = at([1, 2, 5]);
  return coarse.length >= 3 ? coarse : at([1, 1.5, 2, 3, 5, 7]);
}

export function Dumbbell({ rows, format, unit }: { rows: DumbbellRow[]; format: (v: number) => string; unit: string }) {
  const values = rows.flatMap((r) => [r.raw, r.replay]).filter((v): v is number => v !== undefined && v > 0);
  if (!values.length) return null;
  const lo = Math.min(...values) / 1.5;
  const hi = Math.max(...values) * 1.5;
  const x = (v: number) => ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100;
  const axis = ticks(lo, hi);

  return (
    <div className="viz-root dumbbell">
      <div className="viz-legend" aria-hidden="true">
        <span><i className="dot dot-raw" /> Raw agent run</span>
        <span><i className="dot dot-replay" /> Replayed workflow</span>
        <span className="muted">{unit}, log scale</span>
      </div>
      <div className="db-row db-axis" aria-hidden="true">
        <span />
        <div className="db-track">
          {axis.map((t) => (
            <span key={t} className="db-tick" style={{ left: `${x(t)}%` }}>{format(t)}</span>
          ))}
        </div>
      </div>
      {rows.map((r) => {
        const a = r.raw && r.raw > 0 ? x(r.raw) : undefined;
        const b = r.replay && r.replay > 0 ? x(r.replay) : undefined;
        const ratio = r.raw && r.replay ? r.raw / r.replay : undefined;
        const summary = `${r.label}: raw ${r.raw !== undefined ? format(r.raw) : "n/a"}, replay ${r.replay !== undefined ? format(r.replay) : "n/a"}${ratio ? `, ${ratio.toFixed(1)}x` : ""}`;
        return (
          <div key={r.label} className="db-row" tabIndex={0} aria-label={summary}>
            <span className="db-label">
              {r.label}
              {r.sub && <span className="muted small"> {r.sub}</span>}
            </span>
            <div className="db-track">
              {axis.map((t) => (
                <span key={t} className="db-grid" style={{ left: `${x(t)}%` }} />
              ))}
              {a !== undefined && b !== undefined && (
                <span className="db-line" style={{ left: `${Math.min(a, b)}%`, width: `${Math.abs(a - b)}%` }} />
              )}
              {a !== undefined && <span className="dot dot-raw db-dot" style={{ left: `${a}%` }} />}
              {b !== undefined && <span className="dot dot-replay db-dot" style={{ left: `${b}%` }} />}
              <span className="db-tip" role="presentation" style={{ left: `${Math.min(Math.max((a ?? b ?? 50) - 4, 0), 62)}%` }}>
                <strong>{r.label}</strong>
                <span><i className="dot dot-raw" /> raw {r.raw !== undefined ? format(r.raw) : "n/a"}</span>
                <span><i className="dot dot-replay" /> replay {r.replay !== undefined ? format(r.replay) : "n/a"}</span>
                {ratio && <span className="muted">{ratio.toFixed(1)}x</span>}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
