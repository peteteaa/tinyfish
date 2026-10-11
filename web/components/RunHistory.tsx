import { RepairButton } from "@/components/Repair";
import { formatDuration, truncate } from "@/lib/learnEvents";
import { STATUS_WORD } from "@/lib/runEvents";

interface RunRow {
  run_id: string;
  version: number;
  status: "ok" | "check_failed" | "error";
  started_at: string;
  duration_ms: number;
  params: Record<string, unknown>;
  steps?: { id: string; status: string }[];
}

export function RunHistory({ runs }: { runs: RunRow[] }) {
  if (runs.length === 0) return <p className="muted">No runs yet. Fill in the parameters above and choose Run.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Started</th><th>Version</th><th>Status</th><th>Duration</th><th>Parameters</th><th><span className="visually-hidden">Details</span></th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.run_id}>
              <td>{new Date(r.started_at).toISOString().slice(0, 16).replace("T", " ")} UTC</td>
              <td>v{r.version}</td>
              <td><span className={`status ${r.status === "ok" ? "status-ok" : "status-failed"}`}>{STATUS_WORD[r.status] ?? r.status}</span></td>
              <td>{formatDuration(r.duration_ms)}</td>
              <td className="mono small">{truncate(JSON.stringify(r.params), 60)}</td>
              <td>
                <a href={`/runs/${r.run_id}`}>View</a>
                {(() => {
                  const failed = r.steps?.find((st) => st.status !== "ok");
                  return failed ? <> · <RepairButton runId={r.run_id} step={failed.id} compact /></> : null;
                })()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
