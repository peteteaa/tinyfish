// Grading for the benchmark: one set of expectations per task, applied the same way to a raw agent's answer and to a
// replayed workflow's output. The two have different shapes (the agent picks its own JSON, the workflow follows its
// output template), so expectations look at content, not paths: strings that must appear, patterns that must match
// often enough, and a list of records with the right kinds of fields somewhere in the value.

export type Expectation =
  /** Every value appears somewhere (case-insensitive), in a key or a value. */
  | { type: "contains"; values: string[] }
  /** The pattern matches at least `min` times across all keys and values. */
  | { type: "pattern"; pattern: string; min: number }
  /**
   * Some array holds at least `min` objects that each have, for every entry in `fields`, a non-empty value under a key
   * matching that regex (case-insensitive), e.g. ["title|name|role", "location"].
   */
  | { type: "records"; min: number; fields?: string[] };

export interface ExpectationResult {
  expectation: string;
  passed: boolean;
  detail: string;
}

export interface Grade {
  passed: boolean;
  results: ExpectationResult[];
}

/**
 * Strings holding JSON objects or arrays are parsed: agents sometimes return each record as a JSON string. Grading
 * is generous to both modes so a failure means missing data, not formatting.
 */
function unwrap(value: unknown): unknown {
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return unwrap(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
  return value;
}

function leaves(value: unknown, out: string[] = []): string[] {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => leaves(v, out));
  else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      leaves(v, out);
    }
  }
  return out;
}

function arraysOfObjects(value: unknown, out: Record<string, unknown>[][] = []): Record<string, unknown>[][] {
  if (Array.isArray(value)) {
    const objects = value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
    if (objects.length) out.push(objects);
    value.forEach((v) => arraysOfObjects(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => arraysOfObjects(v, out));
  }
  return out;
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function describeExpectation(e: Expectation): string {
  switch (e.type) {
    case "contains":
      return `contains ${e.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "pattern":
      return `/${e.pattern}/ x${e.min}`;
    case "records":
      return `${e.min}+ records${e.fields?.length ? ` with ${e.fields.join(", ")}` : ""}`;
  }
}

export function gradeOutput(raw: unknown, expectations: Expectation[]): Grade {
  const output = unwrap(raw);
  const text = leaves(output).join("\n");
  const results = expectations.map((e): ExpectationResult => {
    const expectation = describeExpectation(e);
    switch (e.type) {
      case "contains": {
        const lower = text.toLowerCase();
        const missing = e.values.filter((v) => !lower.includes(v.toLowerCase()));
        return { expectation, passed: !missing.length, detail: missing.length ? `missing ${missing.join(", ")}` : "all present" };
      }
      case "pattern": {
        const n = text.match(new RegExp(e.pattern, "gi"))?.length ?? 0;
        return { expectation, passed: n >= e.min, detail: `${n} matches` };
      }
      case "records": {
        const fields = (e.fields ?? []).map((f) => new RegExp(f, "i"));
        const complete = (o: Record<string, unknown>) =>
          fields.every((re) => Object.entries(o).some(([k, v]) => re.test(k) && filled(v)));
        const best = Math.max(0, ...arraysOfObjects(output).map((arr) => arr.filter(complete).length));
        return { expectation, passed: best >= e.min, detail: `largest list has ${best} complete records` };
      }
    }
  });
  return { passed: output != null && results.every((r) => r.passed), results };
}
