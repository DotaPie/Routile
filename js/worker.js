/* Background compute. The heavy work is tight graph loops that would freeze
   the page for seconds, so it runs here and reports progress by message. */

import { openCache } from './cache.js';
import { compute, parseRequest, requestKey } from './pipeline.js';

const cacheReady = openCache();

self.onmessage = async (ev) => {
  const { id, payload } = ev.data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    const req = parseRequest(payload);
    const cache = await cacheReady;
    const key = requestKey(req);
    const hit = await cache.get('results', key);
    if (hit) {
      post({ type: 'done', result: hit, cached: true });
      return;
    }
    const result = await compute(req, {
      cache,
      progress: (phase, message, fraction) => post({ type: 'progress', phase, message, fraction }),
    });
    await cache.put('results', key, result);
    post({ type: 'done', result, cached: false });
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
