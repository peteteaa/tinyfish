import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkflow, listVersions } from "@core/store.js";
import { SOURCE_LABEL, stepKeyField } from "@/lib/learnEvents";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ learned?: string | string[] }>;
}) {
  const { name } = await params;
  const { learned: learnedRaw } = await searchParams;
  const wf = await getWorkflow(name);
  if (!wf) notFound();
  const versions = await listVersions(name);
  const learned = Number(Array.isArray(learnedRaw) ? learnedRaw[0] : learnedRaw);
  const params_ = Object.entries(wf.params);

  return (
    <main className="column">
      <p className="small"><Link href="/">Back to saved workflows</Link></p>
      {Number.isFinite(learned) && learnedRaw !== undefined && <p className="status status-ok" role="status">Workflow saved. Learned in {learned}s.</p>}
      <h1>{wf.name}</h1>
      <p>{wf.description}</p>

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
                    <tr key={k}>
                      <td><code>{k}</code></td>
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
      </section>

      <section className="panel" aria-labelledby="steps">
        <h2 id="steps">Steps</h2>
        <ol className="wf-steps">
          {wf.steps.map((s) => {
            const key = stepKeyField(s as unknown as Record<string, unknown>);
            return (
              <li key={s.id}>
                <div><strong>{s.id}</strong> <span className="muted small">{s.type}</span></div>
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
      </section>

      <section className="panel" aria-labelledby="versions">
        <h2 id="versions">Versions</h2>
        <ul className="list">
          {[...versions].reverse().map((v) => (
            <li key={v.version}>
              <span><strong>v{v.version}</strong> <span className="muted">{SOURCE_LABEL[v.source] ?? v.source}</span></span>
              <span className="muted small">{new Date(v.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <details>
          <summary>Workflow JSON</summary>
          <pre className="json">{JSON.stringify(wf, null, 2)}</pre>
        </details>
      </section>
    </main>
  );
}
