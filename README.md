# Avisene i Norge – interactive map

A standalone, vanilla-JS map of Norwegian newspapers built with
[Leaflet](https://leafletjs.com/) + OpenStreetMap (free, no API key).

- One marker per **city**. Cities with several papers let you pick which one.
- **National** papers (Nettavisen, Nationen, Bondebladet, …) sit on a separate
  offshore marker.
- Click a paper → its **top 3 most-read articles** (last 72 h) load in the popup.

All data comes from Amedia's public (no-auth) APIs:

| Data | Endpoint |
|---|---|
| Publication list + geography + national flag | `atlas-geography/v1/latest/counties` |
| Top articles per paper | `stagehand/insights/articles/bestread?site_key=…&period=72` |

## Run

```bash
# 1. (Re)generate the dataset — fetches the publication list and joins coords.
node map/build-data.mjs

# 2. Serve the folder (any static server works); then open the page.
npx serve map        # or: python3 -m http.server -d map 8080
```

Opening `index.html` directly via `file://` also works for the map, but the
`fetch("./publications.json")` call needs an `http://` origin, so use a static
server.

## Adding / fixing a newspaper location

Edit `map/coords.mjs` (keyed by publication `domain`), then re-run
`node map/build-data.mjs`. Papers returned by the API with no coords entry are
printed as a "missing coords" list when you build.

## CORS fallback

`atlas-geography` and the ACP search are already browser-callable. If the
`bestread` (articles) request is blocked by CORS in the browser:

```bash
node map/proxy.mjs    # http://localhost:8787
```

Then set `ARTICLES_PROXY = "http://localhost:8787"` at the top of `app.js`.

## Files

- `index.html` – page shell (loads Leaflet from CDN)
- `style.css` – layout, popup + article styling
- `app.js` – map, markers, popup interaction, article fetch
- `build-data.mjs` – fetches the publication list, emits `publications.json`
- `coords.mjs` – `domain → { city, lat, lng }` table
- `publications.json` – generated dataset (committed)
- `proxy.mjs` – optional CORS fallback for the articles endpoint
