const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Competitive Analysis server</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style>
</head>
<body>
<p><strong>Competitive Analysis server.</strong> This server gives the Competitive Analysis plugin its tools: page history from the Wayback Machine, public job boards, Hacker News discussion, and SEC filings. It's read-only, needs no sign-in, and keeps no personal data. More at <a href="https://aaronroy.com/competitive-analysis/">https://aaronroy.com/competitive-analysis/</a>.</p>
</body>
</html>
`;

/** The page a person sees at the server's root. HEAD gets the headers only. */
export function aboutPage(req: Request): Response {
  return new Response(req.method === "HEAD" ? null : PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
