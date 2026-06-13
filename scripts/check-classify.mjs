// Quick offline check of URL classification — run with: node scripts/check-classify.mjs
import assert from 'node:assert';
import { classifyUrl, stripHtml, isSubstackInfraSubdomain } from '../src/utils.js';

const cases = [
    ['https://noahpinion.substack.com', { kind: 'publication', publication: 'noahpinion', origin: 'https://noahpinion.substack.com' }],
    ['https://www.astralcodexten.com', { kind: 'publication', publication: 'www.astralcodexten.com' }],
    ['https://example.substack.com/p/some-post', { kind: 'post', slug: 'some-post', publication: 'example' }],
    ['https://www.astralcodexten.com/p/my-ai-opinions?utm_source=x', { kind: 'post', slug: 'my-ai-opinions' }],
    ['https://substack.com/@mattyglesias', { kind: 'author', handle: 'mattyglesias' }],
    ['https://www.substack.com/@someone/notes', { kind: 'author', handle: 'someone' }],
    ['https://substack.com/profile/123-some-name', { kind: 'author-profile', path: '/profile/123-some-name' }],
    ['https://open.substack.com/pub/astralcodexten/p/my-ai-opinions?r=abc&utm_medium=ios', { kind: 'post', publication: 'astralcodexten', slug: 'my-ai-opinions', origin: 'https://astralcodexten.substack.com' }],
    ['https://open.substack.com/pub/noahpinion', { kind: 'publication', publication: 'noahpinion', origin: 'https://noahpinion.substack.com' }],
    ['https://substack.com/home/post/p-190662510', { kind: 'redirect', url: 'https://substack.com/home/post/p-190662510' }],
    ['https://substack.com/browse/technology', null],
    ['https://on.substack.com/p/announcement', null],
    ['https://support.substack.com', null],
    ['not a url', null],
];

for (const [url, expected] of cases) {
    const got = classifyUrl(url);
    if (expected === null) {
        assert.strictEqual(got, null, `${url} should be null, got ${JSON.stringify(got)}`);
    } else {
        assert.ok(got, `${url} should classify, got null`);
        for (const [k, v] of Object.entries(expected)) {
            assert.strictEqual(got[k], v, `${url}: expected ${k}=${v}, got ${got[k]} (${JSON.stringify(got)})`);
        }
    }
}

assert.strictEqual(stripHtml('<p>Hello&nbsp;&amp;lt; world &#8212; fine</p><script>bad()</script>'), 'Hello &lt; world — fine');
assert.strictEqual(stripHtml('<style>p{}</style><p>A<b>B</b></p>'), 'AB');
assert.strictEqual(isSubstackInfraSubdomain('on.substack.com'), true);
assert.strictEqual(isSubstackInfraSubdomain('noahpinion.substack.com'), false);

console.log(`All ${cases.length} classifyUrl cases + stripHtml checks passed.`);
