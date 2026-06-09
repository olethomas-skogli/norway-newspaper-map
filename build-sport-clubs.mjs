// Build step: geocode the sport-event names the runtime gazetteer can't place,
// using Kartverket's official place-name API, and emit `sport-coords.generated.mjs`
// (a name/token -> [lat,lng] table the resolver merges in).
//
// Run:  node build-sport-clubs.mjs
//
// AGGRESSIVE on purpose: a club whose name isn't its town can land on a same-named
// fjord/farm/homonym. The output is committed so wrong rows can be pruned by hand.
// No auth required (Yoshi schedule + Kartverket SSR are both public).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveTeam, resolveText } from "./sport-clubs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULE = "https://services.api.no/api/video-yoshi/v1/sport/schedule";
const KARTVERKET = "https://api.kartverket.no/stedsnavn/v1/navn";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "norway-newspaper-map build-sport-clubs (github)";

const WEEKS_BACK = 8;
const WEEKS_AHEAD = 16;
// A Kartverket hit is only trusted as Norwegian when it's a real settlement —
// obscure farms/addresses sharing a foreign town's name (Østersund→a Lillestrøm
// "Gard", Romme→a Notodden "Gard") must instead route to the worldwide geocoder
// so the event lands in its real country (Sweden, Finland…).
const SETTLEMENT_TYPES = [
  "By",
  "Tettsted",
  "Tettbebyggelse",
  "Bygd",
  "Grend",
  "Kommune",
];

const FILLER = new Set(
  ("del damer menn kvinner herrer runde kamp cup nm norgesmesterskap finale " +
    "landsfinale semifinale kvartfinale i og med mot vs start målgang kveld natt " +
    "morgen liga divisjon serie sendingen sending direkte bilcross seiling " +
    "gymnastikk rytmisk individuelt internasjonale klasser partner xpress super " +
    "saturday grand prix " +
    // generic competition / category words (not places)
    "functional fitness junior master sprint senior international internasjonal " +
    "memorial invitational primetime norgescup terrengløp motbakkeløp gateritt " +
    "fellesstart vårløp midtsommertrav kobberløpet kallblodskriteriet night " +
    "klasseløpsfinaler derbykvalifiseringer landslagsuttak jubileumsdagen " +
    "påskebonanza teamgym basketballklubb volleyball skoleidrettslag bridge " +
    // country / nationality tokens (national-team matches, not a venue)
    "sverige svensk svenske norge danmark dansk finland polen ukraina nederland " +
    "skottland ecuador østerrike island nordisk finlandia")
    .split(" "),
);

const norm = (s) =>
  (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Fold Swedish diacritics to Norwegian for the STORED key only — geocoders are
// queried with the original spelling (Nominatim needs "Gävle", not "gævle").
// Runtime norm() folds the same way, so either spelling in the data matches.
const fold = (s) => s.replace(/ö/g, "ø").replace(/ä/g, "æ");

// Strip club designators + reserve markers so "Vedavåg Karmøy IL 2" -> "vedavåg karmøy".
const cleanName = (s) =>
  norm(s)
    .replace(/\b(il|fk|if|sk|ik|tf|bk|fc|cf|ff|ol)\b/g, " ")
    .replace(/\s+(2|3|ii|iii|b)\b/g, " ")
    .replace(/[.,()/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isCandidateToken = (t) =>
  t.length >= 3 && !/^\d+$/.test(t) && !/^v\d+$/.test(t) && !FILLER.has(t);

// A name plus its tokens, longest first — what we'll try to geocode in order.
function geocodeCandidates(cleaned) {
  const tokens = cleaned.split(" ").filter(isCandidateToken);
  const longestFirst = [...tokens].sort((a, b) => b.length - a.length);
  return [...new Set([cleaned, ...longestFirst])].filter((s) => s.length >= 3);
}

function isoWeekParts(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year, week };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 1e4) / 1e4;

// Each lookup returns { coords: [lat,lng], cc: "no"|"se"|… } or null, cached.
const kvCache = new Map();
const osmCache = new Map();

// Kartverket SSR (Norway only). `settlementOnly` keeps only real-settlement types
// so foreign homonyms (farms/addresses) fall through to the worldwide geocoder.
async function kartverket(query, settlementOnly) {
  const key = `${settlementOnly}:${query}`;
  if (kvCache.has(key)) return kvCache.get(key);
  let result = null;
  try {
    const res = await fetch(
      `${KARTVERKET}?${new URLSearchParams({ sok: query, treffPerSide: "10", utkoordsys: "4258" })}`,
    );
    if (res.ok) {
      let navn = (await res.json()).navn ?? [];
      if (settlementOnly)
        navn = navn.filter((n) => SETTLEMENT_TYPES.includes(n.navneobjekttype));
      const exact = navn.filter((n) => norm(n.skrivemåte) === query);
      const pick = (exact.length ? exact : navn)[0];
      const p = pick?.representasjonspunkt;
      if (p) result = { coords: [round(p.nord), round(p.øst)], cc: "no" };
    }
  } catch (err) {
    console.error(`  kartverket error for "${query}":`, err.message);
  }
  kvCache.set(key, result);
  await sleep(80);
  return result;
}

// Nominatim (worldwide), biased to the Nordics, top result by importance. This is
// what correctly sends Östersund/Solvalla/Boden → Sweden, Vermo → Finland.
async function nominatim(query) {
  if (osmCache.has(query)) return osmCache.get(query);
  let result = null;
  try {
    const res = await fetch(
      `${NOMINATIM}?${new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "1",
        addressdetails: "1",
        countrycodes: "no,se,dk,fi,is",
      })}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (res.ok) {
      const hit = (await res.json())[0];
      // Only accept genuine settlements / sport venues — drops the noise where a
      // generic word or club name matches a foreign office/shop/road/field.
      const SPORT_LEISURE = new Set([
        "stadium",
        "track",
        "sports_centre",
        "pitch",
        "horse_racing",
        "recreation_ground",
      ]);
      const ok =
        hit &&
        (hit.category === "place" ||
          (hit.category === "boundary" && hit.type === "administrative") ||
          (hit.category === "leisure" && SPORT_LEISURE.has(hit.type)));
      if (ok)
        result = {
          coords: [round(+hit.lat), round(+hit.lon)],
          cc: hit.address?.country_code ?? "??",
        };
    }
  } catch (err) {
    console.error(`  nominatim error for "${query}":`, err.message);
  }
  osmCache.set(query, result);
  await sleep(1100); // Nominatim usage policy: <= 1 request/second
  return result;
}

// Resolve one candidate name to { coords, cc } or null. Order: Norwegian
// settlement (cheap, precise) → worldwide (places foreign events) → any Kartverket
// hit (last-resort Norwegian approximation, e.g. a farm-named local club).
async function geocodeCandidate(cleaned) {
  const variants = geocodeCandidates(cleaned);
  for (const q of variants) {
    const hit = await kartverket(q, true);
    if (hit) return hit;
  }
  for (const q of [variants[0], variants[1]].filter(Boolean)) {
    const hit = await nominatim(q);
    if (hit) return hit;
  }
  for (const q of variants) {
    const hit = await kartverket(q, false);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const today = new Date();
  const events = [];
  for (let i = -WEEKS_BACK; i <= WEEKS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i * 7);
    const { year, week } = isoWeekParts(d);
    try {
      const res = await fetch(`${SCHEDULE}/${year}/${week}/json`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) events.push(...data);
      }
    } catch (err) {
      console.error(`  fetch ${year}/${week} failed:`, err.message);
    }
  }
  console.log(`Fetched ${events.length} events across ${WEEKS_BACK + WEEKS_AHEAD + 1} weeks.`);

  // Collect distinct candidate names the current resolver can't place.
  const candidates = new Set();
  for (const e of events) {
    const teams = [e.homeTeam, e.awayTeam].filter(Boolean);
    if (teams.length) {
      if (teams.some((t) => resolveTeam(t))) continue; // already placed
      for (const t of teams) {
        const c = cleanName(t);
        if (c) candidates.add(c);
      }
    } else if (e.title && !resolveText(e.title)) {
      // Team-less event: mine capitalized place-ish tokens from the title.
      for (const w of e.title.split(/[\s,/–()-]+/)) {
        // Capitalized place-ish token; allow Swedish/foreign Ö Ä Ü too.
        if (/^[A-ZÆØÅÖÄÜ][a-zæøåöäüA-ZÆØÅÖÄÜ]{3,}$/.test(w) && !FILLER.has(norm(w)))
          candidates.add(norm(w));
      }
    }
  }
  console.log(`Geocoding ${candidates.size} distinct unresolved candidates…`);

  const out = {};
  let placed = 0;
  let foreign = 0;
  const unresolved = [];
  for (const cand of candidates) {
    const hit = await geocodeCandidate(cand);
    if (hit) {
      out[fold(cand)] = hit;
      placed++;
      if (hit.cc !== "no") foreign++;
    } else {
      unresolved.push(cand);
    }
  }

  const keys = Object.keys(out).sort();
  const body = keys
    .map((k) => {
      const { coords, cc } = out[k];
      const tag = cc !== "no" ? ` // ${cc.toUpperCase()}` : "";
      return `  ${JSON.stringify(k)}: [${coords[0]}, ${coords[1]}],${tag}`;
    })
    .join("\n");
  const file = `// GENERATED by build-sport-clubs.mjs — do not edit by hand except to prune.
//
// Maps a normalized team name or place token -> [lat, lng], geocoded from the
// Yoshi sport schedule via Kartverket's place-name API (api.kartverket.no).
// Best-effort and AGGRESSIVE: a club whose name is not its town can land on a
// same-named fjord/farm/homonym. Wrong entries are safe to delete here; rerun
// \`node build-sport-clubs.mjs\` to refresh.

export const GEOCODED = {
${body}
};
`;
  await writeFile(join(__dirname, "sport-coords.generated.mjs"), file);

  console.log(`\nWrote sport-coords.generated.mjs with ${keys.length} entries.`);
  console.log(`Geocoded ${placed}/${candidates.size} candidates; ${unresolved.length} still unresolved.`);
  if (unresolved.length) {
    console.log(`\nStill unresolved (add to CLUB_ALIASES by hand if needed):`);
    console.log("  " + unresolved.sort().join(", "));
  }
}

main();
