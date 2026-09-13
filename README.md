<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/routile-wordmark-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/routile-wordmark-light.png">
    <img alt="Routile" src="assets/routile-wordmark-light.png" width="300">
  </picture>
</p>

<p align="center"><strong>🔗 <a href="https://routile.com">https://routile.com</a></strong></p>

Draw an area, get a driving route that covers every street in it. A static web page: no backend, no build step. Road data comes from OpenStreetMap via Overpass; the routing runs in your browser.

## How to use

1. **Find your spot.** Search for a place, or pan and zoom the map.
2. **Draw the area.** Rectangle, Circle or Freehand. Zones merge where they overlap; **Subtract** crops one back out. Hold the middle or right mouse button to pan mid-shape.
3. **Drop a start pin** — optional. Without one the drive starts from the centre of your area.
4. **Choose how to drive it.** One way covers every street once; Both ways drives each one in both directions. Passes repeats the whole route. Split into sessions cuts the drive into outings of a given length.
5. **Compute route**, then **Download**.

The page remembers where you left it. A reload brings back the zones, the settings and the route; **Clear** is what forgets them.

## Edit coverage

OpenStreetMap is sometimes wrong — a one-way street tagged as two-way, a private lane tagged as public — and the route then asks you to do something you cannot legally do.

After a route is computed, the **Edit coverage** tool appears in the map's toolbar. It turns the drive into a map of streets, each painted with what you have said about it:

| | |
|---|---|
| 🟢 green | untouched |
| 🟡 amber | you set it to **Access only** — drivable, never required |
| 🔴 red | you set it to **Not driveable** — out of the route entirely |

Hover a street to pick it out, click it to open its card, choose one of the three. The route recomputes on the spot, on the same piece of map, so you can see straight away whether it helped. Your answers are saved with the route in `metadata.json` and survive a reload.

The **Coverage modifiers** figure in the results counts them.

## The download

A `.zip` stamped with the moment you asked for it, so two goes at the same area stay apart on disk:

- **`routile-route-YYYYMMDD-HHMMSS.gpx`** — the whole drive, or **`routile-session-…-01.gpx`, `-02.gpx`, …** if you split it into sessions
- **`metadata.json`** — everything needed to show you this route again

Navigate it with e.g. OsmAnd [![Android](https://img.shields.io/badge/-3DDC84?logo=android&logoColor=white)](https://play.google.com/store/apps/details?id=net.osmand) [![iOS](https://img.shields.io/badge/-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/app/osmand-maps-travel-navigate/id934850257).

Drop the `.zip` back onto the panel to open a route again — zones, start pin, settings, coverage edits and the route itself are read out of `metadata.json`, with nothing downloaded and nothing recomputed. A `.gpx` on its own carries the track but none of the settings, which is what the extra file is for.

`metadata.json` carries a `format` number. A file written to a different one is refused rather than half-loaded; recompute to get a file this version reads.

## Basemaps

OpenStreetMap light and dark, CARTO light and dark, from the picker on the map's toolbar. OpenStreetMap draws parking, shops and the rest; its dark version is the same tiles inverted. CARTO's two are cleaner but show far less.

The CARTO pair needs a free API key, set as `CARTO_API_KEY` in [`js/config.js`](js/config.js) and tied to the domain you request it for. Leave it empty and the picker offers only the two OpenStreetMap maps.

---

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), place search by [Nominatim](https://nominatim.openstreetmap.org/). Map rendering by [Leaflet](https://leafletjs.com/), zip export by [JSZip](https://stuk.github.io/jszip/).
