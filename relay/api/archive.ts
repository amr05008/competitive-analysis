import { handle } from "../src/relay.js";

// The relay's one endpoint: POST /api/archive. See README.md.
export default {
  fetch: (request: Request) => handle(request, { token: process.env.ARCHIVE_RELAY_TOKEN, fetcher: fetch }),
};
