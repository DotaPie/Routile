/* Split the waypoint list into drivable sessions.

   Waypoints are first grouped into short chunks - a few waypoints, a few
   minutes of driving - and sessions are cut at chunk boundaries. Consecutive
   chunks overlap: one chunk's last waypoint is the next one's first, so the
   sessions join up exactly with no gap and no teleport. */

/* Chunks as {i, j}: indices of the first and last waypoint. A chunk is capped
   both by waypoint count and by drive time. */
export function chunkWaypoints(wps, perChunk, maxSeconds) {
  const chunks = [];
  if (wps.length < 2) return chunks;
  const last = wps.length - 1;
  let i = 0;
  while (i < last) {
    let j = Math.min(i + perChunk + 1, last);
    // Trim for the time budget, but never below a single hop or the chunker
    // would stop making progress.
    while (j > i + 1 && wps[j].cumSeconds - wps[i].cumSeconds > maxSeconds) j--;
    chunks.push({ i, j });
    i = j;
  }
  return chunks;
}

/* Assert the chunking covers the tour with no gaps and no empty chunks. A
   chunk spanning zero tour arcs was a real bug once: the closing waypoint
   shared an arc index with the last real one, giving a 0 km leg and an empty
   GPX segment. */
export function verifyChunks(chunks, wps) {
  if (!chunks.length) {
    if (wps.length >= 2) throw new Error('waypoints present but no chunks produced');
    return;
  }
  if (chunks[0].i !== 0) throw new Error('first chunk does not start at the tour origin');
  if (chunks[chunks.length - 1].j !== wps.length - 1) throw new Error('last chunk does not end at the tour finish');
  for (let k = 1; k < chunks.length; k++) {
    if (chunks[k - 1].j !== chunks[k].i) throw new Error(`gap between chunk ${k - 1} and ${k}`);
  }
  for (const c of chunks) {
    if (wps[c.j].arcIndex <= wps[c.i].arcIndex) throw new Error(`chunk ${c.i}-${c.j} spans no tour arcs`);
  }
}

/* Batch chunks into sessions of roughly `sessionSeconds` driving. A single
   chunk longer than the budget still gets its own session rather than being
   dropped or split - it is already as small as the waypoints allow. */
export function groupSessions(chunks, wps, sessionSeconds) {
  if (sessionSeconds <= 0) throw new Error('session length must be positive');
  const seconds = (c) => Math.max(wps[c.j].cumSeconds - wps[c.i].cumSeconds, 0);
  const metres = (c) => Math.max(wps[c.j].cumMetres - wps[c.i].cumMetres, 0);

  const groups = [];
  let current = [], running = 0;
  for (const c of chunks) {
    if (current.length && running + seconds(c) > sessionSeconds) {
      groups.push(current);
      current = []; running = 0;
    }
    current.push(c);
    running += seconds(c);
  }
  if (current.length) groups.push(current);

  return groups.map((group, index) => ({
    index,
    km: Math.round(group.reduce((s, c) => s + metres(c), 0) / 10) / 100,
    minutes: Math.round(group.reduce((s, c) => s + seconds(c), 0) / 6) / 10,
    chunks: group.length,
    // Half-open range of tour arcs this session covers.
    arc_span: [wps[group[0].i].arcIndex, wps[group[group.length - 1].j].arcIndex],
  }));
}
