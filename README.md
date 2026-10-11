# workflow-memory (starter)

Agents shouldn't solve the same web task twice. An agent solves a web task once with TinyFish, the result is
compiled into a saved, parameterized workflow, and anyone (human or agent) can rerun it faster and cheaper.

## Setup

    npm install
    cp .env.example .env   # add TINYFISH_API_KEY and GEMINI_API_KEY

Requires Node 22.13+ (uses the built-in `node:sqlite`).

There is no mock mode: every run calls the real TinyFish and Gemini APIs.

## Commands

    # Run the hand-written seed workflow (start here)
    npm run run-wf -- competitor_pricing --competitors=yourtestsite.com/pricing,example.com/pricing

    # Learn a new workflow from a plain-English goal (--run: run it right after saving)
    npm run learn -- "Get the pricing plans for firecrawl.dev and browserbase.com"

    npm run list
    npm run show -- competitor_pricing          # --version=N, --trace
    npm run runs -- competitor_pricing          # run history
    npx tsx src/cli.ts save my_workflow.json    # save a hand-written workflow as the next version

    npm test          # unit tests plus live TinyFish/Gemini tests (each skipped when its key is missing)
    npm run typecheck

    npm run web:build && PORT=3000 npm run web:start   # web app (M0: library page + /api/health)
    PORT=3000 npm run web:dev

TinyFish is the only web layer: `src/tinyfish.ts` is the only module that calls out to the web, and Gemini never
gets its built-in web tools. `test/web-boundary.test.ts` fails the build if anything else reaches the web or
imports a scraping, browser or other LLM library.

Results go to stdout as JSON and progress goes to stderr, so `npm run -s run-wf -- ... > out.json` works.
Exit code is 1 when a run errors or a check fails.

## Use from Claude Desktop / Cursor (MCP)

    {
      "mcpServers": {
        "workflow-memory": {
          "command": "npx",
          "args": ["tsx", "/absolute/path/to/workflow-memory/src/mcp.ts"],
          "env": { "TINYFISH_API_KEY": "...", "GEMINI_API_KEY": "..." }
        }
      }
    }

Tools: list_workflows, run_workflow, learn_workflow, save_workflow, get_workflow.
(The server also reads `.env` from the project root, so `env` can be omitted.)

## How it works

**learn** = explore, then compile.

1. **Explore** (`src/explore.ts`): Gemini solves the goal with four tools, `tinyfish_search`, `tinyfish_fetch`,
   `tinyfish_agent` and `submit_answer`, and is told to prefer the free Search and Fetch APIs over the browser agent.
   Every call is recorded in `data/traces/<id>.json`.
2. **Compile** (`src/compile.ts`): Gemini gets the trace and writes a workflow. Concrete values become params whose
   defaults reproduce the original task. Dead ends are dropped, URLs are batched, and fetch + extract replaces
   the agent where possible. Checks are added. The draft goes through `validateWorkflow`; on failure the errors go
   back to Gemini to fix (up to 3 attempts).
3. **Run** (`src/executor.ts`): deterministic. Steps run in order, with no LLM in the loop except inside `extract`
   steps. Checks run on every output, and the run is saved to `data/runs/<name>/`.

### Workflow format

```jsonc
{
  "name": "competitor_pricing",
  "description": "...",
  "params": { "competitors": { "type": "string[]", "description": "...", "required": true } },
  "steps": [
    { "id": "fetch_pages", "type": "fetch", "urls": "{{params.competitors}}",
      "checks": [{ "type": "min_items", "path": "results", "value": 1 }] },
    { "id": "extract_plans", "type": "extract", "forEach": "{{steps.fetch_pages.results}}",
      "input": "{{item.text}}", "instruction": "Extract every pricing plan...", "output_schema": { ... } }
  ],
  "output": { "pricing": "{{steps.extract_plans}}" }
}
```

| Step | Calls | Output |
|---|---|---|
| `search` | TinyFish Search (free) | `{query, results: [{title, url, snippet}]}` |
| `fetch` | TinyFish Fetch (free) | `{results: [{url, final_url, title, text}], errors}` |
| `agent` | TinyFish Agent (credits) | the agent's `result` |
| `extract` | Gemini (`gemini-3.5-flash-lite`), JSON schema output | JSON matching `output_schema` |

Any step can take `forEach` (runs once per array element, bound to `{{item}}`), `concurrency` (default 4)
and `checks` (`not_empty`, `min_items`, `required_keys`, `regex`, each with an optional dotted `path`).

Templates (`src/template.ts`): `{{params.x}}`, `{{steps.<id>.<path>}}`, `{{previous.<id>.<path>}}` (that step's output
from the last *successful* run, for change detection), `{{item.<path>}}`. A string made of a single `{{...}}` keeps
the raw value (array or object). Mixed strings interpolate. `*` maps over arrays: `{{steps.s.results.*.url}}`.

Run statuses: `ok`, `check_failed` (finished, but a check flagged it for repair), `error` (a step threw; the run stops).

## Layout

    src/schema.ts     workflow format (zod) + reference validation
    src/template.ts   {{params.x}} / {{steps.id}} / {{previous.id}} / {{item}} resolution
    src/tinyfish.ts   Search / Fetch / Agent wrappers
    src/llm.ts        Gemini client (reasoning only, no web tools) + the extract step
    src/executor.ts   deterministic runner + checks + run history
    src/explore.ts    phase 1: Gemini + TinyFish tools, records a trace
    src/compile.ts    phase 2: trace -> reusable workflow JSON; learn() = explore + compile + save
    src/store.ts      storage facade: versioned workflows (with source), run history, traces, diff
    src/store/        SQLite (default, node:sqlite) and JSON-file backends; STORAGE=sqlite|files
    src/env.ts        .env loading, paths, config
    src/cli.ts        CLI
    src/mcp.ts        MCP server (stdio)
    seeds/            hand-written workflows, copied into data/ as v1 on first use
    web/              Next.js app (App Router, webpack; imports core through @core/*)
    test/             unit tests, live TinyFish test, store tests (both backends), web-boundary check

## TinyFish API notes (checked against the live API, 2026-10-11)

- Search and Fetch response shapes match `src/tinyfish.ts`. Fetch reports per-URL failures in `errors[]`
  (e.g. `{ error: "page_not_found", status: 404 }`) while the request itself succeeds.
- Agent calls use `POST /v1/automation/run-async`, then poll `GET /v1/runs/{id}` until the status is
  `COMPLETED`/`FAILED`/`CANCELLED` (not the synchronous `/run`, so long runs don't hit HTTP timeouts).
  `result` follows the `output_schema` you pass.
- `agent_config.max_steps` returns 403 unless the TinyFish account is in their beta program, so agent steps
  should leave `max_steps` unset.
- Set `WM_DEBUG=1` to log raw responses.

## Next

- repair.ts: when a check fails, re-explore just that step, recompile it, save as a new version
  (`source.repaired_from` is already in the schema; failed checks are in each run record).
- A fake competitor site you control, for a reliable repair demo.
- Web UI with live step progress. `runWorkflow` already emits `onEvent` step events and `runAgent` takes
  `onProgress`; wire those to SSE.
