import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateUrls,
  DIRECTORY,
  MANUAL_URLS,
  matchVendorNames,
  looksLikeTargetPage,
  resolveVendorUrl,
  searchDirectory,
  vendorBySlug,
} from './directory.ts';
import { escapeXml, feedJson, feedXml, sitemapXml, vendorPage, type DirectoryChange } from './directory-ui.ts';

// ── search & matching ───────────────────────────────────────────────────────────

test('slugs are unique and every vendor has a domain', () => {
  assert.equal(new Set(DIRECTORY.map((v) => v.slug)).size, DIRECTORY.length);
  assert.ok(DIRECTORY.every((v) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v.domain)), 'domains look like domains');
});

test('typeahead prefers exact over prefix over substring', () => {
  assert.equal(searchDirectory('box')[0].slug, 'box', 'exact beats Dropbox');
  assert.equal(searchDirectory('data')[0].slug, 'databricks');
  assert.equal(searchDirectory('datadoghq.com')[0].slug, 'datadog', 'domains are searchable');
});

test('aliases catch what people actually type', () => {
  assert.equal(searchDirectory('amazon web services')[0].slug, 'aws');
  assert.equal(searchDirectory('gcp')[0].slug, 'google-cloud');
  assert.equal(searchDirectory('jira')[0].slug, 'atlassian');
});

test('a pasted spreadsheet column becomes watches', () => {
  const { matched, unmatched } = matchVendorNames('Datadog\nStripe\nOkta\nSnowflake');
  assert.deepEqual(matched.map((v) => v.slug), ['datadog', 'stripe', 'okta', 'snowflake']);
  assert.deepEqual(unmatched, []);
});

test('splitting on commas does not shred "Snowflake, Inc."', () => {
  const { matched, unmatched } = matchVendorNames('Snowflake, Inc., Stripe, Inc., Acme Holdings Ltd.');
  assert.deepEqual(matched.map((v) => v.slug), ['snowflake', 'stripe']);
  // Standalone "Inc." fragments are dropped; a genuine miss is echoed back exactly as
  // typed, so the customer can find that line in the list they pasted from.
  assert.deepEqual(unmatched, ['Acme Holdings Ltd.']);
});

test('a loose substring hit is reported rather than silently added', () => {
  const { matched, unmatched } = matchVendorNames('lab');
  assert.deepEqual(matched, [], 'not auto-matched to Grafana Labs');
  assert.deepEqual(unmatched, ['lab']);
});

test('duplicates in a pasted list collapse to one watch', () => {
  const { matched } = matchVendorNames('Datadog\ndatadog\nDATADOG');
  assert.deepEqual(matched.map((v) => v.slug), ['datadog']);
});

// ── URL resolution ──────────────────────────────────────────────────────────────

test('candidate URLs are generated, never asserted', () => {
  const urls = candidateUrls(vendorBySlug('datadog')!, 'subprocessor_list');
  assert.ok(urls.length > 3);
  assert.ok(urls.every((u) => u.startsWith('https://datadoghq.com/')));
});

test('resolution accepts the first candidate whose body proves it is the right page', async () => {
  const pages: Record<string, string> = {
    'https://stripe.com/legal/subprocessors': '<h1>Legal</h1><p>Index of legal documents.</p>',
    'https://stripe.com/subprocessors': '<h1>Sub-processors</h1><table>...</table>',
  };
  const url = await resolveVendorUrl(vendorBySlug('stripe')!, 'subprocessor_list', async (u) =>
    pages[u] ? { outcome: 'ok', html: pages[u], url: u } : { outcome: 'not_found', url: u },
  );
  assert.equal(url, 'https://stripe.com/subprocessors', 'the 200 that is only a legal index is skipped');
});

test('resolution gives up rather than adopting a wrong page', async () => {
  const url = await resolveVendorUrl(vendorBySlug('okta')!, 'subprocessor_list', async (u) => ({
    outcome: 'ok',
    html: '<h1>Page not found</h1>',
    url: u,
  }));
  assert.equal(url, null);
});

// ── public pages & feeds ────────────────────────────────────────────────────────

const CHANGES: DirectoryChange[] = [
  { slug: 'datadog', vendorName: 'Datadog', at: '2026-03-01T06:00:00.000Z', summary: 'Added 1 subprocessor: OpenAI, L.L.C.' },
  { slug: 'stripe', vendorName: 'Stripe', at: '2026-02-28T06:00:00.000Z', summary: 'Removed 1 subprocessor: Acme & Sons <Ltd>' },
];

test('a vendor page carries the SEO furniture a search engine needs', () => {
  const page = vendorPage(
    {
      vendor: vendorBySlug('datadog')!,
      url: 'https://datadoghq.com/legal/subprocessors',
      lastCheckedAt: '2026-03-01T06:00:00.000Z',
      subprocessors: [{ name: 'Snowflake Inc.', purpose: 'Warehousing', jurisdiction: 'US' }],
      changes: CHANGES.slice(0, 1),
    },
    'https://deltalog.test',
  );

  assert.match(page, /<title>Datadog subprocessors — current list and recent changes<\/title>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/deltalog\.test\/directory\/datadog">/);
  assert.match(page, /<meta name="description" content="Datadog’s subprocessor list as of 2026-03-01/);
  assert.match(page, /application\/ld\+json/);
  assert.match(page, /Where is Datadog’s subprocessor list\?/);
  assert.match(page, /Get notified when Datadog changes this page/);
});

test('a vendor page with no extracted list says so instead of showing an empty table', () => {
  const page = vendorPage({ vendor: vendorBySlug('okta')!, subprocessors: [], changes: [] }, 'https://deltalog.test');
  assert.match(page, /haven’t been able to extract a structured list/);
  assert.match(page, /No changes detected/);
  assert.doesNotMatch(page, /<table>/);
});

test('scraped vendor text cannot inject markup into a public page', () => {
  const page = vendorPage(
    {
      vendor: vendorBySlug('okta')!,
      subprocessors: [{ name: '<script>alert(1)</script>', purpose: 'x' }],
      changes: [],
    },
    'https://deltalog.test',
  );
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;/);
});

test('the RSS feed stays well-formed when a summary contains XML characters', () => {
  const xml = feedXml(CHANGES, 'https://deltalog.test');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /Acme &amp; Sons &lt;Ltd&gt;/);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'no bare ampersands anywhere');
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
});

test('escapeXml covers the five predefined entities', () => {
  assert.equal(escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;');
});

test('the JSON feed is valid JSON Feed 1.1', () => {
  const feed = JSON.parse(feedJson(CHANGES, 'https://deltalog.test'));
  assert.equal(feed.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].url, 'https://deltalog.test/directory/datadog');
});

test('the sitemap lists the index and every vendor page', () => {
  const xml = sitemapXml(DIRECTORY.map((v) => v.slug), 'https://deltalog.test');
  assert.equal((xml.match(/<loc>/g) ?? []).length, DIRECTORY.length + 1);
  assert.match(xml, /<loc>https:\/\/deltalog\.test\/directory\/aws<\/loc>/);
});

// ── acceptance rule (hardened after the first live seeding run) ─────────────────

const acme = { slug: 'acme', name: 'Acme', domain: 'acme.com', category: 'x' };
const accepts = (url: string, html: string) => looksLikeTargetPage(acme, 'subprocessor_list', url, html);

test('a page titled as a subprocessor list is accepted', () => {
  assert.equal(accepts('https://acme.com/legal/subprocessors', '<h1>Sub-processors</h1><p>...</p>'), true);
});

test('a table of entries is accepted even without a matching heading', () => {
  const html = '<p>Our subprocessors are listed below.</p><table><tr><th>Subprocessor</th></tr>' +
    '<tr><td>A</td></tr><tr><td>B</td></tr></table><p>subprocessor changes are notified</p>';
  assert.equal(accepts('https://acme.com/subprocessors', html), true);
});

test('a login page is rejected even though the word survives in the redirect param', () => {
  // Exactly what Vercel returned on the first seeding run.
  assert.equal(accepts('https://acme.com/login?next=%2Fsubprocessors', '<title>Login</title>subprocessors'), false);
});

test('a redirect to a parent company is rejected', () => {
  // Loom redirected to Atlassian's privacy policy, which does mention sub-processors.
  assert.equal(
    accepts('https://www.atlassian.com/legal/privacy-policy', '<h1>Privacy Policy</h1><p>our sub-processors</p>'),
    false,
  );
});

test('a subdomain of the same vendor is fine', () => {
  // GitHub publishes theirs on docs.github.com.
  const gh = { slug: 'github', name: 'GitHub', domain: 'github.com', category: 'x' };
  assert.equal(
    looksLikeTargetPage(gh, 'subprocessor_list', 'https://docs.github.com/en/site-policy/github-subprocessors', '<h1>GitHub Subprocessors</h1>'),
    true,
  );
});

test('a privacy policy that merely mentions the word is rejected', () => {
  assert.equal(
    accepts('https://acme.com/legal/subprocessors', '<title>Privacy Policy</title><p>We may engage subprocessors.</p>'),
    false,
  );
});

test('a trust-center shell with no content is rejected', () => {
  assert.equal(accepts('https://trust.acme.com/', '<title>Acme Trust Center</title><div id="root"></div>'), false);
});

test('a hand-mapped URL is tried first but still has to prove itself', async () => {
  const mapped = { slug: 'acme', name: 'Acme', domain: 'acme.com', category: 'x', url: 'https://acme.com/vendors' };
  const tried: string[] = [];

  const good = await resolveVendorUrl(mapped, 'subprocessor_list', async (u) => {
    tried.push(u);
    return { outcome: 'ok', html: '<h1>Subprocessors</h1>', url: u };
  });
  assert.equal(good, 'https://acme.com/vendors');
  assert.equal(tried[0], 'https://acme.com/vendors', 'the mapping is tried before the guesses');

  const stale = await resolveVendorUrl(mapped, 'subprocessor_list', async (u) => ({
    outcome: u === 'https://acme.com/vendors' ? 'not_found' : 'ok',
    html: '<h1>Sub-processors</h1>',
    url: u,
  }));
  assert.equal(stale, 'https://acme.com/legal/subprocessors', 'a dead mapping falls through to the guesses');
});

test('every hand-mapped URL belongs to the vendor it is mapped to', () => {
  // A typo here would point a watch at another company's page and never look wrong on
  // a dashboard, so the mapping is checked rather than trusted.
  const registrable = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');
  for (const [slug, url] of Object.entries(MANUAL_URLS)) {
    const vendor = vendorBySlug(slug);
    assert.ok(vendor, `${slug} is in MANUAL_URLS but not in the directory`);
    assert.equal(new URL(url).protocol, 'https:', `${slug} must be https`);
    assert.equal(
      registrable(new URL(url).hostname),
      registrable(vendor!.domain),
      `${slug} is mapped to a URL on someone else's domain`,
    );
  }
});

test('a mapped vendor exposes its URL on the directory entry', () => {
  for (const vendor of DIRECTORY) {
    if (MANUAL_URLS[vendor.slug]) assert.equal(vendor.url, MANUAL_URLS[vendor.slug]);
  }
});
