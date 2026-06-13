import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { router, salvageFailedRequest } from './routes.js';
import { classifyUrl, buildInitialRequests, buildDiscoverySeeds } from './utils.js';
import { setConfig, initState, markSeenPub, isSeenPub, incrementDiscovered, getTotalItems } from './state.js';

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    startUrls = [],
    mode = 'posts',
    maxPostsPerPublication = 50,
    includeContent = true,
    includeComments = false,
    onlyFreePosts = false,
    searchQuery = '',
    discoveryMode = 'none',
    discoveryQuery = '',
    maxPublicationsToDiscover = 25,
    maxConcurrency = 5,
} = input;

const hasStart = Array.isArray(startUrls) && startUrls.length > 0;
const hasDiscovery = discoveryMode && discoveryMode !== 'none';

if (!hasStart && !hasDiscovery) {
    throw new Error('Provide either startUrls or a discoveryMode.');
}

const resolvedSearchQuery = (discoveryMode === 'search' && discoveryQuery) ? discoveryQuery : searchQuery;
// 0 means "no limit"; an empty field falls back to the default of 50.
const postLimit = maxPostsPerPublication > 0 ? maxPostsPerPublication : null;
// Set by the platform when the buyer caps paid results — items pushed beyond
// it are never paid for, so the crawl stops there.
const maxPaidItems = Number(process.env.ACTOR_MAX_PAID_DATASET_ITEMS) || null;

// Must come after Actor.init(); restores limits/dedupe state after migrations.
await initState();

// Pay-per-event runs charge one event per record (event name == record type);
// per-result runs are charged by the platform per default-dataset item.
const pricingInfo = Actor.getChargingManager().getPricingInfo();
if (pricingInfo.isPayPerEvent) {
    const missing = ['post', 'publication', 'author', 'comment']
        .filter((e) => !(e in pricingInfo.perEventPrices));
    if (missing.length) {
        log.warning(`Pay-per-event pricing has no price configured for event(s): ${missing.join(', ')} — records of these types will NOT be charged.`);
    }
}

setConfig({
    maxPostsPerPublication: postLimit,
    includeContent,
    includeComments,
    onlyFreePosts,
    searchQuery: resolvedSearchQuery,
    mode: ['posts', 'publication', 'author'].includes(mode) ? mode : 'posts',
    maxPublicationsToDiscover,
    maxPaidItems,
    isPayPerEvent: pricingInfo.isPayPerEvent,
});

// Automatic datacenter proxies: Substack's JSON API is not challenge-gated,
// it only rate-limits per IP, and the session pool rotates IPs on 403/429.
// Local runs connect directly.
const proxyConfiguration = Actor.isAtHome()
    ? await Actor.createProxyConfiguration()
    : undefined;

const initialRequests = [];
for (const entry of startUrls) {
    const rawUrl = typeof entry === 'string' ? entry : entry?.url;
    if (!rawUrl) continue;
    const classified = classifyUrl(rawUrl);
    if (!classified) {
        log.warning(`Skipping unrecognised URL: ${rawUrl}`);
        continue;
    }
    // Start-URL publications are marked seen (so discovery won't re-scrape
    // them) but do NOT consume the discovery budget.
    if (classified.kind === 'publication') markSeenPub(classified.publication);
    initialRequests.push(...buildInitialRequests(classified, mode, { searchQuery: resolvedSearchQuery }));
}

if (hasDiscovery) {
    const seeds = buildDiscoverySeeds({ mode, searchQuery: resolvedSearchQuery });
    const freshSeeds = seeds.filter((seed) => !isSeenPub(seed.userData.publication));
    for (const seed of freshSeeds) {
        markSeenPub(seed.userData.publication);
        incrementDiscovered();
    }
    if (freshSeeds.length) {
        initialRequests.push(...freshSeeds);
        log.info(`Discovery enabled (${discoveryMode}): seeded ${freshSeeds.length} publications, expanding via recommendation graph up to ${maxPublicationsToDiscover} total`);
        if (discoveryMode === 'search' && resolvedSearchQuery) {
            log.info(`Search query "${resolvedSearchQuery}" will be applied to each discovered publication's archive.`);
        }
    }
}

// Generous safety ceiling so a logic bug can never run the queue unbounded.
// Unlimited-posts runs (postLimit null) are intentionally uncapped.
let maxRequestsPerCrawl;
if (postLimit != null) {
    const totalPubs = startUrls.length + (hasDiscovery ? maxPublicationsToDiscover : 0) + 1;
    const perPub = 2 // homepage + recommendations
        + Math.ceil(postLimit / 50) + 1 // archive pages + trailing empty page
        + postLimit * ((includeContent ? 1 : 0) + (includeComments ? 1 : 0));
    maxRequestsPerCrawl = Math.ceil(totalPubs * (perPub + 2) * 1.25) + 25;
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency,
    maxRequestRetries: 3,
    maxRequestsPerCrawl,
    requestHandlerTimeoutSecs: 60,
    additionalMimeTypes: ['application/json', 'text/json'],
    // Default got-scraping header generation produces consistent browser
    // fingerprints — do not override user-agent/accept headers manually.
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 100,
    },
    failedRequestHandler: async ({ request }) => {
        const label = request.userData?.label ?? 'none';
        log.warning(`Request failed after retries: ${request.url} (label=${label})`);
        if (label === 'PUBLICATION_HTML') {
            log.warning(`Is ${request.url} really a Substack publication?`);
        }
        await salvageFailedRequest(request);
    },
});

await Actor.setStatusMessage('Crawling Substack...').catch(() => {});
await crawler.run(initialRequests);

const total = getTotalItems();
await Actor.exit(`Finished — saved ${total} item(s) to the dataset.`);
