// Readable rendering of run/step output: objects become labelled fields, uniform lists become tables, lists of
// records become cards, long text and big lists collapse. The raw JSON stays one click away.
// No hooks, so it works in server and client components.

import type { ReactNode } from "react";

const TEXT_PREVIEW = 280; // chars of a long string shown before "Show all"
const MAX_ROWS = 50; // table rows / list items shown before "Show N more"
const MAX_COLUMNS = 8;
const MAX_DEPTH = 5; // deeper than this falls back to JSON
const TITLE_KEYS = ["name", "title", "company", "competitor", "label", "page_title", "id", "source_url", "url", "final_url"];

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

/** snake_case / camelCase -> "Sentence case". */
export function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** One short line describing a value, e.g. "8 results, 0 errors" or "6 items". */
export function summarizeValue(v: unknown): string {
  if (v === null || v === undefined) return "empty";
  if (Array.isArray(v)) return plural(v.length, "item");
  if (isRec(v)) {
    const lists = Object.entries(v).filter(([, x]) => Array.isArray(x)) as [string, unknown[]][];
    if (lists.length) return lists.map(([k, x]) => `${x.length.toLocaleString()} ${humanize(k).toLowerCase()}`).join(", ");
    return plural(Object.keys(v).length, "field");
  }
  if (typeof v === "string") return v.length > 60 ? plural(v.length, "char") : v;
  return String(v);
}

function Text({ value }: { value: string }) {
  if (value === "") return <span className="muted">(empty)</span>;
  if (isUrl(value)) {
    const shown = value.replace(/^https?:\/\/(www\.)?/, "");
    return <a href={value} target="_blank" rel="noreferrer" className="out-url">{shown.length > 70 ? `${shown.slice(0, 67)}…` : shown}</a>;
  }
  if (value.length <= TEXT_PREVIEW) return <span className="out-text">{value}</span>;
  return (
    <details className="out-more">
      <summary><span className="out-text">{value.slice(0, TEXT_PREVIEW).trimEnd()}…</span> <span className="small muted">Show all ({plural(value.length, "char")})</span></summary>
      <div className="out-text out-long">{value}</div>
    </details>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (typeof value === "number") return <>{value.toLocaleString()}</>;
  return <Text value={String(value)} />;
}

/** Splits a long list into the first MAX_ROWS and a collapsed remainder. */
function Capped<T>({ items, render }: { items: T[]; render: (items: T[], offset: number) => ReactNode }) {
  if (items.length <= MAX_ROWS) return <>{render(items, 0)}</>;
  return (
    <>
      {render(items.slice(0, MAX_ROWS), 0)}
      <details className="out-more">
        <summary className="small">Show {plural(items.length - MAX_ROWS, "more item")}</summary>
        {render(items.slice(MAX_ROWS), MAX_ROWS)}
      </details>
    </>
  );
}

/** A record is "flat" if every value is a scalar or a list of scalars, so it fits in a table row. */
const flat = (r: Rec) => Object.values(r).every((v) => isScalar(v) || (Array.isArray(v) && v.every(isScalar)));

function columnsOf(rows: Rec[]): string[] {
  const seen = new Map<string, number>();
  for (const r of rows) for (const k of Object.keys(r)) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen.keys()];
}

function Cell({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <>{value.map((x, i) => <span key={i}>{i > 0 && ", "}<Scalar value={x} /></span>)}</> : <span className="muted">—</span>;
  return <Scalar value={value} />;
}

function Table({ rows }: { rows: Rec[] }) {
  const all = columnsOf(rows);
  const cols = all.slice(0, MAX_COLUMNS);
  const hidden = all.length - cols.length;
  return (
    <div className="table-wrap">
      <Capped
        items={rows}
        render={(items, offset) => (
          <table className="out-table">
            {offset === 0 && <thead><tr><th className="out-index">#</th>{cols.map((c) => <th key={c}>{humanize(c)}</th>)}</tr></thead>}
            <tbody>
              {items.map((r, i) => (
                <tr key={i}>
                  <td className="out-index muted">{offset + i + 1}</td>
                  {cols.map((c) => <td key={c}><Cell value={r[c]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      />
      {hidden > 0 && <p className="small muted">{plural(hidden, "more column")} in the raw JSON.</p>}
    </div>
  );
}

function titleOf(r: Rec, index: number): { title: string; key?: string } {
  const key = TITLE_KEYS.find((k) => typeof r[k] === "string" && (r[k] as string).trim());
  return key ? { title: String(r[key]).replace(/^https?:\/\/(www\.)?/, ""), key } : { title: `Item ${index + 1}` };
}

function Cards({ items, depth }: { items: Rec[]; depth: number }) {
  return (
    <Capped
      items={items}
      render={(slice, offset) => (
        <ol className="plain out-cards">
          {slice.map((r, i) => {
            const { title, key } = titleOf(r, offset + i);
            // Keep the title field visible when it's a URL, so it stays clickable.
            const rest = Object.fromEntries(Object.entries(r).filter(([k]) => k !== key || isUrl(String(r[k]))));
            return (
              <li key={i} className="out-card">
                <div className="out-card-title"><strong>{title}</strong></div>
                <Fields value={rest} depth={depth + 1} />
              </li>
            );
          })}
        </ol>
      )}
    />
  );
}

function List({ value, depth }: { value: unknown[]; depth: number }) {
  if (value.length === 0) return <span className="muted">None</span>;
  if (value.every(isScalar)) {
    if (value.length <= 4 && value.every((v) => typeof v !== "string" || (v.length < 40 && !isUrl(v)))) {
      return <>{value.map((x, i) => <span key={i}>{i > 0 && ", "}<Scalar value={x} /></span>)}</>;
    }
    return <Capped items={value} render={(items) => <ul className="out-list">{items.map((x, i) => <li key={i}><Scalar value={x} /></li>)}</ul>} />;
  }
  if (value.every(isRec)) return value.every(flat) ? <Table rows={value} /> : <Cards items={value} depth={depth} />;
  return <Capped items={value} render={(items) => <ol className="out-list">{items.map((x, i) => <li key={i}><Value value={x} depth={depth + 1} /></li>)}</ol>} />;
}

function Fields({ value, depth }: { value: Rec; depth: number }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="muted">Empty</span>;
  return (
    <dl className="out-fields">
      {entries.map(([k, v]) => {
        const block = Array.isArray(v) ? !(v.length <= 4 && v.every(isScalar)) : isRec(v);
        return (
          <div key={k} className={block ? "out-field block" : "out-field"}>
            <dt>
              {humanize(k)}
              {Array.isArray(v) && v.length > 0 && block && <span className="muted small"> · {v.length.toLocaleString()}</span>}
            </dt>
            <dd><Value value={v} depth={depth + 1} /></dd>
          </div>
        );
      })}
    </dl>
  );
}

function Value({ value, depth }: { value: unknown; depth: number }) {
  if (depth > MAX_DEPTH) return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value)) return <List value={value} depth={depth} />;
  if (isRec(value)) return <Fields value={value} depth={depth} />;
  return <Scalar value={value} />;
}

/** Pretty view of any JSON value with a "Raw JSON" toggle. */
export function OutputView({ value, raw = true }: { value: unknown; raw?: boolean }) {
  if (value === undefined) return <p className="muted">No output.</p>;
  return (
    <div className="out">
      <Value value={value} depth={0} />
      {raw && (
        <details className="out-raw">
          <summary className="small muted">Raw JSON</summary>
          <pre className="json">{JSON.stringify(value, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
