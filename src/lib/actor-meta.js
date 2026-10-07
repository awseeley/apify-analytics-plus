/*
 * Per-Actor quality score + maintenance notice, shared by every page that
 * shows them (Monetization's Today table and Actor-table Quality column,
 * and the Actor quality tab's list). These are the same small reads the
 * Console's own Actor quality tab makes:
 *
 *   actor-quality/scores/<id>   the score (1 request)
 *   actor/<id>/basic-info       `notice`, e.g. "UNDER_MAINTENANCE" (1 more,
 *                               only when a caller asks for it)
 *
 * Each part is kept in one storage record for TTL_MS: Apify recalculates
 * quality a few times a day, so a few hours of staleness costs nothing.
 * Classic script (no modules), like the rest of lib/.
 */
(function () {
  const KEY = "aap.actorMeta";
  const TTL_MS = 6 * 60 * 60 * 1000;
  const RETRY_MS = 30 * 60 * 1000; // after a failed read
  const KEEP_MS = 7 * 24 * 60 * 60 * 1000; // pruned from storage after this
  const NOTIFY_EVERY_MS = 500; // re-render cadence while a long batch loads

  // actorId -> { quality, percentile, qAt, qFailed, notice, nAt, nFailed };
  // null until read from storage.
  let meta = null;
  let reading = null;
  const inFlight = new Set(); // "<id>:q" / "<id>:n"
  const listeners = new Set();

  function alive() {
    try {
      return !!chrome.runtime?.id && !!chrome.storage?.local;
    } catch {
      return false;
    }
  }

  function fresh(at, failed) {
    return !!at && Date.now() - at < (failed ? RETRY_MS : TTL_MS);
  }

  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* one listener's bug shouldn't stop the others */
      }
    }
  }

  function load() {
    if (meta) return Promise.resolve();
    if (!reading) {
      reading = (async () => {
        try {
          meta = new Map(Object.entries((await chrome.storage.local.get(KEY))[KEY] || {}));
        } catch {
          meta = new Map();
        }
        notify(); // stored scores show straight away, before any refetch
      })();
    }
    return reading;
  }

  async function persist() {
    if (!alive()) return;
    try {
      // Merge over what's stored: another tab may have scored other Actors.
      const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
      const out = {};
      const newest = (m) => Math.max(m?.qAt || 0, m?.nAt || 0);
      for (const [id, m] of Object.entries(stored)) if (Date.now() - newest(m) < KEEP_MS) out[id] = m;
      for (const [id, m] of meta) if (Date.now() - newest(m) < KEEP_MS && newest(m) >= newest(out[id])) out[id] = m;
      await chrome.storage.local.set({ [KEY]: out });
    } catch {
      /* orphaned script: nothing to persist to */
    }
  }

  // Fetches whatever is missing or stale for `ids` (5 in flight at most, via
  // AAP_API.pooled). Safe to call on every poll tick: fresh and in-flight
  // parts are skipped. onProgress(done, total) reports a batch's progress.
  async function ensure(ids, { notice = false, onProgress } = {}) {
    if (!alive()) return;
    await load();
    const jobs = [];
    for (const id of new Set(ids)) {
      const m = meta.get(id) || {};
      const q = !fresh(m.qAt, m.qFailed) && !inFlight.has(`${id}:q`);
      const n = notice && !fresh(m.nAt, m.nFailed) && !inFlight.has(`${id}:n`);
      if (q || n) jobs.push({ id, q, n });
    }
    if (!jobs.length) return;
    const flights = jobs.flatMap((j) => [j.q && `${j.id}:q`, j.n && `${j.id}:n`].filter(Boolean));
    flights.forEach((f) => inFlight.add(f));
    let notifiedAt = 0;
    await AAP_API.pooled(
      jobs,
      async ({ id, q, n }) => {
        const [qr, nr] = await Promise.allSettled([q ? AAP_API.actorQuality(id) : null, n ? AAP_API.actorBasicInfo(id) : null]);
        const m = { ...meta.get(id) };
        if (q) {
          const v = qr.status === "fulfilled" ? qr.value : null;
          m.qFailed = typeof v?.actorQuality !== "number";
          if (!m.qFailed) {
            m.quality = v.actorQuality;
            m.percentile = typeof v.actorQualityPercentile === "number" ? v.actorQualityPercentile : null;
          }
          m.qAt = Date.now();
        }
        if (n) {
          const v = nr.status === "fulfilled" ? nr.value : null;
          m.nFailed = !v;
          if (v) m.notice = v.notice || "NONE";
          m.nAt = Date.now();
        }
        meta.set(id, m);
        if (Date.now() - notifiedAt > NOTIFY_EVERY_MS) {
          notifiedAt = Date.now();
          notify();
        }
      },
      onProgress,
    );
    flights.forEach((f) => inFlight.delete(f));
    await persist();
    notify();
  }

  // The coloured score badge every page uses: green 75+, amber 50+, red
  // below, percentile on hover; "…" while loading, "–" when it failed.
  function badgeHtml(m) {
    if (m?.quality == null) {
      return m?.qAt ? `<span class="aap-acq-dim" title="Couldn't load the quality score">–</span>` : `<span class="aap-acq-dim" title="Loading…">…</span>`;
    }
    const score = Math.round(m.quality * 100);
    const tone = score >= 75 ? "good" : score >= 50 ? "mid" : "low";
    let title = `Actor quality ${score}/100`;
    if (m.percentile != null) title += `, better than ${Math.round(m.percentile * 100)}% of Actors on the platform`;
    return `<span class="aap-hl-q aap-hl-q-${tone}" title="${title}">${score}</span>`;
  }

  self.AAP_META = {
    get: (id) => meta?.get(id) || null,
    ensure,
    load,
    onChange: (fn) => listeners.add(fn),
    badgeHtml,
    KEY,
  };
})();
