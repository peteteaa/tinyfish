import type { Workflow } from "@core/schema.js";

export interface TraceEntry {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  duration_ms: number;
}

export type LearnEvent =
  | { kind: "started"; goal: string }
  | { kind: "trace_start"; index: number; tool: string; input: unknown }
  | { kind: "trace"; index: number; entry: TraceEntry }
  | { kind: "answer"; answer: unknown; notes: string; text: string }
  | { kind: "compiling" }
  | { kind: "draft"; workflow: Workflow; derived_from: Record<string, number[]>; trace_id: string; elapsed_ms: number }
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string }
  | { kind: "done" };

export interface TraceRow {
  index: number;
  tool: string;
  input: unknown;
  status: "running" | "ok" | "failed";
  output?: unknown;
  error?: string;
  duration_ms?: number;
}

export interface LearnState {
  goal: string;
  rows: TraceRow[];
  answer?: { answer: unknown; notes: string };
  compiling: boolean;
  draft?: { workflow: Workflow; derived_from: Record<string, number[]>; elapsed_ms: number };
  error?: string;
  /** Latest wait/fallback notice (e.g. Gemini rate limited); cleared when real progress arrives. */
  notice?: string;
  done: boolean;
}

export function reduceLearnEvents(events: LearnEvent[]): LearnState {
  const s: LearnState = { goal: "", rows: [], compiling: false, done: false };
  const byIndex = new Map<number, TraceRow>();
  for (const e of events) {
    if (e.kind === "notice") {
      s.notice = e.message;
      continue;
    }
    s.notice = undefined;
    switch (e.kind) {
      case "started":
        s.goal = e.goal;
        break;
      case "trace_start":
        byIndex.set(e.index, { index: e.index, tool: e.tool, input: e.input, status: "running" });
        break;
      case "trace": {
        const failed = e.entry.error !== undefined && e.entry.error !== null && e.entry.error !== "";
        byIndex.set(e.index, {
          index: e.index,
          tool: e.entry.tool,
          input: e.entry.input,
          output: e.entry.output,
          error: failed ? e.entry.error : undefined,
          duration_ms: e.entry.duration_ms,
          status: failed ? "failed" : "ok",
        });
        break;
      }
      case "answer":
        s.answer = { answer: e.answer, notes: e.notes };
        break;
      case "compiling":
        s.compiling = true;
        break;
      case "draft":
        s.draft = { workflow: e.workflow, derived_from: e.derived_from, elapsed_ms: e.elapsed_ms };
        break;
      case "error":
        s.error = e.message;
        break;
      case "done":
        s.done = true;
        break;
    }
  }
  s.rows = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return s;
}

const TOOL_LABEL: Record<string, { label: string; note: string }> = {
  tinyfish_search: { label: "search", note: "free" },
  tinyfish_fetch: { label: "fetch", note: "free" },
  tinyfish_agent: { label: "agent", note: "metered" },
};

export function toolInfo(tool: string) {
  return TOOL_LABEL[tool] ?? { label: tool.replace(/^tinyfish_/, ""), note: "" };
}

export function truncate(s: string, n = 90): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

export function summarizeInput(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "tinyfish_search") return truncate(str(i.query));
  if (tool === "tinyfish_fetch") return truncate(Array.isArray(i.urls) ? i.urls.join(", ") : str(i.urls ?? i.url));
  if (tool === "tinyfish_agent") return truncate([str(i.url), str(i.goal)].filter(Boolean).join(" - "));
  return truncate(str(input));
}

/** The one field that best describes what a saved step does. */
export function stepKeyField(step: Record<string, unknown>): string {
  const type = step.type;
  const pick =
    type === "search" ? step.query
    : type === "fetch" ? step.urls
    : type === "agent" ? [step.url, step.goal].filter(Boolean).join(" - ")
    : type === "extract" ? step.instruction
    : undefined;
  if (pick === undefined) return "";
  return truncate(Array.isArray(pick) ? pick.join(", ") : str(pick), 100);
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const SOURCE_LABEL: Record<string, string> = {
  learned: "Learned",
  web: "Edited in web",
  repair: "Repaired",
  cli: "Pushed from CLI",
  import: "Imported",
};
