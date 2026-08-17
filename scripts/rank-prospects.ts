/**
 * Ranks candidate companies by how good an outreach target they are.
 *
 * Scoring reflects what the 12-company scan actually taught us, not what the plan
 * assumed:
 *
 *   - Publishing a machine-readable subprocessor list is the single best qualifier.
 *     It means the company already believes this matters. Ten of twelve did not.
 *   - Vendors we cannot monitor beat vendors that changed. "Two of your AI providers
 *     publish nothing anyone can track" outperformed "Cloudflare added a subsidiary"
 *     as an opener, every time.
 *   - A page that exists but renders client-side is its own hook: their own auditor
 *     cannot retrieve what it said six months ago either.
 *
 *   node scripts/rank-prospects.ts acme.com beta.io …
 */

import { readFileSync } from 'node:fs';
import { candidateUrls, matchVendorNames, type DirectoryVendor } from '../src/directory.ts';
import { extractEntities } from '../src/entities.ts';
import { fetchPage } from '../src/fetch.ts';

const { findings } = JSON.parse(readFileSync(new URL('./findings.json', import.meta.url), 'utf8')) as {
  findings: Record<string, { summary: string }[]>;
};
const monitored = new Set(
  [...readFileSync(new URL('./seed-directory.sql', import.meta.url), 'utf8').matchAll(/VALUES \('dir-([a-z0-9-]+)'/g)].map((m) => m[1]),
);

interface Scored {
  domain: string;
  status: 'readable' | 'client-rendered' | 'no-page';
  url?: string;
  disclosed: number;
  changed: string[];
  unmonitorable: string[];
  score: number;
  hook: string;
}

async function score(domain: string): Promise<Scored> {
  const base: Scored = { domain, status: 'no-page', disclosed: 0, changed: [], unmonitorable: [], score: 0, hook: '' };

  let page: { url: string; html: string } | null = null;
  for (const url of candidateUrls({ slug: '', name: '', domain, category: '' }, 'subprocessor_list')) {
    const r = await fetchPage(url, { maxAttempts: 1, timeoutMs: 12_000 });
    if (r.outcome === 'ok' && r.html) {
      page = { url: r.url, html: r.html };
      break;
    }
  }
  if (!page) return { ...base, hook: 'No page found — probably not feeling this yet.' };

  const disclosed = extractEntities(page.html);
  if (!disclosed.length) {
    return {
      ...base,
      status: 'client-rendered',
      url: page.url,
      score: 30,
      hook: 'Their trust page cannot be fetched or archived — nor by their auditor.',
    };
  }

  const { matched } = matchVendorNames(disclosed.map((e) => e.name).join('\n'));
  const changed = matched.filter((v: DirectoryVendor) => findings[v.slug]?.length).map((v: DirectoryVendor) => v.name);
  const unmonitorable = matched.filter((v: DirectoryVendor) => !monitored.has(v.slug)).map((v: DirectoryVendor) => v.name);

  // Publishing a readable list is worth more than any single finding: it is the only
  // signal that separates a prospect from a stranger.
  const scored = 50 + unmonitorable.length * 12 + changed.length * 8 + Math.min(disclosed.length, 20);
  const hook = unmonitorable.length
    ? `${unmonitorable.length} of their vendors publish nothing anyone can track: ${unmonitorable.join(', ')}`
    : changed.length
      ? `${changed.join(', ')} changed in the last year`
      : 'Publishes a clean list — good prospect, generic hook';

  return { ...base, status: 'readable', url: page.url, disclosed: disclosed.length, changed, unmonitorable, score: scored, hook };
}

const domains = process.argv.slice(2);
const results: Scored[] = [];
for (const d of domains) {
  results.push(await score(d));
  process.stdout.write('.');
}
process.stdout.write('\n\n');

results.sort((a, b) => b.score - a.score);
for (const r of results) {
  const tag = r.status === 'readable' ? 'READABLE' : r.status === 'client-rendered' ? 'JS-ONLY ' : 'NO PAGE ';
  console.log(`${String(r.score).padStart(3)}  ${tag}  ${r.domain.padEnd(20)} ${r.hook}`);
}
console.log(`\nreadable: ${results.filter((r) => r.status === 'readable').length}/${results.length}`);
