/*
 * Enhances https://console.apify.com/actors/insights/actor-quality. With no
 * Actor picked, the native tab only shows "Select an Actor to get started"
 * and a dropdown. Under that we list every Actor the account owns with its
 * quality score, sortable and searchable; clicking one opens the native
 * per-Actor view (`?actorId=<id>`) in place, the same as picking it from the
 * dropdown.
 *
 * Scores come from lib/actor-meta.js (1 request per Actor, 5 in flight,
 * cached 6 hours and shared with the Monetization tab). The Actor list is
 * the same owned-Actor lookup the Acquisition tab uses, and shares its cache
 * record. Once an Actor is picked the empty state goes away and so does our
 * panel; the native page takes over.
 */
(function () {
  const ROUTE_RE = /^(?:\/organization\/[^/]+)?\/actors\/insights\/actor-quality\/?$/;
  const onRoute = () => ROUTE_RE.test(location.pathname) && !new URLSearchParams(location.search).get("actorId");

  const PREF_ON = "aap.qualityListOn"; // false hides the list; absent = shown
  const PANEL_CLASS = "aap-ql";
  const TABLE_PAGE = 50;

  const curMonth = () => new Date().toISOString().slice(0, 7) + "-01";
  const currentOrg = () => (location.pathname.match(/^\/organization\/([^/]+)/) || [])[1] || "";

  // ---- prefs / lifecycle ----------------------------------------------------
  let listOn = true;
  chrome.storage.local
    .get([PREF_ON])
    .then((r) => {
      listOn = r[PREF_ON] !== false;
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PREF_ON]) listOn = changes[PREF_ON].newValue !== false;
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

  // ---- data -----------------------------------------------------------------
  let actors = null; // [{ id, name, title, pictureUrl }]
  let listError = null;
  let loadingFor = null; // org the list is loading/loaded for
  let progress = null; // { done, total } while scores load

  async function loadActorList(org) {
    const cached = await AAP_CACHE.getAcq("list", curMonth(), org);
    if (cached && !cached.stale) return cached.actors;
    try {
      const list = await AAP_API.ownedActors();
      const out = (Array.isArray(list) ? list : [])
        .map((a) => ({ id: a.id || a._id, name: a.name, title: a.title || a.name, pictureUrl: a.pictureUrl || null }))
        .filter((a) => a.id);
      await AAP_CACHE.setAcq("list", curMonth(), org, { actors: out });
      return out;
    } catch (err) {
      if (cached) return cached.actors;
      throw err;
    }
  }

  async function load(org) {
    loadingFor = org;
    actors = null;
    listError = null;
    try {
      const list = await loadActorList(org);
      if (loadingFor !== org) return;
      actors = list;
      render();
      progress = { done: 0, total: list.length };
      await AAP_META.ensure(
        list.map((a) => a.id),
        {
          onProgress: (done, total) => {
            progress = { done, total };
          },
        },
      );
    } catch (err) {
      if (loadingFor === org) listError = String(err?.message || err);
    }
    progress = null;
    render();
  }

  AAP_META.onChange(() => render());

  // ---- render ---------------------------------------------------------------
  let sortKey = "quality";
  let sortDir = -1;
  let query = "";
  let showAll = false;

  function anchor() {
    return document.querySelector('[class*="actor_quality_empty_state"]');
  }

  // While the list shows, the native "Select an Actor to get started" block
  // shrinks to one line (heading + its Actor dropdown) via this class; see
  // app.css. Only restyled, never rebuilt, so the dropdown keeps working.
  const COMPACT_CLASS = "aap-ql-compact";
  function removePanel() {
    document.querySelector(`.${PANEL_CLASS}`)?.remove();
    document.querySelector(`.${COMPACT_CLASS}`)?.classList.remove(COMPACT_CLASS);
  }

  function ensurePanel() {
    const after = anchor();
    let panel = document.querySelector(`.${PANEL_CLASS}`);
    if (!after) {
      panel?.remove();
      return null;
    }
    after.classList.add(COMPACT_CLASS);
    if (!panel || panel.previousElementSibling !== after) {
      panel?.remove();
      panel = document.createElement("section");
      panel.className = `${PANEL_CLASS} aap-acq-panel`;
      panel.innerHTML = `<div class="aap-hl-head"><span class="aap-hl-title">Quality by Actor</span><span class="aap-hl-range aap-ql-sub"></span><input type="search" class="aap-ql-search" placeholder="Search Actors" aria-label="Search Actors"><button type="button" class="aap-hl-hide" title="Hide this list. Turn it back on in the extension's settings.">Hide</button></div><div class="aap-ql-body"></div>`;
      panel.querySelector(".aap-ql-search").value = query;
      panel.querySelector(".aap-ql-search").addEventListener("input", (e) => {
        query = e.target.value;
        render();
      });
      panel.querySelector(".aap-hl-hide").addEventListener("click", () => {
        listOn = false;
        savePref({ [PREF_ON]: false });
        removePanel();
      });
      panel.querySelector(".aap-ql-body").addEventListener("click", onBodyClick);
      after.insertAdjacentElement("afterend", panel);
      panel.dataset.sig = "";
    }
    return panel;
  }

  function rows() {
    const q = query.trim().toLowerCase();
    return (actors || [])
      .filter((a) => !q || a.title.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      .map((a) => ({ ...a, meta: AAP_META.get(a.id) }));
  }

  function sorted(list) {
    const score = (r) => r.meta?.quality ?? null;
    return [...list].sort((a, b) => {
      if (sortKey === "title") return sortDir * a.title.localeCompare(b.title);
      const va = score(a);
      const vb = score(b);
      if (va == null || vb == null) return va == null ? (vb == null ? a.title.localeCompare(b.title) : 1) : -1; // unscored last
      return sortDir * (va - vb) || a.title.localeCompare(b.title);
    });
  }

  function render() {
    if (!onRoute() || !listOn) {
      removePanel();
      return;
    }
    const panel = ensurePanel();
    if (!panel) return;
    const list = rows();
    const scored = (actors || []).map((a) => AAP_META.get(a.id)?.quality).filter((q) => q != null);
    const sig = JSON.stringify([list.map((r) => [r.id, r.meta?.quality, r.meta?.qAt]), sortKey, sortDir, showAll, progress, listError, !!actors]);
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;

    let sub = "";
    if (actors) sub = `${actors.length} Actor${actors.length === 1 ? "" : "s"}`;
    if (scored.length) {
      const avg = Math.round((scored.reduce((s, q) => s + q, 0) / scored.length) * 100);
      const low = scored.filter((q) => q < 0.5).length;
      sub += ` · average ${avg}/100${low ? ` · ${low} below 50` : ""}`;
    }
    if (progress) sub += ` · scoring ${progress.done} of ${progress.total}…`;
    panel.querySelector(".aap-ql-sub").textContent = sub;

    const body = panel.querySelector(".aap-ql-body");
    if (listError && !actors) {
      body.innerHTML = `<div class="aap-hl-note">Couldn't load your Actors: ${escapeHtml(listError)}</div>`;
      return;
    }
    if (!actors) {
      body.innerHTML = `<div class="aap-hl-note">Loading your Actors…</div>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<div class="aap-hl-note">${query ? "No Actor matches that search." : "No Actors found on this account."}</div>`;
      return;
    }

    const all = sorted(list);
    const shown = showAll ? all : all.slice(0, TABLE_PAGE);
    const head = (key, label, num) => {
      const active = sortKey === key;
      return `<th class="${num ? "num" : ""}${active ? " active" : ""}" data-sort="${key}">${label}${active ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`;
    };
    const base = location.pathname.replace(/\/$/, "");
    let html = `<div class="aap-acq-scroll"><table class="aap-acq-table aap-ql-table"><thead><tr>`;
    html += head("title", "Actor") + head("quality", "Quality", true) + `<th class="num">Platform rank</th>`;
    html += `</tr></thead><tbody>`;
    for (const r of shown) {
      const href = `${base}?actorId=${encodeURIComponent(r.id)}`;
      const pct = r.meta?.percentile;
      html += `<tr data-href="${escapeHtml(href)}">`;
      html += `<td><a class="aap-acq-actor aap-ql-link" href="${escapeHtml(href)}">${iconHtml(r)}<span class="aap-ql-name"><span class="aap-ql-title">${escapeHtml(r.title)}</span><span class="aap-ql-slug">${escapeHtml(r.name)}</span></span></a></td>`;
      html += `<td class="num">${AAP_META.badgeHtml(r.meta)}</td>`;
      html += `<td class="num">${pct != null ? `Better than ${Math.round(pct * 100)}%` : `<span class="aap-acq-dim">–</span>`}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
    const foot = [];
    if (all.length > TABLE_PAGE) foot.push(`<button type="button" class="aap-acq-link" data-act="more">${showAll ? `Show top ${TABLE_PAGE}` : `Show all ${all.length}`}</button>`);
    foot.push("Click an Actor for its full quality profile. Scores refresh every 6 hours.");
    html += `<div class="aap-hl-foot">${foot.join(" ")}</div>`;
    body.innerHTML = html;
  }

  function iconHtml(a) {
    if (a.pictureUrl && /^https:\/\//.test(a.pictureUrl)) {
      return `<img class="aap-hl-icon" src="${escapeHtml(a.pictureUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    }
    return `<span class="aap-hl-icon"></span>`;
  }

  // Opens the native per-Actor view in place: the Console is a React Router
  // SPA, so pushState + popstate is what picking from its own dropdown
  // amounts to. Modified clicks fall through to the plain link (new tab).
  function openActor(href) {
    history.pushState(history.state, "", href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    // If the router didn't pick that up, load the page the ordinary way.
    setTimeout(() => {
      if (anchor() && location.search.includes("actorId=")) location.assign(href);
    }, 1500);
  }

  function onBodyClick(e) {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      if (k === sortKey) sortDir = -sortDir;
      else {
        sortKey = k;
        sortDir = k === "title" ? 1 : -1;
      }
      return render();
    }
    if (e.target.closest('[data-act="more"]')) {
      showAll = !showAll;
      return render();
    }
    const row = e.target.closest("tr[data-href]");
    if (!row || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openActor(row.dataset.href);
  }

  // ---- poll -----------------------------------------------------------------
  const poll = setInterval(() => {
    if (!contextAlive()) {
      retired = true;
      clearInterval(poll);
      removePanel();
      return;
    }
    if (!onRoute() || !listOn) {
      removePanel();
      return;
    }
    if (!anchor()) return;
    // Not gated on document.hidden: macOS Chrome reports an occluded window
    // as hidden, which left the list on "Loading…" (see app.js's first load).
    // It's one load per visit and the scores are cached for hours anyway.
    const org = currentOrg();
    if (loadingFor !== org) load(org);
    render();
  }, 500);

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
