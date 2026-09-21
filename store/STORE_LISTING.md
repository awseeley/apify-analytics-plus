# Chrome Web Store listing — Apify Analytics Plus

Everything below is ready to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole).
Upload package: `dist/apify-analytics-plus-chrome.zip` (rebuild with
`node build.mjs`).

> All screenshots were generated from a local mock harness with fabricated
> data — no real account, actor names, or revenue figures appear in them.

## Listing

**Name:** Apify Analytics Plus

**Summary (132 chars max):**
Per-Actor daily revenue breakdown for the Apify Console. Hover any day to see which Actors drove it.

**Category:** Developer Tools

**Language:** English

**Description:**

```
See which Actors drove each day's revenue, right inside the Apify Console.

The Console's Monetization insights page shows account-wide revenue per day,
and per-Actor totals for the whole month, but never both at once. Apify
Analytics Plus fills that gap with a richer chart, drawn in place of the
native one:

• Hover any day for that day's revenue, costs, profit, margin, runs, results
  and success rate, plus a top-10 table of the Actors that drove it.
• Stack the revenue bars by Actor to see composition at a glance, with
  stable per-Actor colors across the whole month.
• Overlay Runs and Results trend lines, each on its own axis.
• Follows the Console's native Actor filter. Filter to one Actor and every
  number scopes to it.
• Flip back to the original Apify chart at any time with one checkbox.

How it works: the extension calls the same first-party Apify analytics API
the Insights page itself uses, once per monetized Actor, and merges the
results into a per-day, per-Actor index. Results are cached locally in your
browser for 15 minutes, so revisiting the page is instant.

Privacy: everything stays in your browser. The extension talks only to
Apify's own analytics backend, using the session the Console page already
has. Nothing is collected, stored remotely, or sent to any third party.

Not affiliated with or endorsed by Apify.
```

## Release notes (0.3.3)

Paste into the "What's new" / release-notes field on each store.

```
0.3.3 removes the optional Apify Hub sync and the host permission it needed.

Earlier versions could send derived per-Actor revenue and cost totals to an
Apify Hub ingest endpoint, but only if you pasted a hub key into the popup.
No key meant no request. Even so, the manifest declared the outbound host
permission for everyone at install time, including the large majority who
never used the feature, and a permission you have to take on trust is worse
than a feature you can live without.

The sync, its host permission, its background service worker and the popup's
key field are all gone. This version talks to exactly one host,
console-backend.apify.com, which is Apify's own backend, using the session
you are already logged into. Nothing else is contacted. If you had a key
saved, the popup deletes it from local storage on upgrade.

0.3.4 goes one step further and requests no host permissions whatsoever:
those first-party calls are now made from the Console page's own context, so
they need no separate grant. The extension asks for local storage, and that
is all.
```

## Images

| Asset | File |
|---|---|
| Screenshot 1 (1280×800) | `screenshot-1-tooltip.png` — day tooltip with top Actors table |
| Screenshot 2 (1280×800) | `screenshot-2-breakdown.png` — revenue stacked by Actor |
| Screenshot 3 (1280×800) | `screenshot-3-multimetric.png` — runs + results overlays |
| Screenshot 4 (1280×800) | `screenshot-4-popup.png` — popup / feature overview |
| Small promo tile (440×280) | `promo-tile-440x280.png` |

## Privacy tab

**Single purpose description:**
Adds a per-Actor daily revenue/cost/profit breakdown to the Apify Console's
Monetization insights page.

**Permission justifications:**

- `storage` — caches the computed per-Actor daily breakdown locally for 15
  minutes so revisiting the Insights page doesn't refetch, and remembers the
  user's chart toggle preferences.
- Host permissions — none. 0.3.4 removed the last one
  (`https://console-backend.apify.com/*`): the extension's requests to that
  first-party backend are now issued from the Console page's own JavaScript
  context, so they carry the console.apify.com origin exactly as the page's
  own calls to it do, and no cross-origin grant is needed.
- Content scripts on `https://console.apify.com/*` — one script renders the
  breakdown panel on the Monetization insights page; a second (MAIN world)
  observes the Authorization header the Console attaches to its own
  analytics requests, then reuses it to call the same first-party
  actor-analytics endpoints (`actor-breakdown`, `profit-margin`,
  `run-statistics`) scoped per Actor. Those calls are the extension's single
  data source. The token is held in memory only, never persisted, and never
  sent anywhere except `console-backend.apify.com`.

**Remote code:** No, I am not using remote code. (All JS is packaged; no
eval, no CDN scripts.)

**Data usage:**
- Collects: **Website content** (revenue/cost/run statistics fetched from
  Apify's analytics API) and **Authentication information** (the Console
  session's bearer token, held in memory only). Everything is processed and
  cached locally; nothing leaves the browser except requests to Apify's own
  backend.
- Certify: data is NOT sold, NOT used for unrelated purposes, NOT used for
  creditworthiness/lending.

## Submission checklist

1. `node build.mjs`
2. Upload `dist/apify-analytics-plus-chrome.zip`
3. Paste listing text + upload the 4 screenshots and promo tile
4. Fill the Privacy tab from the section above
5. Visibility: Public (or Unlisted for a soft launch)

Edge (optional): same flow at the [Edge Add-ons dashboard](https://partner.microsoft.com/dashboard/microsoftedge)
with `dist/apify-analytics-plus-edge.zip`.

Firefox (optional): submit `dist/apify-analytics-plus-firefox.zip` at the
[AMO Developer Hub](https://addons.mozilla.org/developers/) ("Submit a New
Add-on" → On this site). The manifest already carries the required
`browser_specific_settings.gecko` block (id
`apify-analytics-plus@apifyhub.com`, min Firefox 128 — needed for the
MAIN-world token sniffer). AMO asks for source code only if the package is
minified — ours isn't, so plain submission is fine. For local testing use
about:debugging → This Firefox → Load Temporary Add-on (resets on restart;
permanent installs must be AMO-signed).

## Regenerating screenshots

The mock harness (Console-lookalike page + fake data driving the extension's
real `app.js`/`app.css`) is a throwaway under the Claude session scratchpad
(`aap-harness/`); the images in this folder are the durable output. If you
need to regenerate later, the harness is easy to rebuild: shim
`chrome.storage` + `AAP_API` + `AAP_CACHE`, patch `ROUTE` to
`location.pathname`, and screenshot with
`chrome --headless=new --window-size=1280,800 --virtual-time-budget=10000`.
