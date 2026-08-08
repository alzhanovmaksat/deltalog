/**
 * Finds subprocessor pages that path-guessing missed, by asking the vendor's own site
 * where they are.
 *
 * Two sources, both authoritative in the sense that the vendor published them:
 *   1. links on the legal / trust / privacy hub pages
 *   2. <loc> entries in sitemap.xml (following one level of sitemap index)
 *
 * Every candidate is then verified with `looksLikeTargetPage` — the same rule the
 * seeder and production use. Nothing is written down because it looked plausible; a
 * URL only survives if fetching it proves it is the page.
 *
 *   node scripts/discover-urls.ts            # all unresolved vendors
 *   node scripts/discover-urls.ts datadog    # named vendors only
 */

import { writeFileSync } from 'node:fs';
import { DIRECTORY, looksLikeTargetPage, type DirectoryVendor } from '../src/directory.ts';
import { fetchPage } from '../src/fetch.ts';

const CONCURRENCY = 4;
const PAUSE_MS = 200;
const MAX_CANDIDATES = 12;

/** Pages that tend to link out to the legal library. */
const HUBS = ['/legal', '/trust', '/privacy', '/security', '/legal/privacy', '/terms', '/'];
const SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml'];

const TARGET = /sub-?processor/i;
const ANCHOR = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const registrable = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');

function sameSite(url: string, vendor: DirectoryVendor): boolean {
  try {
    return registrable(new URL(url).hostname) === registrable(vendor.domain);
  } catch {
    return false;
  }
}

/** Anchors whose href or label names what we are looking for. */
function linksFrom(html: string, base: string, vendor: DirectoryVendor): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(ANCHOR)) {
    const [, href, label] = match;
    if (!TARGET.test(href) && !TARGET.test(label)) continue;
    try {
      const url = new URL(href, base);
      url.hash = '';
      if (sameSite(url.toString(), vendor)) found.add(url.toString());
    } catch {
      /* unparseable href */
    }
  }
  return [...found];
}

function locsFrom(xml: string, vendor: DirectoryVendor): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  for (const match of xml.matchAll(LOC)) {
    const loc = match[1];
    if (!sameSite(loc, vendor)) continue;
    if (/sitemap.*\.xml$/i.test(loc)) sitemaps.push(loc);
    else if (TARGET.test(loc)) pages.push(loc);
  }
  return { pages, sitemaps };
}

async function candidatesFor(vendor: DirectoryVendor): Promise<string[]> {
  const found = new Set<string>();
  const origins = [`https://${vendor.domain}`, `https://www.${vendor.domain.replace(/^www\./, '')}`];

  for (const origin of new Set(origins)) {
    for (const hub of HUBS) {
      if (found.size >= MAX_CANDIDATES) break;
      const page = await fetchPage(`${origin}${hub}`, { maxAttempts: 1, timeoutMs: 8000 });
      await sleep(PAUSE_MS);
      if (page.outcome !== 'ok' || !page.html) continue;
      for (const link of linksFrom(page.html, page.url, vendor)) found.add(link);
    }

    for (const path of SITEMAPS) {
      if (found.size >= MAX_CANDIDATES) break;
      const map = await fetchPage(`${origin}${path}`, { maxAttempts: 1, timeoutMs: 8000 });
      await sleep(PAUSE_MS);
      if (map.outcome !== 'ok' || !map.html) continue;

      const { pages, sitemaps } = locsFrom(map.html, vendor);
      pages.forEach((p) => found.add(p));

      // One level of sitemap index, and only the child sitemaps whose own name hints
      // at legal content — following all of them turns a lookup into a full crawl.
      for (const child of sitemaps.filter((s) => /legal|polic|trust|privacy|corporate/i.test(s)).slice(0, 2)) {
        const sub = await fetchPage(child, { maxAttempts: 1, timeoutMs: 8000 });
        await sleep(PAUSE_MS);
        if (sub.outcome === 'ok' && sub.html) locsFrom(sub.html, vendor).pages.forEach((p) => found.add(p));
      }
    }
  }
  return [...found].slice(0, MAX_CANDIDATES);
}

async function discover(vendor: DirectoryVendor): Promise<{ vendor: DirectoryVendor; url: string | null; considered: number }> {
  const candidates = await candidatesFor(vendor);
  for (const candidate of candidates) {
    const page = await fetchPage(candidate, { maxAttempts: 1, timeoutMs: 8000 });
    await sleep(PAUSE_MS);
    if (page.outcome === 'ok' && page.html && looksLikeTargetPage(vendor, 'subprocessor_list', page.url, page.html)) {
      return { vendor, url: page.url, considered: candidates.length };
    }
  }
  return { vendor, url: null, considered: candidates.length };
}

async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.map((item, i) => ({ item, i }));
  const out: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        out[next.i] = await work(next.item);
        process.stdout.write('.');
      }
    }),
  );
  return out;
}

const named = process.argv.slice(2);
const targets = named.length ? DIRECTORY.filter((v) => named.includes(v.slug)) : DIRECTORY.filter((v) => !v.url);

console.log(`Discovering pages for ${targets.length} vendors…`);
const results = await pooled(targets, CONCURRENCY, discover);
process.stdout.write('\n\n');

const found = results.filter((r) => r.url);
for (const r of results) {
  console.log(r.url ? `  found   ${r.vendor.slug.padEnd(16)} ${r.url}` : `  none    ${r.vendor.slug.padEnd(16)} (${r.considered} candidates considered)`);
}

const mapping = Object.fromEntries(found.map((r) => [r.vendor.slug, r.url!]));
writeFileSync(new URL('./discovered-urls.json', import.meta.url), JSON.stringify(mapping, null, 2));
console.log(`\n${found.length}/${results.length} discovered. Wrote scripts/discovered-urls.json`);
