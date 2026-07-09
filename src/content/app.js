/*
 * Overlays the native Monetization chart on
 * https://console.apify.com/actors/insights/monetization with our own
 * canvas, plus a small toolbar inserted just above it: independent
 * Revenue / Runs / Results checkboxes (Revenue draws bars against the left
 * axis; Runs/Results draw line series against a secondary right axis) and a
 * "Breakdown by actor" checkbox that stacks the Revenue bars by Actor.
 * Hovering any day shows a tooltip with that day's full stats plus the top
 * 10 Actors by whichever metric is active. We draw our own chart (rather
 * than reaching into Apify's) because it's a black-box Chart.js canvas with
 * no exposed instance to restyle or hook into.
 *
 * The Insights page is a client-routed SPA and never changes the URL when
 * you flip months, so we can't read "which month is shown" from
 * location.href. Instead token-sniffer.js (MAIN world) watches the page's
 * own XHR/fetch calls and tells us the `month` query param of each one.
 */
(function () {
  const ROUTE = "/actors/insights/monetization";
  const OVERLAY_CLASS = "aap-overlay";
  const TOOLBAR_CLASS = "aap-toolbar-row";
  const PALETTE = ["#2dd4bf", "#60a5fa", "#f472b6", "#facc15", "#a78bfa", "#fb923c", "#34d399", "#f87171"];
  const OTHER_COLOR = "#6b7280";
  const TOP_N = PALETTE.length;
  const METRICS = [
    { key: "revenue", label: "Revenue", color: "#4caf82", kind: "bar", axis: "left" },
    { key: "runs", label: "Runs", color: "#22d3ee", kind: "line", axis: "right" },
    { key: "results", label: "Results", color: "#fb7185", kind: "line", axis: "right" },
  ];

  const PREF_KEYS = {
    composition: "aap.compositionOn",
    metricsOn: "aap.metricsOn",
  };

  const state = {
    month: null, // "2026-07-01", from the page's own requests
    filtered: false, // true when the user has the native "Actor" filter set
  };

  chrome.storage.local.get(Object.values(PREF_KEYS)).then((r) => {
    compositionOn = !!r[PREF_KEYS.composition];
    if (r[PREF_KEYS.metricsOn]) metricsOn = { ...metricsOn, ...r[PREF_KEYS.metricsOn] };
    syncToolbar();
    drawChart();
  });

  // ---- token bridge -------------------------------------------------------
  window.addEventListener("aap-token", (e) => AAP_API.setToken(e.detail));
  window.dispatchEvent(new Event("aap-request-token")); // in case we loaded late

  // This only ever records *which month the page is currently showing* — it
  // does NOT trigger loading. The very first request of a page load reliably
  // fires before the chart (our DOM anchor) exists, so a "load on event"
  // design would permanently mark that month as handled and never retry once
  // the anchor shows up. The poll below is the single place that decides
  // whether to (re)load, once it can confirm there's somewhere to render.
  window.addEventListener("aap-request-seen", (e) => {
    const { month, actorIdsCount } = e.detail;
    if (!month) return;
    state.filtered = actorIdsCount > 0;
    if (state.filtered) unmountOverlay();
    else state.month = month;
  });

  // ---- SPA route watcher ---------------------------------------------------
  let lastPath = null;
  setInterval(() => {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    if (path !== ROUTE) unmountOverlay();
  }, 500);

  // ---- DOM anchoring --------------------------------------------------------
  // The wrapper Apify renders its Chart.js canvas into — a plain, statically
  // positioned <div> with exactly one <canvas> child.
  function findChartWrapper() {
    return document.querySelector('[class*="PaidActorProfitMarginChart"]');
  }

  // Ensures: the native canvas is hidden, our toolbar sits just above the
  // chart wrapper (in normal document flow, not overlapping it), and our own
  // chart canvas + tooltip exist inside the wrapper. Safe to call repeatedly
  // — it's the single place that (re)creates anything that went missing,
  // whether that's on first paint or after Apify's own React tree re-renders
  // the wrapper and wipes out nodes it doesn't recognize.
  function ensureOverlay() {
    const wrapper = findChartWrapper();
    if (!wrapper) return null;

    // visibility:hidden, not display:none — the wrapper has no height of its
    // own, it's sized by the canvas; hiding via display would collapse it to
    // 0px and our absolutely-positioned overlay would have nothing to fill.
    const nativeCanvas = wrapper.querySelector("canvas:not(.aap-chart)");
    if (nativeCanvas && nativeCanvas.style.visibility !== "hidden") nativeCanvas.style.visibility = "hidden";
    if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

    ensureToolbar(wrapper);

    let overlay = wrapper.querySelector(`.${OVERLAY_CLASS}`);
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = OVERLAY_CLASS;

    const canvas = document.createElement("canvas");
    canvas.className = "aap-chart";
    overlay.appendChild(canvas);

    const tooltip = document.createElement("div");
    tooltip.className = "aap-tooltip";
    tooltip.style.display = "none";
    document.body.appendChild(tooltip); // fixed-position, outside clipped ancestors

    canvas.addEventListener("mousemove", onHover);
    canvas.addEventListener("mouseleave", hideTooltip);

    wrapper.appendChild(overlay);
    return overlay;
  }

  // The toolbar lives just above the chart wrapper (as its previous sibling,
  // in normal flow) rather than floating over the canvas, so it doesn't sit
  // on top of the graph.
  function ensureToolbar(wrapper) {
    if (wrapper.previousElementSibling?.classList.contains(TOOLBAR_CLASS)) {
      return wrapper.previousElementSibling;
    }

    const toolbar = document.createElement("div");
    toolbar.className = TOOLBAR_CLASS;

    for (const m of METRICS) {
      const label = document.createElement("label");
      label.className = "aap-toggle";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "aap-toggle-checkbox aap-metric-checkbox";
      box.dataset.metric = m.key;
      box.addEventListener("change", () => {
        const next = { ...metricsOn, [m.key]: box.checked };
        if (!Object.values(next).some(Boolean)) {
          box.checked = true; // at least one metric must stay on
          return;
        }
        metricsOn = next;
        chrome.storage.local.set({ [PREF_KEYS.metricsOn]: metricsOn });
        syncToolbar();
        drawChart();
      });
      label.appendChild(box);
      const dot = document.createElement("span");
      dot.className = "aap-tt-dot";
      dot.style.background = m.color;
      label.appendChild(dot);
      label.appendChild(document.createTextNode(m.label));
      toolbar.appendChild(label);
    }

    const breakdownLabel = document.createElement("label");
    breakdownLabel.className = "aap-toggle";
    const breakdownBox = document.createElement("input");
    breakdownBox.type = "checkbox";
    breakdownBox.className = "aap-toggle-checkbox aap-breakdown-checkbox";
    breakdownBox.addEventListener("change", () => {
      compositionOn = breakdownBox.checked;
      chrome.storage.local.set({ [PREF_KEYS.composition]: compositionOn });
      drawChart();
    });
    breakdownLabel.appendChild(breakdownBox);
    breakdownLabel.appendChild(document.createTextNode("Breakdown by actor"));
    toolbar.appendChild(breakdownLabel);

    const status = document.createElement("span");
    status.className = "aap-status";
    toolbar.appendChild(status);

    wrapper.insertAdjacentElement("beforebegin", toolbar);
    syncToolbar();
    return toolbar;
  }

  // Reflects compositionOn/metricsOn onto whatever toolbar controls
  // currently exist (creation happens in ensureToolbar; this just keeps them
  // in sync after a state change or a poll-driven recreation).
  function syncToolbar() {
    const wrapper = findChartWrapper();
    const toolbar = wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)
      ? wrapper.previousElementSibling
      : null;
    if (!toolbar) return;
    toolbar.querySelectorAll(".aap-metric-checkbox").forEach((box) => {
      box.checked = !!metricsOn[box.dataset.metric];
    });
    // Composition (stacking by Actor) only paints the Revenue bars.
    const breakdownBox = toolbar.querySelector(".aap-breakdown-checkbox");
    breakdownBox.checked = compositionOn;
    breakdownBox.disabled = !metricsOn.revenue;
    breakdownBox.title = breakdownBox.disabled ? "Enable Revenue to see the actor breakdown" : "";
  }

  function unmountOverlay() {
    const wrapper = findChartWrapper();
    const overlay = wrapper?.querySelector(`.${OVERLAY_CLASS}`);
    if (overlay) overlay.remove();
    if (wrapper?.previousElementSibling?.classList.contains(TOOLBAR_CLASS)) {
      wrapper.previousElementSibling.remove();
    }
    const nativeCanvas = wrapper?.querySelector("canvas:not(.aap-chart)");
    if (nativeCanvas) nativeCanvas.style.visibility = "";
    document.querySelector(".aap-tooltip")?.remove();
  }

  // Single trigger point, polled: the anchor may not exist yet on first
  // paint, AND the Console's own React tree periodically reconciles that
  // wrapper and wipes out nodes it doesn't recognize (including re-showing
  // the native canvas). Every 400ms: make sure the overlay/toolbar exist and
  // the native canvas is hidden, load whichever month we've most recently
  // learned about if we haven't already, and otherwise just redraw.
  let loadedMonth = null;
  const poll = setInterval(() => {
    if (location.pathname !== ROUTE || state.filtered) return;
    const overlay = ensureOverlay();
    if (!overlay) return;
    if (state.month && state.month !== loadedMonth) {
      loadedMonth = state.month;
      loadAndRender(state.month).catch(() => {});
      return;
    }
    if (lastData) drawChart();
  }, 400);
  window.addEventListener("beforeunload", () => clearInterval(poll));

  // ---- data ------------------------------------------------------------
  let indexRun = 0; // guards against a stale index finishing after a month switch
  let lastData = null; // { month, dayMetrics, daily, actorCount, indexedAt, indexing, progress, error }
  let compositionOn = false;
  let metricsOn = { revenue: true, runs: false, results: false };
  let colorByActorId = new Map();

  async function loadAndRender(month) {
    const overlay = ensureOverlay();
    if (!overlay) return;

    const cached = await AAP_CACHE.get(month);
    let daily = cached?.daily || null;
    let actorCount = cached?.actorCount ?? null;
    let indexedAt = cached?.updatedAt ?? null;
    let indexing = !cached || cached.stale;
    if (daily) colorByActorId = buildColorMap(daily);

    setData({ month, daily, actorCount, indexedAt, indexing, progress: null });

    // Always fetch the cheap account-wide day totals so the chart is
    // accurate even while (or instead of) a full re-index runs.
    let dayMetrics = cached?.dayMetrics || null;
    try {
      const [margin, runs] = await Promise.all([
        AAP_API.profitMargin(month, []),
        AAP_API.runStatistics(month, []),
      ]);
      dayMetrics = buildDayMetrics(margin, runs);
      setData({ month, daily, actorCount, indexedAt, indexing, dayMetrics, progress: null });
    } catch {
      /* keep whatever we had */
    }

    if (!indexing) return;

    const myRun = ++indexRun;
    try {
      const raw = await AAP_API.actorBreakdown(month, []);
      const breakdown = Array.isArray(raw) ? raw : raw?.monetizationPerActor || [];
      const paidActors = breakdown
        .map((item) => ({
          actorId: item.actor?._id,
          actorName: item.actor?.title || item.actor?.name || item.actor?._id,
          totalRevenueUsd: item.earningsStats?.totalRevenueUsd ?? 0,
          totalCostUsd: item.earningsStats?.totalCostUsd ?? 0,
        }))
        .filter((a) => a.actorId && (a.totalRevenueUsd > 0 || a.totalCostUsd > 0));

      const perActor = await AAP_API.pooled(
        paidActors,
        async (actor) => {
          const [margin, runs] = await Promise.all([
            AAP_API.profitMargin(month, [actor.actorId]),
            AAP_API.runStatistics(month, [actor.actorId]),
          ]);
          return { actor, margin, runs };
        },
        (done, total) => {
          if (myRun !== indexRun) return;
          setData({ month, daily, actorCount: paidActors.length, indexedAt, indexing: true, dayMetrics, progress: { done, total } });
        },
      );
      if (myRun !== indexRun) return; // a newer month started loading

      daily = buildDailyIndex(perActor);
      colorByActorId = buildColorMap(daily);
      actorCount = paidActors.length;
      indexedAt = Date.now();
      await AAP_CACHE.set(month, { daily, actorCount, dayMetrics });
      setData({ month, daily, actorCount, indexedAt, indexing: false, dayMetrics, progress: null });
    } catch (err) {
      if (myRun !== indexRun) return;
      setData({ month, daily, actorCount, indexedAt, indexing: false, dayMetrics, progress: null, error: String(err) });
    }
  }

  // Merges profit-margin + run-statistics into
  // { [date]: { revenue, cost, profit, margin, runs, results, successRate } }.
  function buildDayMetrics(margin, runs) {
    const days = new Set([
      ...Object.keys(margin?.dailyProfitMarginStats || {}),
      ...Object.keys(runs?.dailyStats || {}),
    ]);
    const out = {};
    for (const day of days) {
      const m = margin?.dailyProfitMarginStats?.[day]?.allUsersUsd;
      const r = runs?.dailyStats?.[day];
      out[day] = {
        revenue: m?.revenueUsd ?? 0,
        cost: m?.costUsd ?? 0,
        profit: m?.profitUsd ?? 0,
        margin: m?.margin ?? null,
        runs: r?.TOTAL ?? 0,
        results: r?.RESULTS ?? 0,
        successRate: r?.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
      };
    }
    return out;
  }

  function metricValue(day, metric) {
    return (lastData.dayMetrics || {})[day]?.[metric] ?? 0;
  }

  // Which metric drives sorting/coloring when more than one is active:
  // Revenue > Runs > Results, whichever is checked first.
  function primaryMetric() {
    return METRICS.find((m) => metricsOn[m.key])?.key || "revenue";
  }

  // perActor: [{ actor, margin, runs }] -> { [date]: [{ actorId, name, revenue, cost, profit, margin, runs, results, successRate }] }
  function buildDailyIndex(perActor) {
    const daily = {};
    for (const entry of perActor) {
      if (!entry) continue;
      const { actor, margin, runs } = entry;
      const marginByDay = margin?.dailyProfitMarginStats || {};
      const runsByDay = runs?.dailyStats || {};
      const days = new Set([...Object.keys(marginByDay), ...Object.keys(runsByDay)]);
      for (const day of days) {
        const m = marginByDay[day]?.allUsersUsd;
        const r = runsByDay[day];
        if (!m && !r) continue;
        const row = {
          actorId: actor.actorId,
          name: actor.actorName,
          revenue: m?.revenueUsd ?? 0,
          cost: m?.costUsd ?? 0,
          profit: m?.profitUsd ?? 0,
          margin: m?.margin ?? null,
          runs: r?.TOTAL ?? null,
          results: r?.RESULTS ?? null,
          successRate: r && r.TOTAL ? r.SUCCEEDED / r.TOTAL : null,
        };
        if (!row.revenue && !row.cost && !row.runs) continue;
        (daily[day] ||= []).push(row);
      }
    }
    return daily;
  }

  // Assigns a stable color per Actor, ranked by total revenue across the
  // whole indexed month — so an Actor's color stays the same from day to day
  // (and across metric switches) instead of being re-picked per day/metric.
  function buildColorMap(daily) {
    const totals = new Map();
    for (const rows of Object.values(daily)) {
      for (const row of rows) {
        totals.set(row.actorId, (totals.get(row.actorId) || 0) + row.revenue);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const map = new Map();
    ranked.slice(0, TOP_N).forEach(([actorId], i) => map.set(actorId, PALETTE[i]));
    return map;
  }

  function setData(data) {
    lastData = { ...lastData, ...data };
    drawChart();
  }

  // ---- chart drawing ------------------------------------------------------
  // Dual y-axis: Revenue (bars) reads the left axis in $. Runs and Results
  // (lines) each get their OWN right-side axis — sharing one would make
  // whichever metric has the smaller magnitude look flat (Results is
  // typically an order of magnitude above Runs). Gridlines are drawn once,
  // at even fractions of the plot height, and every axis's own max is
  // mapped onto those same fractions — the standard way to keep several
  // independent scales visually aligned on one set of horizontal lines.
  const PAD = { left: 56, right: 56, top: 12, bottom: 22 };
  const AXIS_GUTTER = 48; // width reserved per right-side axis column

  function drawChart() {
    const overlay = ensureOverlay();
    if (!overlay || !lastData) return;
    syncToolbar();

    const wrapper = overlay.parentElement;
    const toolbar = wrapper.previousElementSibling;
    const status = toolbar?.querySelector(".aap-status");
    if (status) {
      if (lastData.error) {
        status.textContent = `Couldn't load Actor data (${lastData.error}).`;
      } else if (lastData.progress) {
        status.textContent = `Indexing Actors… ${lastData.progress.done}/${lastData.progress.total}`;
      } else if (lastData.indexing) {
        status.textContent = "Indexing Actors…";
      } else {
        status.textContent = "";
      }
    }

    const canvas = overlay.querySelector(".aap-chart");
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const days = Object.keys(lastData.dayMetrics || {}).sort();
    canvas.__aapDays = days; // read back by the hover handler
    if (!days.length) return;

    const showLeft = metricsOn.revenue;
    const lineMetrics = METRICS.filter((m) => m.kind === "line" && metricsOn[m.key]);
    const showRight = lineMetrics.length > 0;

    const leftPad = showLeft ? PAD.left : 16;
    const rightPad = showRight ? 16 + lineMetrics.length * AXIS_GUTTER : 16;
    const plotW = rect.width - leftPad - rightPad;
    const plotH = rect.height - PAD.top - PAD.bottom;

    const leftMax = showLeft ? Math.max(1, ...days.map((d) => metricValue(d, "revenue"))) * 1.12 : 1;
    // Each line metric gets its own scale — see the note on PAD above.
    const lineMax = new Map(
      lineMetrics.map((m) => [m.key, Math.max(1, ...days.map((d) => metricValue(d, m.key))) * 1.12]),
    );

    const slot = plotW / days.length;
    const barW = Math.max(4, slot * 0.6);

    // gridlines, shared across every axis (see comment above)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.font = "11px inherit";
    ctx.textBaseline = "middle";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const frac = i / ticks;
      const y = PAD.top + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(rect.width - rightPad, y);
      ctx.stroke();
      if (showLeft) {
        ctx.fillStyle = "#9ca3af";
        ctx.textAlign = "right";
        ctx.fillText(AAPF.money(leftMax * frac), leftPad - 8, y);
      }
      lineMetrics.forEach((m, col) => {
        ctx.fillStyle = m.color;
        ctx.textAlign = "left";
        const x = rect.width - rightPad + 8 + col * AXIS_GUTTER;
        ctx.fillText(AAPF.compact(lineMax.get(m.key) * frac), x, y);
      });
    }

    // x-axis labels (skip some if crowded)
    const labelEvery = Math.max(1, Math.ceil((days.length * 34) / plotW));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    days.forEach((day, i) => {
      if (i % labelEvery === 0 || i === days.length - 1) {
        const x = leftPad + i * slot + slot / 2;
        ctx.fillStyle = "#9ca3af";
        ctx.fillText(AAPF.shortDate(day), x, rect.height - PAD.bottom + 6);
      }
    });

    // Revenue bars (left axis), optionally stacked by Actor.
    if (showLeft) {
      days.forEach((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const total = metricValue(day, "revenue");
        const barH = (total / leftMax) * plotH;
        const yTop = PAD.top + plotH - barH;

        if (compositionOn && lastData.daily?.[day]?.length) {
          let acc = 0;
          const grouped = new Map();
          for (const row of lastData.daily[day]) {
            const key = colorByActorId.get(row.actorId) || OTHER_COLOR;
            grouped.set(key, (grouped.get(key) || 0) + (row.revenue || 0));
          }
          const sumRows = [...grouped.entries()].sort((a, b) =>
            a[0] === OTHER_COLOR ? 1 : b[0] === OTHER_COLOR ? -1 : 0,
          );
          const rowsTotal = [...grouped.values()].reduce((s, v) => s + v, 0) || 1;
          for (const [color, value] of sumRows) {
            const segH = (value / rowsTotal) * barH;
            ctx.fillStyle = color;
            ctx.fillRect(x - barW / 2, yTop + barH - acc - segH, barW, segH);
            acc += segH;
          }
        } else {
          ctx.fillStyle = METRICS[0].color;
          ctx.fillRect(x - barW / 2, yTop, barW, barH);
        }
      });
    }

    // Runs/Results lines (each on its own right-side axis) — drawn as a
    // smooth spline rather than straight segments between days, closer to a
    // typical analytics chart.
    for (const m of lineMetrics) {
      const max = lineMax.get(m.key);
      const pts = days.map((day, i) => {
        const x = leftPad + i * slot + slot / 2;
        const v = metricValue(day, m.key);
        const y = PAD.top + plotH - (v / max) * plotH;
        return { x, y };
      });

      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, pts);
      ctx.stroke();

      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- hover tooltip --------------------------------------------------------
  function onHover(e) {
    const canvas = e.currentTarget;
    const days = canvas.__aapDays || [];
    if (!days.length || !lastData) return hideTooltip();

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const leftPad = metricsOn.revenue ? PAD.left : 16;
    const rightPad = METRICS.some((m) => m.kind === "line" && metricsOn[m.key]) ? PAD.right : 16;
    const plotW = rect.width - leftPad - rightPad;
    if (x < leftPad || x > rect.width - rightPad) return hideTooltip();

    const slot = plotW / days.length;
    const idx = Math.min(days.length - 1, Math.max(0, Math.floor((x - leftPad) / slot)));
    const day = days[idx];
    showTooltip(e.clientX, e.clientY, day);
  }

  function showTooltip(clientX, clientY, day) {
    const tooltip = document.querySelector(".aap-tooltip");
    if (!tooltip) return;

    const dm = (lastData.dayMetrics || {})[day];
    const metric = primaryMetric();

    let html = `<div class="aap-tt-title">${AAPF.shortDate(day)}</div>`;
    html += '<div class="aap-tt-stats">';
    html += `<span>Revenue <b>${AAPF.money(dm?.revenue ?? 0)}</b></span>`;
    html += `<span>Costs <b>${AAPF.money(dm?.cost ?? 0)}</b></span>`;
    html += `<span>Profit <b>${AAPF.money(dm?.profit ?? 0)}</b></span>`;
    html += `<span>Margin <b>${dm?.margin != null ? AAPF.pct(dm.margin) : "–"}</b></span>`;
    html += `<span>Runs <b>${AAPF.compact(dm?.runs ?? 0)}</b></span>`;
    html += `<span>Results <b>${AAPF.compact(dm?.results ?? 0)}</b></span>`;
    html += `<span>Success <b>${dm?.successRate != null ? AAPF.pct(dm.successRate) : "–"}</b></span>`;
    html += "</div>";

    const rows = [...(lastData.daily?.[day] || [])].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    const top10 = rows.slice(0, 10);

    if (top10.length) {
      html += `<div class="aap-tt-subtitle">Top Actors by ${METRICS.find((m) => m.key === metric).label}</div>`;
      html +=
        '<table class="aap-tt-table"><thead><tr><th></th><th>Revenue</th><th>Runs</th><th>Results</th></tr></thead><tbody>';
      for (const row of top10) {
        const color = colorByActorId.get(row.actorId) || OTHER_COLOR;
        html +=
          `<tr><td><span class="aap-tt-dot" style="background:${color}"></span>${escapeHtml(row.name)}</td>` +
          `<td>${AAPF.money(row.revenue || 0)}</td>` +
          `<td>${AAPF.compact(row.runs || 0)}</td>` +
          `<td>${AAPF.compact(row.results || 0)}</td></tr>`;
      }
      html += "</tbody></table>";
    } else if (lastData.indexing) {
      html += `<div class="aap-tt-note">Indexing Actors… ${lastData.progress ? `${lastData.progress.done}/${lastData.progress.total}` : ""}</div>`;
    } else {
      html += `<div class="aap-tt-note">No paid Actor activity this day.</div>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = "block";

    const ttRect = tooltip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + ttRect.width > window.innerWidth - 8) left = clientX - ttRect.width - 14;
    if (top + ttRect.height > window.innerHeight - 8) top = clientY - ttRect.height - 14;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    const tooltip = document.querySelector(".aap-tooltip");
    if (tooltip) tooltip.style.display = "none";
  }

  // Traces `pts` as a smooth Catmull-Rom spline converted to cubic beziers —
  // unlike a midpoint-quadratic smoother, this passes exactly through every
  // point (converted to bezier tangents from each point's neighbors), so the
  // dot markers drawn at the same points always sit right on the line.
  function drawSmoothLine(ctx, pts) {
    ctx.beginPath();
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].x, pts[1].y);
      return;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
