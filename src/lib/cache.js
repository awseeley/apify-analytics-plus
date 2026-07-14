/* chrome.storage.local cache for the per-Actor daily breakdown of one month. */
(function () {
  const TTL_MS = 15 * 60 * 1000;

  // scope is the native Actor filter as a sorted comma-joined id list; ""
  // (all Actors) keeps the historical un-suffixed key so existing caches
  // survive the upgrade.
  function key(month, scope) {
    return `aap.breakdown.${month}${scope ? ":" + scope : ""}`;
  }

  async function get(month, scope) {
    const k = key(month, scope);
    const rec = (await chrome.storage.local.get(k))[k];
    if (!rec) return null;
    return { ...rec, stale: Date.now() - rec.updatedAt > TTL_MS };
  }

  async function set(month, scope, data) {
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
