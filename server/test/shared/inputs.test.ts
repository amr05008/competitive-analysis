import { describe, expect, it } from "vitest";
import { cleanCompanyName, normalizeDomain, normalizePageUrl } from "../../src/shared/inputs";

const BAD = ["127.0.0.1", "http://10.0.0.5/", "localhost:8787", "[::1]", "https://user:pw@x.com", "x.com:8443", "ftp://x.com", "intranet", "", "2130706433", "0x7f.0.0.1", "[::ffff:127.0.0.1]", "localhost", "localhost.", "localhost..", "http://localhost../", "127.0.0.1..", "x.internal..", "a.local.."];

describe("normalizePageUrl", () => {
  it.each(["hightouch.com/pricing", "https://www.hightouch.com/pricing/", "HTTP://Hightouch.com/pricing?ref=x#top"])("normalizes %s", (s) => {
    expect(normalizePageUrl(s)).toEqual({ ok: true, url: "https://hightouch.com/pricing", cdxKey: "hightouch.com/pricing" });
  });
  it.each(["https://hightouch.com", "https://hightouch.com/"])("root %s", (s) => {
    expect(normalizePageUrl(s)).toMatchObject({ ok: true, cdxKey: "hightouch.com" });
  });
  it.each(BAD)("rejects %j", (s) => {
    expect(normalizePageUrl(s).ok).toBe(false);
  });
  it("rejects internal suffixes", () => {
    for (const s of ["a.local", "a.internal", "a.localhost", "foo.localhost"]) expect(normalizePageUrl(s).ok).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("extracts the domain", () => {
    expect(normalizeDomain("https://www.ZeroClick.ai/about")).toEqual({ ok: true, domain: "zeroclick.ai" });
  });
  it.each(BAD)("rejects %j", (s) => {
    expect(normalizeDomain(s).ok).toBe(false);
  });
});

describe("cleanCompanyName", () => {
  it.each([
    ["Carry Technologies, Inc.", "Carry Technologies"],
    ["Acme Labs LLC", "Acme Labs"],
    ["  Zero   Click ", "Zero Click"],
    ["AT&T", "AT&T"],
    ["Acme Co., Ltd.", "Acme"],
    ["Costco", "Costco"],
    ["Incorporated Labs", "Incorporated Labs"],
    ["Foo plc", "Foo"],
    ["Bar GmbH", "Bar"],
    ["Baz PBC", "Baz"],
    ["Qux Corporation", "Qux"],
  ])("%j -> %j", (a, b) => {
    expect(cleanCompanyName(a)).toBe(b);
  });
});
