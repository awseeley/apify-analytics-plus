(function () {
  // Chrome Web Store installs get `update_url` injected into the runtime
  // manifest automatically; unpacked/dev-loaded installs never have it. Used
  // to keep the Apify Hub promo out of the published extension for now
  // without needing a separate build flag.
  if (!chrome.runtime.getManifest().update_url) {
    document.querySelector(".promo")?.classList.remove("promo-hidden");
  }

  // ---- Views: main <-> settings ----
  const mainView = document.getElementById("view-main");
  const settingsView = document.getElementById("view-settings");
  document.getElementById("open-settings").addEventListener("click", () => {
    mainView.hidden = true;
    settingsView.hidden = false;
  });
  document.getElementById("back-to-main").addEventListener("click", () => {
    settingsView.hidden = true;
    mainView.hidden = false;
  });

  async function loadCacheSummary() {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith("aap.breakdown."))
      .map(([k, v]) => {
        // key is "aap.breakdown.<month>" or "aap.breakdown.<month>:<actorIds>"
        // when the view was scoped to the native Actor filter
        const [month, scope] = k.replace("aap.breakdown.", "").split(":");
        return { month, filtered: !!scope, ...v };
      })
      .sort((a, b) => b.month.localeCompare(a.month));

    const body = document.getElementById("cache-body");
    body.replaceChildren();
    if (!entries.length) {
      body.className = "muted";
      body.textContent = "No cached months yet — open the Insights page.";
      return;
    }
    body.className = "";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "cache-row";
      const label = document.createElement("span");
      label.textContent = e.filtered ? `${e.month} (filtered)` : e.month;
      const meta = document.createElement("span");
      const actors = e.actorCount != null ? `${e.actorCount} actors` : "–";
      const when = e.updatedAt ? new Date(e.updatedAt).toLocaleTimeString() : "";
      meta.textContent = `${actors} · ${when}`;
      row.append(label, meta);
      body.appendChild(row);
    }
  }

  document.getElementById("clear-cache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("aap.breakdown."));
    if (keys.length) await chrome.storage.local.remove(keys);
    loadCacheSummary();
  });

  // ---- Settings: breakdown tooltip actor count ----
  // Kept opt-in — the content script falls back to this same default when
  // nothing is stored, so a user who never opens this panel sees no change.
  const TOOLTIP_ACTOR_COUNT_KEY = "aap.tooltipActorCount";
  const TOOLTIP_ACTOR_COUNT_DEFAULT = 10;

  const countInput = document.getElementById("tooltip-actor-count");
  document.getElementById("tooltip-actor-count-default").textContent = TOOLTIP_ACTOR_COUNT_DEFAULT;

  chrome.storage.local.get(TOOLTIP_ACTOR_COUNT_KEY).then((r) => {
    countInput.value = r[TOOLTIP_ACTOR_COUNT_KEY] > 0 ? r[TOOLTIP_ACTOR_COUNT_KEY] : TOOLTIP_ACTOR_COUNT_DEFAULT;
  });

  countInput.addEventListener("change", () => {
    const n = Math.round(Number(countInput.value));
    if (!(n > 0)) {
      countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
      chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
      return;
    }
    countInput.value = n;
    chrome.storage.local.set({ [TOOLTIP_ACTOR_COUNT_KEY]: n });
  });

  document.getElementById("tooltip-actor-count-reset").addEventListener("click", () => {
    countInput.value = TOOLTIP_ACTOR_COUNT_DEFAULT;
    chrome.storage.local.remove(TOOLTIP_ACTOR_COUNT_KEY);
  });

  // ---- Settings: Apify Hub sync ----
  // Key only: the endpoint is fixed (a local hub sets aap.hub.endpoint from
  // the service worker console) and syncing is unconditional once a key
  // exists, so there is nothing else here to get wrong.
  const HUB = {
    key: "aap.hub.key",
    endpoint: "aap.hub.endpoint",
    lastSync: "aap.hub.lastSync",
  };
  const HUB_DEFAULT_ENDPOINT = "https://notable-toad-601.convex.site";
  const HUB_MONTHS_SHOWN = 6;
  const hubKey = document.getElementById("hub-key");
  const hubMonths = document.getElementById("hub-months");
  const hubStatus = document.getElementById("hub-status");
  const hubEndpointNote = document.getElementById("hub-endpoint-note");
  const hubEndpointHost = document.getElementById("hub-endpoint-host");

  // There is no endpoint field: the hub URL is fixed and a local hub sets
  // aap.hub.endpoint from the service worker console. But an override left
  // behind after local work silently sends every sync somewhere that isn't
  // running, so when one exists it shows here with a way out.
  function renderHubEndpoint(endpoint) {
    const custom = endpoint && endpoint.replace(/\/+$/, "") !== HUB_DEFAULT_ENDPOINT;
    hubEndpointNote.hidden = !custom;
    if (custom) hubEndpointHost.textContent = endpoint;
  }
  document.getElementById("hub-endpoint-reset").addEventListener("click", () => {
    chrome.storage.local.remove(HUB.endpoint);
    renderHubEndpoint(null);
  });

  function renderHubStatus(lastSync) {
    const entries = Object.entries(lastSync || {}).sort((a, b) => b[0].localeCompare(a[0]));
    hubMonths.replaceChildren();
    if (!entries.length) {
      hubStatus.textContent = hubKey.value ? "No sync yet. Open the Insights page." : "";
      return;
    }
    for (const [month, r] of entries.slice(0, HUB_MONTHS_SHOWN)) {
      const row = document.createElement("div");
      row.className = "cache-row";
      const label = document.createElement("span");
      label.textContent = month;
      const meta = document.createElement("span");
      // "–" is a month with no activity at all: nothing was sent, and nothing
      // needs to be.
      meta.textContent = `${r.ok ? (r.empty ? "–" : "✓") : "✗"} ${r.message}`;
      row.append(label, meta);
      hubMonths.appendChild(row);
    }
    const synced = entries.filter(([, r]) => r.ok && !r.empty).length;
    const hidden = Math.max(0, entries.length - HUB_MONTHS_SHOWN);
    const last = entries[0][1].at ? new Date(entries[0][1].at).toLocaleString() : "";
    hubStatus.textContent =
      `${synced} month${synced === 1 ? "" : "s"} synced` +
      `${hidden ? ` (${hidden} older not shown)` : ""}${last ? ` · last ${last}` : ""}`;
  }

  chrome.storage.local.get([HUB.key, HUB.endpoint, HUB.lastSync]).then((r) => {
    hubKey.value = r[HUB.key] || "";
    renderHubEndpoint(r[HUB.endpoint]);
    renderHubStatus(r[HUB.lastSync]);
  });
  hubKey.addEventListener("change", () => {
    const v = hubKey.value.trim();
    if (v) chrome.storage.local.set({ [HUB.key]: v });
    else chrome.storage.local.remove(HUB.key);
    chrome.storage.local.get(HUB.lastSync).then((r) => renderHubStatus(r[HUB.lastSync]));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[HUB.lastSync]) renderHubStatus(changes[HUB.lastSync].newValue);
  });

  // The auto-sync toggle this panel used to carry is gone (syncing is always
  // on once a key exists); drop what it left behind so a stale `false` can't
  // look meaningful to a later version.
  chrome.storage.local.remove("aap.hub.autoSync");

  loadCacheSummary();
})();
