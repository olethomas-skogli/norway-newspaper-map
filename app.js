/* global L */
// Interactive map of Norwegian newspapers.
// - Loads publications.json (built by build-data.mjs).
// - One marker per city; national papers on a separate marker.
// - Click a paper -> fetch its top 3 most-read articles (stagehand bestread).

// The bestread (articles) endpoint blocks cross-origin browser requests, so the
// page fetches articles through the small local proxy (proxy.mjs). Start it with
// `node map/proxy.mjs`. Set to null to attempt direct calls instead.
const ARTICLES_PROXY = "http://localhost:8787";

const BESTREAD_BASE = ARTICLES_PROXY
  ? `${ARTICLES_PROXY}/articles`
  : "https://services.api.no/api/stagehand/insights/articles/bestread";

// Where to draw the "national papers" marker (offshore, clearly separate).
const NATIONAL_MARKER_POS = [60.6, 1.6];

const map = L.map("map", { minZoom: 4 }).setView([65, 14], 4);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

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

async function fetchTopArticles(paper) {
  const url = `${BESTREAD_BASE}?site_key=${encodeURIComponent(paper.sitekey)}&period=72`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bestread ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).slice(0, 3).map((d) => {
    const info = d.info ?? {};
    return {
      title: (info.title ?? "").replace(/&shy;/g, ""),
      url: absoluteUrl(info.url, paper.domain),
      imageUrl: info.image?.url,
      isPremium: !!info.isPremium,
    };
  });
}

// Reflow the Leaflet popup after its DOM content changes, so it keeps the right
// size/position instead of being torn down. `popup` is the Leaflet popup object.
const reflow = (popup) => {
  if (popup && popup.isOpen()) popup.update();
};

// Render the article list into the popup container. `heading` is the city /
// "Nasjonale aviser" label, kept so the back link can restore the chooser.
async function renderArticles(container, paper, papers, popup, heading) {
  container.innerHTML = "";

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
    const articles = await fetchTopArticles(paper);
    status.remove();

    if (!articles.length) {
      const empty = document.createElement("p");
      empty.className = "status";
      empty.textContent = "Ingen mest-leste saker akkurat nå.";
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
      link.innerHTML = `
        ${a.imageUrl ? `<img src="${escapeHtml(a.imageUrl)}" alt="" />` : ""}
        <span class="article-title">
          ${a.isPremium ? '<span class="lock">🔒 </span>' : ""}${escapeHtml(a.title)}
        </span>`;
      list.appendChild(link);
    }
    container.appendChild(list);
    reflow(popup);
  } catch (err) {
    status.className = "status error";
    status.textContent =
      "Klarte ikke å hente saker (mulig CORS-blokkering – se proxy.mjs).";
    console.error("Article fetch failed:", err);
    reflow(popup);
  }
}

// Render the list of papers for a city (or national group).
function renderPaperChooser(container, papers, heading, popup) {
  container.innerHTML = "";

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
}

async function init() {
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

  // Frame mainland Norway plus the offshore national marker.
  map.fitBounds(
    [
      [57.8, NATIONAL_MARKER_POS[1] - 0.5],
      [71.3, 31.2],
    ],
    { padding: [20, 20] },
  );
}

init();
