import Link from "next/link";
import { buildReport, type ModeStats } from "@core/bench/report.js";
import { TASKS } from "@core/bench/tasks.js";
import { Dumbbell } from "@/components/Dumbbell";
import { ThemeToggle } from "../theme-toggle";

// Public: the results are files in the repo (bench/results/), not anyone's workflows.
export const dynamic = "force-dynamic";
export const metadata = { title: "Benchmark · workflow-memory" };

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const toks = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
const usd = (x: number) => (x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`);
const pass = (m?: ModeStats) => (m ? `${m.passed}/${m.trials}` : "–");

const FAULT_TEXT: Record<string, string> = {
  url_moved: "The page moved; its old URL now returns 404.",
  redirected_home: "The old URL now lands on the site's homepage.",
  field_renamed: "Upstream output changed shape; an extract step reads a field that's gone.",
  daily: "A scheduled replay against the live page failed.",
};

function Tile({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="muted small">{detail}</div>
    </div>
  );
}

export default function BenchPage() {
  const r = buildReport();
  const h = r.headline;
  const rows = r.tasks.filter((t) => t.raw || t.replay);

  return (
    <main className="column wide bench">
      <p className="small"><Link href="/">workflow-memory</Link></p>
      <header className="page-header">
        <h1>Benchmark</h1>
        <ThemeToggle />
      </header>
      <p>
        {TASKS.length} real web tasks (pricing pages, product listings, job postings), each run two ways: as a <strong>raw
        agent run</strong>, where Gemini solves it from scratch with TinyFish tools, and as a <strong>replay</strong> of the
        workflow learned from it once. The same task expectations grade both, and one meter counts every Gemini token
        and TinyFish call.
      </p>

      {!h ? (
        <section className="panel">
          <p className="muted">No results yet. Run <code>npm run bench -- learn</code>, then <code>npm run bench -- compare</code>.</p>
        </section>
      ) : (
        <>
          <section className="stat-grid" aria-label="Headline results">
            <Tile value={`${h.speedup.toFixed(1)}×`} label="faster" detail={`median ${secs(h.raw_median_ms)} raw → ${secs(h.replay_median_ms)} replay`} />
            <Tile value={pct(h.token_reduction)} label="fewer tokens" detail={`${toks(h.raw_tokens)} → ${toks(h.replay_tokens)} Gemini tokens per run`} />
            <Tile value={pct(h.cost_reduction)} label="cheaper" detail={`${usd(h.raw_cost_usd)} → ${usd(h.replay_cost_usd)} per run (Gemini)`} />
            <Tile value={pct(h.replay_success)} label="replay success" detail={`raw agent: ${pct(h.raw_success)} · ${h.trials} trials over ${h.tasks} tasks`} />
            {h.median_break_even_runs !== undefined && (
              <Tile value={`${h.median_break_even_runs}`} label="reruns to break even" detail="learning cost ÷ saving per run (median task)" />
            )}
            {r.repair.attempted > 0 && (
              <Tile
                value={`${r.repair.healed}/${r.repair.attempted}`}
                label="self-healed"
                detail={`broken workflows fixed by Gemini repair, ${usd(r.repair.mean_cost_usd)} and ${secs(r.repair.mean_ms)} each`}
              />
            )}
          </section>

          <section className="panel" aria-labelledby="latency">
            <h2 id="latency">Latency per run</h2>
            <p className="muted small">
              Median time per run, not counting time spent waiting out Gemini rate limits (recorded separately). Hover
              or focus a row for exact values.
            </p>
            <Dumbbell
              unit="seconds"
              format={(v) => secs(v)}
              rows={rows.map((t) => ({ label: t.task, raw: t.raw?.median_ms, replay: t.replay?.median_ms }))}
            />
          </section>

          <section className="panel" aria-labelledby="tokens">
            <h2 id="tokens">Gemini tokens per run</h2>
            <p className="muted small">Mean input + output + thinking tokens per task.</p>
            <Dumbbell
              unit="tokens"
              format={toks}
              rows={rows.map((t) => ({ label: t.task, raw: t.raw?.mean_tokens, replay: t.replay?.mean_tokens }))}
            />
          </section>
        </>
      )}

      {r.tasks.length > 0 && (
        <section className="panel" aria-labelledby="per-task">
          <h2 id="per-task">Per task</h2>
          <div className="table-scroll">
            <table className="bench-table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Raw passed</th>
                  <th scope="col">Replay passed</th>
                  <th scope="col">Clean replays</th>
                  <th scope="col" className="num">Raw</th>
                  <th scope="col" className="num">Replay</th>
                  <th scope="col" className="num">Speedup</th>
                  <th scope="col" className="num">Tokens</th>
                  <th scope="col" className="num">Learn cost</th>
                  <th scope="col" className="num">Break-even</th>
                </tr>
              </thead>
              <tbody>
                {r.tasks.map((t) => (
                  <tr key={t.task}>
                    <th scope="row" title={t.goal}>
                      {t.task}
                      <div className="muted small">{t.category}</div>
                    </th>
                    <td>{pass(t.raw)}</td>
                    <td>{pass(t.replay)}</td>
                    <td>{t.replay?.check_pass_rate !== undefined ? pct(t.replay.check_pass_rate) : "–"}</td>
                    <td className="num">{t.raw ? secs(t.raw.median_ms) : "–"}</td>
                    <td className="num">{t.replay ? secs(t.replay.median_ms) : "–"}</td>
                    <td className="num">{t.speedup ? `${t.speedup.toFixed(1)}×` : "–"}</td>
                    <td className="num">{t.raw && t.replay ? `${toks(t.raw.mean_tokens)} → ${toks(t.replay.mean_tokens)}` : "–"}</td>
                    <td className="num">{t.learn ? usd(t.learn.cost_usd) : "–"}</td>
                    <td className="num">{t.break_even_runs ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Passed: the output met the task&apos;s expectations. Clean: every step ran and every check in the workflow
            passed. Break-even: replays after which learning (explore + compile) has cost less than raw runs would have.
          </p>
        </section>
      )}

      {r.daily.length > 0 && (
        <section className="panel" aria-labelledby="daily">
          <h2 id="daily">Reliability over time</h2>
          <p className="muted small">Each saved workflow replayed against the live pages; failures go to automatic repair.</p>
          <div className="table-scroll">
            <table className="bench-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col" className="num">Passed first try</th>
                  <th scope="col" className="num">Broke</th>
                  <th scope="col" className="num">Caught by checks</th>
                  <th scope="col" className="num">Healed</th>
                </tr>
              </thead>
              <tbody>
                {r.daily.map((d) => (
                  <tr key={d.session}>
                    <th scope="row">{d.date}</th>
                    <td className="num">
                      <span className="meter" aria-hidden="true"><span style={{ width: `${(d.passed / Math.max(d.total, 1)) * 100}%` }} /></span>
                      {d.passed}/{d.total}
                    </td>
                    <td className="num">{d.broke}</td>
                    <td className="num">{d.detected}</td>
                    <td className="num">{d.healed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {r.faults.length > 0 && (
        <section className="panel" aria-labelledby="faults">
          <h2 id="faults">Self-healing under page changes</h2>
          <p className="muted small">
            Each saved workflow broken the way a site change breaks it, replayed against the real pages, then handed to
            repair (propose a fix, test-run it, retry up to 3 rounds). Healed means the repaired workflow&apos;s output
            passed the task&apos;s expectations again.
          </p>
          <div className="table-scroll">
            <table className="bench-table">
              <thead>
                <tr>
                  <th scope="col">Fault</th>
                  <th scope="col" className="num">Broke</th>
                  <th scope="col" className="num">Caught by checks</th>
                  <th scope="col" className="num">Healed</th>
                </tr>
              </thead>
              <tbody>
                {r.faults.map((f) => (
                  <tr key={f.fault}>
                    <th scope="row">
                      <code>{f.fault}</code>
                      <div className="muted small">{FAULT_TEXT[f.fault] ?? ""}</div>
                    </th>
                    <td className="num">{f.broke}/{f.applicable}</td>
                    <td className="num">{f.detected}/{f.broke}</td>
                    <td className="num">
                      <span className="meter" aria-hidden="true"><span style={{ width: `${(f.healed / Math.max(f.broke, 1)) * 100}%` }} /></span>
                      {f.healed}/{f.broke}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.repair.undetected > 0 && (
            <p className="small">
              {r.repair.undetected} {r.repair.undetected === 1 ? "breakage was" : "breakages were"} not caught by the
              workflow&apos;s own checks (the output was wrong but every step passed), so repair never ran.
            </p>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="method">
        <h2 id="method">Method</h2>
        <ul className="small">
          <li>Grading is deterministic: each task lists strings that must appear, patterns that must match often enough, and a minimum number of complete records. No LLM judge.</li>
          <li>Raw runs and replays alternate within each round, so both read the same pages at about the same time.</li>
          <li>
            Cost is Gemini only, at {r.model ?? "the configured model"} list price ($0.30 / $2.50 per 1M input / output tokens; thinking bills as output).
            TinyFish Search and Fetch are free; browser-agent runs cost TinyFish credits and are counted separately
            {h ? ` (${h.raw_agent_runs.toFixed(2)} per raw run, ${h.replay_agent_runs.toFixed(2)} per replay)` : ""}.
          </li>
          <li>
            Speedup is the geometric mean of per-task median speedups. Latency leaves out time spent sleeping on Gemini
            rate limits, which would otherwise penalize whichever mode makes more calls
            {h ? ` (mean wait: ${secs(r.waits.raw)} per raw run, ${secs(r.waits.replay)} per replay)` : ""}.
          </li>
          <li>
            Sessions: {r.sessions.learn} learn, {r.sessions.compare} compare, {r.sessions.daily} daily, {r.sessions.drift} drift.
            Raw data in <code>bench/results/</code>; rerun with <code>npm run bench -- compare</code>.
          </li>
        </ul>
      </section>
    </main>
  );
}
