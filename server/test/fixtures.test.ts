import { describe, expect, it } from "vitest";

const files = import.meta.glob("./fixtures/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("fixtures", () => {
  it("are found", () => {
    expect(Object.keys(files).length).toBeGreaterThan(5);
  });

  it("HN fixtures carry only placeholder authors", () => {
    let seen = 0;
    for (const [path, text] of Object.entries(files)) {
      for (const m of text.matchAll(/"author"\s*:\s*"([^"]*)"/g)) {
        seen++;
        expect(m[1], path).toMatch(/^user\d+$/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("Form D fixtures carry only placeholder people", () => {
    let seen = 0;
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith(".xml")) continue;
      for (const m of text.matchAll(/<(firstName|middleName|lastName|nameOfSigner|signatureName|recipientName)>([^<]*)<\/\1>/g)) {
        seen++;
        expect(m[2], `${path} ${m[1]}`).toMatch(/^(Person( [A-Z])?|[A-Z])$/);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
