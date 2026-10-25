// Env fields that `wrangler types` doesn't generate: secrets, a var only
// some environments set, and a local-only value.
interface Env {
  /** The Discord webhook for self-check failures and the weekly summary (`wrangler secret put`). */
  DISCORD_WEBHOOK_URL?: string;
  /** The archive relay's endpoint, in an environment's vars. Unset (dev, tests), archive requests go direct. */
  ARCHIVE_RELAY_URL?: string;
  /** The archive relay's shared token (`wrangler secret put`). */
  ARCHIVE_RELAY_TOKEN?: string;
  /** In .dev.vars only; honored just when ENVIRONMENT is dev. Marks every self-check failed. */
  SELF_CHECK_FORCE_FAIL?: string;
}
