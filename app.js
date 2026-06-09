/* global L */
// Interactive map of Norwegian newspapers.
// - Loads publications.json (built by build-data.mjs).
// - One marker per city; national papers on a separate marker.
// - Click a paper -> fetch its top 3 most-read articles (stagehand bestread).
// - "Sport mode" swaps in direktesport.no sport broadcasts as map pins.

import { resolveTeam, resolveText } from "./sport-clubs.mjs";

// The bestread (articles) endpoint sends no CORS headers, so the browser blocks
// direct calls. Instead we fetch from the same-origin /articles path, which the
// dev server (serve.mjs) proxies to the real endpoint. Start it with
// `./start.sh` (or `node serve.mjs`).
const BESTREAD_BASE = "/api/articles";

// The API only supports period=72 (most-read over the last 72 hours), so the
// time filter is applied client-side: we keep all returned articles and narrow
// them to those updated within the chosen window. `currentWindowHours` is the
// active selection; 72 = no narrowing (the full dataset).
let currentWindowHours = 72;

// Hide paywalled (premium) articles when true — toggled by the "kun gratis" box.
// When on, map markers whose papers have no free article (in window) are grayed.
let freeOnly = false;

// Active county filter ("all" or a fylke name).
let currentCounty = "all";

// "Most-read hotspots" filter: keep only the top N locations by their single
// most-read article; 0 = off (show all). Excluded markers gray out but stay
// clickable. Needs article data (prefetched), like the free-only filter.
let topReadsN = 0;

// Sport mode: pivot to direktesport.no broadcasts as map pins (best-effort,
// placed by team name). State lives here; markers/programs are filled on enter.
let sportMode = false;
let sportPrograms = []; // mapped + location-resolved programs (cached)
let sportMarkers = []; // Leaflet markers for sport pins, cleared on exit
let currentSport = "all"; // active sportName filter
let currentWeek = "all"; // upcoming window: "all" | "this" | "next"

// genZ mode: pivot to vertical reels, one pin per publication city. Reels load
// lazily on pin click into a fullscreen TikTok-style viewer. Mutually exclusive
// with sport mode.
let genzMode = false;
let reelMarkers = []; // Leaflet markers for reel pins, cleared on exit
let reelsObserver = null; // IntersectionObserver driving current-reel autoplay
let reelsMuted = true; // shared mute state across the viewer

// Norwegian number formatting for read counts (space as thousands separator).
const nf = new Intl.NumberFormat("nb-NO");

// Where to draw the "national papers" marker (offshore, clearly separate).
const NATIONAL_MARKER_POS = [60.6, 1.6];

// Column in the North Sea where placeless sport events are stacked, one marker
// per sport (clearly offshore so they read as "no real location").
const SPORT_UNKNOWN_ANCHOR = [63.0, 1.5]; // top of the column
const SPORT_UNKNOWN_STEP = 0.7; // degrees latitude south, per sport
const SPORT_UNKNOWN_FILL = "#475569"; // slate — distinct from cyan SPORT_FILL

const map = L.map("map", { minZoom: 4 }).setView([65, 14], 4);

// Light (default) and dark (sport mode) basemaps; only one is on the map at a time.
const osmLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  { maxZoom: 18, attribution: "© OpenStreetMap contributors" },
).addTo(map);
const darkLayer = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: "© OpenStreetMap, © CARTO",
  },
);

const escapeHtml = (s = "") =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Build an absolute article URL (bestread sometimes returns a relative path).
const absoluteUrl = (url, domain) => {
  if (!url) return "#";
  if (/^https?:\/\//.test(url)) return url;
  return `https://${domain}${url.startsWith("/") ? "" : "/"}${url}`;
};

// Cache the full article list per paper (keyed by sitekey) so changing the time
// filter just re-narrows in memory instead of re-fetching. Data refreshes hourly
// upstream, which is plenty fresh for a session.
const articleCache = new Map();

// Fetch the full most-read list (up to ~10 articles) for a paper, with the
// `updated` timestamp kept so it can be filtered by the chosen time window.
async function fetchArticles(paper) {
  if (articleCache.has(paper.sitekey)) return articleCache.get(paper.sitekey);

  const url = `${BESTREAD_BASE}?site_key=${encodeURIComponent(paper.sitekey)}&period=72`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bestread ${res.status}`);
  const json = await res.json();
  const articles = (json.data ?? []).map((d) => {
    const info = d.info ?? {};
    return {
      title: (info.title ?? "").replace(/&shy;/g, ""),
      url: absoluteUrl(info.url, paper.domain),
      imageUrl: info.image?.url,
      isPremium: !!info.isPremium,
      updated: info.lastUpdated ? Date.parse(info.lastUpdated) : NaN,
      reads: typeof d.stats?.count === "number" ? d.stats.count : null,
    };
  });
  articleCache.set(paper.sitekey, articles);
  return articles;
}

// Narrow the cached list by the active filters (time window + free-only) and
// take the top 3. The list is already ordered most-read first, so a filtered
// slice keeps that ranking. Articles without a usable timestamp are kept.
function topArticlesWithin(articles, windowHours) {
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  return articles
    .filter((a) => Number.isNaN(a.updated) || a.updated >= cutoff)
    .filter((a) => !freeOnly || !a.isPremium)
    .slice(0, 3);
}

// Reflow the Leaflet popup after its DOM content changes, so it keeps the right
// size/position instead of being torn down. `popup` is the Leaflet popup object.
const reflow = (popup) => {
  if (popup && popup.isOpen()) popup.update();
};

// The article view currently shown in an open popup, so a change to the time
// filter can re-render it in place. Null when no popup shows articles (chooser
// or nothing open). Cleared on popupclose and when returning to the chooser.
let openArticleView = null;

// Render the article list into the popup container. `heading` is the city /
// "Nasjonale aviser" label, kept so the back link can restore the chooser.
async function renderArticles(container, paper, papers, popup, heading) {
  container.innerHTML = "";
  openArticleView = { container, paper, papers, popup, heading };

  if (papers && papers.length > 1) {
    const back = document.createElement("span");
    back.className = "back-link";
    back.textContent = "← Tilbake til aviser";
    back.onclick = () => renderPaperChooser(container, papers, heading, popup);
    container.appendChild(back);
  }

  const title = document.createElement("p");
  title.className = "popup-title";
  title.textContent = paper.name;
  container.appendChild(title);

  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Laster saker…";
  container.appendChild(status);
  reflow(popup);

  try {
    const all = await fetchArticles(paper);
    const articles = topArticlesWithin(all, currentWindowHours);
    status.remove();

    if (!articles.length) {
      const empty = document.createElement("p");
      empty.className = "status";
      empty.textContent = !all.length
        ? "Ingen mest-leste saker akkurat nå."
        : freeOnly
          ? "Ingen gratis saker i valgt tidsrom."
          : "Ingen saker i valgt tidsrom.";
      container.appendChild(empty);
      reflow(popup);
      return;
    }

    const list = document.createElement("div");
    list.className = "articles";
    for (const a of articles) {
      const link = document.createElement("a");
      link.className = "article";
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      const reads =
        a.reads != null ? `<span class="reads">${nf.format(a.reads)} lesninger</span>` : "";
      link.innerHTML = `
        ${a.imageUrl ? `<img src="${escapeHtml(a.imageUrl)}" alt="" />` : ""}
        <span class="article-text">
          <span class="article-title">
            ${a.isPremium ? '<span class="lock">🔒 </span>' : ""}${escapeHtml(a.title)}
          </span>
          ${reads}
        </span>`;
      list.appendChild(link);
    }
    container.appendChild(list);
    reflow(popup);
  } catch (err) {
    status.className = "status error";
    status.textContent = "Klarte ikke å hente saker akkurat nå.";
    console.error("Article fetch failed:", err);
    reflow(popup);
  }
}

// Render the list of papers for a city (or national group).
function renderPaperChooser(container, papers, heading, popup) {
  container.innerHTML = "";
  openArticleView = null; // chooser shown, so nothing to re-filter

  const title = document.createElement("p");
  title.className = "popup-title";
  title.textContent = `${heading} – velg avis`;
  container.appendChild(title);

  const list = document.createElement("div");
  list.className = "paper-list";
  for (const p of papers) {
    const btn = document.createElement("button");
    btn.className = "paper-btn";
    btn.textContent = p.name;
    btn.onclick = () => renderArticles(container, p, papers, popup, heading);
    list.appendChild(btn);
  }
  container.appendChild(list);
  reflow(popup);
}

// Fill an opened popup with content (chooser, or articles if a single paper).
function fillPopup(popup, papers, heading) {
  const container = document.createElement("div");
  popup.setContent(container);
  if (papers.length === 1) {
    renderArticles(container, papers[0], papers, popup, heading);
  } else {
    renderPaperChooser(container, papers, heading, popup);
  }
}

const POPUP_OPTS = {
  maxWidth: 300,
  minWidth: 240,
  closeOnClick: false, // don't close on clicks inside the popup / content reflow
};

// City markers, tracked so the filters can gray them out, plus a search index
// (lowercased city / paper name -> a marker to fly to and open). `nationalEntry`
// is the offshore national marker; `countyGeo` holds the fylke boundary GeoJSON.
const cityMarkers = []; // { marker, county, papers }
let nationalEntry = null; // { marker, papers, isNational: true }
let countyGeo = null;
const searchIndex = new Map();

function addCityMarker(city, papers) {
  const { lat, lng } = papers[0];
  const marker = L.circleMarker([lat, lng], {
    radius: papers.length > 1 ? 8 : 6,
    color: "#fff",
    weight: 2,
    fillColor: "#2563eb",
    fillOpacity: 0.9,
  }).addTo(map);

  marker.bindTooltip(
    papers.length > 1 ? `${city} (${papers.length} aviser)` : papers[0].name,
    { direction: "top" },
  );
  marker.bindPopup("", POPUP_OPTS);
  // Build fresh content each open so it always starts at the chooser.
  marker.on("popupopen", (e) => fillPopup(e.popup, papers, city));

  cityMarkers.push({ marker, county: papers[0].county ?? null, papers });
  // Searchable by city name and by each paper's name.
  searchIndex.set(city.toLowerCase(), { lat, lng, marker });
  for (const p of papers) searchIndex.set(p.name.toLowerCase(), { lat, lng, marker });
}

function addNationalMarker(papers) {
  if (!papers.length) return;
  const marker = L.circleMarker(NATIONAL_MARKER_POS, {
    radius: 10,
    color: "#fff",
    weight: 2,
    fillColor: "#d97706",
    fillOpacity: 0.95,
  }).addTo(map);
  marker.bindTooltip(`Nasjonale aviser (${papers.length})`, {
    direction: "top",
  });
  marker.bindPopup("", POPUP_OPTS);
  marker.on("popupopen", (e) => fillPopup(e.popup, papers, "Nasjonale aviser"));

  nationalEntry = { marker, papers, isNational: true };
  const [lat, lng] = NATIONAL_MARKER_POS;
  searchIndex.set("nasjonale aviser", { lat, lng, marker });
  for (const p of papers) searchIndex.set(p.name.toLowerCase(), { lat, lng, marker });
}

// When a popup closes, there is no longer an article view to re-filter.
map.on("popupclose", () => {
  openArticleView = null;
});

// Wire up the time-window <select>: update the active window and, if a popup is
// currently showing articles, re-render it in place (served from cache).
function setupPeriodFilter() {
  const select = document.getElementById("period");
  if (!select) return;
  currentWindowHours = Number(select.value) || 72;
  select.onchange = () => {
    currentWindowHours = Number(select.value) || 72;
    rerenderOpenArticles();
    updateMarkerStyles(); // free-availability depends on the window
  };
}

// Re-render the article list in the currently open popup, if one is showing
// articles — used after any article-level filter (time window, free-only) changes.
function rerenderOpenArticles() {
  if (openArticleView && openArticleView.popup.isOpen()) {
    const { container, paper, papers, popup, heading } = openArticleView;
    renderArticles(container, paper, papers, popup, heading);
  }
}

// "Vis kun gratis saker" checkbox — hide premium articles in popups, and gray
// out markers with no free article. Turning it on prefetches all papers (once)
// so the map can tell which have free results.
function setupFreeFilter() {
  const box = document.getElementById("free-only");
  if (!box) return;
  freeOnly = box.checked;
  box.onchange = async () => {
    freeOnly = box.checked;
    rerenderOpenArticles();
    if (freeOnly) {
      box.disabled = true;
      setFilterStatus("Sjekker aviser…");
      await prefetchAllArticles();
      setFilterStatus("");
      box.disabled = false;
      if (!box.checked) return; // toggled back off while loading
    }
    updateMarkerStyles();
  };
}

// "Mest lest" <select> — keep only the top N locations by their most-read
// article. Turning it on prefetches all papers (once) so the ranking has data.
function setupTopReadsFilter() {
  const select = document.getElementById("topreads");
  if (!select) return;
  topReadsN = Number(select.value) || 0;
  select.onchange = async () => {
    topReadsN = Number(select.value) || 0;
    if (topReadsN > 0) {
      select.disabled = true;
      setFilterStatus("Sjekker aviser…");
      await prefetchAllArticles();
      setFilterStatus("");
      select.disabled = false;
    }
    updateMarkerStyles();
  };
}

// County <select>: populate from the counties present, then gray local markers
// outside the selected fylke and draw its boundary. National papers stay active.
function setupCountyFilter() {
  const select = document.getElementById("county");
  if (!select) return;
  const counties = [...new Set(cityMarkers.map((m) => m.county).filter(Boolean))];
  counties.sort((a, b) => a.localeCompare(b, "nb"));
  for (const c of counties) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }
  select.onchange = () => {
    currentCounty = select.value;
    showCountyBorder(currentCounty);
    updateMarkerStyles();
  };
}

// Marker colours. Inactive markers are kept on the map but grayed out and made
// inert (no popup, no tooltip) so it's clear they exist but have no result.
const ACTIVE_FILL = "#2563eb"; // --local blue
const NATIONAL_FILL = "#d97706"; // --national orange
const GRAY_FILL = "#cbd5e1";

// Does this paper have at least one free article within the active time window?
// Returns null when the paper's articles haven't been fetched yet (unknown).
function paperHasFreeMatch(paper) {
  const arts = articleCache.get(paper.sitekey);
  if (!arts) return null;
  const cutoff = Date.now() - currentWindowHours * 3600 * 1000;
  return arts.some(
    (a) => (Number.isNaN(a.updated) || a.updated >= cutoff) && !a.isPremium,
  );
}

// `active` controls colour (blue vs gray); `interactive` controls pointer-events.
// They differ for the Top-N filter, where excluded markers gray out but stay
// clickable. County/free graying passes interactive=false (gray + inert).
function styleMarker(marker, active, interactive, baseFill, baseOpacity) {
  marker.setStyle({
    fillColor: active ? baseFill : GRAY_FILL,
    fillOpacity: active ? baseOpacity : 0.45,
  });
  const el = marker.getElement();
  if (el) el.style.pointerEvents = interactive ? "" : "none";
  if (!interactive && marker.isPopupOpen()) marker.closePopup();
}

// A marker's "hotspot score": the highest read count among its papers' articles
// that pass the current time-window (and free-only, if on). -1 when unknown/none.
function markerScore(entry) {
  const cutoff = Date.now() - currentWindowHours * 3600 * 1000;
  let best = -1;
  for (const p of entry.papers) {
    const arts = articleCache.get(p.sitekey);
    if (!arts) continue;
    for (const a of arts) {
      const inWindow = Number.isNaN(a.updated) || a.updated >= cutoff;
      if (!inWindow || (freeOnly && a.isPremium)) continue;
      if (typeof a.reads === "number" && a.reads > best) best = a.reads;
    }
  }
  return best;
}

const passCounty = (e) =>
  e.isNational || currentCounty === "all" || e.county === currentCounty;
const passFree = (e) =>
  !freeOnly || e.papers.some((p) => paperHasFreeMatch(p) !== false);

// Recompute every marker's style from all three map filters:
// - county / free-only gray a marker AND make it inert (no result for the filter);
// - Top-N hotspots gray the lower-read markers but leaves them clickable.
function updateMarkerStyles() {
  const entries = nationalEntry ? [...cityMarkers, nationalEntry] : cityMarkers;

  // Build the Top-N set among non-national markers that pass county + free.
  let topSet = null;
  if (topReadsN > 0) {
    topSet = new Set(
      entries
        .filter((e) => !e.isNational && passCounty(e) && passFree(e))
        .map((e) => ({ e, s: markerScore(e) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, topReadsN)
        .map((x) => x.e),
    );
  }

  for (const entry of entries) {
    const interactive = passCounty(entry) && passFree(entry);
    const inTop = entry.isNational || !topSet || topSet.has(entry);
    const active = interactive && inTop;
    styleMarker(
      entry.marker,
      active,
      interactive,
      entry.isNational ? NATIONAL_FILL : ACTIVE_FILL,
      entry.isNational ? 0.95 : 0.9,
    );
  }
}

// Draw the selected fylke's boundary; clear it for "all". The outline sits below
// the markers and ignores pointer events so it never blocks a marker click.
let countyBorderLayer = null;
function showCountyBorder(county) {
  if (countyBorderLayer) {
    map.removeLayer(countyBorderLayer);
    countyBorderLayer = null;
  }
  if (county === "all" || !countyGeo) return;
  const feat = countyGeo.features.find(
    (f) => (f.properties.fylkesnavn ?? f.properties.name) === county,
  );
  if (!feat) return;
  countyBorderLayer = L.geoJSON(feat, {
    interactive: false,
    style: {
      color: "#2563eb",
      weight: 2.5,
      fillColor: "#636976",
      fillOpacity: 0.06,
      dashArray: "5 4",
    },
  }).addTo(map);
  countyBorderLayer.bringToBack();
}

// Norway outline, drawn in sport mode so the country stands out against the dark
// basemap. Lazily loaded + cached on first use; non-interactive so it never
// blocks a marker click.
let norwayBorderLayer = null;
async function ensureNorwayBorder() {
  if (norwayBorderLayer) return norwayBorderLayer;
  try {
    const res = await fetch("./norge.geojson");
    if (!res.ok) return null;
    norwayBorderLayer = L.geoJSON(await res.json(), {
      interactive: false,
      style: {
        color: "#3c889d",
        weight: 1.5,
        opacity: 0.9,
        fill: false,
      },
    });
  } catch (err) {
    console.warn("Could not load norge.geojson (Norway outline disabled)", err);
    return null;
  }
  return norwayBorderLayer;
}

// Fetch every paper's articles (concurrency-limited) so the free-only filter can
// tell which markers have free results. Cached, so it only does real work once.
async function prefetchAllArticles() {
  const papers = cityMarkers.flatMap((e) => e.papers);
  if (nationalEntry) papers.push(...nationalEntry.papers);
  const queue = papers.filter((p) => !articleCache.has(p.sitekey));
  const CONCURRENCY = 6;
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const p = queue[i++];
      try {
        await fetchArticles(p);
      } catch {
        /* leave uncached; treated as unknown (stays active) */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
}

// Small status line under the controls (e.g. "Sjekker aviser…").
function setFilterStatus(text) {
  const el = document.getElementById("filter-status");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// Search box: jump the map to a matching city or paper and open its popup.
// A match clears the county filter so the target is never hidden.
function setupSearch() {
  const input = document.getElementById("search");
  const list = document.getElementById("search-list");
  if (!input || !list) return;

  for (const label of [...searchIndex.keys()].sort((a, b) => a.localeCompare(b, "nb"))) {
    const opt = document.createElement("option");
    // Title-case-ish: just reuse the stored label; datalist matching is case-insensitive.
    opt.value = label;
    list.appendChild(opt);
  }

  const go = () => {
    const hit = searchIndex.get(input.value.trim().toLowerCase());
    if (!hit) return;
    const county = document.getElementById("county");
    if (county) {
      county.value = "all";
      currentCounty = "all";
      showCountyBorder("all");
      updateMarkerStyles();
    }
    map.flyTo([hit.lat, hit.lng], 9, { duration: 0.6 });
    map.once("moveend", () => hit.marker.openPopup());
    input.value = "";
  };
  input.onchange = go; // fires when a datalist option is chosen
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

// ---- Sport mode --------------------------------------------------------

const SPORT_FILL = "#1abcea"; // direktesport cyan
const sportDate = new Intl.DateTimeFormat("nb-NO", { dateStyle: "medium" });

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// The schedule endpoint gives `sport` as an enum (no display name), so map the
// known ones to Norwegian labels and prettify unknowns (SPORT_FOO_BAR → "Foo bar").
const SPORT_NAMES = {
  SPORT_FOOTBALL: "Fotball",
  SPORT_HARNESS_RACING: "Trav",
  SPORT_GYMNASTICS: "Gymnastikk og turn",
  SPORT_MOTORSPORT_BILCROSS: "Bilcross",
  SPORT_FUNCTIONAL_FITNESS_AND_CROSSFIT: "Functional Fitness",
  SPORT_OTHER: "Øvrig sport",
};
function sportNameFromEnum(s) {
  if (!s) return "Øvrig sport";
  if (SPORT_NAMES[s]) return SPORT_NAMES[s];
  const words = s.replace(/^SPORT_/, "").replace(/_/g, " ").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Øvrig sport";
}

function mapSportProgram(p) {
  const teams = [p.homeTeam, p.awayTeam].filter(Boolean);
  let loc = null;
  for (const t of teams) {
    loc = resolveTeam(t);
    if (loc) break;
  }
  // Team-less sports (trav, seiling…) carry the place in the title instead.
  if (!loc) loc = resolveText(p.title);
  return {
    title: p.title ?? "",
    sportName: sportNameFromEnum(p.sport),
    image: p.image,
    url: p.dsUrl || "#",
    start: p.eventStartTime ? Date.parse(p.eventStartTime) : NaN,
    loc,
  };
}

// ISO-8601 week number + week-year for a date. The week-year can differ from the
// calendar year at the Dec/Jan boundary (e.g. 2026-01-01 is week 1 of 2026, but
// 2027-01-01 is week 53 of 2026), so the schedule path needs the ISO year.
function isoWeekParts(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  // Shift to the Thursday of this week — that day's year is the ISO week-year.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year, week };
}

// How many ISO weeks ahead to load. Broadcasts cluster near-term, so a bounded
// forward window keeps the default "all" view fast while covering the schedule.
const SCHEDULE_WEEKS = 10;

// Load UPCOMING programs (today onward) from the weekly schedule endpoint. We
// fetch a bounded window of ISO weeks (this week + the next SCHEDULE_WEEKS-1) in
// parallel, then keep every program dated >= today. Cached.
async function fetchSportPrograms() {
  if (sportPrograms.length) return sportPrograms;
  const today = startOfToday();
  const base = new Date(today);
  const weeks = Array.from({ length: SCHEDULE_WEEKS }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i * 7);
    return isoWeekParts(d);
  });

  const pages = await Promise.all(
    weeks.map(async ({ year, week }) => {
      try {
        const res = await fetch(`/api/sport-schedule/${year}/${week}`);
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : (data.results ?? []);
      } catch (err) {
        console.error("Sport schedule fetch failed:", year, week, err);
        return [];
      }
    }),
  );

  const out = [];
  for (const p of pages.flat()) {
    const start = p.eventStartTime ? Date.parse(p.eventStartTime) : NaN;
    if (!Number.isNaN(start) && start >= today) out.push(mapSportProgram(p));
  }
  sportPrograms = out;
  return sportPrograms;
}

function clearSportMarkers() {
  for (const m of sportMarkers) map.removeLayer(m);
  sportMarkers = [];
}

// Monday 00:00 of the week containing `ts`.
function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// [start, end) range for the active week filter, or null for "all".
function weekRange() {
  if (currentWeek === "all") return null;
  const thisStart = startOfWeek(Date.now());
  const week = 7 * 24 * 3600 * 1000;
  const start = currentWeek === "next" ? thisStart + week : thisStart;
  return [start, start + week];
}

// Render cyan pins for the located programs matching the active sport + week
// filters, stacking programs that share a location onto one marker.
function renderSportMarkers() {
  clearSportMarkers();
  const range = weekRange();
  // Programs matching the sport + week filters (regardless of whether we could
  // place them), so the note's "på kartet / uten kjent sted" counts agree.
  const matching = sportPrograms.filter(
    (p) =>
      (currentSport === "all" || p.sportName === currentSport) &&
      (!range || (p.start >= range[0] && p.start < range[1])),
  );
  const visible = matching.filter((p) => p.loc);

  const byLoc = new Map();
  for (const p of visible) {
    const key = `${p.loc.lat},${p.loc.lng}`;
    if (!byLoc.has(key))
      byLoc.set(key, { lat: p.loc.lat, lng: p.loc.lng, programs: [] });
    byLoc.get(key).programs.push(p);
  }

  for (const { lat, lng, programs } of byLoc.values()) {
    const marker = L.circleMarker([lat, lng], {
      radius: programs.length > 1 ? 8 : 6,
      color: "#01172b",
      weight: 2,
      fillColor: SPORT_FILL,
      fillOpacity: 0.9,
    }).addTo(map);
    marker.bindTooltip(
      programs.length > 1
        ? `${programs.length} sendinger`
        : programs[0].title,
      { direction: "top" },
    );
    marker.bindPopup("", POPUP_OPTS);
    marker.on("popupopen", (e) => fillSportPopup(e.popup, programs));
    sportMarkers.push(marker);
  }

  // Events we couldn't geolocate go offshore, one stacked marker per sport, so
  // they stay visible and clickable instead of vanishing from the map.
  const unplaced = matching.filter((p) => !p.loc);
  const bySport = new Map();
  for (const p of unplaced) {
    if (!bySport.has(p.sportName)) bySport.set(p.sportName, []);
    bySport.get(p.sportName).push(p);
  }
  // Stable offshore slot per sport (independent of the active filter).
  const order = [...new Set(sportPrograms.map((p) => p.sportName))].sort((a, b) =>
    a.localeCompare(b, "nb"),
  );
  for (const [sportName, programs] of bySport) {
    const lat =
      SPORT_UNKNOWN_ANCHOR[0] - order.indexOf(sportName) * SPORT_UNKNOWN_STEP;
    const marker = L.circleMarker([lat, SPORT_UNKNOWN_ANCHOR[1]], {
      radius: programs.length > 1 ? 8 : 6,
      color: "#fff",
      weight: 2,
      fillColor: SPORT_UNKNOWN_FILL,
      fillOpacity: 0.85,
    }).addTo(map);
    marker.bindTooltip(`${sportName} · ukjent sted (${programs.length})`, {
      direction: "right",
      permanent: true,
      className: "sport-unknown-label",
    });
    marker.bindPopup("", POPUP_OPTS);
    marker.on("popupopen", (e) => fillSportPopup(e.popup, programs));
    sportMarkers.push(marker);
  }

  setSportNote(
    `${visible.length} sendinger på kartet · ${unplaced.length} uten kjent sted (vist til havs)`,
  );
}

// Order a pin's programs so the soonest upcoming game is first: future events
// ascending (nearest first), then past events descending (most recent first).
function sortUpcomingFirst(a, b) {
  const now = Date.now();
  const ka = Number.isNaN(a.start) ? -Infinity : a.start;
  const kb = Number.isNaN(b.start) ? -Infinity : b.start;
  const aUp = ka >= now;
  const bUp = kb >= now;
  if (aUp !== bUp) return aUp ? -1 : 1;
  return aUp ? ka - kb : kb - ka;
}

// Render a program list into a sport pin's popup.
function fillSportPopup(popup, programs) {
  const c = document.createElement("div");
  c.className = "sport-popup";
  for (const p of [...programs].sort(sortUpcomingFirst).slice(0, 12)) {
    const a = document.createElement("a");
    a.className = "sport-prog";
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener";
    const meta = Number.isNaN(p.start)
      ? escapeHtml(p.sportName)
      : `${escapeHtml(p.sportName)} · ${sportDate.format(p.start)}`;
    a.innerHTML = `
      ${p.image ? `<img src="${escapeHtml(p.image)}" alt="" />` : ""}
      <span class="sport-prog-text">
        <span class="sport-prog-title">${escapeHtml(p.title)}</span>
        <span class="sport-prog-meta">${meta}</span>
      </span>`;
    c.appendChild(a);
  }
  popup.setContent(c);
}

// Populate the sport-type <select> once, from every sport in the loaded data.
// Team-less sports (trav, seiling, gym…) carry no location, so selecting them
// shows no pins — just the "uten kjent sted" count — but they stay selectable.
function populateSportTypes() {
  const sel = document.getElementById("sport-type");
  if (!sel || sel.dataset.filled) return;
  const sports = [
    ...new Set(sportPrograms.map((p) => p.sportName)),
  ].sort((a, b) => a.localeCompare(b, "nb"));
  for (const s of sports) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  sel.dataset.filled = "1";
}

function setSportNote(text) {
  const el = document.getElementById("sport-note");
  if (el) el.textContent = text;
}

// Show/hide all newspaper markers (city + national) as a group.
function setNewspaperMarkersVisible(visible) {
  const entries = nationalEntry ? [...cityMarkers, nationalEntry] : cityMarkers;
  for (const { marker } of entries) {
    if (visible) marker.addTo(map);
    else map.removeLayer(marker);
  }
}

async function enterSportMode() {
  if (genzMode) exitGenzMode();
  sportMode = true;
  document.body.classList.add("sport-mode");
  map.closePopup();
  if (countyBorderLayer) {
    map.removeLayer(countyBorderLayer);
    countyBorderLayer = null;
  }
  map.removeLayer(osmLayer);
  darkLayer.addTo(map);
  ensureNorwayBorder().then((b) => {
    if (b && sportMode) {
      b.setStyle({ color: "#1abcea" }); // cyan outline for sport
      b.addTo(map).bringToBack();
    }
  });
  setNewspaperMarkersVisible(false);
  setSportNote("Laster sport…");
  try {
    await fetchSportPrograms();
    populateSportTypes();
    renderSportMarkers();
  } catch (err) {
    setSportNote("Klarte ikke å laste sport.");
    console.error("Sport fetch failed:", err);
  }
}

function exitSportMode() {
  sportMode = false;
  document.body.classList.remove("sport-mode");
  map.closePopup();
  clearSportMarkers();
  if (norwayBorderLayer) map.removeLayer(norwayBorderLayer);
  map.removeLayer(darkLayer);
  osmLayer.addTo(map);
  setNewspaperMarkersVisible(true);
  updateMarkerStyles();
  showCountyBorder(currentCounty);
}

function setupSportMode() {
  const btn = document.getElementById("sport-toggle");
  if (btn) btn.onclick = () => navigate(sportMode ? "aviser" : "sport");
  const sel = document.getElementById("sport-type");
  if (sel) {
    sel.onchange = () => {
      currentSport = sel.value;
      renderSportMarkers();
    };
  }
  const week = document.getElementById("sport-week");
  if (week) {
    week.onchange = () => {
      currentWeek = week.value;
      renderSportMarkers();
    };
  }
}

// ---- genZ mode (reels) ------------------------------------------------

const REEL_FILL = "#ff2d95"; // neon hot pink

// A publication's reels are fetched lazily (on pin click) and cached by sitekey.
const reelCache = new Map(); // sitekey -> reel[]

function mapReel(r) {
  return {
    title: r.title || "",
    lead: r.leadText || "",
    poster: r.poster?.url || "",
    mp4: r.video?.src || "",
    created: r.publishedAt ? Date.parse(r.publishedAt) : NaN,
    permalink: r.permalink || "",
  };
}

async function fetchReels(sitekey) {
  if (reelCache.has(sitekey)) return reelCache.get(sitekey);
  let reels = [];
  try {
    const res = await fetch(
      `/api/reels?content=none&tail=latest&publication=${encodeURIComponent(sitekey)}`,
    );
    if (res.ok) reels = ((await res.json()).results ?? []).map(mapReel);
  } catch (err) {
    console.error("Reel fetch failed:", sitekey, err);
  }
  reelCache.set(sitekey, reels);
  return reels;
}

function clearReelMarkers() {
  for (const m of reelMarkers) map.removeLayer(m);
  reelMarkers = [];
}

// One pink pin per publication city; clicking opens the fullscreen reels viewer.
function renderReelMarkers() {
  clearReelMarkers();
  for (const { papers } of cityMarkers) {
    const { lat, lng, city } = papers[0];
    const marker = L.circleMarker([lat, lng], {
      radius: 6,
      color: "#0d0b1a",
      weight: 2,
      fillColor: REEL_FILL,
      fillOpacity: 0.9,
    }).addTo(map);
    marker.bindTooltip(city, { direction: "top" });
    marker.on("click", () => openReelsViewer(papers, city));
    reelMarkers.push(marker);
  }
  setGenzNote("Klikk en by for å se reels");
}

// ---- Fullscreen reels viewer (TikTok/Instagram style) -----------------

const reelsViewer = () => document.getElementById("reels-viewer");
const reelsTrack = () => document.getElementById("reels-track");

function reelVideos() {
  return [...reelsTrack().querySelectorAll("video")];
}

// Open the viewer and lazily load the city's reels into it.
async function openReelsViewer(papers, city) {
  const viewer = reelsViewer();
  const track = reelsTrack();
  if (!viewer || !track) return;

  track.innerHTML = '<p class="reels-status">Laster reels…</p>';
  viewer.hidden = false;
  viewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("reels-open");
  viewer.querySelector(".reels-close")?.focus();

  try {
    const lists = await Promise.all(papers.map((p) => fetchReels(p.sitekey)));
    const reels = lists.flat().sort((a, b) => b.created - a.created);
    if (!viewer.hidden) renderReels(reels, city);
  } catch (err) {
    track.innerHTML = '<p class="reels-status">Klarte ikke å laste reels.</p>';
    console.error("Reels load failed:", err);
  }
}

function renderReels(reels, city) {
  const track = reelsTrack();
  track.innerHTML = "";

  if (!reels.length) {
    track.innerHTML = '<p class="reels-status">Ingen reels her akkurat nå.</p>';
    return;
  }

  for (const v of reels) {
    const reel = document.createElement("section");
    reel.className = "reel";
    const date = Number.isNaN(v.created) ? "" : sportDate.format(v.created);
    const lead = v.lead
      ? `<p class="reel-lead">${escapeHtml(v.lead)}</p>`
      : "";
    const link = v.permalink
      ? `<a class="reel-link" href="${escapeHtml(v.permalink)}" target="_blank" rel="noopener">Se hele saken →</a>`
      : "";
    reel.innerHTML = `
      <video class="reel-video" loop playsinline preload="none"${v.poster ? ` poster="${escapeHtml(v.poster)}"` : ""}>
        ${v.mp4 ? `<source src="${escapeHtml(v.mp4)}" type="video/mp4" />` : ""}
      </video>
      <span class="reel-play" aria-hidden="true">▶</span>
      <div class="reel-caption">
        <p class="reel-by">${escapeHtml(city)}${date ? ` · ${escapeHtml(date)}` : ""}</p>
        <p class="reel-title">${escapeHtml(v.title)}</p>
        ${lead}
        ${link}
      </div>`;

    const video = reel.querySelector("video");
    video.muted = reelsMuted;
    // Tap the video area to toggle play/pause (ignore taps on the link).
    video.addEventListener("click", () => togglePlay(video, reel));
    reel.querySelector(".reel-play").addEventListener("click", () =>
      togglePlay(video, reel),
    );
    reel.addEventListener("play", () => reel.classList.remove("paused"), true);

    track.appendChild(reel);
  }

  startReelsObserver();
}

function togglePlay(video, reel) {
  if (video.paused) {
    video.play();
    reel.classList.remove("paused");
  } else {
    video.pause();
    reel.classList.add("paused");
  }
}

// Play whichever reel is in view, pause/reset the rest.
function startReelsObserver() {
  reelsObserver?.disconnect();
  reelsObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const video = entry.target.querySelector("video");
        if (!video) continue;
        if (entry.isIntersecting) {
          video.muted = reelsMuted;
          video.play().catch(() => {});
          entry.target.classList.remove("paused");
        } else {
          video.pause();
          video.currentTime = 0;
        }
      }
    },
    { root: reelsTrack(), threshold: 0.6 },
  );
  for (const reel of reelsTrack().querySelectorAll(".reel")) {
    reelsObserver.observe(reel);
  }
}

function closeReelsViewer() {
  const viewer = reelsViewer();
  if (!viewer || viewer.hidden) return;
  reelsObserver?.disconnect();
  reelsObserver = null;
  for (const v of reelVideos()) v.pause();
  reelsTrack().innerHTML = "";
  viewer.hidden = true;
  viewer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("reels-open");
}

function setReelsMuted(muted) {
  reelsMuted = muted;
  for (const v of reelVideos()) v.muted = muted;
  const btn = document.getElementById("reels-mute");
  if (btn) btn.textContent = muted ? "🔇" : "🔊";
}

function setupReelsViewer() {
  const viewer = reelsViewer();
  if (!viewer) return;
  viewer.querySelector(".reels-close")?.addEventListener("click", closeReelsViewer);
  document
    .getElementById("reels-mute")
    ?.addEventListener("click", () => setReelsMuted(!reelsMuted));
  // Click on the dimmed backdrop (outside the frame) closes.
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) closeReelsViewer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewer.hidden) closeReelsViewer();
  });
}

function setGenzNote(text) {
  const el = document.getElementById("genz-note");
  if (el) el.textContent = text;
}

// Keep both mode buttons' labels in sync (only one mode is ever active).
function refreshModeButtons() {
  const sb = document.getElementById("sport-toggle");
  const gb = document.getElementById("genz-toggle");
  if (sb) sb.textContent = sportMode ? "← Tilbake til aviser" : "⚽ Sport mode";
  if (gb) gb.textContent = genzMode ? "← Tilbake til aviser" : "✨ Gen Z mode";
}

// ---- Client-side routing (/aviser, /sport, /gen-z) --------------------

const pathForMode = (mode) =>
  mode === "sport" ? "/sport" : mode === "genz" ? "/gen-z" : "/aviser";

const modeFromPath = (path) =>
  path.startsWith("/sport") ? "sport" : path.startsWith("/gen-z") ? "genz" : "aviser";

// Switch to a mode without touching history (used on load + back/forward).
function applyMode(mode) {
  if (mode === "sport") {
    if (!sportMode) enterSportMode();
  } else if (mode === "genz") {
    if (!genzMode) enterGenzMode();
  } else {
    if (sportMode) exitSportMode();
    else if (genzMode) exitGenzMode();
  }
  refreshModeButtons();
}

// Apply a mode AND push it to the URL — used by the mode buttons.
function navigate(mode) {
  applyMode(mode);
  const path = pathForMode(mode);
  if (location.pathname !== path) history.pushState({ mode }, "", path);
}

function setupRouter() {
  window.addEventListener("popstate", () =>
    applyMode(modeFromPath(location.pathname)),
  );
  // Deep-link / refresh: enter whatever mode the current path names.
  applyMode(modeFromPath(location.pathname));
}

async function enterGenzMode() {
  if (sportMode) exitSportMode();
  genzMode = true;
  document.body.classList.add("genz-mode");
  map.closePopup();
  if (countyBorderLayer) {
    map.removeLayer(countyBorderLayer);
    countyBorderLayer = null;
  }
  map.removeLayer(osmLayer);
  darkLayer.addTo(map);
  ensureNorwayBorder().then((b) => {
    if (b && genzMode) {
      b.setStyle({ color: "#c6ff00" }); // lime outline for genZ
      b.addTo(map).bringToBack();
    }
  });
  setNewspaperMarkersVisible(false);
  renderReelMarkers();
}

function exitGenzMode() {
  genzMode = false;
  document.body.classList.remove("genz-mode");
  closeReelsViewer();
  map.closePopup();
  clearReelMarkers();
  if (norwayBorderLayer) map.removeLayer(norwayBorderLayer);
  map.removeLayer(darkLayer);
  osmLayer.addTo(map);
  setNewspaperMarkersVisible(true);
  updateMarkerStyles();
  showCountyBorder(currentCounty);
}

function setupGenzMode() {
  const btn = document.getElementById("genz-toggle");
  if (btn) btn.onclick = () => navigate(genzMode ? "aviser" : "genz");
}

async function init() {
  setupPeriodFilter();
  setupFreeFilter();
  setupTopReadsFilter();
  setupSportMode();
  setupGenzMode();
  setupReelsViewer();

  const res = await fetch("./publications.json");
  if (!res.ok) {
    console.error("Could not load publications.json", res.status);
    return;
  }
  const { local, national } = await res.json();

  // Group local papers by city (papers sharing coords stack into one marker).
  const byCity = new Map();
  for (const p of local) {
    if (!byCity.has(p.city)) byCity.set(p.city, []);
    byCity.get(p.city).push(p);
  }
  for (const [city, papers] of byCity) addCityMarker(city, papers);

  addNationalMarker(national ?? []);

  // County boundary outlines (drawn when a fylke is selected). Non-fatal if absent.
  try {
    const geoRes = await fetch("./fylker.geojson");
    countyGeo = geoRes.ok ? await geoRes.json() : null;
  } catch (err) {
    console.warn("Could not load fylker.geojson (county borders disabled)", err);
  }

  // Controls that depend on the loaded markers.
  setupCountyFilter();
  setupSearch();

  // Frame mainland Norway plus the offshore national marker.
  map.fitBounds(
    [
      [57.8, NATIONAL_MARKER_POS[1] - 0.5],
      [71.3, 31.2],
    ],
    { padding: [20, 20] },
  );

  // Enter the mode named by the URL (deep-link / refresh) + handle back/forward.
  setupRouter();
}

init();
