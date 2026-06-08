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
// v2 includes future-dated fixtures (v1 only had past replays), with comparable
// team-name coverage once sorted newest-first.
const SPORT_UPSTREAM = "https://services.api.no/api/content/search/sport/v2";
const VIDEO_UPSTREAM = "https://services.api.no/api/content/search/video";
const REELS_UPSTREAM = "https://services.api.no/api/video-yoshi/v1/reels";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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

  // 2. Sport programs proxy (v1 endpoint, no CORS upstream) — forwards paging.
  if (url.pathname === "/sport") {
    const limit = url.searchParams.get("limit") ?? "200";
    const offset = url.searchParams.get("offset") ?? "0";
    const sort = url.searchParams.get("sort") ?? "-eventStartTime";
    const target = `${SPORT_UPSTREAM}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}&sort=${encodeURIComponent(sort)}`;
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

  // 3. Video clips proxy (genZ mode) — newest-first by default, forwards paging.
  if (url.pathname === "/video") {
    const limit = url.searchParams.get("limit") ?? "200";
    const offset = url.searchParams.get("offset") ?? "0";
    const sort = url.searchParams.get("sort") ?? "-createdAt";
    const target = `${VIDEO_UPSTREAM}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}&sort=${encodeURIComponent(sort)}`;
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

  // 4. Reels proxy (genZ mode) — a publication's own reel feed by sitekey.
  if (url.pathname === "/reels") {
    const publication = url.searchParams.get("publication") ?? "";
    const content = url.searchParams.get("content") ?? "none";
    const tail = url.searchParams.get("tail") ?? "latest";
    const target = `${REELS_UPSTREAM}?content=${encodeURIComponent(content)}&tail=${encodeURIComponent(tail)}&publication=${encodeURIComponent(publication)}`;
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

  // 5. Static files (with guards against path traversal and dotfiles).
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  // Never serve dotfiles/dirs (.git, .env, .DS_Store, …), even if inside ROOT.
  if (pathname.split("/").some((seg) => seg.startsWith("."))) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
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

// Bind to loopback only — this is a local dev server, not for exposing on a LAN.
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Map running on http://localhost:${PORT}  (articles proxied at /articles)`,
  );
});
