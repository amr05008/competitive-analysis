/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { assertAdditive, type JsonSchema, type ToolListJson } from "../src/contract/additive";
import { errorResult, type ErrorReason } from "../src/contract/envelope";
import { TOOL_NAMES, type JobOpeningsResult } from "../src/contract/tools";
import { rpc } from "./helpers/mcp";

const SNAPSHOT = "./__snapshots__/tools-list.json";

// The committed snapshot, read when this file loads: before the snapshot test
// below can rewrite it, so a `vitest run -u` that makes a breaking change still
// fails here. import.meta.glob gives {} when the file doesn't exist yet; the
// first run then writes it and the additive test fails once, asking for a rerun.
const committed = import.meta.glob<ToolListJson>("./__snapshots__/tools-list.json", {
  eager: true,
  import: "default",
})[SNAPSHOT];

const READ_ONLY_OPEN_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

describe("tools/list", () => {
  it("lists exactly the four tools", async () => {
    const list: ToolListJson = await rpc("tools/list");
    expect(list.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("every tool is read-only and open-world", async () => {
    const list: ToolListJson = await rpc("tools/list");
    for (const tool of list.tools) expect(tool.annotations, tool.name).toEqual(READ_ONLY_OPEN_WORLD);
  });

  it("every tool declares an output schema", async () => {
    const list: ToolListJson = await rpc("tools/list");
    for (const tool of list.tools) expect(tool.outputSchema?.type, tool.name).toBe("object");
  });

  it("the tool list matches the committed snapshot", async () => {
    const list: ToolListJson = await rpc("tools/list");
    await expect(JSON.stringify(list, null, 2)).toMatchFileSnapshot(SNAPSHOT);
  });

  // A failure here means the change breaks the approved contract, so it waits
  // for a new plugin version (a new tool, reviewed again). Never silence it
  // with -u.
  it("the committed snapshot to now is additive", async () => {
    expect(committed, `no committed snapshot at test/${SNAPSHOT.slice(2)}; run the tests again`).toBeDefined();
    const current: ToolListJson = await rpc("tools/list");
    expect(() => assertAdditive(committed!, current)).not.toThrow();
  });
});

describe("assertAdditive", () => {
  const before = (): ToolListJson => ({
    tools: [
      {
        name: "page_history",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" }, from: { type: "string" } },
          required: ["url"],
        },
        outputSchema: {
          type: "object",
          properties: {
            status: { type: "string" },
            first_capture: {
              anyOf: [
                { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
                { type: "null" },
              ],
            },
            changes: {
              type: "array",
              items: { type: "object", properties: { days_between: { type: "integer" } } },
            },
          },
          required: ["status"],
        },
        annotations: { ...READ_ONLY_OPEN_WORLD },
      },
      {
        name: "job_openings",
        inputSchema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
        annotations: { ...READ_ONLY_OPEN_WORLD },
      },
    ],
  });
  const tool = (list: ToolListJson) => list.tools[0]!;
  const input = (list: ToolListJson) => tool(list).inputSchema.properties!;
  const output = (list: ToolListJson) => tool(list).outputSchema!.properties!;

  it("removing a tool throws", () => {
    const after = before();
    after.tools.shift();
    expect(() => assertAdditive(before(), after)).toThrow(/removed tool page_history/);
  });

  it("removing an input property throws", () => {
    const after = before();
    delete input(after).from;
    expect(() => assertAdditive(before(), after)).toThrow(/from/);
  });

  it("changing a property's type throws", () => {
    const after = before();
    input(after).url = { type: "number" };
    expect(() => assertAdditive(before(), after)).toThrow(/url/);
  });

  it("adding a name to required throws", () => {
    const after = before();
    tool(after).inputSchema.required = ["url", "from"];
    expect(() => assertAdditive(before(), after)).toThrow(/from/);
  });

  it("removing an output property throws", () => {
    const after = before();
    delete output(after).changes;
    expect(() => assertAdditive(before(), after)).toThrow(/changes/);
  });

  it("removing a nested output property throws", () => {
    const after = before();
    delete output(after).changes!.items!.properties!.days_between;
    expect(() => assertAdditive(before(), after)).toThrow(/days_between/);
  });

  it("removing a field of a nullable output object throws", () => {
    const after = before();
    delete output(after).first_capture!.anyOf![0]!.properties!.date;
    expect(() => assertAdditive(before(), after)).toThrow(/first_capture\.date/);
  });

  it("making a required output optional throws", () => {
    const after = before();
    tool(after).outputSchema!.required = [];
    expect(() => assertAdditive(before(), after)).toThrow(/status/);
  });

  it("changing an annotation throws", () => {
    const after = before();
    tool(after).annotations = { ...READ_ONLY_OPEN_WORLD, idempotentHint: false };
    expect(() => assertAdditive(before(), after)).toThrow(/annotations/);
  });

  it("adding an optional input passes", () => {
    const after = before();
    input(after).to = { type: "string" };
    expect(() => assertAdditive(before(), after)).not.toThrow();
  });

  it("adding an output property passes", () => {
    const after = before();
    output(after).fetches_used = { type: "integer" };
    expect(() => assertAdditive(before(), after)).not.toThrow();
  });

  it("changing a description passes", () => {
    const after = before();
    tool(after).description = "Something else.";
    input(after).url = { type: "string", description: "A new description." };
    expect(() => assertAdditive(before(), after)).not.toThrow();
  });

  it("adding a tool passes", () => {
    const after = before();
    after.tools.push({ name: "new_tool", inputSchema: { type: "object" }, annotations: {} });
    expect(() => assertAdditive(before(), after)).not.toThrow();
  });

  // A list with one extra input or output property, `kind`, set to `schema`.
  const withInput = (schema: JsonSchema) => {
    const list = before();
    input(list).kind = schema;
    return list;
  };
  const withOutput = (schema: JsonSchema) => {
    const list = before();
    output(list).kind = schema;
    return list;
  };
  const check = (was: ToolListJson, now: ToolListJson) => () => assertAdditive(was, now);

  describe("outputs must still validate under the old schema", () => {
    it("adding a value to an output enum throws", () => {
      const was = withOutput({ type: "string", enum: ["ok", "error"] });
      const now = withOutput({ type: "string", enum: ["ok", "error", "partial"] });
      expect(check(was, now)).toThrow(/added value "partial" to output kind/);
    });

    it("dropping an output enum throws", () => {
      const was = withOutput({ type: "string", enum: ["posted", "updated"] });
      expect(check(was, withOutput({ type: "string" }))).toThrow(/dropped the value list of output kind/);
    });

    it("changing an output const throws", () => {
      const was = withOutput({ type: "string", const: "fall back to browsing for this check." });
      const now = withOutput({ type: "string", const: "something else" });
      expect(check(was, now)).toThrow(/added value "something else" to output kind/);
    });

    it("an enum inside a nullable output is checked too", () => {
      const was = withOutput({ anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] });
      const now = withOutput({ anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] });
      expect(check(was, now)).toThrow(/added value "b" to output kind/);
    });

    it("removing a value from an output enum passes", () => {
      const was = withOutput({ type: "string", enum: ["ok", "partial", "error"] });
      const now = withOutput({ type: "string", enum: ["ok", "error"] });
      expect(check(was, now)).not.toThrow();
    });

    it("closing an output to extra properties throws", () => {
      const now = before();
      tool(now).outputSchema!.additionalProperties = false;
      expect(check(before(), now)).toThrow(/closed the output to extra properties/);
    });
  });

  describe("inputs the old schema accepted must still pass", () => {
    it("removing a value from an input enum throws", () => {
      const was = withInput({ type: "string", enum: ["story", "comment"] });
      expect(check(was, withInput({ type: "string", enum: ["story"] }))).toThrow(
        /removed value "comment" from input kind/,
      );
    });

    it("adding an enum to an input throws", () => {
      const now = withInput({ type: "string", enum: ["story"] });
      expect(check(withInput({ type: "string" }), now)).toThrow(/limited input kind to the values "story"/);
    });

    it("adding a value to an input enum passes", () => {
      const was = withInput({ type: "string", enum: ["story"] });
      expect(check(was, withInput({ type: "string", enum: ["story", "comment"] }))).not.toThrow();
    });

    it.each<[string, JsonSchema, JsonSchema]>([
      ["minimum", { type: "integer", minimum: 1 }, { type: "integer", minimum: 2 }],
      ["maximum", { type: "integer", maximum: 15 }, { type: "integer", maximum: 10 }],
      ["minLength", { type: "string", minLength: 2 }, { type: "string", minLength: 3 }],
      ["maxLength", { type: "string", maxLength: 80 }, { type: "string", maxLength: 40 }],
      ["minItems", { type: "array", items: { type: "string" } }, { type: "array", items: { type: "string" }, minItems: 1 }],
      ["maxItems", { type: "array", items: { type: "string" }, maxItems: 5 }, { type: "array", items: { type: "string" }, maxItems: 3 }],
    ])("tightening an input's %s throws", (key, was, now) => {
      expect(check(withInput(was), withInput(now))).toThrow(new RegExp(`tightened ${key} of input kind`));
    });

    it("loosening input bounds passes", () => {
      const was = withInput({ type: "string", minLength: 2, maxLength: 80 });
      expect(check(was, withInput({ type: "string", minLength: 1 }))).not.toThrow();
    });

    it("adding an input pattern throws", () => {
      const now = withInput({ type: "string", pattern: "^\\d{4}$" });
      expect(check(withInput({ type: "string" }), now)).toThrow(/added the pattern of input kind/);
    });

    it("changing an input pattern throws", () => {
      const was = withInput({ type: "string", pattern: "^\\d{4}-\\d{2}$" });
      const now = withInput({ type: "string", pattern: "^\\d{4}$" });
      expect(check(was, now)).toThrow(/changed the pattern of input kind/);
    });

    it("adding an input format throws", () => {
      const now = withInput({ type: "string", format: "uri" });
      expect(check(withInput({ type: "string" }), now)).toThrow(/added the format of input kind/);
    });
  });

  it("reports every break in one error", () => {
    const now = before();
    delete input(now).from;
    tool(now).annotations = {};
    expect(check(before(), now)).toThrow(/removed input property from[\s\S]*changed annotations/);
  });
});

describe("result types", () => {
  it("are closed: a misspelled field or an unknown value doesn't compile", () => {
    // `npm run typecheck` fails if any of these stop being errors.
    const result: JobOpeningsResult = {
      status: "ok",
      notes: [],
      retrieved_at: "2026-10-20",
      board: {
        // @ts-expect-error board services are a closed union in TypeScript
        ats: "workday",
        slug: "example",
        url: "https://example.com/jobs",
      },
      roles: [
        {
          id: "1",
          title: "Engineer",
          department: null,
          location: null,
          date: null,
          date_kind: "posted",
          pay: null,
          link: "https://example.com/jobs/1",
          // @ts-expect-error a misspelled nested field
          descripton: "A typo for description.",
        },
      ],
    };
    // @ts-expect-error error reasons are a closed union in TypeScript
    const reason: ErrorReason = "something_else";
    expect(result.roles).toHaveLength(1);
    expect(reason).toBe("something_else");
  });
});

describe("errorResult", () => {
  it("stamps retrieved_at from the clock it's given", () => {
    const result = errorResult("not_found", "no board", ["https://example.com/careers"], Date.UTC(2026, 9, 20, 23, 59));
    expect(result.retrieved_at).toBe("2026-10-20");
    expect(result.error).toEqual({
      reason: "not_found",
      detail: "no board",
      tried: ["https://example.com/careers"],
      fallback: "fall back to browsing for this check.",
    });
  });

  it("defaults to the current time", () => {
    expect(errorResult("bad_input", "x", []).retrieved_at).toBe(new Date().toISOString().slice(0, 10));
  });
});
