// The four tools as a directory reviews them: names, titles, descriptions,
// input and output schemas, annotations. Changes are additive only (see
// additive.ts); `npm test` compares tools/list against the committed snapshot.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { envelopeShape, outputEnum, outputObject } from "./envelope";

export const TOOL_NAMES = ["page_history", "job_openings", "hacker_news_mentions", "sec_filings"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolContract = {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
};

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

const MONTH = /^\d{4}-\d{2}$/;
const count = () => z.number().int().nonnegative();
/** Caps on text inputs, so no input can make a call do unbounded work. */
const MAX_URL_CHARS = 2000;
const MAX_DOMAIN_CHARS = 253;
const MAX_COMPANY_NAME_CHARS = 120;
const MAX_ROLE_ID_CHARS = 64;
const domainInput = () => z.string().max(MAX_DOMAIN_CHARS);

// ---------------------------------------------------------------- page_history

export const pageHistoryInput = {
  url: z.string().max(MAX_URL_CHARS).describe("The company page to check, such as https://example.com/pricing."),
  from: z
    .string()
    .regex(MONTH)
    .optional()
    .describe("The first month to search, as YYYY-MM. Defaults to 24 months before the last month; the earliest is 1996-01."),
  to: z.string().regex(MONTH).optional().describe("The last month to search, as YYYY-MM; defaults to this month."),
  max_changes: z
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe(
      "The most changes to return, from 1 to 15; defaults to 10. When there are more, the ones that changed the most title, headline and price copy are kept, in date order.",
    ),
};

const captureFields = {
  timestamp: z.string().describe("The capture's Wayback Machine timestamp, as YYYYMMDDhhmmss."),
  date: z.string().describe("The date of the capture, as YYYY-MM-DD."),
  link: z.string().describe("A link to the capture on the Wayback Machine."),
};

const snapshot = outputObject({
  ...captureFields,
  title: z.string().describe("The page's title at this capture."),
  headline: z.string().describe("The page's main heading at this capture."),
  subheadings: z.array(z.string()).describe("The page's section headings at this capture."),
  prices: z
    .array(z.string())
    .describe(
      "Prices on the page at this capture: currency figures next to a pricing word such as plan, fee, free or per month, each with a few words around it. Funding and revenue figures are left out.",
    ),
});

export const pageHistoryOutput = {
  ...envelopeShape,
  url: z.string().optional().describe("The page address that was checked, normalized."),
  range: outputObject({
    from: z.string().describe("The first month searched, as YYYY-MM."),
    to: z.string().describe("The last month searched, as YYYY-MM."),
  })
    .optional()
    .describe("The months that were searched."),
  first_capture: outputObject({
    ...captureFields,
    title: z
      .string()
      .optional()
      .describe("The page's title at its earliest capture, when that capture could be read: it says who held the address then."),
    headline: z.string().optional().describe("The page's main heading at its earliest capture, when that capture could be read."),
  })
    .nullable()
    .optional()
    .describe("The page's earliest capture on the Wayback Machine, or null when it couldn't be read."),
  captures_in_range: count().optional().describe("How many distinct captures of the page fall in the months searched."),
  changes: z
    .array(
      outputObject({
        before: snapshot.describe("The last capture checked before the change."),
        after: snapshot.describe("The first capture checked after the change."),
        days_between: count().describe("Days between the two captures; the change happened in that window."),
        resolved: z
          .boolean()
          .describe("Whether no capture between the two is left to check, so the change can't be dated more closely."),
      }),
    )
    .optional()
    .describe("Each change in the page's copy, bracketed between two dated captures."),
  fetches_used: count()
    .optional()
    .describe("How many Wayback Machine requests this call made; answers already cached cost none."),
};

// ---------------------------------------------------------------- job_openings

/** The job board services job_openings reads. Services may be added, never removed. */
export const ATS = ["greenhouse", "lever", "ashby"] as const;
export type Ats = (typeof ATS)[number];

export const jobOpeningsInput = {
  domain: domainInput().describe("The company's website domain, such as example.com."),
  company_name: z
    .string()
    .max(MAX_COMPANY_NAME_CHARS)
    .optional()
    .describe("The company's name, used to find its board when the name differs from the domain."),
  role_ids: z
    .array(z.string().max(MAX_ROLE_ID_CHARS))
    .max(5)
    .optional()
    .describe("Up to five role ids from an earlier call, to get those roles' full descriptions."),
};

const nameCount = outputObject({
  name: z.string().describe("The department or location, or Unspecified when the board gives none."),
  count: count().describe("How many open roles it has."),
});

export const jobOpeningsOutput = {
  ...envelopeShape,
  board: outputObject({
    ats: outputEnum(ATS, "The service that hosts the board"),
    slug: z.string().describe("The company's board name on that service."),
    url: z.string().describe("A link to the board."),
  })
    .nullable()
    .optional()
    .describe("The public job board that was found, or null when none was."),
  no_public_board_found: z
    .boolean()
    .optional()
    .describe("True only when every board and careers page checked showed no board; a check that failed never counts."),
  tried: z.array(z.string()).optional().describe("The board and careers-page addresses that were checked."),
  counts: outputObject({
    total: count().describe("How many open roles the board lists."),
    by_department: z.array(nameCount).describe("Open roles per department, most first."),
    by_location: z.array(nameCount).describe("Open roles per location, most first."),
  })
    .optional()
    .describe("Open-role counts across the whole board."),
  roles: z
    .array(
      outputObject({
        id: z.string().describe("The role's id on the board, to pass in role_ids."),
        title: z.string().describe("The role's title."),
        department: z.string().nullable().describe("The role's department, or null when the board gives none."),
        location: z.string().nullable().describe("The role's location, or null when the board gives none."),
        date: z.string().nullable().describe("The date the board gives for the role, or null when it gives none."),
        date_kind: z.enum(["posted", "updated"]).describe("Whether date is when the role was posted or last updated."),
        pay: z.string().nullable().describe("The pay range as the board publishes it, or null when it doesn't."),
        link: z.string().describe("A link to the role's posting."),
        description: z
          .string()
          .optional()
          .describe("The role's full description as plain text, present only for roles asked for by role_ids."),
      }),
    )
    .optional()
    .describe("The open roles, newest first, or only the roles asked for by role_ids."),
};

// -------------------------------------------------------- hacker_news_mentions

export const hnInput = {
  query: z.string().min(2).max(80).describe("The company or product name to search for."),
  domain: domainInput()
    .optional()
    .describe("The company's website domain, to also count stories that link to it."),
  years: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("How many calendar years to count, ending with this one, from 1 to 10; defaults to 6."),
};

export const hnOutput = {
  ...envelopeShape,
  query: z.string().optional().describe("The name that was searched for."),
  years: z
    .array(
      outputObject({
        year: z.number().int().describe("The calendar year."),
        stories: count().describe("How many stories that year mention the name."),
        comments: count().describe("How many comments that year mention the name."),
        stories_linking_domain: count()
          .optional()
          .describe("How many stories that year link to the domain, present only when a domain was given."),
        sample_titles: z
          .array(z.string())
          .describe("A few story titles from that year, to spot stories about something else with the same name."),
        search_link: z.string().describe("A link to that year's search on Hacker News search."),
      }),
    )
    .optional()
    .describe("Mention counts for each calendar year."),
  top_threads: z
    .array(
      outputObject({
        title: z.string().describe("The story's title."),
        points: count().describe("The story's points."),
        comments: count().describe("How many comments the story has."),
        date: z.string().describe("The date the story was posted, as YYYY-MM-DD."),
        hn_link: z.string().describe("A link to the story's discussion on Hacker News."),
        story_link: z
          .string()
          .nullable()
          .describe("The address the story links to, or null for a text post such as Ask HN."),
      }),
    )
    .optional()
    .describe("The stories mentioning the name that have the most points, drawn from across all years, not only the years counted."),
};

// ----------------------------------------------------------------- sec_filings

export const secInput = {
  company_name: z.string().min(2).max(MAX_COMPANY_NAME_CHARS).describe("The company's name, such as Example Inc."),
  domain: domainInput()
    .optional()
    .describe("The company's website domain, whose first label is tried as a second name."),
  state: z
    .string()
    .length(2)
    .optional()
    .describe("The company's two-letter US state, used to rank matching companies first."),
};

const formD = outputObject({
  date_filed: z.string().describe("The date the notice was filed, as YYYY-MM-DD."),
  link: z.string().describe("A link to the notice on EDGAR."),
  amendment: z.boolean().describe("Whether the notice amends an earlier one."),
  total_offering_amount: z
    .string()
    .nullable()
    .describe("The total offering amount as filed, in US dollars or Indefinite, or null when not given."),
  total_amount_sold: z
    .string()
    .nullable()
    .describe("The total amount sold as filed, in US dollars, or null when not given."),
  date_of_first_sale: z
    .string()
    .nullable()
    .describe("The date of first sale, as YYYY-MM-DD, or null when it hasn't happened or isn't given."),
  industry_group: z.string().nullable().describe("The industry group named in the notice, or null when not given."),
  year_of_incorporation: z
    .string()
    .nullable()
    .describe("The year of incorporation, or over five years or within five years, or null when not given."),
});

export const secOutput = {
  ...envelopeShape,
  names_tried: z.array(z.string()).optional().describe("The company names that were searched on EDGAR."),
  entities: z
    .array(
      outputObject({
        name: z.string().describe("The company's name on EDGAR."),
        cik: z.string().describe("The company's EDGAR id, its CIK."),
        state: z.string().nullable().describe("The company's state on EDGAR, or null when none is listed."),
        former_names: z.array(z.string()).describe("Names the company filed under before."),
        exact_match: z
          .boolean()
          .describe("Whether the EDGAR name matches the name asked for, ignoring case, punctuation and legal suffixes."),
        edgar_link: z.string().describe("A link to the company's filings on EDGAR."),
        filings: z
          .array(
            outputObject({
              form: z.string().describe("The form type, such as D or 10-K."),
              date: z.string().describe("The filing date, as YYYY-MM-DD."),
              link: z.string().describe("A link to the filing on EDGAR."),
            }),
          )
          .describe("The company's most recent filings, newest first."),
        form_d: z.array(formD).describe("Figures from the company's Form D notices of private fundraising."),
      }),
    )
    .optional()
    .describe("The companies on EDGAR that match the names tried; companies only, never people."),
  statement: z
    .string()
    .nullable()
    .optional()
    .describe("A plain statement when nothing is filed under the names tried, or when the companies listed are only close matches, otherwise null."),
};

// ----------------------------------------------------------------------- types

type Infer<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export type PageHistoryInput = Infer<typeof pageHistoryInput>;
export type PageHistoryResult = Infer<typeof pageHistoryOutput>;
export type JobOpeningsInput = Infer<typeof jobOpeningsInput>;
export type JobOpeningsResult = Infer<typeof jobOpeningsOutput>;
export type HnInput = Infer<typeof hnInput>;
export type HnResult = Infer<typeof hnOutput>;
export type SecInput = Infer<typeof secInput>;
export type SecResult = Infer<typeof secOutput>;

export type ToolInputs = {
  page_history: PageHistoryInput;
  job_openings: JobOpeningsInput;
  hacker_news_mentions: HnInput;
  sec_filings: SecInput;
};
export type ToolResults = {
  page_history: PageHistoryResult;
  job_openings: JobOpeningsResult;
  hacker_news_mentions: HnResult;
  sec_filings: SecResult;
};

/** The envelope plus one tool's own fields. */
export type ToolResult = ToolResults[ToolName];

// ----------------------------------------------------------------------- tools

export const TOOLS: readonly ToolContract[] = [
  {
    name: "page_history",
    title: "Page history",
    description:
      "Finds when a company web page's copy changed, using Wayback Machine captures. Give a page URL, such as a homepage or pricing page, and optionally a month range. Returns the page's earliest capture and each change, bracketed between two dated captures, with the title, headline, subheadings and prices before and after, each with a link.",
    inputSchema: pageHistoryInput,
    outputSchema: pageHistoryOutput,
    annotations: { ...ANNOTATIONS },
  },
  {
    name: "job_openings",
    title: "Job openings",
    description:
      "Lists a company's open roles from its public job board (Greenhouse, Lever or Ashby). Give the company's domain, and optionally its name. Returns the board, role counts by department and location, and the roles with dates, links and pay ranges where the board publishes them, or says that no public board was found and lists what was tried. Pass role_ids to get full descriptions of specific roles.",
    inputSchema: jobOpeningsInput,
    outputSchema: jobOpeningsOutput,
    annotations: { ...ANNOTATIONS },
  },
  {
    name: "hacker_news_mentions",
    title: "Hacker News mentions",
    description:
      "Counts Hacker News stories and comments that mention a company or product, by calendar year, and lists the threads with the most points. Give the company or product name, and optionally its domain to count stories that link to its site. Includes a few story titles per year so name collisions are easy to spot. Never returns usernames.",
    inputSchema: hnInput,
    outputSchema: hnOutput,
    annotations: { ...ANNOTATIONS },
  },
  {
    name: "sec_filings",
    title: "SEC filings",
    description:
      "Looks up a company's filings with the SEC on EDGAR, especially Form D notices of private fundraising. Give the company name, and optionally its domain or two-letter state. Returns matching companies, their filings with dates and links, and for each Form D the offering amount, amount sold and date of first sale. Says plainly when nothing is filed under the names tried. Returns companies only, never people.",
    inputSchema: secInput,
    outputSchema: secOutput,
    annotations: { ...ANNOTATIONS },
  },
];
