// The additive-only rule, checked on two tools/list responses. A tool may gain
// optional inputs and output fields; it never loses a tool, an input or an
// output field, never changes a field's type, never makes an input required,
// never makes a guaranteed output optional, and never changes its annotations.
// Titles and descriptions are free to change.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
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
    compare(was.inputSchema, now.inputSchema, "input", "", (b) => breaks.push(`${was.name}: ${b}`));
    if (was.outputSchema) {
      if (!now.outputSchema) breaks.push(`${was.name}: removed its output schema`);
      else compare(was.outputSchema, now.outputSchema, "output", "", (b) => breaks.push(`${was.name}: ${b}`));
    }
    if (canonical(was.annotations ?? {}) !== canonical(now.annotations ?? {})) {
      breaks.push(`${was.name}: changed annotations from ${canonical(was.annotations ?? {})} to ${canonical(now.annotations ?? {})}`);
    }
  }
  if (breaks.length > 0) throw new Error(`non-additive contract change:\n- ${breaks.join("\n- ")}`);
}

function compare(was: JsonSchema, now: JsonSchema, side: Side, path: string, report: (b: string) => void): void {
  const label = path || `the ${side}`;
  const wasTypes = typesOf(was);
  const nowTypes = typesOf(now);
  if (wasTypes !== nowTypes) {
    report(`changed the type of ${side} ${label} from ${wasTypes} to ${nowTypes}`);
    return;
  }

  const wasObject = part(was, "object");
  const nowObject = part(now, "object");
  if (wasObject && nowObject) {
    const nowProps = nowObject.properties ?? {};
    for (const [key, sub] of Object.entries(wasObject.properties ?? {})) {
      const subPath = path ? `${path}.${key}` : key;
      const nowSub = nowProps[key];
      if (!nowSub) report(`removed ${side} property ${subPath}`);
      else compare(sub, nowSub, side, subPath, report);
    }
    const wasRequired = new Set(wasObject.required ?? []);
    const nowRequired = new Set(nowObject.required ?? []);
    const prefix = path ? `${path}.` : "";
    if (side === "input") {
      for (const key of nowRequired) if (!wasRequired.has(key)) report(`made input ${prefix}${key} required`);
    } else {
      for (const key of wasRequired) if (!nowRequired.has(key)) report(`made output ${prefix}${key} optional`);
    }
  }

  const wasItems = part(was, "array")?.items;
  const nowItems = part(now, "array")?.items;
  if (wasItems && nowItems) compare(wasItems, nowItems, side, `${path}[]`, report);
}

/** The JSON types a schema allows, sorted and joined, such as "null|object". */
function typesOf(schema: JsonSchema): string {
  const types = new Set<string>();
  const visit = (s: JsonSchema) => {
    if (typeof s.type === "string") types.add(s.type);
    else if (Array.isArray(s.type)) s.type.forEach((t) => types.add(t));
    [...(s.anyOf ?? []), ...(s.oneOf ?? [])].forEach(visit);
  };
  visit(schema);
  return types.size > 0 ? [...types].sort().join("|") : "any";
}

/** The schema itself, or its anyOf/oneOf member, that has the given type. */
function part(schema: JsonSchema, type: "object" | "array"): JsonSchema | undefined {
  const has = (s: JsonSchema) => s.type === type || (Array.isArray(s.type) && s.type.includes(type));
  if (has(schema)) return schema;
  return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].find(has);
}

/** JSON with sorted keys, for comparing plain values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
