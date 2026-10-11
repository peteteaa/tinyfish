// Resolves {{params.x}} / {{steps.id.path}} / {{previous.id.path}} / {{item.path}} inside workflow fields.
//
// - A string that is exactly one {{expr}} resolves to the raw value (keeps arrays/objects intact).
// - A string with surrounding text interpolates; non-string values are JSON-encoded.
// - Paths are dotted; numeric segments index arrays; "*" maps over an array
//   (e.g. {{steps.search.results.*.url}} -> list of urls).

export interface TemplateContext {
  params: Record<string, unknown>;
  steps: Record<string, unknown>;
  previous: Record<string, unknown>;
  item?: unknown;
}

const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^}]+?)\s*\}\}/g;

export class TemplateError extends Error {}

export function getPath(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (cur == null) return undefined;
    if (seg === "*") {
      if (!Array.isArray(cur)) return undefined;
      const rest = path.slice(i + 1);
      return cur.map((el) => getPath(el, rest));
    }
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

export function lookup(expr: string, ctx: TemplateContext): unknown {
  const [root, ...path] = expr.split(".");
  switch (root) {
    case "params":
      return getPath(ctx.params, path);
    case "steps":
      return getPath(ctx.steps, path);
    case "previous":
      return getPath(ctx.previous, path);
    case "item":
      return getPath(ctx.item, path);
    default:
      throw new TemplateError(`Unknown template root "${root}" in {{${expr}}}`);
  }
}

export function resolve<T = unknown>(value: unknown, ctx: TemplateContext): T {
  if (typeof value === "string") {
    const whole = value.match(WHOLE);
    if (whole) return lookup(whole[1], ctx) as T;
    return value.replace(ANY, (_, expr: string) => {
      const v = lookup(expr, ctx);
      if (v === undefined || v === null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)])) as T;
  }
  return value as T;
}
