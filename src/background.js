/*
 * Service worker: relays "sync to Apify Hub" POSTs from the content script.
 * Content scripts are bound by the page's CORS, so cross-origin fetches to the
 * hub's ingest endpoint go through here (host_permissions: *.convex.site).
 * Nothing else runs in the background; the worker sleeps between messages.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "AAP_HUB_SYNC") return false;
  (async () => {
    try {
      const res = await fetch(msg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${msg.key}`,
        },
        body: JSON.stringify(msg.body),
      });
      const text = await res.text();
      sendResponse({ ok: res.ok, status: res.status, text: text.slice(0, 500) });
    } catch (err) {
      sendResponse({ ok: false, status: 0, text: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // keep the channel open for the async response
});
