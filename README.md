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

The download is always a `.zip` — `routile-route-YYYYMMDD-HHMMSS.zip`, stamped with the moment you asked for it — containing:

- **`routile-route-YYYYMMDD-HHMMSS.gpx`**, the whole drive as one file — or **`routile-session-YYYYMMDD-HHMMSS-01.gpx`, `-02.gpx`, …** if you split it into sessions
- **`metadata.json`**, everything the page would need to show you this route again

The stamp is your own clock, and the same one throughout a download, so two goes at the same area stay apart on disk and every file says which go it belongs to.

Use for example OsmAnd [![Android](https://img.shields.io/badge/-3DDC84?logo=android&logoColor=white)](https://play.google.com/store/apps/details?id=net.osmand) [![iOS](https://img.shields.io/badge/-0D96F6?logo=apple&logoColor=white)](https://apps.apple.com/app/osmand-maps-travel-navigate/id934850257) to navigate with GPX file.

## Turns

The route is planned over the *movements* through a junction, not just the roads
between them, so it doesn't ask for things you can't legally do: no turning round
in the middle of a street, and no turns OpenStreetMap marks as banned. Where a
street has to be covered in both directions it goes round the block instead.

Three manoeuvres look alike on a map and are not alike to drive, so they're
priced apart. Leaving a street on the same tarmac you arrived on is the illegal
one, and it's effectively banned. A hairpin onto a *different* road — a slip
lane, the far carriageway of a dual road — is legal but awkward, so it's avoided
where something better exists. Turning at a dead end is free, because there is
nothing else to do there.

Over the 39 km² I measure against, that leaves 5 same-tarmac reversals in a
one-way route and 16 in a both-ways one, against 25 and 42 before — and every
one that remains is at a junction where the road layout allows nothing else.
Raising the price to the equivalent of a 28-hour detour doesn't remove a single
one. The cost of getting there is about 5% more driving, spent on extra passes
over streets already covered.

Angles are measured over 15 m of road at each side of a junction rather than off
the first shape point, which at a finely mapped junction can be a five-metre stub
pointing somewhere the road doesn't go.

## Which roads count

The public streets a car may use. Private roads are off by default — the
driveways, yards and parking aisles behind a gate are somebody's property — and
the toggle turns them on for an industrial estate or a gated development.

Plain service roads (`highway=service` with no further tag: the access road
through an estate, not a car-park aisle) are always downloaded, but only ever as
*connectors*. The route may drive along one to get somewhere; it is never asked
to cover one. Without them, a street whose only link to the network is a service
road belongs to no reachable component at all and quietly disappears from the
coverage — and no amount of extra download margin fixes that, because those
streets are in the middle of the area, not at its edge.

A connector is also priced as a last resort rather than a shortcut, which is not
a detail. The service crossings through the central reservation of a dual
carriageway are mapped as ordinary service roads and look to a solver like a free
U-turn across a fast road; on the ground they are signed no-entry. Nothing in the
data separates one of those from a legitimate access road, so the rule is that a
connector is only worth driving when there is no alternative — which is exactly
the case it exists for.

## Opening a route again

Drop a downloaded `.zip` onto the panel at the top left, or click it to pick the file. The zones, the start pin, every setting and the route itself come straight back — the whole thing is read out of `metadata.json`, so nothing is downloaded and nothing is recomputed. A GPX file on its own carries the track but none of the settings behind it, which is what that extra file is for.

## Basemaps

Four, from the picker on the map's toolbar: OpenStreetMap light and dark, and CARTO light and dark. OpenStreetMap is the detailed one — it draws parking, shops and the rest — and its dark version is the same tiles inverted, so nothing is lost. CARTO's two are cleaner but deliberately show far less.

The CARTO pair needs a free API key, set as `CARTO_API_KEY` in [`js/config.js`](js/config.js); the key is tied to the domain you request it for. Leave it empty and the picker just offers the two OpenStreetMap maps.

---

Road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), place search by [Nominatim](https://nominatim.openstreetmap.org/). Map rendering by [Leaflet](https://leafletjs.com/), zip export by [JSZip](https://stuk.github.io/jszip/).
