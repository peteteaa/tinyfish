// Fault injection: the ways a site change breaks a saved workflow, applied to the workflow so the breakage is the same
// every time. The pages are still real; only where the workflow looks changes.
//   url_moved        the page moved and its old URL now 404s
//   redirected_home  the old URL now lands on the site's homepage, which doesn't have the data
//   field_renamed    upstream output changed shape: an extract step's input reads a field that is no longer there
// Each returns the broken workflow, or null when the workflow has nothing the fault applies to.

import type { Workflow } from "../schema.js";

export type FaultName = "url_moved" | "redirected_home" | "field_renamed";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function moveUrl(u: string): string {
  const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
  const p = url.pathname.replace(/\/+$/, "");
  url.pathname = p ? `${p.replace(/(\.html?)$/, "")}-old${p.match(/\.html?$/)?.[0] ?? ""}` : "/home-old";
  return url.toString();
}

function homeUrl(u: string): string | null {
  const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
  return url.pathname.replace(/\/+$/, "") ? url.origin + "/" : null;
}

/** Rewrites the first URL a fetch or agent step reads (a literal, or the default of the param it reads). */
function rewriteFirstUrl(wf: Workflow, rewrite: (u: string) => string | null): Workflow | null {
  const out = clone(wf);
  for (const step of out.steps) {
    if (step.type !== "fetch" && step.type !== "agent") continue;
    const target = step.type === "fetch" ? step.urls : step.url;
    // Only a param that is the whole URL ("{{params.x}}"), not part of one ("https://{{params.domain}}/pricing").
    const refs = [...JSON.stringify(target).matchAll(/"\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}"/gi)].map((m) => m[1]);
    for (const name of refs) {
      const param = out.params[name];
      const def = param?.default;
      if (typeof def === "string" && def) {
        const next = rewrite(def.split(",")[0].trim());
        if (!next) return null;
        param.default = [next, ...def.split(",").slice(1)].join(",");
        return out;
      }
      if (Array.isArray(def) && typeof def[0] === "string") {
        const next = rewrite(def[0]);
        if (!next) return null;
        param.default = [next, ...def.slice(1)];
        return out;
      }
    }
    const literal = (urls: unknown): unknown => {
      if (typeof urls === "string" && !urls.includes("{{")) return rewrite(urls);
      if (Array.isArray(urls)) {
        const i = urls.findIndex((u) => typeof u === "string" && !u.includes("{{"));
        if (i < 0) return null;
        const next = rewrite(urls[i] as string);
        return next ? urls.map((u, j) => (j === i ? next : u)) : null;
      }
      return null;
    };
    const next = literal(target);
    if (next) {
      if (step.type === "fetch") step.urls = next as typeof step.urls;
      else step.url = next as string;
      return out;
    }
  }
  return null;
}

function renameField(wf: Workflow): Workflow | null {
  const out = clone(wf);
  let changed = false;
  for (const step of out.steps) {
    if (step.type !== "extract") continue;
    const next = step.input.replace(/(\{\{[^}]*?)\.text(\s*\}\})/g, "$1.body$2");
    if (next !== step.input) {
      step.input = next;
      changed = true;
    }
  }
  return changed ? out : null;
}

export const FAULTS: Record<FaultName, (wf: Workflow) => Workflow | null> = {
  url_moved: (wf) => rewriteFirstUrl(wf, moveUrl),
  redirected_home: (wf) => rewriteFirstUrl(wf, homeUrl),
  field_renamed: renameField,
};
