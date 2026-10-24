import { describe, expect, it } from "vitest";
import { copyKey, extractFingerprint } from "../../src/sources/fingerprint";
import capture from "../fixtures/wayback/capture-hightouch-pricing.html?raw";

const page = (price = "$350/month") => `<html><head><title>Acme — Pricing</title>
<meta name="description" content="Plans for teams"></head><body>
<h1>Simple pricing</h1><h2>Starter</h2><h2>Pro</h2><h2>Enterprise</h2><h2>FAQ</h2>
<p>Pro is ${price} billed yearly</p><script>var x="$999"</script></body></html>`;

describe("extractFingerprint", () => {
  it("reads title, description, headline, subheadings and prices", async () => {
    const fp = await extractFingerprint(page());
    expect(fp.title).toBe("Acme — Pricing");
    expect(fp.description).toBe("Plans for teams");
    expect(fp.headline).toBe("Simple pricing");
    expect(fp.subheadings).toEqual(["Starter", "Pro", "Enterprise"]);
    expect(fp.prices.some((p) => p.includes("$350/month"))).toBe(true);
    expect(fp.prices.some((p) => p.includes("$999"))).toBe(false);
    expect(fp.readable).toBe(true);
  });

  it("uses og:description when meta description is missing", async () => {
    const fp = await extractFingerprint(
      `<title>T</title><meta property="og:description" content="From OG"><h1>H</h1>`,
    );
    expect(fp.description).toBe("From OG");
  });

  it("is unreadable for an empty app shell and for PDF bytes", async () => {
    expect((await extractFingerprint(`<div id="root"></div>`)).readable).toBe(false);
    expect((await extractFingerprint("%PDF-1.7\n1 0 obj")).readable).toBe(false);
  });

  it("reads prices from the first 200,000 characters of body text only", async () => {
    const filler = `<p>${"word ".repeat(40_000)}</p>`; // 200,000 characters of text
    const fp = await extractFingerprint(`<title>T</title><h1>H</h1><p>Starter $10/month</p>${filler}<p>Pro $99/month</p>`);
    expect(fp.prices.some((p) => p.includes("$10/month"))).toBe(true);
    expect(fp.prices.some((p) => p.includes("$99/month"))).toBe(false);
    expect(fp.headline).toBe("H");
  });

  it("still reads headings after the body-text cap", async () => {
    const fp = await extractFingerprint(`<title>T</title><p>${"word ".repeat(50_000)}</p><h1>Late headline</h1><h2>Late section</h2>`);
    expect(fp.headline).toBe("Late headline");
    expect(fp.subheadings).toEqual(["Late section"]);
  });

  it("reads the recorded capture", async () => {
    const fp = await extractFingerprint(capture);
    expect(fp.readable).toBe(true);
    expect(fp.title).not.toBe("");
    expect(fp.prices.length).toBeGreaterThan(0);
  });
});

describe("copyKey", () => {
  it("ignores case and whitespace", async () => {
    const a = await extractFingerprint(page());
    const b = await extractFingerprint(page().toUpperCase().replace(/<SCRIPT>.*<\/SCRIPT>/, "").replace(/ /g, "  "));
    expect(copyKey(a)).toBe(copyKey(b));
  });

  it("changes when a price changes", async () => {
    expect(copyKey(await extractFingerprint(page("$350/month")))).not.toBe(
      copyKey(await extractFingerprint(page("$400/month"))),
    );
  });
});
