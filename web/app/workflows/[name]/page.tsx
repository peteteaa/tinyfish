import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkflow, listVersions, listRuns } from "@core/store.js";
import { REPO_URL, ROOT } from "@core/env.js";
import { RunPanel } from "@/components/RunPanel";
import { RunHistory } from "@/components/RunHistory";
import { ExportPanel } from "@/components/ExportPanel";
import { DeleteWorkflowButton } from "@/components/DeleteWorkflowButton";
import { WorkflowEditor } from "@/components/WorkflowEditor";
import { RepairProvider } from "@/components/Repair";
import { WorkingCopyProvider } from "@/components/WorkingCopy";
import { SOURCE_LABEL } from "@/lib/learnEvents";
import { asUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ learned?: string | string[] }>;
}) {
  return asUser(async () => {
    const { name } = await params;
    const { learned: learnedRaw } = await searchParams;
    const wf = await getWorkflow(name);
    if (!wf) notFound();
    const versions = await listVersions(name);
    const runs = await listRuns(name, 20);
    const learned = Number(Array.isArray(learnedRaw) ? learnedRaw[0] : learnedRaw);

    return (
      <main className="column">
        <RepairProvider>
        <WorkingCopyProvider workflow={wf}>
          <p className="small"><Link href="/">Back to saved workflows</Link></p>
          {Number.isFinite(learned) && learnedRaw !== undefined && <p className="status status-ok" role="status">Workflow saved. Learned in {learned}s.</p>}
          <h1>{wf.name}</h1>
          <p>{wf.description}</p>

          <RunPanel name={wf.name} params={wf.params} forEachIds={wf.steps.filter((s) => s.forEach !== undefined).map((s) => s.id)} />

          <section className="panel" aria-labelledby="history">
            <h2 id="history">Run history</h2>
            <RunHistory runs={runs} />
          </section>

          <WorkflowEditor workflow={wf} testParams={runs[0]?.params} />

          <ExportPanel
            name={wf.name}
            params={wf.params}
            // Hosted (Vercel): readers have nothing installed and /var/task means nothing to them.
            local={!process.env.VERCEL}
            root={ROOT}
            repoUrl={REPO_URL}
          />

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
              <summary>Saved workflow JSON (v{wf.version})</summary>
              <pre className="json">{JSON.stringify(wf, null, 2)}</pre>
            </details>
          </section>

          <section className="panel" aria-labelledby="delete">
            <h2 id="delete">Delete workflow</h2>
            <p className="muted">Removes every version of {wf.name} and its run history. This can&apos;t be undone.</p>
            <DeleteWorkflowButton name={wf.name} redirectTo="/" />
          </section>
        </WorkingCopyProvider>
        </RepairProvider>
      </main>
    );
  });
}
