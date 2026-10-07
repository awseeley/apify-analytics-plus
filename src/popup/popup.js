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
    const keys = Object.keys(all).filter((k) => k.startsWith("aap.breakdown.") || k.startsWith("aap.acq.") || k.startsWith("aap.actorMeta"));
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

  // ---- Settings: panel toggles. Absent = on, so only an explicit false
  // is stored; the content scripts pick changes up live via onChanged.
  const TOGGLES = { "highlights-on": "aap.highlightsOn", "hl-customise-on": "aap.hlCustomiseOn", "acq-actors-on": "aap.acqActorsOn", "ql-on": "aap.qualityListOn" };
  chrome.storage.local.get(Object.values(TOGGLES)).then((r) => {
    for (const [id, key] of Object.entries(TOGGLES)) {
      const box = document.getElementById(id);
      box.checked = r[key] !== false;
      box.addEventListener("change", () => {
        if (box.checked) chrome.storage.local.remove(key);
        else chrome.storage.local.set({ [key]: false });
      });
    }
  });

  // ---- Settings: individual Highlights cards. One object pref holding
  // `false` per hidden card (absent = shown), the same one the panel's own
  // customise menu writes. Greyed out while the whole panel is off.
  const HL_CARDS_KEY = "aap.hlCards";
  const cardBoxes = [...document.querySelectorAll("#hl-cards input[data-card], #hl-cards-extra input[data-card]")];
  const hlGroup = document.getElementById("hl-cards");
  const highlightsBox = document.getElementById("highlights-on");
  const syncHlGroup = () => hlGroup.classList.toggle("disabled", !highlightsBox.checked);
  highlightsBox.addEventListener("change", syncHlGroup);

  function paintCards(off) {
    for (const box of cardBoxes) box.checked = off[box.dataset.card] !== false;
  }
  chrome.storage.local.get([HL_CARDS_KEY, "aap.highlightsOn"]).then((r) => {
    paintCards(r[HL_CARDS_KEY] || {});
    highlightsBox.checked = r["aap.highlightsOn"] !== false;
    syncHlGroup();
  });
  // The in-page menu can change these while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[HL_CARDS_KEY]) paintCards(changes[HL_CARDS_KEY].newValue || {});
  });
  for (const box of cardBoxes) {
    box.addEventListener("change", async () => {
      const off = { ...((await chrome.storage.local.get(HL_CARDS_KEY))[HL_CARDS_KEY] || {}) };
      if (box.checked) delete off[box.dataset.card];
      else off[box.dataset.card] = false;
      chrome.storage.local.set({ [HL_CARDS_KEY]: off });
    });
  }

  // 0.3.3 removed the Apify Hub sync entirely. Purge what it left behind so
  // an upgraded install keeps no key or sync history on disk.
  chrome.storage.local.remove(["aap.hub.key", "aap.hub.endpoint", "aap.hub.lastSync", "aap.hub.autoSync"]);

  loadCacheSummary();
})();
