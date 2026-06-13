import * as cheerio from 'cheerio';

// Substack's archive API rejects limit > 50. Note the API may return SHORT
// pages that are not the end of the archive (offset=0 reliably returns ~23
// items), so pagination must continue until an empty page — never treat a
// short page as exhaustion.
const ARCHIVE_PAGE_LIMIT = 50;

export function normaliseUrl(input) {
    try {
        return new URL(input);
    } catch {
        return null;
    }
}

export function classifyUrl(rawUrl) {
    const url = normaliseUrl(rawUrl);
    if (!url) return null;

    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);

    // Reader share links: https://open.substack.com/pub/{publication}[/p/{slug}]
    if (host === 'open.substack.com') {
        if (segments[0] === 'pub' && segments[1]) {
            const publication = segments[1].toLowerCase();
            const origin = `https://${publication}.substack.com`;
            if (segments[2] === 'p' && segments[3]) {
                return { kind: 'post', origin, publication, slug: segments[3] };
            }
            return { kind: 'publication', origin, publication };
        }
        return null;
    }

    if (host === 'substack.com' || host === 'www.substack.com') {
        // Author profile: https://substack.com/@handle
        if (url.pathname.startsWith('/@')) {
            const handle = url.pathname.slice(2).split('/')[0];
            return { kind: 'author', handle, origin: 'https://substack.com' };
        }
        // Numeric profile: https://substack.com/profile/123-name
        if (url.pathname.startsWith('/profile/')) {
            return { kind: 'author-profile', origin: 'https://substack.com', path: url.pathname };
        }
        // Reader post links: https://substack.com/home/post/p-{id} — these 302
        // to the canonical post URL, so fetch and classify the landing URL.
        if (/^\/home\/post\/p-\d+/.test(url.pathname)) {
            return { kind: 'redirect', url: `https://substack.com${url.pathname}` };
        }
        return null;
    }

    // Infra subdomains (on.substack.com, support.substack.com, ...) are not publications.
    if (isSubstackInfraSubdomain(host)) return null;

    // Custom-domain or subdomain publications.
    const publication = host.endsWith('.substack.com')
        ? host.replace(/\.substack\.com$/, '')
        : host;
    const origin = `${url.protocol}//${host}`;

    if (url.pathname.startsWith('/p/')) {
        const slug = url.pathname.split('/')[2];
        return { kind: 'post', origin, publication, slug };
    }

    return { kind: 'publication', origin, publication };
}

export function buildInitialRequests(classified, mode, opts = {}) {
    const { searchQuery = '' } = opts;

    if (classified.kind === 'redirect') {
        return [{
            url: classified.url,
            userData: { label: 'RESOLVE' },
        }];
    }

    if (classified.kind === 'post') {
        return [{
            url: `${classified.origin}/api/v1/posts/${classified.slug}`,
            userData: {
                label: 'POST_JSON',
                origin: classified.origin,
                publication: classified.publication,
                slug: classified.slug,
            },
        }];
    }

    if (classified.kind === 'author' || classified.kind === 'author-profile') {
        const profileUrl = classified.kind === 'author'
            ? `${classified.origin}/api/v1/user/${classified.handle}/public_profile`
            : `${classified.origin}${classified.path}`;
        return [{
            url: profileUrl,
            userData: {
                label: classified.kind === 'author' ? 'AUTHOR_JSON' : 'AUTHOR_HTML',
                origin: classified.origin,
                handle: classified.handle,
            },
        }];
    }

    if (classified.kind === 'publication') {
        return [{
            url: classified.origin,
            userData: {
                label: 'PUBLICATION_HTML',
                origin: classified.origin,
                publication: classified.publication,
                followWithArchive: mode === 'posts',
                searchQuery,
            },
        }];
    }

    return [];
}

// Substack embeds page data as: window._preloads = JSON.parse("<escaped JSON>").
// Scan to the closing quote of the string literal, honouring backslash escapes.
export function extractPreload(html) {
    if (!html) return null;

    const re = /window\._preloads\s*=\s*JSON\.parse\(\s*(["'])/g;
    const match = re.exec(html);
    if (!match) return null;

    const quote = match[1];
    let i = re.lastIndex;
    while (i < html.length) {
        if (html[i] === '\\' && i + 1 < html.length) { i += 2; continue; }
        if (html[i] === quote) break;
        i++;
    }
    if (i >= html.length) return null;

    try {
        const jsonStr = JSON.parse(`${quote}${html.slice(re.lastIndex, i)}${quote}`);
        return JSON.parse(jsonStr);
    } catch {
        return null;
    }
}

export function findPublicationObject(preload) {
    if (!preload || typeof preload !== 'object') return null;
    const candidates = [
        preload.publication,
        preload.pub,
        preload.pageData?.publication,
        preload.props?.pageProps?.publication,
        preload.props?.pageProps?.pub,
    ];
    for (const c of candidates) {
        if (c && typeof c === 'object' && (c.name || c.subdomain || c.id)) return c;
    }
    return null;
}

const DISCOVERY_SEEDS = [
    'https://www.noahpinion.blog',
    'https://www.slowboring.com',
    'https://www.astralcodexten.com',
    'https://www.lennysnewsletter.com',
    'https://www.thefp.com',
];

const RESERVED_SUBSTACK_SUBDOMAINS = new Set([
    'www', 'on', 'pages', 'reader', 'support', 'open', 'explore',
    'discover', 'blog', 'about', 'help', 'shop', 'api', 'cdn',
    'assets', 'static', 'images', 'img', 'login', 'signup',
    'terms', 'privacy', 'press', 'careers', 'tos', 'email',
    'mail', 'media', 'status', 'jobs',
]);

const NON_PUBLICATION_HOSTS = new Set([
    'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
    'linkedin.com', 'youtube.com', 'youtu.be', 'github.com',
    'google.com', 'apple.com', 'tiktok.com', 'mastodon.social',
    'bsky.app', 'threads.net', 'medium.com', 'paypal.com',
    'amazon.com', 'patreon.com', 'ko-fi.com', 'wikipedia.org',
    'reddit.com', 'discord.com', 'discord.gg', 'spotify.com',
    'soundcloud.com', 'vimeo.com', 't.me', 'telegram.me',
]);

export function isSubstackInfraSubdomain(host) {
    if (!host) return true;
    const h = host.toLowerCase();
    if (h === 'substack.com') return true;
    if (!h.endsWith('.substack.com')) return false;
    const sub = h.slice(0, -'.substack.com'.length);
    return RESERVED_SUBSTACK_SUBDOMAINS.has(sub);
}

export function isLikelyNonPublicationHost(host) {
    if (!host) return true;
    const h = host.toLowerCase();
    if (NON_PUBLICATION_HOSTS.has(h)) return true;
    const parts = h.split('.');
    if (parts.length >= 2) {
        const base = parts.slice(-2).join('.');
        if (NON_PUBLICATION_HOSTS.has(base)) return true;
    }
    return false;
}

export function buildDiscoverySeeds({ mode = 'posts', searchQuery = '' } = {}) {
    return DISCOVERY_SEEDS.map((rawUrl) => {
        const parsed = new URL(rawUrl);
        const origin = parsed.origin;
        const host = parsed.hostname.toLowerCase();
        const publication = host.endsWith('.substack.com')
            ? host.replace(/\.substack\.com$/, '')
            : host;
        return {
            url: origin,
            userData: {
                label: 'PUBLICATION_HTML',
                origin,
                publication,
                followWithArchive: mode === 'posts',
                harvestRecommendations: true,
                fromDiscovery: true,
                searchQuery,
            },
        };
    });
}

export function buildArchiveRequest({ origin, publication, offset = 0, searchQuery = '' }) {
    const params = new URLSearchParams({
        sort: 'new',
        offset: String(offset),
        limit: String(ARCHIVE_PAGE_LIMIT),
    });
    if (searchQuery) params.set('search', searchQuery);
    return {
        url: `${origin}/api/v1/archive?${params.toString()}`,
        userData: {
            label: 'ARCHIVE',
            origin,
            publication,
            offset,
            searchQuery,
        },
    };
}

export { ARCHIVE_PAGE_LIMIT };

// cheerio handles script/style removal and full entity decoding (named and
// numeric), which the previous regex chain got wrong (&amp;lt; double-decoded).
export function stripHtml(html) {
    if (!html) return '';
    try {
        const $ = cheerio.load(html);
        $('script, style').remove();
        return $.root().text().replace(/\s+/g, ' ').trim();
    } catch {
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

export function wordCount(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(Boolean).length;
}
