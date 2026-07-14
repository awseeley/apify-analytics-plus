# Apify Analytics Plus — browser extension

A Chrome + Edge (Manifest V3) extension that adds a per-Actor daily
breakdown to the Apify Console's **Monetization insights** page
(`console.apify.com/actors/insights/monetization`).

## What it does

The native page shows account-wide revenue/cost/profit per day (a bar chart)
and per-Actor totals for the whole month (a table) — but not both at once.
This extension injects a panel under the chart with:

- A row of clickable day chips (mini bar chart, driven by the same daily
  totals as the native chart).
- A sortable-by-revenue table of every **paying** Actor's revenue, cost,
  profit, margin, runs, success rate and results **for the selected day**.

Click a day → see exactly which Actors drove it.

## How it gets the data

The page calls `console-backend.apify.com/actor-analytics/*` endpoints
(`profit-margin`, `actor-breakdown`, `run-statistics/monthly/all-users`),
which already accept a repeated `actorIds[]` query param to scope any of them
to one Actor. The native UI only ever calls them for "all actors" or for
whichever Actors are in its own filter — it never loops over every Actor to
build a per-day-per-actor matrix. This extension does exactly that loop:

1. Fetch `actor-breakdown` for the month (no filter) to get the full Actor
   list, then keep only Actors with nonzero revenue/cost for that month
   (typically a few dozen, not your whole account).
2. Fetch `profit-margin` + `run-statistics` once per paid Actor (5 requests
   in flight at a time), each scoped with `actorIds[]=<id>`.
3. Merge everything into a `{ day: [ {actor, revenue, cost, ...} ] }` index,
   cached in `chrome.storage.local` for 15 minutes so revisiting the page is
   instant.

**Auth:** these endpoints require the same bearer token the Console's own
API client already attaches to its requests (there's no session cookie on
`console-backend.apify.com` — a bare navigation there 401s with
`token-not-provided`). Rather than reading that token out of any storage,
`content/token-sniffer.js` runs in the page's own JS world and watches the
`Authorization` header the page was *already* about to send on a request it
was making anyway, then hands it to the extension's isolated content script
over a `CustomEvent`. The token is only ever used to call this same
first-party endpoint, for the same logged-in user, from this same browser —
it's never persisted or sent anywhere else.

## Architecture

```
src/
  manifest.json               MV3 manifest (two content-script worlds + popup)
  content/token-sniffer.js    MAIN world, document_start: sniffs the bearer
                               token + the `month`/`actorIds[]` of every
                               actor-analytics request the page makes
  content/app.js               isolated world: renders the panel, drives the
                               indexing pass, owns the click-a-day UI
  content/app.css
  lib/api.js                  actor-analytics fetch client + a small
                               concurrency-limited pool for the per-Actor pass
  lib/cache.js                chrome.storage.local cache (15 min TTL)
  lib/format.js                money / percent / date helpers
  popup/*                     shows cached months, "clear cache" button
build.mjs                     emits dist/chrome and dist/edge
```

## Build & load

```bash
node extensions/apify-analytics-plus/build.mjs
```

- **Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked*
  → select `extensions/apify-analytics-plus/dist/chrome`.
- **Edge:** `edge://extensions` → enable *Developer mode* → *Load unpacked* →
  select `extensions/apify-analytics-plus/dist/edge`.

`src/` is also directly loadable during development.

## Notes / limitations

- Follows the native **Actor filter**: with a filter set, the chart, day
  totals and per-Actor index are all scoped to the filtered Actor(s), and the
  scoped breakdown is cached under its own key (shown as "(filtered)" in the
  popup).
- Selectors target Apify's *readable* styled-component class prefixes
  (`PaidActorProfitMarginChart`) via `[class*=]`, which tend to survive
  rebuilds even though the hash suffixes change. If Apify renames that
  component, update `findAnchor()` in `content/app.js`.
- Indexing cost scales with how many Actors had *any* charge that month, not
  your total Actor count — zero-revenue Actors are skipped before the
  per-Actor fetch loop.
