// Env fields that `wrangler types` doesn't generate: a secret and a
// local-only value. Neither goes in wrangler.toml.
interface Env {
  /** The Discord webhook for self-check failures and the weekly summary (`wrangler secret put`). */
  DISCORD_WEBHOOK_URL?: string;
  /** In .dev.vars only; honored just when ENVIRONMENT is dev. Marks every self-check failed. */
  SELF_CHECK_FORCE_FAIL?: string;
}
