import type { Workflow } from "@core/schema.js";
import type { WorkflowDiff } from "@core/store.js";
import { stepKeyField } from "@/lib/learnEvents";

/** Parameters table and step list. With `diff`, marks what changed since the saved version. */
export function WorkflowOutline({ workflow, diff }: { workflow: Workflow; diff?: WorkflowDiff }) {
  const params_ = Object.entries(workflow.params);
  const newParams = new Set([...(diff?.params.added ?? []), ...(diff?.params.changed ?? [])]);
  const added = new Set(diff?.steps.added ?? []);
  const changed = new Map((diff?.steps.changed ?? []).map((c) => [c.id, c.fields]));
  const removedParams = diff?.params.removed ?? [];
  const removedSteps = diff?.steps.removed ?? [];

  return (
    <>
      <section className="panel" aria-labelledby="params">
        <h2 id="params">Parameters</h2>
        {params_.length === 0 ? (
          <p className="muted">This workflow takes no parameters.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
              <tbody>
                {params_.map(([k, p]) => {
                  const rec = p as unknown as Record<string, unknown>;
                  const hasDefault = rec.default !== undefined;
                  return (
                    <tr key={k} className={newParams.has(k) ? "edited" : undefined}>
                      <td>
                        <code>{k}</code>
                        {newParams.has(k) && <span className="edit-tag">{diff?.params.added.includes(k) ? "new" : "edited"}</span>}
                      </td>
                      <td>{String(rec.type ?? "")}</td>
                      <td>{hasDefault ? <>default <code>{JSON.stringify(rec.default)}</code></> : rec.required === false ? "optional" : "required"}</td>
                      <td>{String(rec.description ?? "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {removedParams.length > 0 && <p className="small muted">Removed: {removedParams.map((k) => <code key={k}>{k}</code>)}</p>}
      </section>

      <section className="panel" aria-labelledby="steps">
        <h2 id="steps">Steps</h2>
        <ol className="wf-steps">
          {workflow.steps.map((s) => {
            const key = stepKeyField(s as unknown as Record<string, unknown>);
            const fields = changed.get(s.id);
            const tag = added.has(s.id) ? "new" : fields ? `edited: ${fields.join(", ")}` : null;
            return (
              <li key={s.id} className={tag ? "edited" : undefined}>
                <div>
                  <strong>{s.id}</strong> <span className="muted small">{s.type}</span>
                  {tag && <span className="edit-tag">{tag}</span>}
                </div>
                {s.description && <div>{s.description}</div>}
                {key && <div className="mono small">{key}</div>}
                {s.forEach && <div className="small muted">For each: <code>{s.forEach}</code></div>}
                {s.checks && s.checks.length > 0 && (
                  <ul className="small checks">
                    {s.checks.map((c, i) => (
                      <li key={i}><code>{c.type}</code>{"path" in c && c.path ? <> at <code>{c.path}</code></> : null}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
        {removedSteps.length > 0 && <p className="small muted">Removed: {removedSteps.map((id) => <code key={id}>{id}</code>)}</p>}
      </section>
    </>
  );
}
