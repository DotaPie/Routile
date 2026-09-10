<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/routile-wordmark-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/routile-wordmark-light.png">
    <img alt="Routile" src="assets/routile-wordmark-light.png" width="300">
  </picture>
</p>

<p align="center"><strong>🔗 <a href="https://routile.com">https://routile.com</a></strong></p>

It started as a small tool I needed myself, to systematically scan the roads of a given area. It's a static web page, nothing more: no backend and no build step. Road data comes straight from OpenStreetMap via the Overpass API, and all the routing happens right in your browser.

## How to use

1. **Find your spot.** Search for a place, or just pan and zoom the map.
2. **Draw the area.** Pick Rectangle, Circle or Freehand and drag on the map. Draw as many zones as you like: overlapping ones merge into a single area, separate ones are covered by the same route.
3. **Drop a start pin — optional.** Click Start, then click the map to say where the drive begins and ends. Leave it out and the route starts from the centre of your area.
4. **Choose how to drive it.** One way covers every street once; Both ways drives each one in both directions. Passes per street repeats the whole route. Split into sessions cuts the drive into outings of a given length, so a big area becomes several manageable trips.
5. **Compute route**, then **Download**.

The download is always a `.zip`, containing:

- **`routile-route.gpx`**, the whole drive as one file — or **`routile-session-01.gpx`, `-02.gpx`, …** if you split it into sessions
- **`metadata.json`**, everything the page would need to show you this route again

Use for example OsmAnd [![Android](https://img.shields.io/badge/-3DDC84?logo=android&logoColor=white)](https://play.google.com/store/apps/details?id=net.osmand) [![iOS](https://img.shields.io/badge/-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/app/osmand-maps-travel-navigate/id934850257) to navigate with GPX file.

## Opening a route again

Drop a downloaded `.zip` onto the panel at the top left, or click it to pick the file. The zones, the start pin, every setting and the route itself come straight back — the whole thing is read out of `metadata.json`, so nothing is downloaded and nothing is recomputed. A GPX file on its own carries the track but none of the settings behind it, which is what that extra file is for.

## Basemaps

Four, from the picker on the map's toolbar: OpenStreetMap light and dark, and CARTO light and dark. OpenStreetMap is the detailed one — it draws parking, shops and the rest — and its dark version is the same tiles inverted, so nothing is lost. CARTO's two are cleaner but deliberately show far less.

The CARTO pair needs a free API key, set as `CARTO_API_KEY` in [`js/config.js`](js/config.js); the key is tied to the domain you request it for. Leave it empty and the picker just offers the two OpenStreetMap maps.

---

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), place search by [Nominatim](https://nominatim.openstreetmap.org/). Map rendering by [Leaflet](https://leafletjs.com/), zip export by [JSZip](https://stuk.github.io/jszip/).
