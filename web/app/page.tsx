import { listWorkflows } from "@core/store.js";
import { ThemeToggle } from "./theme-toggle";

export const dynamic = "force-dynamic";

export default async function Home() {
  const workflows = await listWorkflows();
  return (
    <main className="column">
      <header className="page-header">
        <h1>workflow-memory</h1>
        <ThemeToggle />
      </header>
      <p>Describe a web task once. Rerun it as a tested workflow.</p>
      <section className="panel" aria-labelledby="saved">
        <h2 id="saved">Saved workflows</h2>
        {workflows.length === 0 ? (
          <p className="muted">Nothing saved yet. Describe a web task above and we&apos;ll learn it, or import a workflow file.</p>
        ) : (
          <ul className="list">
            {workflows.map((w) => (
              <li key={w.name}>
                <strong>{w.name}</strong>
                <span className="muted">{w.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
