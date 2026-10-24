import { z } from "zod";

/** Every reason a tool can fail with. Reasons may be added, never removed or renamed. */
export const ERROR_REASONS = [
  "source_rate_limited",
  "source_unavailable",
  "server_busy",
  "not_found",
  "bad_input",
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

export const FALLBACK_LINE = "fall back to browsing for this check.";

/**
 * Every object in a tool's output. Its JSON Schema allows extra keys
 * (`additionalProperties: {}`, where a plain zod object gives `false`), so a
 * field added later still validates against the schema a directory approved.
 */
export const outputObject = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape);

/** The fields every tool's output starts with. */
export const envelopeShape = {
  status: z
    .enum(["ok", "partial", "error"])
    .describe("ok when the check finished, partial when some of it is missing, and error when it failed."),
  notes: z.array(z.string()).describe("Notes on the result, such as what a partial result is missing."),
  retrieved_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("The UTC date this result was produced, as YYYY-MM-DD."),
  error: outputObject({
    reason: z.enum(ERROR_REASONS).describe("The kind of failure."),
    detail: z.string().describe("A short description of what went wrong."),
    tried: z.array(z.string()).describe("The sources or addresses that were tried."),
    fallback: z.literal(FALLBACK_LINE).describe("What to do instead."),
  })
    .optional()
    .describe("Why the check failed, present only when status is error."),
};

export type Envelope = z.infer<z.ZodObject<typeof envelopeShape>>;
export type ErrorEnvelope = Envelope & { status: "error"; error: NonNullable<Envelope["error"]> };

/** A UTC date as YYYY-MM-DD. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function errorResult(reason: ErrorReason, detail: string, tried: string[]): ErrorEnvelope {
  return {
    status: "error",
    notes: [],
    retrieved_at: utcDay(Date.now()),
    error: { reason, detail, tried, fallback: FALLBACK_LINE },
  };
}
