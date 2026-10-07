/*
 * Enhances https://console.apify.com/actors/insights/acquisition, the
 * Insights tab that shows a month's funnel (Actor detail viewers -> Input
 * page viewers -> people who started the Actor) plus the top 10 referrers
 * and countries. All of it comes from one endpoint,
 * `actor-analytics/monthly-marketing`, which takes the same comma-joined
 * `actorIds` filter as the Monetization endpoints. We add:
 *
 *   1. Conversion rates on the native funnel cards, with the change in
 *      points against the previous month.
 *   2. A per-Actor funnel table (one monthly-marketing call per Actor), so
 *      you can see which listing loses people, not just that the account
 *      does.
 *   3. Quality flags on that table: views up but starts flat, very low
 *      conversion, and traffic concentrated in one country.
 *   4. Referrer / country changes against the previous month (point deltas,
 *      "new" entries, and what dropped out of the top 10).
 *   5. A label for the blank referrer row ("Direct / unknown") and a note
 *      that referrer shares overlap, so they add up to more than 100%.
 *
 * Kept apart from app.js (the Monetization tab) on purpose: that file is a
 * canvas overlay with its own range machinery, none of which applies here.
 * Shared pieces are the token bridge (lib/api.js), the cache (lib/cache.js)
 * and the formatters (lib/format.js).
 *
 * Unlike the Monetization tab, this one keeps its state in the URL
 * (`?timePeriod=YYYY-MM&actorId=...`), so the month and filter are read
 * from there on every poll tick.
 */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/acquisition\/?$/;
  const onRoute = () => ROUTE_RE.test(location.pathname);

  const TABLE_PAGE = 20;
  // Flags need enough people behind them to mean something.
  const FLAG_MIN_PREV_VIEWS = 20; // views-up-runs-flat: last month's viewers at this month's pace
  const FLAG_MIN_VIEWS_LOW_CONV = 100;
  const FLAG_MIN_VIEWS_COUNTRY = 50;
  const FLAG_VIEW_GROWTH = 1.5; // viewers at least +50%...
  const FLAG_RUN_GROWTH = 1.1; // ...while starts grew 10% or less
  const FLAG_LOW_CONV_RATIO = 0.4; // detail->run below 40% of the account's rate
  const FLAG_COUNTRY_SHARE = 60; // one country at 60%+ of viewers

  const REFRESH_MS = 60 * 60 * 1000;

  const PREF_ACTORS = "aap.acqActorsOn"; // false hides the per-Actor table; absent = shown

  const PANEL_ACTORS = "aap-acq-actors";
  const MARK = "aap-acq-mark"; // every node we add to Apify's own DOM carries this

  const regionName = (() => {
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      return (code) => {
        try {
          return dn.of(code) || code;
        } catch {
          return code;
        }
      };
    } catch {
      return (code) => code;
    }
  })();

  // ---- dates (Apify's months are UTC) -------------------------------------
  const curMonth = () => new Date().toISOString().slice(0, 7) + "-01";
  function addMonths(month, n) {
    const d = new Date(String(month).slice(0, 7) + "-01T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  }
  const shortMonth = (m) =>
    new Date(String(m).slice(0, 7) + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

  // Share of the current month already over, counted in whole days the way
  // the page's own comparison call does (Sep 27 -> 26/30). 1 for past months.
  function portionElapsed(month) {
    if (month !== curMonth()) return 1;
    const now = new Date();
    const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    return (now.getUTCDate() - 1) / days;
  }

  // ---- page state -----------------------------------------------------------
  function currentOrg() {
    return (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "";
  }

  // Month + Actor filter, straight from the page URL.
  function pageView() {
    const q = new URLSearchParams(location.search);
    const tp = q.get("timePeriod");
    const month = tp && /^\d{4}-\d{2}$/.test(tp) ? `${tp}-01` : curMonth();
    const ids = q
      .getAll("actorId")
      .concat(q.getAll("actorIds"))
      .flatMap((v) => v.split(","))
      .filter(Boolean);
    return { month, actorIds: [...new Set(ids)].sort(), org: currentOrg() };
  }

  const viewKey = (v) => `${v.org}|${v.month}|${v.actorIds.join(",")}`;
  const totalsScope = (v) => (v.org ? v.org + "|" : "") + v.actorIds.join(",");

  // ---- prefs / lifecycle ----------------------------------------------------
  let actorsOn = true;
  chrome.storage.local
    .get([PREF_ACTORS])
    .then((r) => {
      actorsOn = r[PREF_ACTORS] !== false;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PREF_ACTORS]) actorsOn = changes[PREF_ACTORS].newValue !== false;
  });

  let retired = false;
  function contextAlive() {
    if (retired) return false;
    try {
      return !!chrome.runtime?.id && !!chrome.storage;
    } catch {
      return false;
    }
  }
  function savePref(obj) {
    if (!contextAlive()) return;
    try {
      chrome.storage.local.set(obj).catch(() => {});
    } catch {
      /* orphaned */
    }
  }

  // app.js already relays the token into AAP_API; asking again is harmless
  // and covers the case where only this script is running on the page.
  window.addEventListener("aap-token", (e) => AAP_API.setToken(e.detail));
  window.dispatchEvent(new Event("aap-request-token"));

  // ---- data -----------------------------------------------------------------
  // Everything loaded for the view on screen. Replaced wholesale when the
  // month / filter / account changes; async work checks `gen` before landing.
  let data = null;
  let gen = 0;

  function emptyData(view) {
    return {
      key: viewKey(view),
      view,
      totals: {}, // month -> monthly-marketing response (for this filter)
      totalsLoading: true,
      actors: null, // [{ id, title, name, pictureUrl }]
      stats: {}, // id -> { v, i, r, cc: [[code, pct]] } for view.month
      prevStats: {}, // id -> same, previous month
      actorsProgress: null, // { done, total } while the per-Actor pass runs
      actorsError: null,
      totalsError: null,
      loadedAt: Date.now(),
    };
  }

  const pick = (res) => ({
    v: res.numUniqueViewingUsers || 0,
    i: res.numUniqueConsolePageViews || 0,
    r: res.numUniqueUsersWithRun || 0,
    cc: (res.topCountryCodes || []).slice(0, 3).map((c) => [c.origin, c.trafficPercent]),
  });

  async function loadTotal(month, view) {
    const scope = totalsScope(view);
    const cached = await AAP_CACHE.getAcq("total", month, scope);
    if (cached && !cached.stale) return cached.res;
    try {
      const res = await AAP_API.monthlyMarketing(month, view.actorIds);
      await AAP_CACHE.setAcq("total", month, scope, { res });
      return res;
    } catch (err) {
      if (cached) return cached.res; // stale beats nothing
      throw err;
    }
  }

  async function loadActorList(org) {
    const cached = await AAP_CACHE.getAcq("list", curMonth(), org);
    if (cached && !cached.stale) return cached.actors;
    try {
      const list = await AAP_API.ownedActors();
      const actors = (Array.isArray(list) ? list : [])
        .map((a) => ({ id: a.id || a._id, name: a.name, title: a.title || a.name, pictureUrl: a.pictureUrl || null }))
        .filter((a) => a.id);
      await AAP_CACHE.setAcq("list", curMonth(), org, { actors });
      return actors;
    } catch (err) {
      if (cached) return cached.actors;
      throw err;
    }
  }

  // Per-Actor stats for one month. The record accumulates: a month first
  // fetched only for some Actors (the previous month, fetched just for the
  // ones a flag could apply to) gets the rest filled in later rather than
  // refetched. A stale record is refetched in full for the ids asked for.
  async function loadActorStats(month, org, ids, myGen, onProgress) {
    const cached = await AAP_CACHE.getAcq("actors", month, org);
    const rows = cached && !cached.stale ? { ...cached.rows } : {};
    const missing = ids.filter((id) => !rows[id]);
    if (!missing.length) return rows;
    let sinceSave = 0;
    const save = () => AAP_CACHE.setAcq("actors", month, org, { rows });
    await AAP_API.pooled(
      missing,
      async (id) => {
        const res = await AAP_API.monthlyMarketing(month, [id]);
        if (myGen !== gen) return;
        rows[id] = pick(res);
        // Save as we go so a tab closed halfway through keeps its progress.
        if (++sinceSave >= 25) {
          sinceSave = 0;
          save();
        }
      },
      onProgress,
      () => myGen !== gen || !contextAlive()
    );
    if (myGen === gen) await save();
    return rows;
  }

  async function load(view) {
    const myGen = ++gen;
    const d = (data = emptyData(view));
    // Account-level totals for the month and the one before it (the cards'
    // and tables' comparison). A past month comes from cache after one visit.
    const months = [view.month, addMonths(view.month, -1)];
    try {
      const results = await AAP_API.pooled(months, (m) => loadTotal(m, view), null, () => myGen !== gen);
      if (myGen !== gen) return;
      months.forEach((m, idx) => {
        if (results[idx]) d.totals[m] = results[idx];
      });
      if (!d.totals[view.month]) d.totalsError = "Couldn't load this month's totals.";
    } catch (err) {
      d.totalsError = String(err.message || err);
    }
    d.totalsLoading = false;
    render();

    if (!actorsOn) return;
    try {
      const list = await loadActorList(view.org);
      if (myGen !== gen) return;
      const wanted = view.actorIds.length ? list.filter((a) => view.actorIds.includes(a.id)) : list;
      d.actors = wanted;
      d.actorsProgress = { done: 0, total: wanted.length };
      render();
      d.stats = await loadActorStats(
        view.month,
        view.org,
        wanted.map((a) => a.id),
        myGen,
        (done, total) => {
          d.actorsProgress = { done, total };
          render();
        }
      );
      if (myGen !== gen) return;
      d.actorsProgress = null;
      render();

      // Previous month, only for Actors with enough viewers for the
      // views-up-runs-flat flag to be possible.
      const pace = portionElapsed(view.month);
      if (pace > 0) {
        const candidates = wanted
          .map((a) => a.id)
          .filter((id) => (d.stats[id]?.v || 0) >= FLAG_MIN_PREV_VIEWS);
        if (candidates.length) {
          d.prevStats = await loadActorStats(addMonths(view.month, -1), view.org, candidates, myGen, null);
          if (myGen !== gen) return;
          render();
        }
      }
    } catch (err) {
      if (myGen !== gen) return;
      d.actorsProgress = null;
      d.actorsError = String(err.message || err);
      render();
    }
  }

  // ---- derived numbers ----------------------------------------------------
  const ratio = (a, b) => (b > 0 ? a / b : null);

  function funnel(res) {
    if (!res) return null;
    const v = res.numUniqueViewingUsers || 0;
    const i = res.numUniqueConsolePageViews || 0;
    const r = res.numUniqueUsersWithRun || 0;
    return { v, i, r, d2i: ratio(i, v), i2r: ratio(r, i), d2r: ratio(r, v) };
  }

  function actorRows(d) {
    const acct = funnel(d.totals[d.view.month]);
    const pace = portionElapsed(d.view.month);
    const prevLabel = shortMonth(addMonths(d.view.month, -1));
    const rows = [];
    let silent = 0;
    for (const a of d.actors || []) {
      const s = d.stats[a.id];
      if (!s) continue;
      if (!s.v && !s.i && !s.r) {
        silent++;
        continue;
      }
      const row = {
        ...a,
        v: s.v,
        i: s.i,
        r: s.r,
        d2i: ratio(s.i, s.v),
        i2r: ratio(s.r, s.i),
        d2r: ratio(s.r, s.v),
        topCountry: s.cc?.[0] || null,
        growth: null,
        flags: [],
      };
      const p = d.prevStats[a.id];
      if (p && pace > 0) {
        const pv = p.v * pace;
        const pr = p.r * pace;
        row.growth = pv > 0 ? s.v / pv - 1 : null;
        if (pv >= FLAG_MIN_PREV_VIEWS && s.v / pv >= FLAG_VIEW_GROWTH && (pr > 0 ? s.r / pr : s.r > 0 ? Infinity : 1) <= FLAG_RUN_GROWTH) {
          row.flags.push({
            kind: "flat",
            label: "Views up, starts flat",
            why: `Detail viewers ${pctChange(s.v / pv - 1)} vs ${prevLabel}${pace < 1 ? " at the same point in the month" : ""}, starts ${pctChange(pr > 0 ? s.r / pr - 1 : 0)}. The new traffic isn't converting.`,
          });
        }
      }
      if (acct?.d2r && s.v >= FLAG_MIN_VIEWS_LOW_CONV && row.d2r != null && row.d2r < acct.d2r * FLAG_LOW_CONV_RATIO) {
        row.flags.push({
          kind: "low",
          label: "Low conversion",
          why: `${AAPF.pct(row.d2r)} of detail viewers start it, against ${AAPF.pct(acct.d2r)} across your Actors. Worth checking the listing, input schema and example output.`,
        });
      }
      const tc = row.topCountry;
      if (acct?.d2r && tc && s.v >= FLAG_MIN_VIEWS_COUNTRY && tc[1] >= FLAG_COUNTRY_SHARE && row.d2r != null && row.d2r < acct.d2r) {
        row.flags.push({
          kind: "geo",
          label: `${tc[1].toFixed(0)}% ${tc[0]}`,
          why: `${tc[1].toFixed(0)}% of viewers are from ${regionName(tc[0])} and conversion is below your average. Could be bots or scrapers, or a market the listing doesn't serve.`,
        });
      }
      rows.push(row);
    }
    return { rows, silent, acct };
  }

  function pctChange(x) {
    if (x == null || !isFinite(x)) return "–";
    return (x >= 0 ? "+" : "") + (x * 100).toFixed(0) + "%";
  }
  function ptsChange(cur, prev) {
    if (cur == null || prev == null) return null;
    return (cur - prev) * 100;
  }
  const num = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));

  // ---- DOM anchors ----------------------------------------------------------
  function wrappers() {
    const out = {};
    for (const w of document.querySelectorAll('[class*="StyledChartWrapper"]')) {
      const h = (w.querySelector("h3")?.textContent || "").trim().toLowerCase();
      if (h.startsWith("user acquisition")) out.funnel = w;
      else if (h.startsWith("referrers")) out.referrers = w;
      else if (h.startsWith("countries")) out.countries = w;
    }
    return out;
  }

  function unmountAll() {
    document.querySelectorAll(`.${PANEL_ACTORS}, .${MARK}`).forEach((n) => n.remove());
    document.querySelectorAll("[data-aap-acq-sig]").forEach((n) => delete n.dataset.aapAcqSig);
  }

  // ---- 1. conversion on the funnel cards ------------------------------------
  function renderCards(w, d) {
    const cards = w.funnel?.querySelectorAll('[class*="SimpleActorStatsItem"]');
    if (!cards || cards.length !== 3) return;
    const cur = funnel(d.totals[d.view.month]);
    // Only annotate the numbers we can see are the ones we loaded: while the
    // page is still swapping months the cards briefly show the old month.
    const shown = Number((cards[0].querySelector("h2")?.textContent || "").replace(/[^\d]/g, ""));
    if (!cur || shown !== cur.v) {
      cards.forEach((c) => c.querySelector(`:scope > .${MARK}`)?.remove());
      return;
    }
    const prevM = addMonths(d.view.month, -1);
    const prev = funnel(d.totals[prevM]);
    const vs = shortMonth(prevM);
    const specs = [
      { main: [cur.d2r, `start the Actor`], delta: [cur.d2r, prev?.d2r] },
      { main: [cur.d2i, `of detail viewers`], delta: [cur.d2i, prev?.d2i] },
      { main: [cur.i2r, `of input viewers`], delta: [cur.i2r, prev?.i2r], extra: [cur.d2r, `of detail viewers`] },
    ];
    specs.forEach((s, idx) => {
      const card = cards[idx];
      const sig = JSON.stringify([s, vs]);
      let el = card.querySelector(`:scope > .${MARK}`);
      if (el && el.dataset.sig === sig) return;
      if (!el) {
        el = document.createElement("div");
        el.className = `${MARK} aap-acq-conv`;
        card.appendChild(el);
      }
      el.dataset.sig = sig;
      let html = `<span class="aap-acq-conv-rate">${AAPF.pct(s.main[0])}</span> <span class="aap-acq-conv-label">${s.main[1]}</span>`;
      if (s.extra) html += `<span class="aap-acq-conv-sep">·</span><span class="aap-acq-conv-rate">${AAPF.pct(s.extra[0])}</span> <span class="aap-acq-conv-label">${s.extra[1]}</span>`;
      const pts = ptsChange(...s.delta);
      if (pts != null) html += ` ${deltaHtml(pts, `vs ${vs}`, `${vs}: ${AAPF.pct(s.delta[1])}`)}`;
      el.innerHTML = html;
    });
  }

  function deltaHtml(pts, suffix, title) {
    const cls = Math.abs(pts) < 0.05 ? "flat" : pts > 0 ? "up" : "down";
    const sign = pts > 0 ? "+" : pts < 0 ? "−" : "±";
    return `<span class="aap-acq-delta aap-acq-delta-${cls}" title="${escapeHtml(title || "")}">${sign}${Math.abs(pts).toFixed(1)} pts${suffix ? ` <span class="aap-acq-delta-vs">${escapeHtml(suffix)}</span>` : ""}</span>`;
  }

  // ---- 4 + 5. referrer / country tables -------------------------------------
  function renderShareTable(wrapper, items, prevItems, vsLabel, kind) {
    const tbody = wrapper?.querySelector("table tbody");
    if (!tbody || !items) return;
    const trs = [...tbody.rows];
    // Rows are rendered in response order; confirm each one before touching it.
    const aligned =
      trs.length === items.length &&
      trs.every((tr, i) => Math.abs(parseFloat(tr.cells[1]?.textContent || "") - items[i].trafficPercent) < 0.01);
    const foot = wrapper.querySelector(`:scope > .${MARK}.aap-acq-foot`);
    if (!aligned) {
      tbody.querySelectorAll(`.${MARK}`).forEach((n) => n.remove());
      foot?.remove();
      return;
    }
    const prevBy = new Map((prevItems || []).map((p) => [p.origin, p.trafficPercent]));
    trs.forEach((tr, i) => {
      const it = items[i];
      const nameCell = tr.cells[0];
      const pctCell = tr.cells[1];
      if (kind === "ref" && !it.origin && !nameCell.querySelector(`.${MARK}`)) {
        const s = document.createElement("span");
        s.className = `${MARK} aap-acq-direct`;
        s.textContent = "Direct / unknown";
        s.title = "No referrer was sent: typed or bookmarked links, apps, email clients, and browsers or sites that strip the referrer.";
        nameCell.appendChild(s);
      }
      if (!prevItems) return;
      const prev = prevBy.get(it.origin);
      const sig = `${it.origin}|${it.trafficPercent}|${prev}`;
      let badge = pctCell.querySelector(`.${MARK}`);
      if (badge && badge.dataset.sig === sig) return;
      if (!badge) {
        badge = document.createElement("span");
        badge.className = MARK;
        pctCell.appendChild(badge);
      }
      badge.dataset.sig = sig;
      badge.innerHTML =
        prev == null
          ? `<span class="aap-acq-new" title="Not in ${escapeHtml(vsLabel)}'s top 10">new</span>`
          : deltaHtml(it.trafficPercent - prev, "", `${vsLabel}: ${prev.toFixed(2)}%`).replace(" pts", "");
    });

    // Footer: what left the top 10, and (for referrers) why the column
    // doesn't sum to 100.
    const notes = [];
    if (prevItems) {
      const nowSet = new Set(items.map((x) => x.origin));
      const gone = prevItems.filter((p) => !nowSet.has(p.origin));
      if (gone.length) {
        const label = (o) => (kind === "cc" ? regionName(o) : o || "Direct / unknown");
        notes.push(`Left the top 10 since ${escapeHtml(vsLabel)}: ${gone.map((g) => `${escapeHtml(label(g.origin))} (${g.trafficPercent.toFixed(2)}%)`).join(", ")}.`);
      }
    }
    if (kind === "ref") {
      const sum = items.reduce((t, x) => t + x.trafficPercent, 0);
      if (sum > 100.5) notes.push(`Shares add up to ${sum.toFixed(0)}% because one person can arrive from more than one place during the month.`);
    }
    const html = notes.map((n) => `<div>${n}</div>`).join("");
    if (!html) return foot?.remove();
    if (foot && foot.dataset.sig === html) return;
    const el = foot || document.createElement("div");
    el.className = `${MARK} aap-acq-foot`;
    el.dataset.sig = html;
    el.innerHTML = html;
    if (!foot) wrapper.appendChild(el);
  }

  // ---- panels ---------------------------------------------------------------
  function ensurePanel(cls, after) {
    let panel = document.querySelector(`.${cls}`);
    if (!after) return null;
    if (!panel || panel.previousElementSibling !== after) {
      panel?.remove();
      panel = document.createElement("section");
      panel.className = `${cls} aap-acq-panel`;
      after.insertAdjacentElement("afterend", panel);
    }
    return panel;
  }

  function panelHead(title, sub, hidePref) {
    return `<div class="aap-hl-head"><span class="aap-hl-title">${title}</span><span class="aap-hl-range">${sub}</span><button type="button" class="aap-hl-hide" data-pref="${hidePref}" title="Hide this panel. Turn it back on in the extension's settings.">Hide</button></div>`;
  }

  function bindHide(panel) {
    panel.querySelector(".aap-hl-hide")?.addEventListener("click", (e) => {
      const pref = e.currentTarget.dataset.pref;
      if (pref === PREF_ACTORS) actorsOn = false;
      savePref({ [pref]: false });
      panel.remove();
    });
  }

  // ---- 2 + 3. per-Actor funnel table --------------------------------------
  const COLS = [
    { key: "title", label: "Actor", sort: (a, b) => a.title.localeCompare(b.title) },
    { key: "v", label: "Detail", num: true, title: "People who viewed the Actor detail page" },
    { key: "growth", label: "vs last month", num: true, title: "Change in detail viewers against last month (at the same point in the month, for the current month)" },
    { key: "i", label: "Input", num: true, title: "People who viewed the Input page" },
    { key: "r", label: "Started", num: true, title: "People who started the Actor" },
    { key: "d2i", label: "Detail → input", num: true },
    { key: "i2r", label: "Input → start", num: true },
    { key: "d2r", label: "Detail → start", num: true },
    { key: "flags", label: "Flags", num: true, sort: (a, b) => a.flags.length - b.flags.length },
  ];
  let sortKey = "v";
  let sortDir = -1;
  let showAll = false;
  let flaggedOnly = false;

  function renderActors(panel, d) {
    const { rows, silent, acct } = actorRows(d);
    const sig = JSON.stringify([d.key, rows, silent, d.actorsProgress, d.actorsError, sortKey, sortDir, showAll, flaggedOnly, !!d.actors]);
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;

    const flaggedCount = rows.filter((r) => r.flags.length).length;
    let sub = AAPF.monthLabelLong(d.view.month);
    if (d.actorsProgress) sub += ` · loading ${d.actorsProgress.done} of ${d.actorsProgress.total} Actors…`;
    let html = panelHead("Funnel by Actor", escapeHtml(sub), PREF_ACTORS);

    if (d.actorsError && !rows.length) {
      html += `<div class="aap-hl-note">Couldn't load Actors: ${escapeHtml(d.actorsError)}</div>`;
    } else if (!rows.length) {
      html += `<div class="aap-hl-note">${d.actors && !d.actorsProgress ? "No Actor had detail-page viewers this month." : "Loading Actors…"}</div>`;
    } else {
      html += `<div class="aap-acq-bar">`;
      if (acct) html += `<span>Your average: <b>${AAPF.pct(acct.d2i)}</b> detail → input, <b>${AAPF.pct(acct.i2r)}</b> input → start, <b>${AAPF.pct(acct.d2r)}</b> overall.</span>`;
      if (flaggedCount) html += `<label class="aap-acq-check"><input type="checkbox" ${flaggedOnly ? "checked" : ""} data-act="flagged"> Flagged only (${flaggedCount})</label>`;
      html += `</div>`;

      const col = COLS.find((c) => c.key === sortKey) || COLS[1];
      const asc = col.sort || ((a, b) => (a[col.key] ?? -Infinity) - (b[col.key] ?? -Infinity));
      let list = rows.filter((r) => !flaggedOnly || r.flags.length).sort((a, b) => asc(a, b) * sortDir || b.v - a.v);
      const total = list.length;
      if (!showAll) list = list.slice(0, TABLE_PAGE);

      html += `<div class="aap-acq-scroll"><table class="aap-acq-table"><thead><tr>`;
      for (const c of COLS) {
        const active = c.key === sortKey;
        html += `<th class="${c.num ? "num" : ""}${active ? " active" : ""}" data-sort="${c.key}"${c.title ? ` title="${escapeHtml(c.title)}"` : ""}>${c.label}${active ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`;
      }
      html += `</tr></thead><tbody>`;
      for (const r of list) {
        html += `<tr>`;
        html += `<td><div class="aap-acq-actor">${iconHtml(r)}<span title="${escapeHtml(r.name)}">${escapeHtml(r.title)}</span></div></td>`;
        html += `<td class="num">${num(r.v)}</td>`;
        html += `<td class="num">${r.growth == null ? `<span class="aap-acq-dim">–</span>` : `<span class="${r.growth >= 0 ? "aap-acq-up" : "aap-acq-down"}">${pctChange(r.growth)}</span>`}</td>`;
        html += `<td class="num">${num(r.i)}</td>`;
        html += `<td class="num">${num(r.r)}</td>`;
        html += `<td class="num">${rateHtml(r.d2i, acct?.d2i, r.v)}</td>`;
        html += `<td class="num">${rateHtml(r.i2r, acct?.i2r, r.i)}</td>`;
        html += `<td class="num">${rateHtml(r.d2r, acct?.d2r, r.v)}</td>`;
        html += `<td class="num aap-acq-flags">${r.flags.map((f) => `<span class="aap-acq-flag aap-acq-flag-${f.kind}" title="${escapeHtml(f.why)}">${escapeHtml(f.label)}</span>`).join("")}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table></div>`;
      const foot = [];
      if (total > TABLE_PAGE) foot.push(`<button type="button" class="aap-acq-link" data-act="more">${showAll ? "Show top " + TABLE_PAGE : `Show all ${total}`}</button>`);
      if (silent) foot.push(`${silent} Actor${silent === 1 ? "" : "s"} had no viewers this month.`);
      foot.push(`Rates are coloured against your average once an Actor has 30+ people at that step. Hover a flag for why it was raised.`);
      html += `<div class="aap-hl-foot">${foot.join(" ")}</div>`;
    }
    panel.innerHTML = html;
    bindHide(panel);
    panel.querySelectorAll("th[data-sort]").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (k === sortKey) sortDir = -sortDir;
        else {
          sortKey = k;
          sortDir = k === "title" ? 1 : -1;
        }
        render();
      })
    );
    panel.querySelector('[data-act="more"]')?.addEventListener("click", () => {
      showAll = !showAll;
      render();
    });
    panel.querySelector('[data-act="flagged"]')?.addEventListener("change", (e) => {
      flaggedOnly = e.target.checked;
      render();
    });
  }

  function rateHtml(rate, avg, base) {
    if (rate == null) return `<span class="aap-acq-dim">–</span>`;
    let cls = "";
    if (avg && base >= 30) {
      if (rate >= avg * 1.25) cls = "aap-acq-up";
      else if (rate <= avg * 0.75) cls = "aap-acq-down";
    }
    return `<span class="${cls}">${AAPF.pct(rate)}</span>`;
  }

  function iconHtml(a) {
    if (a.pictureUrl && /^https:\/\//.test(a.pictureUrl)) {
      return `<img class="aap-hl-icon" src="${escapeHtml(a.pictureUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<span class="aap-hl-icon"></span>`;
  }

  // ---- render / poll --------------------------------------------------------
  function render() {
    if (!data || !onRoute()) return;
    const w = wrappers();
    if (!w.funnel) return;
    const d = data;
    renderCards(w, d);
    const prevM = addMonths(d.view.month, -1);
    const cur = d.totals[d.view.month];
    const prev = d.totals[prevM];
    const vs = shortMonth(prevM);
    renderShareTable(w.referrers, cur?.topReferrers, prev?.topReferrers, vs, "ref");
    renderShareTable(w.countries, cur?.topCountryCodes, prev?.topCountryCodes, vs, "cc");

    const actors = actorsOn ? ensurePanel(PANEL_ACTORS, w.funnel) : (document.querySelector(`.${PANEL_ACTORS}`)?.remove(), null);
    if (actors) renderActors(actors, d);
  }

  let lastActorsOn = actorsOn;
  const poll = setInterval(() => {
    if (!contextAlive()) {
      retired = true;
      clearInterval(poll);
      try {
        unmountAll();
      } catch {
        /* best effort */
      }
      return;
    }
    if (!onRoute()) {
      if (data) {
        data = null;
        gen++;
        unmountAll();
      }
      return;
    }
    if (document.hidden) return;
    const view = pageView();
    const key = viewKey(view);
    // Turning the table back on from the popup needs the per-Actor pass.
    const reenabled = actorsOn && !lastActorsOn;
    lastActorsOn = actorsOn;
    // The current month keeps moving; pick up fresh numbers once the cache
    // TTL (an hour) has passed, as long as the tab is being looked at.
    const expired = view.month === curMonth() && Date.now() - data?.loadedAt > REFRESH_MS;
    if (!data || data.key !== key || reenabled || expired) {
      load(view);
      return;
    }
    render();
  }, 500);


  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
