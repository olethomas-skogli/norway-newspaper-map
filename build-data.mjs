// Build step: fetch the public atlas-geography publication list, join it to the
// hand-maintained coordinate table, flag national papers, and emit a static
// `publications.json` the map page loads at runtime.
//
// Run:  node map/build-data.mjs
//
// Endpoint + national heuristic mirror apps/vorwerk/frontend/fetch/usePublicationsList.ts
// (publication in > 10 counties => national). No auth required.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CITY_COORDS } from "./coords.mjs";

const ATLAS_URL =
  "https://services.api.no/api/atlas-geography/v1/latest/counties?embed=(sitekeys:publication(key,name,domain))";

// Same exclusions as the repo's usePublicationsList.ts.
const TEST_PUBLICATIONS = new Set([
  "Tangotidende",
  "Rumbarapporten",
  "Salsaposten",
  "Polkaposten",
  "Avisnavn",
]);

const NATIONAL_COUNTY_THRESHOLD = 10; // > 10 counties => national paper

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("Fetching atlas-geography publication list…");
  const res = await fetch(ATLAS_URL);
  if (!res.ok) {
    throw new Error(`atlas-geography failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();

  const counties = json.entities ?? [];
  const publications = json._embedded?.publication ?? [];
  const pubByKey = new Map(publications.map((p) => [p.key, p]));

  // Count how many counties each publication appears in (for national detection),
  // and remember the first (primary) county name for each — used as the paper's
  // region in the map's county filter. Most local papers sit in exactly one.
  const countyCount = new Map(); // key -> number of distinct counties
  const primaryCounty = new Map(); // key -> first county name seen
  for (const county of counties) {
    for (const key of county.sitekeys ?? []) {
      countyCount.set(key, (countyCount.get(key) ?? 0) + 1);
      if (!primaryCounty.has(key)) primaryCounty.set(key, county.name);
    }
  }

  const local = [];
  const national = [];
  const missingCoords = [];

  for (const pub of publications) {
    if (TEST_PUBLICATIONS.has(pub.name)) continue;
    const domain = pub.domain ?? "";
    const isNational =
      (countyCount.get(pub.key) ?? 0) > NATIONAL_COUNTY_THRESHOLD;

    if (isNational) {
      national.push({ sitekey: pub.key, name: pub.name, domain, national: true });
      continue;
    }

    const coords = CITY_COORDS[domain];
    if (!coords) {
      // Only counts as "missing" if it's an actual local paper we couldn't place.
      missingCoords.push(`${pub.name} (${domain || pub.key})`);
      continue;
    }

    local.push({
      sitekey: pub.key,
      name: pub.name,
      domain,
      city: coords.city,
      lat: coords.lat,
      lng: coords.lng,
      county: primaryCounty.get(pub.key) ?? null,
      national: false,
    });
  }

  // De-duplicate national papers by sitekey (they appear under many counties).
  const nationalUnique = Array.from(
    new Map(national.map((p) => [p.sitekey, p])).values(),
  ).sort((a, b) => a.name.localeCompare(b.name, "nb"));

  local.sort((a, b) => a.city.localeCompare(b.city, "nb"));

  const out = { generatedFrom: ATLAS_URL, local, national: nationalUnique };

  const outPath = join(__dirname, "publications.json");
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  // Summary.
  const cities = new Set(local.map((p) => p.city));
  console.log(`\n✓ Wrote ${outPath}`);
  console.log(`  Local papers placed: ${local.length} across ${cities.size} cities`);
  console.log(`  National papers:     ${nationalUnique.length}`);
  console.log(
    `    -> ${nationalUnique.map((p) => p.name).join(", ") || "(none)"}`,
  );
  if (missingCoords.length) {
    console.log(
      `\n⚠ ${missingCoords.length} local papers had no coords entry (add them to coords.mjs):`,
    );
    for (const m of missingCoords.sort()) console.log(`    - ${m}`);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
