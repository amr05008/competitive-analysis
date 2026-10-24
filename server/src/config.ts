/** Sent on every outbound request, so each source can see who is asking and how to reach us. */
export const USER_AGENT =
  "competitive-analysis-plugin/0.2 (+https://aaronroy.com/competitive-analysis/; aaron@aaronroy.com)";

/** The most characters of JSON a whole tool response may hold. */
export const RESPONSE_CAP_CHARS = 20_000;
