type Bad = { ok: false; detail: string };

/** The one rule set for hosts we will fetch: lowercased, dots trimmed, public names only. */
function checkHost(hostname: string): { ok: true; host: string } | Bad {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || host.includes(":")) return { ok: false, detail: "IP addresses are not accepted" };
  if (host.split(".").some((l) => !l)) return { ok: false, detail: "not a valid host name" };
  if (/^\d+(\.\d+){0,3}$/.test(host) || /^\d+$/.test(host.split(".").pop() ?? "")) {
    return { ok: false, detail: "IP addresses are not accepted" };
  }
  if (!host.includes(".")) return { ok: false, detail: "expected a public domain name" };
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) {
    return { ok: false, detail: "local and internal hosts are not accepted" };
  }
  return { ok: true, host };
}

export function isPublicHost(hostname: string): boolean {
  return checkHost(hostname).ok;
}

/** A public hostname, lowercased, without `www.`; or a reason it was refused. */
function publicHost(raw: string): { ok: true; host: string; path: string } | Bad {
  const s = raw.trim();
  if (!s) return { ok: false, detail: "empty input" };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { ok: false, detail: "not a valid URL or domain" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, detail: "only http and https are accepted" };
  if (u.username || u.password) return { ok: false, detail: "credentials in a URL are not accepted" };
  if (u.port) return { ok: false, detail: "ports are not accepted" };
  const checked = checkHost(u.hostname);
  if (!checked.ok) return checked;
  const host = checked.host.replace(/^www\./, "");
  if (!host.includes(".")) return { ok: false, detail: "expected a public domain name" };
  return { ok: true, host, path: u.pathname };
}

/**
 * A page address without trailing slashes, except that a homepage keeps its one slash: the Wayback Machine
 * stores homepage captures as https://host/ and answers https://host with a redirect, a second request per capture.
 */
export function normalizePageUrl(s: string): { ok: true; url: string; cdxKey: string } | Bad {
  const r = publicHost(s);
  if (!r.ok) return r;
  const path = r.path.replace(/\/+$/, "");
  return { ok: true, url: `https://${r.host}${path || "/"}`, cdxKey: `${r.host}${path}` };
}

export function normalizeDomain(s: string): { ok: true; domain: string } | Bad {
  const r = publicHost(s);
  return r.ok ? { ok: true, domain: r.host } : r;
}

const SUFFIX = /[\s,]+(?:inc|llc|ltd|corp|corporation|co|gmbh|pbc|plc)\.?$/i;
/**
 * The most characters of a name that are cleaned. SUFFIX takes time quadratic in a long run of spaces
 * and commas, and no company name is this long.
 */
export const MAX_CLEANED_NAME_CHARS = 200;

/** Collapse whitespace and strip trailing legal-form words ("Acme Co., Ltd." -> "Acme"), from the first 200 characters. */
export function cleanCompanyName(s: string): string {
  let name = s.slice(0, MAX_CLEANED_NAME_CHARS).trim().replace(/\s+/g, " ");
  for (let prev = ""; prev !== name; ) {
    prev = name;
    name = name.replace(SUFFIX, "").trim().replace(/,+$/, "").trim();
  }
  return name;
}
