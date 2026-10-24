import type { ErrorReason } from "../contract/envelope";

export type Fetcher = typeof fetch;

export type FetchOutcome =
  | { ok: true; status: number; url: string; text: string; truncated: boolean }
  | { ok: false; reason: ErrorReason; status?: number; url: string; detail: string };

export type FailedOutcome = Extract<FetchOutcome, { ok: false }>;

export type ArchiveFetch = (
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
) => Promise<FetchOutcome>;
