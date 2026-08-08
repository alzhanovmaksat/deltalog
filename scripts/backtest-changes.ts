/**
 * Validation step 1–2, run against history instead of the future.
 *
 * PRODUCT.md §10 says: snapshot 30 vendors, wait three weeks, count the real changes.
 * The waiting is the expensive part and it is avoidable — the Internet Archive already
 * holds the snapshots. This pulls ~12 months of archived versions of each resolved
 * subprocessor page and runs consecutive pairs through the *actual* materiality engine,
 * producing the number the plan is really asking for: how often does a vendor change
 * something a customer would want to know about?
 *
 * That number decides the product. Too low and there is nothing to alert on, and the
 * pitch has to move entirely to the evidence log. High enough and the alerting is the
 * hook.
 *
 * Honest limits, which the report repeats:
 *   - the Archive samples irregularly, so this undercounts changes between snapshots
 *   - pages it never crawled produce no data, not a zero
 *   - a rewritten page can read as one large change rather than several small ones
 *
 *   node scripts/backtest-changes.ts [--months 12] [--max-snapshots 8]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isMaterialChange } from '../src/materiality.ts';
import { buildSnapshot } from '../src/snapshot.ts';
import { vendorBySlug } from '../src/directory.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};

const MONTHS = arg('months', 12);
const MAX_SNAPSHOTS = arg('max-snapshots', 8);
const CONCURRENCY = 3;
const PAUSE_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the URLs we actually resolved out of the generated seed. */
function seededVendors(): { slug: string; url: string }[] {
  const sql = readFileSync(new URL('./seed-directory.sql', import.meta.url), 'utf8');
  const out: { slug: string; url: string }[] = [];
  for (const m of sql.matchAll(/VALUES \('dir-([a-z0-9-]+)', '[^']+', '[^']+',\s*'([^']+)'/g)) {
    out.push({ slug: m[1], url: m[2] });
  }
  return out;
}

interface Change {
  slug: string;
  from: string;
  to: string;
  summary: string;
  confidence: 'high' | 'low';
  /** Which detection path produced it — they are not equally trustworthy. */
  channel: 'entity' | 'clause' | 'text';
}

/**
 * Entity events are named facts ("added Snowflake Inc."). Text events are
 * "+140 characters", which is real but unactionable and fires on any edit. Counting
 * them together would inflate the headline rate with noise, so they are reported apart.
 */
function channelOf(summary: string): Change['channel'] {
  if (/Added \d+ subprocessor|Removed \d+ subprocessor|Jurisdiction changed|purpose changed|no longer lists any entities|Now listing/.test(summary)) return 'entity';
  if (/Page text changed/.test(summary)) return 'text';
  return 'clause';
}

/**
 * The Archive's CDX index, collapsed to roughly one snapshot per month so we sample
 * the year evenly instead of pulling 400 captures of a popular page.
 */
async function snapshotTimestamps(url: string): Promise<string[]> {
  const from = new Date();
  from.setMonth(from.getMonth() - MONTHS);
  const stamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

  const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&from=${stamp(from)}&to=${stamp(new Date())}&output=json&filter=statuscode:200&collapse=timestamp:6&limit=200`;

  // The Archive is a nonprofit running under load; timeouts are routine. Two attempts,
  // then give up on this vendor rather than taking the whole run down with it.
  let rows: string[][] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(cdx, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) return [];
      rows = (await response.json()) as string[][];
      break;
    } catch {
      if (attempt === 2) return [];
      await sleep(2000);
    }
  }
  if (rows.length < 2) return [];
  const timestamps = rows.slice(1).map((r) => r[1]);

  // Evenly spaced across whatever the Archive has.
  if (timestamps.length <= MAX_SNAPSHOTS) return timestamps;
  const step = (timestamps.length - 1) / (MAX_SNAPSHOTS - 1);
  return Array.from({ length: MAX_SNAPSHOTS }, (_, i) => timestamps[Math.round(i * step)]);
}

/** `id_` returns the original bytes without the Archive's injected toolbar. */
async function archived(url: string, timestamp: string): Promise<string | null> {
  try {
    const response = await fetch(`https://web.archive.org/web/${timestamp}id_/${url}`, {
      signal: AbortSignal.timeout(45_000),
      headers: { 'user-agent': 'DeltaLogBot/1.0 (+https://deltalog.app/bot; product research)' },
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function backtest(vendor: { slug: string; url: string }): Promise<{
  slug: string;
  snapshots: number;
  spanDays: number;
  changes: Change[];
}> {
  const timestamps = await snapshotTimestamps(vendor.url);
  await sleep(PAUSE_MS);
  if (timestamps.length < 2) return { slug: vendor.slug, snapshots: timestamps.length, spanDays: 0, changes: [] };

  const changes: Change[] = [];
  let previous: ReturnType<typeof buildSnapshot> | null = null;
  let previousStamp = '';
  let captured = 0;

  for (const ts of timestamps) {
    const html = await archived(vendor.url, ts);
    await sleep(PAUSE_MS);
    if (!html) continue;

    const current = buildSnapshot(html, 'subprocessor_list', new Date());
    captured++;

    if (previous) {
      const verdict = isMaterialChange(previous, current, {
        kind: 'subprocessor_list',
        falsePositivesReported: 0,
        learnedNoisePatterns: [],
      });
      // Extraction regressions are an artifact of archived pages, not vendor changes.
      const isArtifact = /no longer lists any entities|Now listing|structure disappeared/.test(verdict.summary);
      if (verdict.material && !isArtifact) {
        changes.push({ slug: vendor.slug, from: previousStamp.slice(0, 8), to: ts.slice(0, 8), summary: verdict.summary, confidence: verdict.confidence, channel: channelOf(verdict.summary) });
      }
    }
    previous = current;
    previousStamp = ts;
  }

  const days =
    timestamps.length > 1
      ? (Date.parse(iso(timestamps[timestamps.length - 1])) - Date.parse(iso(timestamps[0]))) / 86_400_000
      : 0;
  return { slug: vendor.slug, snapshots: captured, spanDays: Math.round(days), changes };
}

const iso = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T00:00:00Z`;

async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const queue = items.map((item, i) => ({ item, i }));
  const out: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        // One vendor's failure must never abort the batch — the same rule the cron
        // worker follows, which this script originally forgot.
        out[next.i] = await work(next.item).catch(() => ({ slug: (next!.item as { slug: string }).slug, snapshots: 0, spanDays: 0, changes: [] }) as R);
        process.stdout.write('.');
      }
    }),
  );
  return out;
}

const vendors = seededVendors();
console.log(`Backtesting ${vendors.length} vendors over ${MONTHS} months of Internet Archive snapshots…`);
const results = await pooled(vendors, CONCURRENCY, backtest);
process.stdout.write('\n\n');

const withData = results.filter((r) => r.snapshots >= 2);
const allChanges = results.flatMap((r) => r.changes);
const byChannel = (c: Change['channel']) => allChanges.filter((x) => x.channel === c).length;
const totalVendorMonths = withData.reduce((sum, r) => sum + r.spanDays / 30.44, 0);
const years = totalVendorMonths / 12;
const changesPerVendorYear = years ? byChannel('entity') / years : 0;

for (const r of results.sort((a, b) => b.changes.length - a.changes.length)) {
  const name = vendorBySlug(r.slug)?.name ?? r.slug;
  console.log(
    r.snapshots < 2
      ? `  no data   ${name.padEnd(22)} (${r.snapshots} usable snapshots)`
      : `  ${String(r.changes.filter((c) => c.channel === 'entity').length).padStart(2)} entity ${String(r.changes.filter((c) => c.channel !== 'entity').length).padStart(2)} other  ${name.padEnd(22)} ${r.snapshots} snapshots over ${r.spanDays}d`,
  );
}

console.log(`
─────────────────────────────────────────────
Vendors with usable history : ${withData.length} of ${results.length}
Observed vendor-years       : ${years.toFixed(1)}

Entity-level events         : ${byChannel('entity')}   (named, actionable)
Clause-path events          : ${byChannel('clause')}   (should be 0 for subprocessor pages)
Text-only events            : ${byChannel('text')}   (vague; digest, not a page)

ENTITY CHANGES / VENDOR / YR : ${changesPerVendorYear.toFixed(2)}
─────────────────────────────────────────────`);

writeFileSync(
  new URL('./backtest-results.json', import.meta.url),
  JSON.stringify({ changesPerVendorYear, entity: byChannel('entity'), clause: byChannel('clause'), text: byChannel('text'), vendorYears: years, results }, null, 2),
);
console.log('\nWrote scripts/backtest-results.json');
