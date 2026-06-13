import { Actor } from 'apify';
import { Dataset, createCheerioRouter, log } from 'crawlee';
import {
    buildArchiveRequest,
    buildInitialRequests,
    classifyUrl,
    extractPreload,
    findPublicationObject,
    isLikelyNonPublicationHost,
    stripHtml,
    wordCount,
} from './utils.js';
import {
    state,
    getCount,
    incrementCount,
    setPublicationInfo,
    getPublicationInfo,
    isSeenPub,
    markSeenPub,
    getDiscoveredCount,
    incrementDiscovered,
    markPubSaved,
    markPostEnqueued,
    markPostSavedRecord,
    reserveItemSlots,
    isCapReached,
    isTypeExhausted,
    markTypeExhausted,
    addItems,
    getTotalItems,
} from './state.js';

export const router = createCheerioRouter();

// All record types go to the default dataset with a `type` discriminator;
// named datasets are account-global (they accumulate across runs and never
// expire), so they are never used. Under pay-per-event pricing each record
// type charges its own event (event name == record type) and the SDK trims
// pushes to the buyer's budget; under per-result pricing the platform charges
// per default-dataset item and ACTOR_MAX_PAID_DATASET_ITEMS caps it.
let lastStatusCount = 0;
async function saveRecords(records) {
    if (!records.length) return;

    if (state.config.isPayPerEvent) {
        // The SDK trims each push to the buyer's remaining budget and reports
        // chargedCount — count only what was actually pushed, and track budget
        // exhaustion per event type (e.g. comments can run out while posts
        // remain chargeable).
        const byType = new Map();
        for (const row of records) {
            if (isTypeExhausted(row.type)) continue;
            if (!byType.has(row.type)) byType.set(row.type, []);
            byType.get(row.type).push(row);
        }
        for (const [eventName, items] of byType) {
            const result = await Actor.pushData(items, eventName);
            // When the budget limit trims a push, only chargedCount items were
            // written; otherwise (incl. free/unpriced events) the whole batch was.
            const delivered = result?.eventChargeLimitReached
                ? (result?.chargedCount ?? 0)
                : items.length;
            if (delivered > 0) addItems(delivered);
            if (result?.eventChargeLimitReached) {
                markTypeExhausted(eventName);
                log.warning(`Budget for '${eventName}' results exhausted — no further ${eventName} records will be scraped.`);
            }
        }
    } else {
        const allowed = reserveItemSlots(records.length);
        if (allowed < records.length) {
            log.warning(`Maximum paid dataset items reached — dropped ${records.length - allowed} record(s).`);
        }
        const rows = records.slice(0, allowed);
        if (!rows.length) return;
        await Dataset.pushData(rows);
    }

    const total = getTotalItems();
    if (total - lastStatusCount >= 50) {
        lastStatusCount = total;
        await Actor.setStatusMessage(`Saved ${total} items so far...`).catch(() => {});
    }
}

// The crawl stops only when its PRIMARY deliverable can no longer be charged
// (posts in posts mode, publications otherwise) or the per-result item cap is
// hit — exhausting a secondary type (comments) just stops that record type.
function crawlBudgetExhausted() {
    const primaryType = state.config.mode === 'posts' ? 'post' : 'publication';
    return isCapReached() || isTypeExhausted(primaryType);
}

let stopRequested = false;
async function stopIfCapReached(crawler) {
    if (!crawlBudgetExhausted() || stopRequested) return;
    stopRequested = true;
    log.warning('Paid results budget reached — stopping the crawl.');
    if (typeof crawler.stop === 'function') crawler.stop();
}

function parseJsonBody(body) {
    if (!body) return null;
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
    try {
        return JSON.parse(body.toString());
    } catch {
        return null;
    }
}

function commentsRequest(origin, publication, post) {
    return {
        url: `${origin}/api/v1/post/${post.id}/comments?token=&all_comments=true&sort=best_first`,
        userData: {
            label: 'COMMENTS',
            origin,
            publication,
            postId: post.id,
            postSlug: post.slug,
            postTitle: post.title,
        },
    };
}

// Substack data carries stray whitespace in titles/names — trim for clean exports.
function clean(s) {
    return typeof s === 'string' ? s.trim() : s ?? null;
}

// "450,000" → 450000; passes numbers through; null for anything else.
function parseCount(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const n = Number(value.replace(/[,\s]/g, ''));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function shapePost(raw, ctx = {}) {
    const canonical = raw.canonical_url || (raw.slug && ctx.origin ? `${ctx.origin}/p/${raw.slug}` : null);
    const bodyHtml = raw.body_html ?? null;
    const bodyText = bodyHtml ? stripHtml(bodyHtml) : (raw.truncated_body_text ?? raw.description ?? '');
    const pubKey = ctx.publication ?? raw.publication?.subdomain ?? null;
    const cachedPub = pubKey ? getPublicationInfo(pubKey) : {};
    const publicationName = clean(raw.publication?.name ?? raw.publicationName ?? cachedPub.name ?? null);
    return {
        type: 'post',
        id: raw.id,
        title: clean(raw.title),
        subtitle: clean(raw.subtitle),
        slug: raw.slug,
        url: canonical,
        publication: pubKey,
        publicationName,
        publishedAt: raw.post_date ?? raw.published_at ?? null,
        audience: raw.audience ?? null,
        postType: raw.type ?? null,
        coverImage: raw.cover_image ?? null,
        description: raw.description ?? null,
        truncatedBodyText: raw.truncated_body_text ?? null,
        bodyHtml,
        bodyText: bodyText || null,
        wordcount: wordCount(bodyText),
        reactionCount: raw.reaction_count ?? raw.reactions?.heart ?? null,
        commentCount: raw.comment_count ?? null,
        restacks: raw.restacks ?? null,
        isPaid: raw.audience ? raw.audience !== 'everyone' : null,
        author: clean(raw.publishedBylines?.[0]?.name
            ?? raw.publishedBylines?.[0]?.handle
            ?? raw.author?.name
            ?? null),
        authors: (raw.publishedBylines ?? []).map((b) => ({
            id: b.id,
            name: b.name,
            handle: b.handle,
            photoUrl: b.photo_url ?? null,
            bio: b.bio ?? null,
        })),
        postTags: (raw.postTags ?? []).map((t) => t.name ?? t),
        scrapedAt: new Date().toISOString(),
    };
}

function shapePublication(raw, ctx = {}) {
    const pub = raw.publication ?? raw;
    return {
        type: 'publication',
        id: pub.id,
        name: clean(pub.name),
        subdomain: pub.subdomain ?? ctx.publication ?? null,
        customDomain: pub.custom_domain ?? null,
        url: pub.custom_domain ? `https://${pub.custom_domain}` : (pub.subdomain ? `https://${pub.subdomain}.substack.com` : ctx.origin),
        heroText: pub.hero_text ?? null,
        description: pub.description ?? pub.about ?? null,
        logoUrl: pub.logo_url ?? null,
        copyright: pub.copyright ?? null,
        language: pub.language ?? null,
        authorId: pub.author_id ?? null,
        foundingPlanName: pub.founding_plan_name ?? null,
        paidSubscribers: pub.paid_subscribers_visible ? pub.paid_subscribers : null,
        totalSubscribers: pub.subscriber_count_number ?? pub.subscriber_count ?? null,
        subscriberCountString: pub.subscriber_count_string ?? null,
        categoryName: pub.base_category_name ?? null,
        createdAt: pub.created_at ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

router.addHandler('PUBLICATION_HTML', async ({ request, $, body, crawler }) => {
    const ctx = request.userData;
    if (typeof $ !== 'function') {
        throw new Error(`Non-HTML response on publication page ${request.url} — retrying`);
    }
    const html = body?.toString() ?? '';

    // Apex domains (astralcodexten.com) redirect pages to the canonical host
    // (www.astralcodexten.com) but 404 API paths — follow-up API requests must
    // use the origin the page actually loaded from.
    let effectiveOrigin = ctx.origin;
    let effectiveHost = null;
    try {
        const loaded = new URL(request.loadedUrl ?? request.url);
        effectiveOrigin = loaded.origin;
        effectiveHost = loaded.hostname.toLowerCase();
    } catch { /* keep ctx.origin */ }

    // Every real Substack page embeds window._preloads; its absence means a
    // block page / interstitial (throw → retry on a new session) or, for
    // discovered links, a site that isn't Substack at all.
    const preload = extractPreload(html);
    const pubObj = findPublicationObject(preload);

    if (!preload) {
        if (ctx.fromDiscovery) {
            log.info(`Skipping ${request.url} — no Substack preload, likely not a Substack publication`);
            return;
        }
        throw new Error(`No Substack preload data on ${request.url} — blocked or not a Substack publication`);
    }

    markSeenPub(ctx.publication, pubObj?.subdomain, pubObj?.custom_domain, effectiveHost);

    let shaped;
    if (pubObj) {
        shaped = shapePublication({ publication: pubObj }, ctx);
    } else {
        if (ctx.fromDiscovery) {
            log.info(`Skipping ${request.url} — no publication object in preload`);
            return;
        }
        const get = (sel, attr = 'content') => {
            const v = $(sel).attr(attr);
            return v ? v.trim() : null;
        };
        const cleanPubName = (s) => {
            if (!s) return null;
            const parts = s
                .split(/\s*[|\-–—]\s*/)
                .map((x) => x.trim())
                .filter(Boolean)
                .filter((x) => x.toLowerCase() !== 'substack');
            return parts[0] ?? null;
        };
        const metaName = cleanPubName(get('meta[property="og:title"]'))
            || cleanPubName(get('meta[name="twitter:title"]'))
            || cleanPubName(($('title').text() ?? '').trim())
            || cleanPubName(get('meta[property="og:site_name"]'))
            || null;
        shaped = {
            type: 'publication',
            id: null,
            name: metaName,
            subdomain: ctx.publication ?? null,
            customDomain: ctx.origin?.replace(/^https?:\/\//, '') ?? null,
            url: ctx.origin,
            description: get('meta[property="og:description"]') || get('meta[name="description"]') || null,
            heroText: null,
            logoUrl: get('meta[property="og:image"]') || null,
            copyright: null,
            language: null,
            authorId: null,
            foundingPlanName: null,
            paidSubscribers: null,
            totalSubscribers: null,
            subscriberCountString: null,
            categoryName: null,
            createdAt: null,
            scrapedAt: new Date().toISOString(),
        };
    }

    if (ctx.publication && shaped.name) {
        setPublicationInfo(ctx.publication, {
            name: shaped.name,
            description: shaped.description,
            logoUrl: shaped.logoUrl,
        });
    }

    if (pubObj) {
        // Subscriber counts only appear on the /about page preload — enrich
        // there before saving. The request queue dedupes repeat visits.
        await crawler.addRequests([{
            url: `${effectiveOrigin}/about`,
            userData: {
                label: 'PUBLICATION_ABOUT',
                origin: effectiveOrigin,
                publication: ctx.publication,
                shaped,
            },
        }]);
    } else if (markPubSaved(shaped.subdomain ?? ctx.publication)) {
        await saveRecords([shaped]);
        log.info(`Saved publication: ${shaped.name || ctx.publication} (from meta tags)`);
    }

    if (crawlBudgetExhausted()) {
        await stopIfCapReached(crawler);
        return;
    }

    if (ctx.followWithArchive) {
        await crawler.addRequests([buildArchiveRequest({
            origin: effectiveOrigin,
            publication: ctx.publication,
            searchQuery: ctx.searchQuery,
        })]);
    }

    if (ctx.harvestRecommendations) {
        const limit = state.config.maxPublicationsToDiscover ?? 25;
        if (getDiscoveredCount() < limit) {
            await crawler.addRequests([{
                url: `${effectiveOrigin}/recommendations`,
                userData: {
                    label: 'RECOMMENDATIONS_HTML',
                    origin: effectiveOrigin,
                    publication: ctx.publication,
                },
            }]);
        }
    }
});

// The /about page preload carries subscriber stats the homepage lacks
// (subscriberCountDetails text + pub.freeSubscriberCount like "450,000").
router.addHandler('PUBLICATION_ABOUT', async ({ request, body, crawler }) => {
    const { publication, shaped } = request.userData;
    const preload = extractPreload(body?.toString() ?? '');
    if (!preload) {
        throw new Error(`No Substack preload data on ${request.url} — retrying`);
    }

    const aboutPub = findPublicationObject(preload) ?? {};
    const enriched = {
        ...shaped,
        description: shaped.description ?? clean(aboutPub.hero_text) ?? null,
        heroText: shaped.heroText ?? clean(aboutPub.hero_text) ?? null,
        totalSubscribers: shaped.totalSubscribers
            ?? parseCount(aboutPub.freeSubscriberCount ?? preload.pub?.freeSubscriberCount),
        subscriberCountString: shaped.subscriberCountString
            ?? clean(preload.subscriberCountDetails)
            ?? null,
        categoryName: shaped.categoryName ?? clean(aboutPub.base_category_name) ?? null,
    };

    if (markPubSaved(enriched.subdomain ?? publication)) {
        await saveRecords([enriched]);
        log.info(`Saved publication: ${enriched.name || publication}${enriched.totalSubscribers ? ` (${enriched.totalSubscribers} subscribers)` : ''}`);
    }
    await stopIfCapReached(crawler);
});

router.addHandler('ARCHIVE', async ({ request, json, body, crawler }) => {
    const config = state.config;
    const payload = json ?? parseJsonBody(body);
    if (!Array.isArray(payload)) {
        // Soft blocks come back 200 with an HTML body; retry on a fresh session
        // instead of silently dropping a whole page of posts.
        throw new Error(`Archive endpoint returned non-JSON for ${request.url} — retrying`);
    }
    if (payload.length === 0) return; // true end of archive

    if (crawlBudgetExhausted()) {
        await stopIfCapReached(crawler);
        return;
    }

    const { origin, publication, offset, searchQuery } = request.userData;
    const countKey = `posts:${publication}`;
    const limit = config.maxPostsPerPublication;

    const toEnqueue = [];
    const toStoreInline = [];
    let limitReached = false;

    for (const raw of payload) {
        if (config.onlyFreePosts && raw.audience && raw.audience !== 'everyone') continue;
        if (limit != null && getCount(countKey) >= limit) {
            limitReached = true;
            break;
        }
        // Idempotent across page retries/re-runs after a migration.
        if (!markPostEnqueued(publication, raw.id)) continue;
        incrementCount(countKey);

        if (config.includeContent) {
            toEnqueue.push({
                url: `${origin}/api/v1/posts/${raw.slug}`,
                userData: {
                    label: 'POST_JSON',
                    origin,
                    publication,
                    slug: raw.slug,
                    archiveFallback: raw,
                },
            });
        } else if (markPostSavedRecord(publication, raw.id)) {
            toStoreInline.push(shapePost(raw, { origin, publication }));
        }

        if (config.includeComments && raw.comment_count !== 0 && !isTypeExhausted('comment')) {
            toEnqueue.push(commentsRequest(origin, publication, raw));
        }
    }

    if (toStoreInline.length) await saveRecords(toStoreInline);
    if (toEnqueue.length) await crawler.addRequests(toEnqueue);

    // The API can return short pages mid-archive (offset=0 returns ~23 items),
    // so only an empty page means the end. Advance by the actual page length.
    const hasMore = !limitReached
        && (limit == null || getCount(countKey) < limit)
        && !isCapReached();
    if (hasMore) {
        const nextOffset = offset + payload.length;
        await crawler.addRequests([buildArchiveRequest({ origin, publication, offset: nextOffset, searchQuery })]);
    }
});

router.addHandler('POST_JSON', async ({ request, json, body, crawler }) => {
    const payload = json ?? parseJsonBody(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        // Throw so the request retries; if all retries fail, the
        // failedRequestHandler salvages archive metadata where available.
        throw new Error(`Post endpoint returned non-JSON for ${request.url} — retrying`);
    }
    const { origin, publication } = request.userData;

    // 404s come back as JSON like {"error":"Post not found","type":"single"} —
    // never push those as records. Salvage the archive listing if we have it.
    if (payload.error || payload.id == null) {
        await salvageFailedRequest(request);
        log.warning(`Not a post (${payload.error ?? 'no id'}): ${request.url} — skipped`);
        return;
    }

    if (markPostSavedRecord(publication, payload.id)) {
        await saveRecords([shapePost(payload, { origin, publication })]);
    }

    // Direct post start URLs skip the ARCHIVE handler, so enqueue comments
    // here too — the request queue deduplicates by URL.
    if (state.config.includeComments && payload.id && payload.comment_count !== 0 && !isTypeExhausted('comment')) {
        await crawler.addRequests([commentsRequest(origin, publication, payload)]);
    }

    await stopIfCapReached(crawler);
});

router.addHandler('COMMENTS', async ({ request, json, body, crawler }) => {
    if (isTypeExhausted('comment')) return; // budget for comments already spent
    const payload = json ?? parseJsonBody(body);
    if (!payload || typeof payload !== 'object') {
        throw new Error(`Comments endpoint returned non-JSON for ${request.url} — retrying`);
    }
    const comments = payload.comments ?? payload.children ?? [];
    if (!comments.length) return;

    const flat = [];
    const walk = (nodes, depth = 0, parentId = null) => {
        for (const node of nodes) {
            flat.push({
                type: 'comment',
                postId: request.userData.postId,
                postSlug: request.userData.postSlug,
                postTitle: request.userData.postTitle,
                publication: request.userData.publication,
                id: node.id,
                parentId,
                depth,
                body: node.body,
                authorName: node.name,
                authorHandle: node.handle,
                authorId: node.user_id,
                publishedAt: node.date,
                reactionCount: node.reactions?.heart ?? node.reaction_count ?? 0,
                scrapedAt: new Date().toISOString(),
            });
            if (node.children && node.children.length) walk(node.children, depth + 1, node.id);
        }
    };
    walk(comments);
    if (flat.length) await saveRecords(flat);
    await stopIfCapReached(crawler);
});

router.addHandler('AUTHOR_JSON', async ({ request, json, body, crawler }) => {
    const payload = json ?? parseJsonBody(body);
    if (!payload || typeof payload !== 'object') {
        throw new Error(`Profile endpoint returned non-JSON for ${request.url} — retrying`);
    }
    if (payload.error || payload.id == null) {
        log.warning(`Not an author profile (${payload.error ?? 'no id'}): ${request.url} — skipped`);
        return;
    }
    const handle = payload.handle ?? request.userData.handle ?? null;
    await saveRecords([{
        type: 'author',
        id: payload.id,
        name: payload.name,
        handle,
        bio: payload.bio ?? null,
        photoUrl: payload.photo_url ?? null,
        profileUrl: handle ? `https://substack.com/@${handle}` : null,
        subscriptions: (payload.subscriptions ?? []).map((s) => ({
            publicationId: s.publication?.id,
            publicationName: s.publication?.name,
            subdomain: s.publication?.subdomain,
            customDomain: s.publication?.custom_domain,
        })),
        publications: (payload.publicationUsers ?? []).map((p) => ({
            publicationId: p.publication?.id,
            publicationName: p.publication?.name,
            subdomain: p.publication?.subdomain,
            role: p.role,
        })),
        scrapedAt: new Date().toISOString(),
    }]);
    await stopIfCapReached(crawler);
});

// Numeric profile pages (substack.com/profile/123-name): pull the handle out
// of the page preload, then hit the public_profile API like @handle URLs.
router.addHandler('AUTHOR_HTML', async ({ request, $, body, crawler }) => {
    const html = body?.toString() ?? '';
    const preload = extractPreload(html);
    let handle = preload?.profile?.handle ?? preload?.user?.handle ?? null;
    if (!handle && typeof $ === 'function') {
        const ogUrl = $('meta[property="og:url"]').attr('content') ?? '';
        handle = ogUrl.match(/substack\.com\/@([\w.-]+)/)?.[1] ?? null;
    }
    if (!handle) {
        throw new Error(`Could not resolve author handle from ${request.url}`);
    }
    await crawler.addRequests([{
        url: `https://substack.com/api/v1/user/${handle}/public_profile`,
        userData: { label: 'AUTHOR_JSON', origin: 'https://substack.com', handle },
    }]);
});

// Reader links that 302 to a canonical URL: classify wherever we landed.
router.addHandler('RESOLVE', async ({ request, crawler }) => {
    const finalUrl = request.loadedUrl ?? request.url;
    const classified = classifyUrl(finalUrl);
    if (!classified || classified.kind === 'redirect') {
        log.warning(`Could not resolve ${request.url} (landed on ${finalUrl})`);
        return;
    }
    if (classified.kind === 'publication') markSeenPub(classified.publication);
    await crawler.addRequests(buildInitialRequests(classified, state.config.mode, {
        searchQuery: state.config.searchQuery,
    }));
});

router.addHandler('RECOMMENDATIONS_HTML', async ({ request, $, crawler }) => {
    const config = state.config;
    const limit = config.maxPublicationsToDiscover ?? 25;
    if (typeof $ !== 'function') {
        throw new Error(`Non-HTML response on ${request.url} — retrying`);
    }
    const sourceOrigin = request.userData.origin;
    const sourcePub = request.userData.publication;
    const found = new Map();

    $('a[href]').each((_i, el) => {
        if (getDiscoveredCount() + found.size >= limit) return false;
        const href = $(el).attr('href');
        if (!href) return;
        let abs;
        try { abs = new URL(href, request.url); } catch { return; }
        if (abs.origin === sourceOrigin) return;
        if (isLikelyNonPublicationHost(abs.hostname)) return;
        // classifyUrl handles *.substack.com, custom domains, and
        // open.substack.com/pub/... share links; infra subdomains return null.
        const classified = classifyUrl(abs.href);
        if (!classified || classified.kind !== 'publication') return;
        const key = classified.publication;
        if (!key || isSeenPub(key) || found.has(key)) return;
        found.set(key, classified);
    });

    if (!found.size) {
        log.info(`No new publications on ${sourcePub}/recommendations (discovered: ${getDiscoveredCount()}/${limit})`);
        return;
    }

    const toEnqueue = [];
    for (const [key, classified] of found) {
        // Budget is committed at enqueue time so concurrent harvests can't
        // overshoot; seenPubs makes this idempotent across retries.
        markSeenPub(key);
        incrementDiscovered();
        toEnqueue.push({
            url: classified.origin,
            userData: {
                label: 'PUBLICATION_HTML',
                origin: classified.origin,
                publication: classified.publication,
                followWithArchive: config.mode === 'posts',
                harvestRecommendations: getDiscoveredCount() < limit,
                fromDiscovery: true,
                searchQuery: config.searchQuery,
            },
        });
    }
    await crawler.addRequests(toEnqueue);
    log.info(`Discovery: harvested ${toEnqueue.length} publications from ${sourcePub} (total: ${getDiscoveredCount()}/${limit})`);
});

router.addDefaultHandler(async ({ request }) => {
    log.warning(`No handler for ${request.url} (label=${request.label ?? 'none'})`);
});

// Called from failedRequestHandler: when a POST_JSON request exhausts its
// retries, the archive listing entry still has title/date/description —
// save that instead of losing the post entirely.
export async function salvageFailedRequest(request) {
    const { label, archiveFallback, origin, publication, shaped } = request.userData ?? {};
    if (label === 'POST_JSON' && archiveFallback) {
        if (!markPostSavedRecord(publication, archiveFallback.id)) return;
        const salvaged = shapePost(archiveFallback, { origin, publication });
        salvaged.note = 'full content fetch failed; archive metadata only';
        await saveRecords([salvaged]);
        log.info(`Salvaged archive metadata for failed post ${request.url}`);
        return;
    }
    // /about enrichment failed — save the homepage-derived publication record.
    if (label === 'PUBLICATION_ABOUT' && shaped) {
        if (!markPubSaved(shaped.subdomain ?? publication)) return;
        await saveRecords([shaped]);
        log.info(`Saved publication ${shaped.name || publication} without /about enrichment`);
    }
}
