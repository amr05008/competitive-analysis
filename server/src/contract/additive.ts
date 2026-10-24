// The additive-only rule, checked on two tools/list responses. A directory may
// hold an update and keep the old, approved schema in force, so every new
// output must still validate under the old schema, and every input the old
// schema accepted must still pass. A tool may gain tools, optional inputs and
// output fields. It never:
// - removes a tool, an input or an output field, or changes a field's type
// - makes an input required, or a guaranteed output optional
// - adds a value to an output's enum or const, or drops that list
// - changes or drops an output's pattern or format, or loosens or drops its
//   minimum, maximum, minLength, maxLength, minItems or maxItems
// - closes an output object to extra properties
// - removes a value from an input's enum, or adds an enum to an input
// - tightens an input's minimum, maximum, minLength, maxLength, minItems or
//   maxItems, or adds or changes its pattern or format
// - changes its annotations
// Titles and descriptions are free to change.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  additionalProperties?: unknown;
  [key: string]: unknown;
};

export type ToolListJson = {
  tools: {
    name: string;
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
    annotations?: Record<string, unknown>;
    [key: string]: unknown;
  }[];
};

type Side = "input" | "output";
type Report = (problem: string) => void;

const LOWER_BOUNDS = ["minimum", "minLength", "minItems"] as const;
const UPPER_BOUNDS = ["maximum", "maxLength", "maxItems"] as const;
const FORMATS = ["pattern", "format"] as const;

/** Throws, naming every break, unless `after` only adds to `before`. */
export function assertAdditive(before: ToolListJson, after: ToolListJson): void {
  const breaks: string[] = [];
  const afterTools = new Map(after.tools.map((t) => [t.name, t]));
  for (const was of before.tools) {
    const now = afterTools.get(was.name);
    if (!now) {
      breaks.push(`removed tool ${was.name}`);
      continue;
    }
    const report: Report = (problem) => breaks.push(`${was.name}: ${problem}`);
    compare(was.inputSchema, now.inputSchema, "input", "", report);
    if (was.outputSchema) {
      if (!now.outputSchema) report("removed its output schema");
      else compare(was.outputSchema, now.outputSchema, "output", "", report);
    }
    const wasAnnotations = canonical(was.annotations ?? {});
    const nowAnnotations = canonical(now.annotations ?? {});
    if (wasAnnotations !== nowAnnotations) report(`changed annotations from ${wasAnnotations} to ${nowAnnotations}`);
  }
  if (breaks.length > 0) throw new Error(`non-additive contract change:\n- ${breaks.join("\n- ")}`);
}

function compare(was: JsonSchema, now: JsonSchema, side: Side, path: string, report: Report): void {
  const label = path ? `${side} ${path}` : `the ${side}`;
  const wasTypes = typeSet(was);
  const nowTypes = typeSet(now);
  if (wasTypes.join("|") !== nowTypes.join("|")) {
    report(`changed the type of ${label} from ${wasTypes.join("|") || "any"} to ${nowTypes.join("|") || "any"}`);
    return;
  }
  for (const type of wasTypes) {
    const w = part(was, type);
    const n = part(now, type);
    if (!w || !n) continue;
    if (side === "output") checkOutputLimits(w, n, label, report);
    else checkInputLimits(w, n, label, report);
    if (type === "object") compareObjects(w, n, side, path, label, report);
    if (type === "array" && w.items && n.items) compare(w.items, n.items, side, `${path}[]`, report);
  }
}

function compareObjects(was: JsonSchema, now: JsonSchema, side: Side, path: string, label: string, report: Report): void {
  if (side === "output" && was.additionalProperties !== false && now.additionalProperties === false) {
    report(`closed ${label} to extra properties`);
  }
  const nowProps = now.properties ?? {};
  for (const [key, sub] of Object.entries(was.properties ?? {})) {
    const subPath = path ? `${path}.${key}` : key;
    const nowSub = nowProps[key];
    if (!nowSub) report(`removed ${side} property ${subPath}`);
    else compare(sub, nowSub, side, subPath, report);
  }
  const wasRequired = new Set(was.required ?? []);
  const nowRequired = new Set(now.required ?? []);
  const prefix = path ? `${path}.` : "";
  if (side === "input") {
    for (const key of nowRequired) if (!wasRequired.has(key)) report(`made input ${prefix}${key} required`);
  } else {
    for (const key of wasRequired) if (!nowRequired.has(key)) report(`made output ${prefix}${key} optional`);
  }
}

/**
 * Outputs: an enum or const may only shrink, and never disappear; a pattern or format may not change or
 * disappear; bounds may only tighten. Anything else lets a new output fail the old schema.
 */
function checkOutputLimits(was: JsonSchema, now: JsonSchema, label: string, report: Report): void {
  const wasValues = valuesOf(was);
  if (wasValues) {
    const nowValues = valuesOf(now);
    if (!nowValues) report(`dropped the value list of ${label}`);
    else for (const value of nowValues) if (!wasValues.includes(value)) report(`added value ${value} to ${label}`);
  }
  for (const key of LOWER_BOUNDS) {
    const w = numberAt(was, key);
    const n = numberAt(now, key);
    if (w !== undefined && (n === undefined || n < w)) report(`loosened ${key} of ${label} from ${w} to ${n ?? "none"}`);
  }
  for (const key of UPPER_BOUNDS) {
    const w = numberAt(was, key);
    const n = numberAt(now, key);
    if (w !== undefined && (n === undefined || n > w)) report(`loosened ${key} of ${label} from ${w} to ${n ?? "none"}`);
  }
  for (const key of FORMATS) {
    if (was[key] !== undefined && now[key] !== was[key]) {
      report(`${now[key] === undefined ? "dropped" : "changed"} the ${key} of ${label}`);
    }
  }
}

/** Inputs: an enum may only grow, bounds may only loosen, and no new pattern or format. */
function checkInputLimits(was: JsonSchema, now: JsonSchema, label: string, report: Report): void {
  const wasValues = valuesOf(was);
  const nowValues = valuesOf(now);
  if (nowValues) {
    if (!wasValues) report(`limited ${label} to the values ${nowValues.join(", ")}`);
    else for (const value of wasValues) if (!nowValues.includes(value)) report(`removed value ${value} from ${label}`);
  }
  for (const key of LOWER_BOUNDS) {
    const w = numberAt(was, key);
    const n = numberAt(now, key);
    if (n !== undefined && (w === undefined || n > w)) report(`tightened ${key} of ${label} from ${w ?? "none"} to ${n}`);
  }
  for (const key of UPPER_BOUNDS) {
    const w = numberAt(was, key);
    const n = numberAt(now, key);
    if (n !== undefined && (w === undefined || n < w)) report(`tightened ${key} of ${label} from ${w ?? "none"} to ${n}`);
  }
  for (const key of FORMATS) {
    if (now[key] !== undefined && now[key] !== was[key]) {
      report(`${was[key] === undefined ? "added" : "changed"} the ${key} of ${label}`);
    }
  }
}

/** The JSON types a schema allows, across anyOf/oneOf members, sorted. */
function typeSet(schema: JsonSchema): string[] {
  const types = new Set<string>();
  const visit = (s: JsonSchema) => {
    if (typeof s.type === "string") types.add(s.type);
    else if (Array.isArray(s.type)) s.type.forEach((t) => types.add(t));
    [...(s.anyOf ?? []), ...(s.oneOf ?? [])].forEach(visit);
  };
  visit(schema);
  return [...types].sort();
}

/** The schema itself, or its anyOf/oneOf member, that has the given type. */
function part(schema: JsonSchema, type: string): JsonSchema | undefined {
  const has = (s: JsonSchema) => s.type === type || (Array.isArray(s.type) && s.type.includes(type));
  if (has(schema)) return schema;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].find(has);
}

/** An enum's values, or a const as one value, each as canonical JSON. */
function valuesOf(schema: JsonSchema): string[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum.map(canonical);
  if ("const" in schema) return [canonical(schema.const)];
  return undefined;
}

function numberAt(schema: JsonSchema, key: string): number | undefined {
  const value = schema[key];
  return typeof value === "number" ? value : undefined;
}

/** JSON with sorted keys, for comparing plain values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
