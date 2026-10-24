/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { assertAdditive, type ToolListJson } from "../src/contract/additive";
import { TOOL_NAMES } from "../src/contract/tools";
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
});
