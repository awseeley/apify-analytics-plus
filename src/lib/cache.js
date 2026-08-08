/* chrome.storage.local cache for the per-Actor daily breakdown of one month. */
(function () {
  const TTL_MS = 15 * 60 * 1000;
  const VERSION_KEY = "aap.cacheVersion";

  // Wipe every cached breakdown the first time a new extension version runs.
  // A version bump can change what a record means or fix a bug that cached
  // wrong data (e.g. the actorIds[] 400s silently caching an empty breakdown,
  // which then kept the chart flat until the TTL expired or the user found
  // the manual Clear-cache button). get/set await this gate so a page that's
  // already loading can't read or write around the wipe.
  const versionReady = (async () => {
    const version = chrome.runtime.getManifest().version;
    const stored = (await chrome.storage.local.get(VERSION_KEY))[VERSION_KEY];
    if (stored !== version) {
      await clearAll();
      await chrome.storage.local.set({ [VERSION_KEY]: version });
    }
  })();

  // scope is the native Actor filter as a sorted comma-joined id list; ""
  // (all Actors) keeps the historical un-suffixed key so existing caches
  // survive the upgrade.
  function key(month, scope) {
    return `aap.breakdown.${month}${scope ? ":" + scope : ""}`;
  }

  async function get(month, scope) {
    await versionReady;
    const k = key(month, scope);
    const rec = (await chrome.storage.local.get(k))[k];
    if (!rec) return null;
    return { ...rec, stale: Date.now() - rec.updatedAt > TTL_MS };
  }

  async function set(month, scope, data) {
    await versionReady;
    const k = key(month, scope);
    const rec = { ...data, updatedAt: Date.now() };
    await chrome.storage.local.set({ [k]: rec });
    return rec;
  }

  async function clearAll() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("aap.breakdown."));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  self.AAP_CACHE = { get, set, clearAll };
})();
