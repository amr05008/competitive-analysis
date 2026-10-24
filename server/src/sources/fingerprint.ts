export type Fingerprint = {
  title: string;
  description: string;
  headline: string;
  subheadings: string[];
  prices: string[];
  readable: boolean;
};

const SKIP = "script, style, noscript, template, svg";
const PRICE =
  /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kKmM])?(?:\s?(?:\/|per)\s?(?:month|mo|year|yr|user|seat|member))?/gi;
const MAX_SUBHEADINGS = 3;
const MAX_PRICES = 8;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s: string, max: number): string => decode(s).replace(/\s+/g, " ").trim().slice(0, max);

function pricesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PRICE)) {
    const before = text.slice(Math.max(0, m.index - 80), m.index).trim().split(/\s+/).filter(Boolean).slice(-3);
    const words = [...before, m[0].replace(/\s+/g, " ")];
    while (words.length > 1 && words.join(" ").length > 60) words.shift();
    const s = words.join(" ").slice(-60);
    if (!out.includes(s)) out.push(s);
    if (out.length >= MAX_PRICES) break;
  }
  return out;
}

/** The parts of a page's copy that mark a marketing change; text in scripts, styles and templates never counts. */
export async function extractFingerprint(html: string): Promise<Fingerprint> {
  let skip = 0;
  let title = "";
  let titleDone = false;
  let description = "";
  let ogDescription = "";
  let headline = "";
  const subheadings: string[] = [];
  let body = "";
  let heading: { tag: string; text: string } | null = null;

  const onEnd = (el: { onEndTag?: (h: () => void) => void }, fn: () => void) => {
    try {
      el.onEndTag?.(fn);
    } catch {
      // void or self-closing element: nothing to close
    }
  };

  const rewriter = new HTMLRewriter()
    .on(SKIP, {
      element(el) {
        skip++;
        onEnd(el, () => {
          skip--;
        });
      },
    })
    .on("meta", {
      element(el) {
        const content = el.getAttribute("content") ?? "";
        const name = (el.getAttribute("name") ?? "").toLowerCase();
        const prop = (el.getAttribute("property") ?? "").toLowerCase();
        if (name === "description" && !description) description = content;
        if (prop === "og:description" && !ogDescription) ogDescription = content;
      },
    })
    .on("title", {
      element(el) {
        if (skip || titleDone) return;
        title = "";
        onEnd(el, () => {
          titleDone = true;
        });
      },
      text(t) {
        if (!skip && !titleDone) title += t.text;
      },
    })
    .on("h1, h2", {
      element(el) {
        if (skip) return;
        const tag = el.tagName;
        heading = { tag, text: "" };
        onEnd(el, () => {
          const h = heading;
          heading = null;
          if (!h) return;
          const text = squash(h.text, 200);
          if (!text) return;
          if (h.tag === "h1") headline ||= text;
          else if (subheadings.length < MAX_SUBHEADINGS) subheadings.push(text);
        });
      },
    })
    .on("*", {
      text(t) {
        if (skip) return;
        body += t.text;
        if (heading) heading.text += t.text;
        if (t.lastInTextNode) {
          body += " ";
          if (heading) heading.text += " ";
        }
      },
    });

  await rewriter.transform(new Response(html)).text();

  const fp = {
    title: squash(title, 200),
    description: squash(description || ogDescription, 300),
    headline: squash(headline, 200),
    subheadings,
    prices: pricesIn(decode(body).replace(/\s+/g, " ")),
  };
  return { ...fp, readable: Boolean(fp.title || fp.headline || fp.subheadings.length) };
}

/** A comparison key: two pages with the same key have the same copy, ignoring case and spacing. */
export function copyKey(fp: Fingerprint): string {
  return JSON.stringify([fp.title, fp.description, fp.headline, fp.subheadings, fp.prices])
    .toLowerCase()
    .replace(/\s+/g, " ");
}
