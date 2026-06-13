# Substack Scraper

**Scrape any Substack newsletter, post, author, or comment — fast, cheap, and at scale.**

This Apify actor extracts structured data from Substack publications via their public JSON API. No browser, no JavaScript rendering, no login required. Built for newsletter research, content monitoring, author discovery, competitive intelligence, and LLM training datasets.

## What you can scrape

- **Substack posts** — title, subtitle, full HTML and plain-text body, word count, publish date, tags, cover image, paywall status, reactions, comment count, restacks
- **Substack publications** — name, subdomain, custom domain, description, logo, category, language, subscriber count (when public), founding plan
- **Substack authors** — profile, handle, bio, photo, the publications they write for, the publications they subscribe to
- **Substack comments** — full nested comment threads, author handles, publish dates, reactions, reply depth

Works with any Substack URL: `https://*.substack.com`, custom domains (`https://stratechery.com`), individual post URLs, `https://substack.com/@handle` author profiles, and `https://open.substack.com/pub/...` share links.

## Why use this Substack scraper

- **Pay only for data, not for browser time** — no Playwright, no rendering overhead, no per-minute compute billing. You pay per result, and failed requests are never charged.
- **Full archives, not just the front page** — paginates through the entire publication archive until the very first post.
- **Clean, typed output** — one dataset with a `type` field (`post` / `publication` / `author` / `comment`) and per-type table views, so you can export straight to BI tools, CSV, JSON, Excel, or Google Sheets.
- **No duplicates, no surprises** — every post is delivered exactly once, limits are enforced even across platform restarts, and proxy rotation is handled for you.

## Common use cases

- **Newsletter research** — download the full archive of a competitor's Substack for content analysis, topic clustering, or SEO research
- **Content monitoring** — schedule a daily run with `maxPostsPerPublication: 5` to capture new posts from a tracked list of newsletters and pipe to Slack or email
- **Author discovery and lead generation** — crawl author profiles to map who writes for which publications, then export handles for outreach
- **LLM training data** — bulk-extract long-form Substack content (with word counts and metadata) for fine-tuning datasets
- **Competitive intelligence** — track subscriber counts, post frequency, paywall strategy, and engagement metrics (reactions, comments, restacks) across a competitor set
- **Academic and journalism research** — gather statements, essays, and commentary from Substack writers with citable timestamps
- **Archiving and backup** — export your own Substack publication before a migration

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `startUrls` | array of URLs | — | Substack publication, post, or author URLs. Leave empty only when using Discovery mode |
| `mode` | `posts` / `publication` | `posts` | What to pull for each publication URL |
| `maxPostsPerPublication` | integer | 50 | Cap per publication. `0` = entire archive. Lower = cheaper |
| `includeContent` | boolean | true | Fetch each post's full HTML body |
| `includeComments` | boolean | false | Fetch comments for each post (each comment is a separate result) |
| `onlyFreePosts` | boolean | false | Skip paid / subscriber-only posts in archives |
| `searchQuery` | string | — | Filter the publication archive by keyword |
| `discoveryMode` | `none` / `leaderboard` / `search` | `none` | Auto-discover many publications without providing URLs |
| `discoveryQuery` | string | — | Keyword for `search` discovery |
| `maxPublicationsToDiscover` | integer | 25 | Cap on discovered publications. Lower = cheaper |
| `maxConcurrency` | integer | 5 | Parallel requests |

### Discovery mode — scrape many publications without a list

If you don't have a list of specific newsletters, turn on **Discovery mode** and the actor will find publications for you:

- **Top publications** (`leaderboard`) — seeds from 5 curated top Substacks and expands through each publication's recommendations until the limit is hit
- **Search** (`search`) — same expansion, plus your `discoveryQuery` keyword filters every discovered publication's archive

Each discovered publication is then scraped using the same `mode` / `maxPostsPerPublication` settings as `startUrls`, so you can go from zero URLs to a full corpus in one run. Discovery is **off by default** — a discovery run scrapes many publications and produces a correspondingly large dataset.

```json
{
    "discoveryMode": "search",
    "discoveryQuery": "AI",
    "maxPublicationsToDiscover": 50,
    "mode": "posts",
    "maxPostsPerPublication": 20,
    "includeContent": true
}
```

## Example input

```json
{
    "startUrls": [
        { "url": "https://www.thefitzwilliam.com" },
        { "url": "https://noahpinion.substack.com" },
        { "url": "https://substack.com/@mattyglesias" }
    ],
    "mode": "posts",
    "maxPostsPerPublication": 100,
    "includeContent": true,
    "includeComments": false
}
```

## Output

All records land in the run's dataset with a `type` discriminator (`post`, `publication`, `author`, `comment`). The Output tab offers per-type table views (**Posts**, **Publications**, **Authors**, **Comments**); for exports, filter on the `type` field to split record types into separate files.

### Post record

```json
{
    "type": "post",
    "id": 123456,
    "title": "Why newsletters won",
    "slug": "why-newsletters-won",
    "url": "https://example.substack.com/p/why-newsletters-won",
    "publication": "example",
    "publicationName": "The Example",
    "publishedAt": "2026-02-01T14:00:00Z",
    "audience": "everyone",
    "isPaid": false,
    "author": "Jane Author",
    "authors": [{ "id": 99, "name": "Jane Author", "handle": "janeauthor" }],
    "bodyHtml": "<p>...</p>",
    "bodyText": "...",
    "wordcount": 1842,
    "reactionCount": 213,
    "commentCount": 42,
    "restacks": 18,
    "postTags": ["media", "business"]
}
```

### Publication record

```json
{
    "type": "publication",
    "id": 42,
    "name": "The Example",
    "subdomain": "example",
    "customDomain": null,
    "url": "https://example.substack.com",
    "description": "A newsletter about newsletters.",
    "categoryName": "Business",
    "totalSubscribers": 48211,
    "paidSubscribers": 1203,
    "createdAt": "2022-06-14T09:12:00Z"
}
```

### Author record

```json
{
    "type": "author",
    "id": 99,
    "name": "Jane Author",
    "handle": "janeauthor",
    "profileUrl": "https://substack.com/@janeauthor",
    "bio": "Writing about media.",
    "photoUrl": "https://.../photo.jpg",
    "publications": [{ "publicationName": "The Example", "subdomain": "example", "role": "admin" }],
    "subscriptions": [{ "publicationName": "Noahpinion", "subdomain": "noahpinion" }]
}
```

### Comment record

```json
{
    "type": "comment",
    "id": 55512,
    "postId": 123456,
    "postSlug": "why-newsletters-won",
    "postTitle": "Why newsletters won",
    "publication": "example",
    "parentId": null,
    "depth": 0,
    "body": "Great piece.",
    "authorName": "A Reader",
    "authorHandle": "areader",
    "publishedAt": "2026-02-01T16:30:00Z",
    "reactionCount": 4
}
```

## How to scrape Substack (step-by-step)

1. **Click "Try for free"** at the top of this page — you'll be taken to the Apify console.
2. **Paste your target URLs** into the Start URLs field. Examples:
   - A publication: `https://stratechery.com` or `https://noahpinion.substack.com`
   - A single post: `https://example.substack.com/p/some-post`
   - An author profile: `https://substack.com/@handle`
   - A share link: `https://open.substack.com/pub/astralcodexten/p/some-post`
3. **Set `maxPostsPerPublication`** — start with `10` for a test, then bump it (or set `0` for the whole archive).
4. **Click "Start"**. When the run completes, open the **Output** tab to browse results or hit **Export** for CSV / JSON / Excel.

## FAQ

**How am I charged?** Per record in your results — each post, publication, author, and comment counts as one result. Failed or retried requests are never charged, and you'll never receive the same post twice. Control your bill with `maxPostsPerPublication`, `includeComments`, and `maxPublicationsToDiscover`; you can also set a maximum budget for any run in the Apify Console.

**Does it scrape paywalled posts?** Paid posts are listed with metadata and the free preview text; full paid bodies require a subscriber login, which this scraper does not use. Enable `onlyFreePosts` to skip them entirely.

**How many comments will a post produce?** Whatever the thread holds — popular posts can carry hundreds of comments, each delivered (and charged) as its own result. Leave `includeComments` off unless you need them.

**Will it get blocked?** No setup needed on your side — proxy rotation, retries, and rate-limit handling are built in.

**Can I schedule it?** Yes — use Apify Schedules for daily/weekly monitoring runs, and connect the dataset to Google Sheets, webhooks, or the API for delivery.
