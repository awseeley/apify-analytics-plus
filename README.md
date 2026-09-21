# Apify Analytics Plus, browser extension

A Chrome, Edge and Firefox (Manifest V3) extension that adds a per-Actor
daily breakdown to the Apify Console's **Monetization insights** page
(`console.apify.com/actors/insights/monetization`).

> **This repository is a read-only mirror.** The code is developed in a
> private monorepo and pushed here automatically on every change, so commits
> made directly to this repo will be overwritten. It exists so that anyone
> running the extension can read exactly what they are running, and diff it
> against the packages on the Chrome, Edge and Firefox stores. Issues are
> welcome; please open them here rather than sending pull requests.

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
   cached in `chrome.storage.local` so revisiting the page is instant: 15
   minutes for the current month (its numbers still move), 30 days for past
   months (final after the payout invoice; see *Date ranges* for the TTLs).

Request budget, so Apify's backend is never hammered: at most 5 calls in
flight; a cold month costs 3 account-wide calls plus 2 per paid Actor; a warm
one costs 0 (past month) or 2 (current month). Only the current month is
refreshed while the tab stays open (day totals every 60 s, a full re-index
every 15 min), past months never are, and a background (hidden) tab does
nothing at all.

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

## Date ranges (0.3.0+)

Pills styled like the Console's own controls, mounted right after its month
picker in the native filter bar (`.SequenceSelect`; falls back to the top of
our toolbar if that ever disappears), pick what the chart covers:

- **This month**, **Last 30 days**, **Last 90 days** pills. With none active
  the chart follows Apify's own month picker, as before; clicking the active
  pill again returns to it, and so does flipping the picker.
- **Custom range** — a button opening two native date inputs (the browser's
  calendar dropdown) with Apply / Clear; once set, the button shows the
  dates.
- An **All time** mode exists in the loader (`rangeMode: "all"`, see
  resolveFirstMonth) but isn't surfaced in the bar yet.

The choice is remembered. While a preset or custom range is active, the
Console's Costs / Revenue / Profit / Margin cards above the chart show the
range's totals (hover a figure for Apify's own month value)
and are restored when you return to the picker month. Hovering a bar still
shows that day's Actor table; on dense ranges the x-axis labels month starts.

The backend is month-scoped, so a range is the union of the months it
touches, loaded in two phases and cached per month:

1. **Day totals** (2 requests per month) load first, newest month first, and
   the chart draws as they land. Past months are cached for 30 days (they're
   final; the previous month stays on a 6-hour TTL until the 14th, while
   Apify's payout invoice can still move it), the current month for 60 s.
2. **Per-Actor breakdown** (1 + 2 requests per paid Actor, per month) then
   loads one month at a time, newest first, from cache wherever it's fresh
   (30 days for past months, 15 min for the current one). A single load
   indexes at most 6 not-yet-cached months on its own; beyond that the
   status line says how many months are covered and offers a "Load N more
   (~X requests)" button, so "All time" on an account with years of history
   never fires hundreds of requests unasked. Months with no activity are
   cached as empty and never re-indexed.

**All time** finds the account's first month once: it walks back from the
current month (6 months at a time, in parallel) until 6 consecutive empty
months, caching each probed month's totals as above and the answer itself
for good. Switching between overlapping presets (Last 30 → Last 90 → This
month) reuses the months already in memory — no storage read, no request.
Only the current month is refreshed while a tab stays open; every other
month in a range is served from cache.

## Highlights (0.3.0+)

A panel between the chart and the Console's Actor table with four cards for
the selected range: top 3 Actors by profit, top 3 by cost, and the best and
worst 3 by success rate (Actors with fewer than 20 runs in the range are
left out of the success-rate cards). Rows show the Actor's own Console icon
(from the breakdown response, cached per month). Built from the per-Actor
index already in memory, so it adds no requests. The panel's Hide button turns it off;
the popup's Settings turn it back on.

## No data leaves your browser (0.3.3+)

Versions 0.2.0 through 0.3.2 could POST derived per-Actor cost/revenue/profit
figures to an Apify Hub ingest endpoint on `*.convex.site`. It was opt-in (no
request was ever made without a hub key pasted into the popup), but the
manifest still declared the host permission at install time for everyone, so
every user was asked to grant an outbound host they would probably never use.

That was the wrong trade. As of 0.3.3 the sync, its host permission, its
background service worker and the popup's key field are gone. The only host
this extension talks to is `console-backend.apify.com`, Apify's own backend,
for the user who is already logged into it. On upgrade the popup clears the
`aap.hub.*` keys the old version left in `chrome.storage.local`.

## Architecture

```
src/
  manifest.json               MV3 manifest (two content-script worlds + popup;
                               no background worker, one host permission)
  content/token-sniffer.js    MAIN world, document_start: sniffs the bearer
                               token + the `month`/`actorIds[]` of every
                               actor-analytics request the page makes
  content/app.js               isolated world: renders the panel, drives the
                               indexing pass, owns the click-a-day UI
  content/app.css
  lib/api.js                  actor-analytics fetch client + a small
                               concurrency-limited pool for the per-Actor pass
  lib/cache.js                chrome.storage.local cache: per-month day
                               totals + per-Actor breakdown + first month
  lib/format.js                money / percent / date helpers
  popup/*                     shows cached months, "clear cache" button
                               (also resets the cached "All time" start)
build.mjs                     emits dist/chrome, dist/edge and dist/firefox
```

## Build & load

```bash
node build.mjs
```

- **Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked*
  → select `dist/chrome`.
- **Edge:** `edge://extensions` → enable *Developer mode* → *Load unpacked* →
  select `dist/edge`.

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
