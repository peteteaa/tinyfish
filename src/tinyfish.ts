// Thin wrappers over the TinyFish Search, Fetch and Agent APIs.
// Shapes follow the OpenAPI specs at https://agent.tinyfish.ai/v1/openapi/{search,fetch,main}.
// Set WM_DEBUG=1 to log raw responses (day-1 verification).

import { DEBUG, log, requireEnv } from "./env.js";

const SEARCH_URL = process.env.TINYFISH_SEARCH_URL ?? "https://api.search.tinyfish.ai";
const FETCH_URL = process.env.TINYFISH_FETCH_URL ?? "https://api.fetch.tinyfish.ai";
const AGENT_URL = process.env.TINYFISH_AGENT_URL ?? "https://agent.tinyfish.ai";

export class TinyFishError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(label: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-API-Key": requireEnv("TINYFISH_API_KEY"),
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  if (DEBUG) log(`[tinyfish:${label}] ${res.status}`, JSON.stringify(body, null, 2).slice(0, 4000));
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? text.slice(0, 500);
    throw new TinyFishError(`TinyFish ${label} failed (${res.status}): ${msg}`, res.status, body);
  }
  return body as T;
}

/** TinyFish expects absolute URLs; accept "example.com/pricing" for convenience. */
export function normalizeUrl(u: string): string {
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

// ---------- Search ----------

export interface SearchParams {
  query: string;
  purpose?: string;
  include_domains?: string;
  exclude_domains?: string;
  domain_type?: "web" | "news" | "research_paper";
  location?: string;
  language?: string;
  page?: number;
}

export interface SearchResult {
  position: number;
  site_name: string;
  snippet: string;
  title: string;
  url: string;
  date?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_results: number;
  page: number;
}

export function search(params: SearchParams): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  return call("search", `${SEARCH_URL}/?${qs}`, { method: "GET" });
}

// ---------- Fetch ----------

export interface FetchParams {
  urls: string[];
  purpose?: string;
  format?: "markdown" | "html" | "json";
  links?: boolean;
  per_url_timeout_ms?: number;
}

export interface FetchResult {
  url: string;
  final_url: string;
  title: string | null;
  description: string | null;
  language: string | null;
  format: string;
  text: string | Record<string, unknown> | null;
  links?: string[];
}

export interface FetchResponse {
  results: FetchResult[];
  errors: { url: string; error: string; status?: number }[];
}

export function fetchPages(params: FetchParams): Promise<FetchResponse> {
  return call("fetch", `${FETCH_URL}/`, {
    method: "POST",
    body: JSON.stringify({ ...params, urls: params.urls.map(normalizeUrl) }),
  });
}

// ---------- Agent ----------

export interface AgentParams {
  url: string;
  goal: string;
  output_schema?: Record<string, unknown>;
  browser_profile?: "lite" | "stealth";
  max_steps?: number;
}

export type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface AgentRun {
  run_id: string;
  status: RunStatus;
  result: unknown;
  error: { code?: string; message: string; category: string; help_message?: string } | null;
  num_of_steps: number | null;
  streaming_url?: string | null;
  steps?: { id: string; action: string; status: string }[];
}

const TERMINAL: RunStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Runs a browser agent. Uses /run-async + polling /v1/runs/{id} rather than the synchronous /run,
 * so long runs don't hit HTTP timeouts and callers can observe progress.
 */
export async function runAgent(
  params: AgentParams,
  opts: { pollMs?: number; timeoutMs?: number; onProgress?: (run: AgentRun) => void } = {},
): Promise<AgentRun> {
  const { pollMs = 3000, timeoutMs = 15 * 60_000, onProgress } = opts;
  const body = {
    url: normalizeUrl(params.url),
    goal: params.goal,
    output_schema: params.output_schema,
    browser_profile: params.browser_profile,
    agent_config: params.max_steps ? { max_steps: params.max_steps } : undefined,
    api_integration: "workflow-memory",
  };
  const started = await call<{ run_id: string | null; error: { message: string } | null }>(
    "agent:start",
    `${AGENT_URL}/v1/automation/run-async`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!started.run_id) throw new TinyFishError(`TinyFish agent failed to start: ${started.error?.message}`);

  const deadline = Date.now() + timeoutMs;
  let lastSteps = -1;
  while (true) {
    const run = await call<AgentRun>("agent:poll", `${AGENT_URL}/v1/runs/${started.run_id}?screenshots=none&html=none`);
    if (onProgress && (run.steps?.length ?? 0) !== lastSteps) {
      lastSteps = run.steps?.length ?? 0;
      onProgress(run);
    }
    if (TERMINAL.includes(run.status)) return run;
    if (Date.now() > deadline) {
      await call("agent:cancel", `${AGENT_URL}/v1/runs/${started.run_id}/cancel`, { method: "POST" }).catch(() => {});
      throw new TinyFishError(`TinyFish agent run ${started.run_id} timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
