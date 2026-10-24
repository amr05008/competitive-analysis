/** The name and version the MCP server reports in `initialize`. */
export const SERVER_NAME = "competitive-analysis";
export const SERVER_VERSION = "0.2.0";

/** Sent on every outbound request. */
export const USER_AGENT =
  "competitive-analysis-plugin/0.2 (+https://aaronroy.com/competitive-analysis/; aaron@aaronroy.com)";

/** The shortest time between the starts of two Wayback Machine requests, server-wide. */
export const ARCHIVE_GAP_MS = 1_000;
/** The most archive requests that may be pending at once, the running one included. */
export const ARCHIVE_MAX_QUEUE = 3;
/** After the archive refuses a request, how long every archive request fails fast. */
export const ARCHIVE_COOLDOWN_MS = 120_000;
/** How many days of usage counts are kept. */
export const USAGE_RETENTION_DAYS = 90;

/** How long a Wayback CDX index answer is cached: one day. */
export const TTL_CDX = 86_400;
/** How long a capture's copy fingerprint is cached: a year (a capture never changes). */
export const TTL_FINGERPRINT = 31_536_000;
/** The most bytes read from one archived capture. */
export const CAPTURE_MAX_BYTES = 1_500_000;

/** How many captures page_history reads first, spread evenly across the range. */
export const SAMPLE_SIZE = 8;
/** The most captures page_history fetches in one call; its two index queries aren't counted. */
export const PAGE_HISTORY_MAX_FETCHES = 30;
/** How long page_history may keep starting capture fetches, counted from the start of the call. */
export const PAGE_HISTORY_DEADLINE_MS = 25_000;
/** The most characters of JSON in one tool result. */
export const RESPONSE_CAP_CHARS = 20_000;
