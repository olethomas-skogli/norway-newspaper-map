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

The dataset is already committed, so just serve and open:

```bash
./start.sh            # serves on http://localhost:8080 and opens the browser
./start.sh 3000       # custom port
./start.sh --build    # regenerate publications.json first, then serve
```

This runs `serve.mjs`, which serves the static files **and** proxies the
articles endpoint at `/articles` on the same origin — so the article popups
work without any CORS errors. Node.js is required.

Equivalently, by hand:

```bash
node serve.mjs 8080        # or just: node serve.mjs
```

> Don't use a plain static server (`python3 -m http.server`, `npx serve`) on its
> own: the bestread (articles) endpoint sends no CORS headers, so the popups
> would fail to load. `serve.mjs` exists to proxy that call same-origin.

## Adding / fixing a newspaper location

Edit `coords.mjs` (keyed by publication `domain`), then re-run
`node build-data.mjs`. Papers returned by the API with no coords entry are
printed as a "missing coords" list when you build.

## Why a server (CORS)

The `atlas-geography` list and the ACP search are browser-callable, but the
`bestread` (articles) endpoint sends no CORS headers, so a direct browser call
is blocked. `serve.mjs` proxies it at the same-origin `/articles` path, which
the page fetches — no cross-origin request, no CORS error.

## Files

- `start.sh` – serve the map locally (optional `--build` to refresh data)
- `serve.mjs` – dev server: static files + same-origin `/articles` proxy
- `index.html` – page shell (loads Leaflet from CDN)
- `style.css` – layout, popup + article styling
- `app.js` – map, markers, popup interaction, article fetch
- `build-data.mjs` – fetches the publication list, emits `publications.json`
- `coords.mjs` – `domain → { city, lat, lng }` table
- `publications.json` – generated dataset (committed)
