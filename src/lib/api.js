/*
 * Thin client for the same `console-backend.apify.com/actor-analytics/*`
 * endpoints the Insights page itself calls (confirmed by inspecting its own
 * network traffic). Auth is a bearer token the page attaches to its own
 * requests; we pick that value up from `token-sniffer.js` (see that file for
 * why) and reuse it for a bounded number of extra per-Actor calls.
 *
 * We don't issue the requests from here. This file runs in the isolated
 * content-script world, where a cross-origin fetch needs a `host_permissions`
 * grant for the target; `token-sniffer.js` runs in the page's own world,
 * where the very same request is just another console.apify.com call. So we
 * build the URL and hand it over an event, and the extension ships with no
 * host permission at all.
 */
(function () {
  const HOST = "https://console-backend.apify.com";
  const BASE = `${HOST}/actor-analytics`;
  const MAX_CONCURRENT = 5;

  // Only a readiness gate now that the MAIN world holds the copy it actually
  // sends: a token here means the page has authenticated at least one request
  // of its own, so there is something for the bridge to reuse.
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

  function buildUrl(path, params, base = BASE) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, v);
    }
    return `${base}/${path}?${qs.toString()}`;
  }

  // ---- Bridge to the MAIN-world fetcher ---------------------------------
  const CALL_EVENT = "aap-api-call";
  const RESULT_EVENT = "aap-api-result";
  // Generous: a cold per-Actor pass runs 5 of these at once and the backend
  // is not always quick. This only exists so a reply that never arrives (a
  // browser without MAIN-world content scripts, say) fails instead of
  // wedging the indexing pass forever.
  const CALL_TIMEOUT_MS = 60_000;

  let seq = 0;
  const pending = new Map();

  window.addEventListener(RESULT_EVENT, (event) => {
    const detail = (event && event.detail) || {};
    const entry = pending.get(detail.id);
    if (!entry) return;
    pending.delete(detail.id);
    clearTimeout(entry.timer);
    entry.settle(detail);
  });

  // Firefox puts an Xray wrapper between the two worlds, so an object minted
  // here is opaque to the MAIN-world listener unless it's explicitly cloned
  // into the page's realm. `cloneInto` is a Firefox-only content-script
  // global; Chrome needs nothing and doesn't define it.
  function toPageRealm(detail) {
    return typeof cloneInto === "function" ? cloneInto(detail, window) : detail;
  }

  function call(url) {
    const id = `${Date.now()}.${seq++}`;
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        settle({ error: "timeout" });
      }, CALL_TIMEOUT_MS);
      pending.set(id, { settle, timer });
      window.dispatchEvent(new CustomEvent(CALL_EVENT, { detail: toPageRealm({ id, url }) }));
    });
  }

  // Transport-level failures (offline, DNS/TLS hiccup, connection reset, no
  // answer at all) get a couple of short retries; an HTTP error status does
  // not — the backend answered, retrying won't change it. Nor does a refusal
  // from the bridge itself, which retrying can't fix either.
  const NETWORK_RETRIES = 2;
  const RETRYABLE = new Set(["network", "timeout"]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function req(path, params, base) {
    await ready();
    const url = buildUrl(path, params, base);
    for (let attempt = 0; ; attempt++) {
      const res = await call(url);
      if (res.error) {
        if (!RETRYABLE.has(res.error) || attempt >= NETWORK_RETRIES) {
          throw new Error(`${path} -> ${res.error}`);
        }
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return JSON.parse(res.body);
    }
  }

  // Runs `items.map(fn)` with at most MAX_CONCURRENT in flight, reporting
  // progress via onProgress(done, total). Never throws for a single item
  // failure — that item's result is `null` so one bad actor doesn't sink the
  // whole indexing pass. `shouldStop()` is checked before each item so a
  // pass that's been superseded (the user switched month/range mid-index)
  // stops spending requests instead of finishing a result nobody will use;
  // unstarted items are left `undefined`.
  async function pooled(items, fn, onProgress, shouldStop) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    async function worker() {
      while (next < items.length) {
        if (shouldStop && shouldStop()) return;
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
    // Acquisition tab. monthStartAt is "YYYY-MM-01"; portion (0..1] asks for
    // only the first part of that month, the way the page builds its own
    // pro-rated comparison baseline. An empty `actorIds=` means all Actors,
    // which is exactly what the page itself sends.
    monthlyMarketing: (monthStartAt, actorIds, portion) =>
      req("monthly-marketing", {
        actorIds: joinIds(actorIds) || "",
        monthStartAt: `${String(monthStartAt).slice(0, 7)}-01T00:00:00.000Z`,
        portionOfMonthElapsed: portion == null ? null : String(portion),
      }),
    // Every Actor the account owns (id, name, title, pictureUrl), the same
    // list the Acquisition tab's Actor filter shows.
    ownedActors: () => req("find-users-owned-actors-by-text", { text: "" }, `${HOST}/actors`),
    // The Actor quality tab's score card: { actorQuality: 0..1,
    // actorQualityPercentile: 0..1, hasReadme, ... }. The Console shows it
    // as round(actorQuality * 100) out of 100.
    actorQuality: (actorId) => req(`scores/${encodeURIComponent(actorId)}`, {}, `${HOST}/actor-quality`),
    // The Actor's own settings record; we only read `notice`
    // ("NONE" | "UNDER_MAINTENANCE") from it.
    actorBasicInfo: (actorId) => req(`${encodeURIComponent(actorId)}/basic-info`, {}, `${HOST}/actor`),
    pooled,
  };
})();
