import { Actor } from 'apify';

export const state = {
    config: {
        maxPostsPerPublication: 50,
        includeContent: true,
        includeComments: false,
        onlyFreePosts: false,
        searchQuery: '',
        mode: 'posts',
        maxPublicationsToDiscover: 25,
        maxPaidItems: null,
        isPayPerEvent: false,
    },
    data: null,
};

// Crawl progress lives in Actor.useState so it survives migrations/restarts.
// The request queue is persisted by the platform, so any counter that gates
// what gets enqueued or pushed must be persisted too — otherwise a migration
// resets the limits and the run over-delivers (and over-charges the buyer).
export async function initState() {
    state.data = await Actor.useState('CRAWL_STATE', {
        counts: {},
        publicationInfo: {},
        seenPubs: {},
        savedPubs: {},
        enqueuedPostIds: {},
        savedPostIds: {},
        discoveredCount: 0,
        totalItems: 0,
        capReached: false,
        exhaustedTypes: {},
    });
    return state.data;
}

export function setConfig(partial) {
    state.config = { ...state.config, ...partial };
}

export function getCount(key) {
    return state.data.counts[key] ?? 0;
}

export function incrementCount(key, by = 1) {
    state.data.counts[key] = (state.data.counts[key] ?? 0) + by;
    return state.data.counts[key];
}

export function setPublicationInfo(key, info) {
    if (!key) return;
    state.data.publicationInfo[key] = { ...(state.data.publicationInfo[key] ?? {}), ...info };
}

export function getPublicationInfo(key) {
    return state.data.publicationInfo[key] ?? {};
}

// seenPubs deduplicates publications across start URLs, discovery seeds, and
// recommendation harvesting (including subdomain/custom-domain aliases).
// discoveredCount tracks only discovery-found publications against the budget,
// so start URLs don't silently consume maxPublicationsToDiscover.
export function isSeenPub(key) {
    return Boolean(key && state.data.seenPubs[key.toLowerCase?.() ?? key]);
}

export function markSeenPub(...keys) {
    for (const key of keys) {
        if (key) state.data.seenPubs[key.toLowerCase?.() ?? key] = true;
    }
}

export function getDiscoveredCount() {
    return state.data.discoveredCount;
}

export function incrementDiscovered(by = 1) {
    state.data.discoveredCount += by;
    return state.data.discoveredCount;
}

export function markPubSaved(key) {
    if (!key) return true;
    const k = key.toLowerCase?.() ?? key;
    if (state.data.savedPubs[k]) return false;
    state.data.savedPubs[k] = true;
    return true;
}

// Enqueue-side guard: makes per-publication post counting idempotent when an
// archive page is retried or re-run after a migration.
export function markPostEnqueued(pub, id) {
    if (id == null) return true;
    const key = `${pub ?? ''}:${id}`;
    if (state.data.enqueuedPostIds[key]) return false;
    state.data.enqueuedPostIds[key] = true;
    return true;
}

// Push-side guard: a post id is billed at most once per publication.
export function markPostSavedRecord(pub, id) {
    if (id == null) return true;
    const key = `${pub ?? ''}:${id}`;
    if (state.data.savedPostIds[key]) return false;
    state.data.savedPostIds[key] = true;
    return true;
}

// Reserve dataset slots under the buyer's max-paid-items cap
// (ACTOR_MAX_PAID_DATASET_ITEMS). Items pushed beyond the cap are never paid
// for, so scraping past it only burns the owner's proxy/compute budget.
export function reserveItemSlots(n) {
    const cap = state.config.maxPaidItems;
    if (cap == null) {
        state.data.totalItems += n;
        return n;
    }
    const allowed = Math.max(0, Math.min(n, cap - state.data.totalItems));
    state.data.totalItems += allowed;
    if (allowed < n) state.data.capReached = true;
    return allowed;
}

export function isCapReached() {
    return state.data.capReached;
}

// Under pay-per-event, the SDK reports budget exhaustion PER EVENT TYPE.
// Track it per type so e.g. running out of comment budget stops comment
// scraping but lets posts (still chargeable) continue.
export function markTypeExhausted(type) {
    state.data.exhaustedTypes[type] = true;
}

export function isTypeExhausted(type) {
    return Boolean(state.data.exhaustedTypes[type]);
}

// Count of records actually pushed (and charged, under pay-per-event).
export function addItems(n) {
    state.data.totalItems += n;
    return state.data.totalItems;
}

export function getTotalItems() {
    return state.data.totalItems;
}
