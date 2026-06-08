// Best-effort resolver: a sport program's only location signal is its team-name
// string (the sport API carries no coordinates). We map a team name to a
// Norwegian place using two tables:
//
//   PLACE_COORDS — place name -> [lat, lng]. Used both directly and as a
//                  word/prefix gazetteer (e.g. "Grand Bodø" -> Bodø,
//                  "Mandalskameratene" -> Mandal).
//   CLUB_ALIASES — club whose name is NOT its town -> a PLACE_COORDS key
//                  (e.g. "Vålerenga" -> Oslo, "Rosenborg" -> Trondheim).
//
// Matching is deliberately conservative (exact token, or prefix only for places
// >= 5 chars) so short names like "Ås"/"Os" don't swallow "Gjelleråsen"/"Os".
// Names that don't resolve return null and are dropped from the map.
//
// Seeded from the most frequent clubs in a ~2000-program sample; grow the tables
// to improve coverage (see build-sport-clubs.mjs for the unresolved list).

export const PLACE_COORDS = {
  oslo: [59.9139, 10.7522],
  bergen: [60.3913, 5.3221],
  trondheim: [63.4305, 10.3951],
  stavanger: [58.97, 5.7331],
  kristiansand: [58.1467, 7.9956],
  tromsø: [69.6492, 18.9553],
  drammen: [59.744, 10.2045],
  fredrikstad: [59.2181, 10.9298],
  sandnes: [58.8524, 5.7352],
  sarpsborg: [59.2839, 11.1096],
  skien: [59.2096, 9.609],
  ålesund: [62.4722, 6.1495],
  sandefjord: [59.1313, 10.2167],
  haugesund: [59.4138, 5.268],
  tønsberg: [59.2674, 10.4076],
  moss: [59.434, 10.658],
  bodø: [67.2804, 14.4049],
  arendal: [58.4617, 8.7722],
  hamar: [60.7945, 11.068],
  larvik: [59.0537, 10.0357],
  halden: [59.133, 11.3875],
  lillehammer: [61.1153, 10.4662],
  molde: [62.7375, 7.1591],
  kongsberg: [59.6686, 9.65],
  gjøvik: [60.7957, 10.6915],
  kristiansund: [63.1105, 7.7281],
  jessheim: [60.1417, 11.1746],
  elverum: [60.8819, 11.5623],
  førde: [61.4524, 5.8571],
  steinkjer: [64.0149, 11.4954],
  alta: [69.9689, 23.2716],
  levanger: [63.7465, 11.299],
  stjørdal: [63.4712, 10.9216],
  egersund: [58.4517, 5.999],
  bryne: [58.7356, 5.6489],
  sogndal: [61.2294, 7.1003],
  mandal: [58.027, 7.455],
  grimstad: [58.3405, 8.5934],
  porsgrunn: [59.1405, 9.656],
  raufoss: [60.7253, 10.615],
  kongsvinger: [60.1903, 11.9962],
  hønefoss: [60.1681, 10.257],
  lørenskog: [59.9266, 10.956],
  asker: [59.833, 10.439],
  sandvika: [59.8939, 10.529],
  strømmen: [59.943, 11.0],
  lillestrøm: [59.9558, 11.0496],
  surnadal: [62.976, 8.696],
  orkanger: [63.3, 9.85],
  ulsteinvik: [62.3433, 5.849],
  jørpeland: [59.019, 6.047],
  sola: [58.887, 5.651],
  nittedal: [60.056, 10.88],
  mjøndalen: [59.753, 10.019],
  ski: [59.7195, 10.835],
  straume: [60.358, 5.117],
  os: [60.186, 5.466],
  notodden: [59.559, 9.259],
  florø: [61.5996, 5.0328],
  volda: [62.1466, 6.0717],
  narvik: [68.4385, 17.4272],
  harstad: [68.7986, 16.5415],
  ås: [59.664, 10.8],
  finnsnes: [69.2287, 17.9799],
  "mo i rana": [66.3128, 14.1428],
  trysil: [61.3107, 12.2614],
  jevnaker: [60.2426, 10.3849],
  hokksund: [59.7745, 9.9105],
  kopervik: [59.2833, 5.3008],
  lakselv: [70.0667, 24.9667],
};

export const CLUB_ALIASES = {
  vålerenga: "oslo",
  lyn: "oslo",
  frigg: "oslo",
  kjelsås: "oslo",
  skeid: "oslo",
  oppsal: "oslo",
  grorud: "oslo",
  ullern: "oslo",
  nordstrand: "oslo",
  ros: "oslo",
  "kfum oslo": "oslo",
  kfum: "oslo",
  rosenborg: "trondheim",
  ranheim: "trondheim",
  kolstad: "trondheim",
  charlottenlund: "trondheim",
  tiller: "trondheim",
  byåsen: "trondheim",
  viking: "stavanger",
  vidar: "stavanger",
  madla: "stavanger",
  ryger: "stavanger",
  "sandnes ulf": "sandnes",
  start: "kristiansand",
  fløy: "kristiansand",
  vipers: "kristiansand",
  "vipers kristiansand": "kristiansand",
  stabæk: "sandvika",
  brann: "bergen",
  sandviken: "bergen",
  loddefjord: "bergen",
  fana: "bergen",
  lysekloster: "os",
  hødd: "ulsteinvik",
  odd: "skien",
  pors: "porsgrunn",
  strømsgodset: "drammen",
  glassverket: "drammen",
  hamkam: "hamar",
  jerv: "grimstad",
  tromsdalen: "tromsø",
  fløya: "tromsø",
  ulfstind: "tromsø",
  "stjørdals-blink": "stjørdal",
  "kvik halden": "halden",
  gjelleråsen: "nittedal",
  fjellhammer: "lørenskog",
  mandalskameratene: "mandal",
  "gjøvik-lyn": "gjøvik",
  "staal jørpeland": "jørpeland",
  "ull/kisa": "jessheim",
  follo: "ski",
  sotra: "straume",
  orkla: "orkanger",
  hødd2: "ulsteinvik",
  flint: "tønsberg",
  træff: "molde",
  aalesund: "ålesund",
  skedsmo: "lillestrøm",
  senja: "finnsnes",
  junkeren: "bodø",
  rana: "mo i rana",
  bossekop: "alta",
  randesund: "kristiansand",
  rælingen: "lillestrøm",
  nybergsund: "trysil",
  porsanger: "lakselv",
};

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Drop a trailing reserve-team marker ("2", "3", "II", "B").
const stripReserve = (s) => s.replace(/\s+(2|3|ii|iii|b)$/i, "").trim();

// Places tried longest-first so the most specific name wins.
const PLACE_KEYS = Object.keys(PLACE_COORDS).sort((a, b) => b.length - a.length);

// Resolve a team name to { lat, lng } or null.
export function resolveTeam(name) {
  const n = stripReserve(norm(name));
  if (!n) return null;

  // 1. Exact club alias, then exact place.
  if (CLUB_ALIASES[n]) return coordsOf(CLUB_ALIASES[n]);
  if (PLACE_COORDS[n]) return xy(PLACE_COORDS[n]);

  // 2. Gazetteer: a place that appears as a whole token, or as a prefix of a
  //    token when the place is long enough to be unambiguous (>= 5 chars).
  const tokens = n.split(/[ /]+/);
  for (const place of PLACE_KEYS) {
    for (const t of tokens) {
      if (t === place || (place.length >= 5 && t.startsWith(place))) {
        return xy(PLACE_COORDS[place]);
      }
    }
  }
  return null;
}

const coordsOf = (placeKey) =>
  PLACE_COORDS[placeKey] ? xy(PLACE_COORDS[placeKey]) : null;
const xy = ([lat, lng]) => ({ lat, lng });
