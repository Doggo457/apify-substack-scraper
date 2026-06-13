# Substack Scraper (Apify actor)

Fast Substack scraper built on Crawlee's `CheerioCrawler`. Uses Substack's public JSON API — no browser, no JavaScript execution.

See [`.actor/README.md`](.actor/README.md) for the user-facing documentation published on the Apify Store.

## Local dev

```bash
npm install
npm test            # syntax checks + URL-classification unit checks
npx apify run --purge
```

Set input by editing `storage/key_value_stores/default/INPUT.json` before running. Local runs connect directly (no proxy); on the platform the actor uses automatic Apify datacenter proxies.

## Deploy to Apify

```bash
npx apify push
```

## Layout

- `src/main.js` — actor entry: input parsing, pricing-model detection, crawler setup, request-count safety cap
- `src/routes.js` — per-label request handlers (publication page, archive, post, comments, author, recommendations, redirect resolution)
- `src/utils.js` — URL classification (incl. open.substack.com links), preload extraction, HTML stripping
- `src/state.js` — crawl state persisted via `Actor.useState` (survives migrations): per-publication counters, publication/post dedupe, discovery budget, charge caps
- `scripts/check-classify.mjs` — offline unit checks for URL classification and HTML stripping
- `.actor/input_schema.json` — user-facing inputs
- `.actor/actor.json` — actor metadata, memory defaults, dataset schema + per-type views

## Architecture notes

- **Single dataset, `type` discriminator.** All record types go to the run's default dataset; per-type tables are dataset views. Named datasets are account-global on the platform (they would mix data across runs and never expire), so they are never used.
- **Pricing-model aware.** Under pay-per-event, each record charges an event named after its `type` (`post` / `publication` / `author` / `comment`) via `Actor.pushData(items, eventName)`, and the crawl winds down when the buyer's budget is exhausted. Under per-result pricing, the platform charges per default-dataset item and `ACTOR_MAX_PAID_DATASET_ITEMS` is honored. Test the PPE path locally with `ACTOR_TEST_PAY_PER_EVENT=1`.
- **State survives migrations** (`Actor.useState`): post counters, seen/saved dedupe maps, and the discovery budget persist, so a restart can never deliver duplicate or excess records.
- **Archive pagination runs until an empty page.** The API returns short pages mid-archive (offset=0 reliably returns ~23 items, verified June 2026), so a short page must NOT be treated as the end; the offset advances by the actual page length.
- **404s arrive as 200-shaped JSON** (`{"error":"Post not found"}`) — handlers validate `payload.id` before saving, and failed post fetches are salvaged from archive metadata.
