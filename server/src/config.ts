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

/**
 * How many captures page_history reads first, spread evenly across the range. Sixteen puts a sample about
 * every quarter on a multi-year range, so a positioning era shows before bisection spends the budget.
 */
export const SAMPLE_SIZE = 16;
/** The most captures page_history fetches in one call; its two index queries aren't counted. */
export const PAGE_HISTORY_MAX_FETCHES = 30;
/**
 * How long page_history may keep starting capture fetches, counted from the start of the call. The last
 * capture can still take a gate wait (up to 1 s) and a slow archive answer (about 5 s), and the call targets 30 s.
 */
export const PAGE_HISTORY_DEADLINE_MS = 22_000;
/**
 * The subrequests (every fetch() and every Cache API call) one tool call may make when SUBREQUEST_LIMIT
 * isn't a usable number. The free plan allows 50 per request; the other 5 leave room for the self-check's
 * Discord posts. Raise SUBREQUEST_LIMIT to about 900 on the paid plan.
 */
export const DEFAULT_SUBREQUEST_LIMIT = 45;
/**
 * The longest any tool call runs, from its start. Each tool stops starting requests earlier (its own
 * deadline); at this one, a request still running is cut and the call returns what it has.
 */
export const TOOL_HARD_DEADLINE_MS = 28_000;
/** The most characters of JSON in one tool result. */
export const RESPONSE_CAP_CHARS = 20_000;

/**
 * The most upstream fetches job_openings makes in one call: nine board guesses, four careers pages, one role
 * page, a board and its departments, and five role descriptions.
 */
export const JOBS_MAX_FETCHES = 21;
/** How long job_openings may keep starting fetches, counted from the start of the call. */
export const JOBS_DEADLINE_MS = 25_000;
/** How long a job board's role list is cached: one hour. */
export const TTL_BOARD = 3_600;
/** The most roles job_openings returns when no role_ids are given; counts still cover every role. */
export const MAX_ROLES = 40;
/** The most role ids job_openings accepts. */
export const MAX_ROLE_IDS = 5;
/** The most characters of one role's description. */
export const ROLE_DESCRIPTION_MAX_CHARS = 3_000;
/** The most bytes read from one careers page. */
export const CAREERS_MAX_BYTES = 512_000;
/** The most bytes read from one job board's role list (a large Lever board is several megabytes). */
export const BOARD_MAX_BYTES = 12_000_000;

/** The most upstream fetches hacker_news_mentions makes in one call. */
export const HN_MAX_FETCHES = 32;
/** How long hacker_news_mentions may keep starting fetches, counted from the start of the call. */
export const HN_DEADLINE_MS = 25_000;
/** How long a Hacker News search answer is cached: six hours. */
export const TTL_HN = 21_600;
/** The most top threads hacker_news_mentions lists. */
export const MAX_THREADS = 10;

/** The most upstream fetches sec_filings makes in one call. */
export const SEC_MAX_FETCHES = 25;
/**
 * How long sec_filings may keep starting fetches, counted from the start of the call. A request that hangs runs
 * to its 10 s timeout, and the call targets 30 s.
 */
export const SEC_DEADLINE_MS = 18_000;
/** How long an EDGAR answer is cached: one day. */
export const TTL_EDGAR = 86_400;
/** The most companies sec_filings returns. */
export const MAX_ENTITIES = 5;
/** The most recent filings sec_filings lists per company. */
export const MAX_FILINGS = 20;
/** The most Form D notices sec_filings reads per company. */
export const MAX_FORM_D = 5;
/** The shortest time between the starts of two EDGAR requests within one call. */
export const EDGAR_GAP_MS = 150;
