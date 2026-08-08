/**
 * Public directory pages and feeds.
 *
 * These are the only pages on the site that are anonymous, indexable, and cacheable —
 * everything else is behind a session. They exist to answer a query someone types into
 * a search engine at the exact moment they need the product ("where is Datadog's
 * subprocessor list"), and to convert that answer into a watch.
 */

import type { Entity } from './entities.ts';
import { escapeHtml } from './render.ts';
import { CATEGORIES, type DirectoryGap, type DirectoryVendor, type GapReason } from './directory.ts';

export interface DirectoryChange {
  slug: string;
  vendorName: string;
  at: string;
  summary: string;
}

export interface DirectoryEntry {
  vendor: DirectoryVendor;
  url?: string;
  lastCheckedAt?: string;
  subprocessors: Entity[];
  changes: DirectoryChange[];
}

export interface DirectoryIndexRow {
  vendor: DirectoryVendor;
  subprocessorCount: number;
  lastCheckedAt?: string;
  lastChangeAt?: string;
}

const STYLE = `
:root { --fg:#101828; --muted:#667085; --line:#e4e7ec; --bg:#fff; --accent:#175cd3 }
@media (prefers-color-scheme: dark) { :root { --fg:#e7e9ee; --muted:#98a2b3; --line:#2a2f3a; --bg:#14161b; --accent:#84adff } }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:780px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:28px;line-height:1.25;margin:0 0 8px} h2{font-size:17px;margin:36px 0 10px}
a{color:var(--accent)} .muted{color:var(--muted);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:15px;margin:10px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.cta{display:block;border:1px solid var(--accent);border-radius:8px;padding:16px 18px;margin:28px 0;text-decoration:none;color:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 16px;margin:8px 0 24px;padding:0;list-style:none}
.change{border-left:2px solid var(--line);padding:2px 0 2px 12px;margin-bottom:12px}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line)}
`;

function page(opts: { title: string; description: string; canonical: string; body: string; jsonLd?: unknown }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<link rel="canonical" href="${escapeHtml(opts.canonical)}">
<link rel="alternate" type="application/rss+xml" title="Subprocessor changes" href="/feed.xml">
<meta property="og:title" content="${escapeHtml(opts.title)}">
<meta property="og:description" content="${escapeHtml(opts.description)}">
<style>${STYLE}</style>
${opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head><body><div class="wrap">${opts.body}
<footer class="muted">DeltaLog watches these pages every day and keeps a timestamped log of every check.
<a href="/login">Monitor your own vendors free</a> · <a href="/feed.xml">Change feed</a></footer>
</div></body></html>`;
}

const day = (iso?: string) => (iso ? escapeHtml(iso.slice(0, 10)) : 'not yet checked');

export function directoryIndexPage(rows: DirectoryIndexRow[], baseUrl: string): string {
  const byCategory = CATEGORIES.map((category) => {
    const items = rows.filter((r) => r.vendor.category === category);
    if (!items.length) return '';
    return `<h2>${escapeHtml(category)}</h2><ul class="grid">${items
      .map((r) => `<li><a href="/directory/${escapeHtml(r.vendor.slug)}">${escapeHtml(r.vendor.name)}</a></li>`)
      .join('')}</ul>`;
  }).join('');

  return page({
    title: 'Subprocessor lists for 60+ SaaS vendors — DeltaLog Directory',
    description:
      'Find any vendor’s subprocessor list, DPA, and trust page — plus what changed recently. Updated daily, free to browse.',
    canonical: `${baseUrl}/directory`,
    body: `<h1>Vendor subprocessor lists, in one place</h1>
      <p>Every page below is checked daily. Each entry shows the current subprocessor list and what has changed recently.</p>
      <a class="cta" href="/login"><strong>Watch your own vendors →</strong><br>
        <span class="muted">Get an email the day one of them changes. Free for 3 vendors.</span></a>
      ${byCategory}
      <p class="muted">Not every vendor can be monitored automatically —
         <a href="/directory/unmonitored">here are the ones we can’t, and why</a>.</p>`,
  });
}

export function vendorPage(entry: DirectoryEntry, baseUrl: string): string {
  const { vendor } = entry;
  const canonical = `${baseUrl}/directory/${vendor.slug}`;

  const table = entry.subprocessors.length
    ? `<table><tr><th>Subprocessor</th><th>Purpose</th><th>Location</th></tr>${entry.subprocessors
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.purpose ?? '')}</td><td>${escapeHtml(e.jurisdiction ?? '')}</td></tr>`,
        )
        .join('')}</table>`
    : `<p class="muted">We haven’t been able to extract a structured list from this page. ${
        entry.url ? 'The source page is linked above.' : ''
      }</p>`;

  const changes = entry.changes.length
    ? entry.changes
        .map(
          (c) => `<div class="change"><div class="muted">${day(c.at)}</div><div>${escapeHtml(c.summary)}</div></div>`,
        )
        .join('')
    : '<p class="muted">No changes detected since we started watching this page.</p>';

  return page({
    title: `${vendor.name} subprocessors — current list and recent changes`,
    description: `${vendor.name}’s subprocessor list as of ${day(entry.lastCheckedAt)}, with every change we have detected. Checked daily.`,
    canonical,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${vendor.name} subprocessor list`,
      description: `Current subprocessors published by ${vendor.name}, with a history of detected changes.`,
      url: canonical,
      dateModified: entry.lastCheckedAt,
      isAccessibleForFree: true,
    },
    body: `<h1>Where is ${escapeHtml(vendor.name)}’s subprocessor list?</h1>
      <p class="muted">${escapeHtml(vendor.category)} · last checked ${day(entry.lastCheckedAt)}
      ${entry.url ? ` · <a href="${escapeHtml(entry.url)}" rel="nofollow noopener">source page</a>` : ''}</p>
      <h2>Current subprocessors${entry.subprocessors.length ? ` (${entry.subprocessors.length})` : ''}</h2>
      ${table}
      <a class="cta" href="/login"><strong>Get notified when ${escapeHtml(vendor.name)} changes this page →</strong><br>
        <span class="muted">Email on the day it happens, plus a log you can export at audit time. Free for 3 vendors.</span></a>
      <h2>Recent changes</h2>
      ${changes}`,
  });
}

/**
 * The gap page.
 *
 * Publishing what the product cannot do is unusual, and it is here for two reasons
 * that both hold up commercially. It is the honest version of a coverage claim — a
 * directory of 60 vendors that silently monitors 31 is a promise waiting to be broken
 * during an audit. And it answers a query people genuinely type: "does Okta publish a
 * subprocessor list?" is a real question, and "no, and here is what to do instead" is
 * a better answer than a page pretending otherwise.
 *
 * Each group ends with an action, because three of the four gaps are things the
 * reader can actually resolve.
 */
const GAP_COPY: Record<GapReason, { title: string; what: string; action: string }> = {
  no_public_page: {
    title: 'No public list we could find',
    what: 'We checked their legal, trust, and privacy pages, their sitemap, and every common URL pattern. Nothing published a subprocessor list.',
    action: 'Ask the vendor directly — many will send the list under NDA, or expose it inside a customer trust portal. If they give you a URL, you can watch it in DeltaLog like any other page.',
  },
  blocked: {
    title: 'Their site blocks automated checks',
    what: 'The page may well exist, but the vendor’s bot protection rejects our requests before we ever see it.',
    action: 'Tell us which vendor you need and we can usually get these working. This is the group most likely to move into the directory.',
  },
  not_machine_readable: {
    title: 'Published, but not machine-readable',
    what: 'A page exists, but it is drawn by JavaScript in the browser or has no stable structure, so we cannot extract the list or tell a real change from a re-render.',
    action: 'We can still watch the page for wholesale changes on request, though the alerts will be vaguer than the ones you get for a normal vendor.',
  },
  stopped_answering: {
    title: 'Stopped answering',
    what: 'We were monitoring these and the page broke — moved, withdrawn, or newly gated. They are in our queue.',
    action: 'Nothing needed from you. If you monitor one of these yourself, we have already alerted you.',
  },
};

const GAP_ORDER: GapReason[] = ['blocked', 'not_machine_readable', 'stopped_answering', 'no_public_page'];

export function unmonitoredPage(gaps: DirectoryGap[], monitoredCount: number, baseUrl: string): string {
  const groups = GAP_ORDER.map((reason) => ({ reason, items: gaps.filter((g) => g.reason === reason) })).filter(
    (g) => g.items.length,
  );

  const total = monitoredCount + gaps.length;
  const body = groups
    .map(
      ({ reason, items }) => `<h2>${escapeHtml(GAP_COPY[reason].title)} <span class="muted">(${items.length})</span></h2>
        <p>${escapeHtml(GAP_COPY[reason].what)}</p>
        <ul class="grid">${items
          .map((g) => `<li>${escapeHtml(g.vendor.name)} <span class="muted">${escapeHtml(g.vendor.category)}</span></li>`)
          .join('')}</ul>
        <p class="muted">${escapeHtml(GAP_COPY[reason].action)}</p>`,
    )
    .join('');

  return page({
    title: 'Vendors we can’t monitor, and why — DeltaLog',
    description: `${gaps.length} of the ${total} vendors in our directory cannot be monitored automatically. Here is each one, the reason, and what to do instead.`,
    canonical: `${baseUrl}/directory/unmonitored`,
    body: `<h1>Vendors we can’t monitor, and why</h1>
      <p>We watch <strong>${monitoredCount}</strong> of the ${total} vendors in our directory. These ${gaps.length} we do not —
         and we would rather say so here than let you find out during an audit.</p>
      <p class="muted">Some of this we can fix, and the blocked group especially. Some of it is structural — a vendor who
         publishes only inside a gated trust portal cannot be monitored by us or by anyone else. Rather than quietly drop
         those vendors from the directory, we list them here and refresh this page with every crawl.</p>
      ${body}
      <a class="cta" href="/directory"><strong>See the ${monitoredCount} vendors we do watch →</strong><br>
        <span class="muted">Current subprocessor lists and every change we have detected.</span></a>`,
  });
}

// ── feeds ───────────────────────────────────────────────────────────────────────

/**
 * XML escaping is its own function on purpose.
 *
 * The summaries in this feed contain text scraped from vendor websites, and an
 * unescaped `&` or `<` does not merely look wrong in XML — it makes the document
 * malformed, and every reader drops the whole feed rather than one item.
 */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function feedXml(changes: DirectoryChange[], baseUrl: string): string {
  const items = changes
    .map(
      (c) => `  <item>
    <title>${escapeXml(`${c.vendorName}: ${c.summary}`)}</title>
    <link>${escapeXml(`${baseUrl}/directory/${c.slug}`)}</link>
    <guid isPermaLink="false">${escapeXml(`${c.slug}-${c.at}`)}</guid>
    <pubDate>${escapeXml(new Date(c.at).toUTCString())}</pubDate>
    <description>${escapeXml(c.summary)}</description>
  </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Subprocessor changes across 60+ SaaS vendors</title>
  <link>${escapeXml(`${baseUrl}/directory`)}</link>
  <description>Every subprocessor, DPA, and trust page change DeltaLog detects, as it happens.</description>
${items}
</channel></rss>`;
}

export function feedJson(changes: DirectoryChange[], baseUrl: string): string {
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Subprocessor changes across 60+ SaaS vendors',
      home_page_url: `${baseUrl}/directory`,
      feed_url: `${baseUrl}/feed.json`,
      items: changes.map((c) => ({
        id: `${c.slug}-${c.at}`,
        url: `${baseUrl}/directory/${c.slug}`,
        title: `${c.vendorName}: ${c.summary}`,
        date_published: c.at,
      })),
    },
    null,
    2,
  );
}

export function sitemapXml(slugs: string[], baseUrl: string): string {
  const urls = [`${baseUrl}/directory`, ...slugs.map((s) => `${baseUrl}/directory/${s}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n')}
</urlset>`;
}
