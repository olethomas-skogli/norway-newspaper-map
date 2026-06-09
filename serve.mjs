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
// Yoshi weekly schedule: one flat array of broadcasts per ISO week, scoped by
// {year}/{week} in the path — no paging, explicit home/away team names.
const SCHEDULE_UPSTREAM =
  "https://services.api.no/api/video-yoshi/v1/sport/schedule";
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

  // 1. Articles proxy — same origin as the page, so no CORS. Data proxies live
  //    under /api/ so the top-level paths (/sport, /gen-z, /aviser) are free for
  //    client-side routing.
  if (url.pathname === "/api/articles") {
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

  // 2. Sport schedule proxy — /api/sport-schedule/{year}/{week} maps to the
  //    Yoshi weekly schedule (year/week live in the upstream path, no CORS).
  if (url.pathname.startsWith("/api/sport-schedule/")) {
    const [year, week] = url.pathname
      .slice("/api/sport-schedule/".length)
      .split("/");
    if (!/^\d+$/.test(year ?? "") || !/^\d+$/.test(week ?? "")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "year and week must be integers" }));
      return;
    }
    const target = `${SCHEDULE_UPSTREAM}/${year}/${week}/json`;
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

  // 3. Video clips proxy (newest-first by default, forwards paging).
  if (url.pathname === "/api/video") {
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
  if (url.pathname === "/api/reels") {
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
    // SPA fallback: serve index.html for extensionless routes (/sport, /gen-z,
    // /aviser) so client-side routing works on direct load / refresh.
    if (!extname(pathname)) {
      try {
        const html = await readFile(join(ROOT, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
        return;
      } catch {
        /* fall through to 404 */
      }
    }
    res.writeHead(404);
    res.end("Not found");
  }
});

// Bind to loopback only — this is a local dev server, not for exposing on a LAN.
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Map running on http://localhost:${PORT}  (data proxied under /api/*)`,
  );
});
