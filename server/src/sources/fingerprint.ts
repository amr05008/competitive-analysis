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
  /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kKmM]\b)?(?:\s?(?:\/|per)\s?(?:month|mo|year|yr|user|seat|member))?/gi;
/** A figure is a price only with one of these words within CUE_WORDS of it, or a per-period suffix of its own. */
const PRICING =
  /^(?:fees?|setup|pricing|prices?|plans?|per|monthly|months?|mo|annual(?:ly)?|year(?:ly)?|yr|billed|seats?|free|trial|subscriptions?|licen[cs]es?|costs?|charges?|charged|tiers?|starts?|starting|credits?)$/i;
/** ...and never with one of these within CONTEXT_WORDS: funding banners and revenue dashboards. */
const NOT_PRICING = /^(?:raises?|raised|raising|funding|funded|valuation|revenue)$/i;
const CUE_WORDS = 5;
const CONTEXT_WORDS = 3;
const MAX_SUBHEADINGS = 3;
const MAX_PRICES = 8;
/** Prices are read from this much of a page's body text: a long page's pricing comes early, and the rest costs CPU. */
const BODY_MAX_CHARS = 200_000;

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

const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean);
const bare = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
/** One amount however it's spaced or cased: "$350 Per month" and "$350/month" are the same. */
const amountKey = (figure: string) => figure.toLowerCase().replace(/\s+/g, "").replace("per", "/");

/**
 * Each amount once, in page order, with up to CONTEXT_WORDS words on each side. The context never
 * reaches a neighbouring figure, so each entry holds exactly one, which copyKey relies on. Words are
 * read across element boundaries, so a figure just before a pricing sentence can pass as a price.
 */
function pricesIn(text: string): string[] {
  const figures = [...text.matchAll(PRICE)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, m] of figures.entries()) {
    const start = m.index;
    const end = start + m[0].length;
    const before = wordsIn(text.slice(Math.max(0, start - 200), start)).map(bare);
    const after = wordsIn(text.slice(end, end + 200)).map(bare);
    const cued = /\/|per/i.test(m[0]) || [...before.slice(-CUE_WORDS), ...after.slice(0, CUE_WORDS)].some((w) => PRICING.test(w));
    const excluded = [...before.slice(-CONTEXT_WORDS), ...after.slice(0, CONTEXT_WORDS)].some((w) => NOT_PRICING.test(w));
    const amount = amountKey(m[0]);
    if (!cued || excluded || seen.has(amount)) continue;
    seen.add(amount);

    const prevEnd = i > 0 ? figures[i - 1].index + figures[i - 1][0].length : 0;
    const nextStart = i + 1 < figures.length ? figures[i + 1].index : text.length;
    const lead = wordsIn(text.slice(Math.max(prevEnd, start - 80), start)).slice(-CONTEXT_WORDS);
    const tail = wordsIn(text.slice(end, Math.min(nextStart, end + 80))).slice(0, CONTEXT_WORDS);
    const join = () => [...lead, m[0].replace(/\s+/g, " "), ...tail].join(" ");
    while (join().length > 60 && lead.length + tail.length > 0) {
      if (lead.length > 0) lead.shift();
      else tail.pop();
    }
    out.push(join().slice(0, 60));
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
        const end = t.lastInTextNode ? " " : "";
        if (body.length < BODY_MAX_CHARS) body += t.text + end;
        if (heading) heading.text += t.text + end;
      },
    });

  // Only the handlers' side effects are wanted, so the output is drained without being kept or decoded.
  const reader = rewriter.transform(new Response(html)).body?.getReader();
  if (reader) {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  const fp = {
    title: squash(title, 200),
    description: squash(description || ogDescription, 300),
    headline: squash(headline, 200),
    subheadings,
    prices: pricesIn(decode(body).replace(/\s+/g, " ")),
  };
  return { ...fp, readable: Boolean(fp.title || fp.headline || fp.subheadings.length) };
}

const ONE_PRICE = new RegExp(PRICE.source, "i");

/**
 * A comparison key: two pages with the same key have the same copy, ignoring case and spacing.
 * Prices count by amount only, so a change in the words around one is not a change.
 */
export function copyKey(fp: Fingerprint): string {
  const amounts = fp.prices.map((p) => amountKey(p.match(ONE_PRICE)?.[0] ?? p));
  return JSON.stringify([fp.title, fp.description, fp.headline, fp.subheadings, amounts])
    .toLowerCase()
    .replace(/\s+/g, " ");
}
