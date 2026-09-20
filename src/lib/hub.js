/*
 * Apify Hub sync (optional). With a hub key configured in the popup's
 * settings, the per-day-per-actor matrix this extension already builds is
 * POSTed to Apify Hub's /v1/insights-ingest so its analytics can show the
 * developer's ACTUAL Apify cost (the public Apify API never exposes it for
 * customers' runs). Off unless a key is saved; the Console token is never
 * sent anywhere — only the derived numbers are.
 *
 * Once a key exists the sync is unconditional and covers the whole account
 * history, not just the month on screen: the hub can only reconcile a day it
 * was given, and a month costs nothing to re-offer (see needsSync — an
 * unchanged month is never re-sent). The endpoint is fixed; a local hub is
 * configured by writing aap.hub.endpoint into chrome.storage from the
 * service worker console, not by a field users have to leave alone.
 */
(function () {
  const KEYS = {
    key: "aap.hub.key",
    endpoint: "aap.hub.endpoint", // dev override only; no UI
    lastSync: "aap.hub.lastSync", // { [month]: { at, ok, message, sig, empty } }
  };
  const DEFAULT_ENDPOINT = "https://notable-toad-601.convex.site";
  const ALL_ACTORS = "__all__";

  async function settings() {
    // An orphaned content script (extension reloaded under the page) has no
    // chrome.storage; report "no key" rather than throwing from a .then().
    let r = {};
    try {
      r = await chrome.storage.local.get([KEYS.key, KEYS.endpoint]);
    } catch {
      return { key: "", endpoint: DEFAULT_ENDPOINT };
    }
    return {
      key: (r[KEYS.key] || "").trim(),
      endpoint: ((r[KEYS.endpoint] || DEFAULT_ENDPOINT).trim()).replace(/\/+$/, ""),
    };
  }

  async function lastSync() {
    try {
      return (await chrome.storage.local.get(KEYS.lastSync))[KEYS.lastSync] || {};
    } catch {
      return {};
    }
  }

  async function writeLastSync(month, record) {
    try {
      const prev = await lastSync();
      await chrome.storage.local.set({ [KEYS.lastSync]: { ...prev, [month]: record } });
    } catch {
      /* orphaned script: the sync itself already happened (or failed) above */
    }
  }

  // daily:      { [day]: [{ actorId, name, revenue, cost, profit, runs, results }] }
  // dayMetrics: { [day]: { revenue, cost, profit, runs, results } } (account-wide)
  // breakdown:  raw actor-breakdown items for the month (per-actor totals)
  function buildPayload(month, daily, dayMetrics, breakdown) {
    const days = [];
    for (const [day, rows] of Object.entries(daily || {})) {
      for (const r of rows) {
        if (!r.actorId) continue;
        days.push({
          day,
          actorId: r.actorId,
          actorName: r.name,
          payingCostUsd: r.cost || 0,
          payingRevenueUsd: r.revenue || 0,
          payingProfitUsd: r.profit || 0,
          runs: r.runs ?? undefined,
          results: r.results ?? undefined,
        });
      }
    }
    for (const [day, m] of Object.entries(dayMetrics || {})) {
      days.push({
        day,
        actorId: ALL_ACTORS,
        payingCostUsd: m.cost || 0,
        payingRevenueUsd: m.revenue || 0,
        payingProfitUsd: m.profit || 0,
        runs: m.runs ?? undefined,
        results: m.results ?? undefined,
      });
    }
    const actors = (breakdown || [])
      .map((item) => {
        const id = item.actor && item.actor._id;
        if (!id) return null;
        const e = item.earningsStats || {};
        const rs = item.runsStats || {};
        const us = item.usersStats || {};
        return {
          actorId: id,
          actorName: item.actor.title || item.actor.name || id,
          revenueUsd: e.totalRevenueUsd || 0,
          costUsd: e.totalCostUsd || 0,
          profitUsd: e.totalProfitUsd || 0,
          runs: rs.TOTAL ?? undefined,
          succeeded: rs.SUCCEEDED ?? undefined,
          failed: rs.FAILED ?? undefined,
          results: rs.RESULTS ?? undefined,
          freeUsers: us.freeUsers ?? undefined,
          payingUsers: us.payingUsers ?? undefined,
        };
      })
      .filter((a) => a && (a.revenueUsd > 0 || a.costUsd > 0 || (a.runs || 0) > 0));
    return { source: "apify-analytics-plus", month, days, actors };
  }

  // Cheap content signature for a month's payload: row counts plus the sums
  // the hub actually stores. Two genuinely different months would have to
  // agree on all five numbers to collide, and a stale signature only ever
  // costs one redundant POST (the ingest is an idempotent upsert).
  function payloadSig(body) {
    let cost = 0;
    let revenue = 0;
    let runs = 0;
    for (const d of body.days) {
      cost += d.payingCostUsd || 0;
      revenue += d.payingRevenueUsd || 0;
      runs += d.runs || 0;
    }
    for (const a of body.actors) {
      cost += a.costUsd || 0;
      revenue += a.revenueUsd || 0;
      runs += a.runs || 0;
    }
    return `${body.days.length}/${body.actors.length}/${cost.toFixed(4)}/${revenue.toFixed(4)}/${runs}`;
  }


  // A fetch that never reached a server (status 0) says nothing useful on its
  // own — "Failed to fetch" covers DNS, a refused connection and a blocked
  // cross-origin request alike. Name the host, and say when it's a leftover
  // dev override rather than the real hub, since that's the usual cause and
  // there is no endpoint field to notice it in.
  function failureMessage(resp, endpoint) {
    const status = resp ? resp.status : 0;
    const text = resp ? resp.text : "no response";
    if (status) return `HTTP ${status}: ${text}`;
    let host = endpoint;
    try {
      host = new URL(endpoint).host;
    } catch {
      /* keep the raw string */
    }
    const override = endpoint !== DEFAULT_ENDPOINT ? ". A custom endpoint is set; reset it in the popup" : "";
    return `couldn't reach ${host} (${text})${override}`;
  }

  // month is "YYYY-MM-01" (the page's param) or "YYYY-MM".
  function monthKey(month) {
    return String(month).slice(0, 7);
  }

  // A month nothing happened in: remembered so the history walk stops
  // re-deriving it, without claiming a POST that never went out.
  async function markEmpty(month) {
    const m = monthKey(month);
    await writeLastSync(m, { at: Date.now(), ok: true, empty: true, sig: "empty", message: "no activity" });
    return { skipped: true, message: "no activity" };
  }

  // send() with `skipUnchanged` re-sends a month only when its numbers moved
  // since the last successful push, so re-walking the account's whole history
  // on every page load is (after the first pass) free.
  async function send(month, daily, dayMetrics, breakdown, opts) {
    const s = await settings();
    if (!s.key) return { skipped: true, message: "no hub key" };
    const body = buildPayload(monthKey(month), daily, dayMetrics, breakdown);
    const sig = payloadSig(body);
    if (opts && opts.skipUnchanged) {
      const prev = (await lastSync())[body.month];
      if (prev && prev.ok && prev.sig === sig) {
        return { skipped: true, unchanged: true, ok: true, message: "already synced" };
      }
    }
    const resp = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "AAP_HUB_SYNC", url: `${s.endpoint}/v1/insights-ingest`, key: s.key, body },
          (r) => resolve(chrome.runtime.lastError ? { ok: false, status: 0, text: chrome.runtime.lastError.message } : r),
        );
      } catch (err) {
        resolve({ ok: false, status: 0, text: String(err) });
      }
    });
    const ok = !!(resp && resp.ok);
    // The ingest answers with whether this month falls inside the range the
    // hub has ingested runs for. Outside it the rows are stored but nothing
    // displays them, which is worth saying instead of reporting a sync that
    // visibly changes nothing.
    let covered;
    try {
      const parsed = JSON.parse(resp.text);
      if (typeof parsed.covered === "boolean") covered = parsed.covered;
    } catch {
      /* older hub, or an error body: no coverage info */
    }
    const result = {
      at: Date.now(),
      ok,
      sig: ok ? sig : undefined,
      covered,
      message: ok
        ? `synced ${body.days.length} day rows, ${body.actors.length} actors${covered === false ? " (stored; no runs ingested yet)" : ""}`
        : failureMessage(resp, s.endpoint),
    };
    await writeLastSync(body.month, result);
    return result;
  }

  self.AAP_HUB = { KEYS, DEFAULT_ENDPOINT, settings, lastSync, buildPayload, payloadSig, monthKey, markEmpty, send };
})();
