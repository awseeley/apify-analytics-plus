/*
 * Thin client for the same `console-backend.apify.com/actor-analytics/*`
 * endpoints the Insights page itself calls (confirmed by inspecting its own
 * network traffic). Auth is a bearer token the page attaches to its own
 * requests; we pick that value up from `token-sniffer.js` (see that file for
 * why) and reuse it for a bounded number of extra per-Actor calls.
 */
(function () {
  const BASE = "https://console-backend.apify.com/actor-analytics";
  const MAX_CONCURRENT = 5;

  let token = null;
  const waiters = [];

  function setToken(t) {
    if (!t || t === token) return;
    token = t;
    waiters.splice(0).forEach((resolve) => resolve());
  }

  function ready() {
    return token ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
  }

  function buildUrl(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, v);
    }
    return `${BASE}/${path}?${qs.toString()}`;
  }

  async function req(path, params) {
    await ready();
    const res = await fetch(buildUrl(path, params), {
      headers: {
        Authorization: token,
        Accept: "application/json",
        "x-idempotency-key": crypto.randomUUID(),
      },
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  // Runs `items.map(fn)` with at most MAX_CONCURRENT in flight, reporting
  // progress via onProgress(done, total). Never throws for a single item
  // failure — that item's result is `null` so one bad actor doesn't sink the
  // whole indexing pass.
  async function pooled(items, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = await fn(items[i], i);
        } catch {
          results[i] = null;
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // The backend expects a single comma-joined `actorIds` param; both the old
  // `actorIds[]=` form and repeated `actorIds=` params are rejected with 400.
  function joinIds(actorIds) {
    return actorIds && actorIds.length ? actorIds.join(",") : null;
  }

  self.AAP_API = {
    setToken,
    hasToken: () => !!token,
    actorBreakdown: (month, actorIds) => req("actor-breakdown", { month, actorIds: joinIds(actorIds) }),
    profitMargin: (month, actorIds) => req("profit-margin", { month, actorIds: joinIds(actorIds) }),
    runStatistics: (month, actorIds) =>
      req("run-statistics/monthly/all-users", { month, actorIds: joinIds(actorIds) }),
    pooled,
  };
})();
