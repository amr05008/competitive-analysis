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
