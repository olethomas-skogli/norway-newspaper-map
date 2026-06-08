// Local dev server for the newspaper map.
//
// Serves the static files AND proxies the bestread (articles) endpoint on the
// SAME origin, at /articles. The upstream sends no CORS headers, so a direct
// browser call is blocked — routing it through here (same host:port as the page)
// sidesteps the browser's same-origin policy entirely.
//
// Run:   node serve.mjs            (http://localhost:8080)
//        node serve.mjs 3000       (custom port)
//   or:  ./start.sh

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2]) || 8080;
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const UPSTREAM =
  "https://services.api.no/api/stagehand/insights/articles/bestread";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 1. Articles proxy — same origin as the page, so no CORS.
  if (url.pathname === "/articles") {
    const siteKey = url.searchParams.get("site_key") ?? "";
    const period = url.searchParams.get("period") ?? "72";
    const target = `${UPSTREAM}?site_key=${encodeURIComponent(siteKey)}&period=${encodeURIComponent(period)}`;
    try {
      const upstream = await fetch(target);
      const body = await upstream.text();
      res.writeHead(upstream.status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // 2. Static files (with a guard against path traversal).
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = join(ROOT, normalize(pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(
    `Map running on http://localhost:${PORT}  (articles proxied at /articles)`,
  );
});
