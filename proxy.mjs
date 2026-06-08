// Optional dev proxy — ONLY needed if direct browser calls to the bestread
// endpoint are blocked by CORS. It forwards /articles?site_key=…&period=… to the
// real endpoint and adds permissive CORS headers.
//
// Run:   node map/proxy.mjs           (listens on http://localhost:8787)
// Then:  set ARTICLES_PROXY = "http://localhost:8787" at the top of app.js
//
// No auth required upstream; this just sidesteps the browser same-origin policy.

import { createServer } from "node:http";

const PORT = 8787;
const UPSTREAM = "https://services.api.no/api/stagehand/insights/articles/bestread";

const server = createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/articles")) {
    res.writeHead(404, cors);
    res.end("Not found");
    return;
  }

  const siteKey = url.searchParams.get("site_key") ?? "";
  const period = url.searchParams.get("period") ?? "72";
  const target = `${UPSTREAM}?site_key=${encodeURIComponent(siteKey)}&period=${encodeURIComponent(period)}`;

  try {
    const upstream = await fetch(target);
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      ...cors,
      "Content-Type": "application/json",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, cors);
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Article proxy on http://localhost:${PORT}  ->  ${UPSTREAM}`);
});
