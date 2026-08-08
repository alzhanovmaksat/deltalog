/**
 * Resolves every directory vendor's real subprocessor URL and emits the seed SQL.
 *
 * This is the verification pass that `directory.ts` is written to require: the seed
 * data carries domains and candidate paths, never asserted URLs, and this script is
 * what turns those guesses into facts by asking the actual web.
 *
 * It is deliberately polite — small concurrency, one attempt per candidate, a real
 * User-Agent that says who we are, and it stops at the first candidate that proves
 * itself. A vendor whose page cannot be found is reported, not guessed at.
 *
 *   node scripts/seed-directory.ts            # resolve and write scripts/seed-directory.sql
 *   node scripts/seed-directory.ts --limit 5  # smaller pass while iterating
 *
 * Apply with:
 *   wrangler d1 execute deltalog --file=scripts/seed-directory.sql
 */

import { writeFileSync } from 'node:fs';
import { DIRECTORY, DIRECTORY_WORKSPACE_ID, candidateUrls, gapReasonFor, resolveVendorUrl, type DirectoryVendor } from '../src/directory.ts';
import { fetchPage } from '../src/fetch.ts';

const CONCURRENCY = 5;
const PAUSE_MS = 250;
/** Directory pages are checked daily; the public pages only need to be a day fresh. */
const INTERVAL_MINUTES = 1440;
/** Spread the first checks so 60 watches don't all land in one cron batch of 12. */
const STAGGER_MINUTES = 5;

interface Attempt {
  url: string;
  outcome: string;
  status?: number;
}
interface Result {
  vendor: DirectoryVendor;
  url: string | null;
  attempts: Attempt[];
}

const limitArg = process.argv.indexOf('--limit');
const vendors = limitArg > -1 ? DIRECTORY.slice(0, Number(process.argv[limitArg + 1])) : DIRECTORY;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveOne(vendor: DirectoryVendor): Promise<Result> {
  const attempts: Attempt[] = [];

  // Wraps the real fetcher so the acceptance rule stays in `resolveVendorUrl` (one
  // definition, shared with production) while this script still sees every attempt.
  const url = await resolveVendorUrl(vendor, 'subprocessor_list', async (candidate) => {
    const result = await fetchPage(candidate, { maxAttempts: 1, timeoutMs: 8000 });
    attempts.push({ url: candidate, outcome: result.outcome, status: result.status });
    await sleep(PAUSE_MS);
    return { outcome: result.outcome, html: result.html, url: result.url };
  });

  return { vendor, url, attempts };
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

/** Why a vendor failed, in the product's own vocabulary. */
function diagnose(result: Result): string {
  const outcomes = new Set(result.attempts.map((a) => a.outcome));
  if (outcomes.has('blocked')) return 'blocked by bot protection';
  if (outcomes.has('timeout')) return 'timed out';
  if (outcomes.has('ok')) return 'pages answered but none proved to be a subprocessor list';
  return 'no candidate path exists';
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function toSql(results: Result[], now: Date): string {
  const resolved = results.filter((r) => r.url);

  const rows = resolved.map((r, i) => {
    const dueAt = new Date(now.getTime() + i * STAGGER_MINUTES * 60_000).toISOString();
    // Deterministic ids make re-seeding idempotent instead of duplicating watches.
    // NOTE: directory watches store the SLUG in `vendor` — that is the key
    // D1DirectoryStore.entry() looks up. Customer watches store the display name.
    return `INSERT OR IGNORE INTO watches
  (id, workspace_id, vendor, url, kind, interval_minutes, next_check_at, created_at)
VALUES (${sqlString(`dir-${r.vendor.slug}`)}, ${sqlString(DIRECTORY_WORKSPACE_ID)}, ${sqlString(r.vendor.slug)},
  ${sqlString(r.url!)}, 'subprocessor_list', ${INTERVAL_MINUTES}, ${sqlString(dueAt)}, ${sqlString(now.toISOString())});`;
  });

  const failures = results.filter((r) => !r.url);
  const unresolved = failures.map((r) => `--   ${r.vendor.slug.padEnd(16)} ${diagnose(r)}`);

  // The same failures as rows, so /directory/unmonitored publishes the real result of
  // this crawl instead of a hand-maintained list that quietly goes stale.
  const gapRows = failures.map((r) => {
    const detail = diagnose(r);
    return `INSERT OR REPLACE INTO directory_gaps (slug, reason, detail, checked_at)
VALUES (${sqlString(r.vendor.slug)}, ${sqlString(gapReasonFor(detail))}, ${sqlString(detail)}, ${sqlString(now.toISOString())});`;
  });

  return `-- DeltaLog directory seed
-- Generated ${now.toISOString()} by scripts/seed-directory.ts
-- Resolved ${resolved.length} of ${results.length} vendors against the live web.
--
-- Re-running is safe: ids are deterministic and every statement is INSERT OR IGNORE.
${unresolved.length ? `--\n-- Not seeded (${unresolved.length}) — add by hand or let a later pass retry:\n${unresolved.join('\n')}\n` : ''}
INSERT OR IGNORE INTO workspaces (id, name, plan, created_at)
VALUES (${sqlString(DIRECTORY_WORKSPACE_ID)}, 'DeltaLog Directory', 'compliance', ${sqlString(now.toISOString())});

${rows.join('\n\n')}

-- Gaps, published at /directory/unmonitored
DELETE FROM directory_gaps WHERE slug IN (${results.map((r) => sqlString(r.vendor.slug)).join(', ')});
${gapRows.join('\n')}
`;
}

const now = new Date();
console.log(`Resolving ${vendors.length} vendors (concurrency ${CONCURRENCY})…`);
const results = await pooled(vendors, CONCURRENCY, resolveOne);
process.stdout.write('\n\n');

const resolved = results.filter((r) => r.url);
for (const r of results) {
  console.log(r.url ? `  ok      ${r.vendor.slug.padEnd(16)} ${r.url}` : `  FAILED  ${r.vendor.slug.padEnd(16)} ${diagnose(r)}`);
}

writeFileSync(new URL('./seed-directory.sql', import.meta.url), toSql(results, now));
writeFileSync(
  new URL('./seed-directory.report.json', import.meta.url),
  JSON.stringify(results.map((r) => ({ slug: r.vendor.slug, url: r.url, attempts: r.attempts })), null, 2),
);

console.log(`\n${resolved.length}/${results.length} resolved. Wrote scripts/seed-directory.sql`);
