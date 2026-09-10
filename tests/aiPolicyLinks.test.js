/**
 * Finding an official page again from the provider's own site — PURE.
 *
 * Two refusals matter more than any ranking: a link off the provider's site is
 * never a candidate (a "terms" page on a third-party domain is not the
 * provider's terms), and a model is never asked to invent a URL — it only ever
 * chooses among what these helpers found.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractLinks, rankCandidates, scoreLinkForKind, looksLikeKind, sameSite,
} = require('../lib/ai/policyLinks');

const FOOTER = `
<html><body>
<nav><a href="/docs">Docs</a> <a href="https://console.groq.com/docs/deprecations">Deprecations</a></nav>
<footer>
  <a href="/terms-of-use/">Terms of Use</a>
  <a href='https://groq.com/privacy-policy/'>Privacy Policy</a>
  <a href=https://groq.com/pricing/>Pricing</a>
  <a href="https://twitter.com/groq">Twitter</a>
  <a href="https://example.com/terms">Partner terms</a>
  <a href="mailto:legal@groq.com">Contact legal</a>
  <a href="/logo.png">Logo</a>
  <a href="#top">Back to top</a>
  <a href="http://groq.com/insecure-terms">Old terms</a>
</footer></body></html>`;

test('extractLinks resolves relative hrefs, keeps https only, drops fragments and mailto', () => {
  const links = extractLinks(FOOTER, 'https://groq.com/');
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://groq.com/terms-of-use'));
  assert.ok(urls.includes('https://groq.com/privacy-policy'));
  assert.ok(urls.includes('https://groq.com/pricing'), 'an unquoted href is still a link');
  assert.equal(urls.some((u) => u.startsWith('http://')), false, 'plain http can be rewritten in transit');
  assert.equal(urls.some((u) => u.includes('mailto') || u.endsWith('#top')), false);
  assert.equal(links.find((l) => l.url === 'https://groq.com/terms-of-use').text, 'Terms of Use');
});

test('a link off the provider\'s site is never a candidate', () => {
  const links = extractLinks(FOOTER, 'https://groq.com/');
  const terms = rankCandidates(links, { kind: 'terms', siteUrl: 'https://groq.com/terms-of-use-old/' });
  assert.deepEqual(terms.map((c) => c.url), ['https://groq.com/terms-of-use']);
  assert.equal(terms.some((c) => c.url.includes('example.com')), false);
});

test('console.groq.com and groq.com are the same site; a different registrable domain is not', () => {
  assert.equal(sameSite('https://console.groq.com/docs/deprecations', 'https://groq.com/terms'), true);
  assert.equal(sameSite('https://docs.mistral.ai/x', 'https://mistral.ai/terms'), true);
  assert.equal(sameSite('https://groq.com/', 'https://groq.example.com/'), false);
});

test('the failing URL itself is excluded, and ranking prefers the exact page', () => {
  const links = extractLinks(FOOTER, 'https://groq.com/');
  const pricing = rankCandidates(links, { kind: 'pricing', siteUrl: 'https://groq.com/', exclude: 'https://groq.com/pricing/' });
  assert.equal(pricing.length, 0, 'the page that just 404ed cannot be its own replacement');

  const deprec = rankCandidates(links, { kind: 'model_policy', siteUrl: 'https://groq.com/' });
  assert.equal(deprec[0].url, 'https://console.groq.com/docs/deprecations');
});

test('images, login pages and unrelated links score zero', () => {
  assert.equal(scoreLinkForKind({ url: 'https://x.com/terms.png', text: 'Terms' }, 'terms'), 0);
  assert.equal(scoreLinkForKind({ url: 'https://x.com/login?next=/terms', text: 'Terms' }, 'terms'), 0);
  assert.equal(scoreLinkForKind({ url: 'https://x.com/blog/post', text: 'A post' }, 'privacy'), 0);
  assert.ok(scoreLinkForKind({ url: 'https://x.com/legal/terms', text: 'Terms of Service' }, 'terms') > 5);
});

test('looksLikeKind wants prose that mentions the subject', () => {
  const prose = `${'These Terms of Service govern your use of the API. '.repeat(20)}`;
  assert.equal(looksLikeKind(prose, 'terms'), true);
  assert.equal(looksLikeKind('Terms', 'terms'), false, 'a stub page is not the page');
  assert.equal(looksLikeKind(`${'lorem ipsum dolor '.repeat(50)}`, 'privacy'), false, 'long, but about nothing');
});
