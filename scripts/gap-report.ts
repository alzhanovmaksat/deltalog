/**
 * Turns a company's public trust page into the outreach email for that company.
 *
 * The bottleneck in validation step 3 is that each email needs real findings about the
 * *recipient's own* vendors — that is the entire reason the email works, and
 * hand-assembling it is six minutes a head. This does it in one command.
 *
 * It reads only what a company publishes about itself: which subprocessors it discloses
 * on its own trust page. It does not touch anything about a person. The findings it
 * cross-references are the verified entity-level events in `findings.json`, every one of
 * which can be checked against the Internet Archive by the recipient.
 *
 * **It will never invent a finding.** If a vendor the company uses has no verified
 * change in our data, it is reported as monitored-but-quiet rather than dressed up.
 * The whole credibility of the email is that its facts survive checking.
 *
 *   node scripts/gap-report.ts https://acme.com/trust
 *   node scripts/gap-report.ts acme.com          # tries the usual subprocessor paths
 */

import { readFileSync } from 'node:fs';
import { candidateUrls, matchVendorNames, vendorBySlug, type DirectoryVendor } from '../src/directory.ts';
import { extractEntities } from '../src/entities.ts';
import { fetchPage } from '../src/fetch.ts';

interface Finding {
  from: string;
  to: string;
  summary: string;
}
const { meta, findings } = JSON.parse(readFileSync(new URL('./findings.json', import.meta.url), 'utf8')) as {
  meta: { source: string; ratePerVendorYear: number };
  findings: Record<string, Finding[]>;
};

/**
 * Which vendors we actually monitor — the seed file, not the directory.
 * The directory lists 60; only the seeded ones have a resolvable page. Describing an
 * unmonitorable vendor as "monitored, no changes" would be a false claim in a sales
 * email, made to the one buyer guaranteed to check.
 */
const monitored = new Set(
  [...readFileSync(new URL('./seed-directory.sql', import.meta.url), 'utf8').matchAll(/VALUES \('dir-([a-z0-9-]+)'/g)].map((m) => m[1]),
);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/gap-report.ts <trust-page-url | domain>');
  process.exit(1);
}

const pretty = (yyyymmdd: string) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(yyyymmdd.slice(4, 6)) - 1]} ${yyyymmdd.slice(0, 4)}`;
};

/** Accept a full URL, or a bare domain we try the usual paths against. */
async function loadPage(input: string): Promise<{ url: string; html: string } | null> {
  const urls = /^https?:\/\//.test(input)
    ? [input]
    : candidateUrls({ slug: '', name: '', domain: input.replace(/^www\./, ''), category: '' }, 'subprocessor_list');

  for (const url of urls) {
    const page = await fetchPage(url, { maxAttempts: 1, timeoutMs: 15_000 });
    if (page.outcome === 'ok' && page.html) return { url: page.url, html: page.html };
  }
  return null;
}

const page = await loadPage(target);
if (!page) {
  console.error(`Could not fetch a subprocessor page for ${target}.`);
  console.error('Give the trust-page URL directly, or check whether they publish one at all.');
  process.exit(1);
}

const disclosed = extractEntities(page.html);
if (!disclosed.length) {
  console.error(`Fetched ${page.url} but could not extract a vendor list from it.`);
  console.error('Likely client-rendered. Try their DPA, or pick a different prospect.');
  process.exit(1);
}

// Reuse the same conservative matcher the product uses for pasted vendor lists, so a
// loose substring hit never silently becomes a claim about the wrong company.
const { matched } = matchVendorNames(disclosed.map((e) => e.name).join('\n'));

const withFindings = matched.filter((v: DirectoryVendor) => findings[v.slug]?.length);
const quiet = matched.filter((v: DirectoryVendor) => !findings[v.slug]?.length && monitored.has(v.slug));
const unmonitorable = matched.filter((v: DirectoryVendor) => !monitored.has(v.slug));

console.log(`# Gap report — ${target}`);
console.log(`\nSource page: ${page.url}`);
console.log(
  `Vendors they disclose: ${disclosed.length}   ·   we monitor: ${matched.length - unmonitorable.length}   ·   with verified changes: ${withFindings.length}   ·   unmonitorable: ${unmonitorable.length}\n`,
);

if (!withFindings.length) {
  console.log('No verified changes among the vendors we track for this company.');
  console.log('Do not send an email claiming otherwise — pick another prospect, or lead with');
  console.log(`the base rate instead (${meta.ratePerVendorYear} changes per vendor per year across our directory).`);
  process.exit(0);
}

// Busiest vendors first: the strongest fact goes in the subject line.
withFindings.sort((a, b) => findings[b.slug].length - findings[a.slug].length);

const lead = withFindings[0];
const leadEvents = findings[lead.slug];
console.log('## Subject line\n');
console.log(`${lead.name} changed its subprocessor list ${leadEvents.length} time${leadEvents.length > 1 ? 's' : ''} in the last year — did you catch it?\n`);

console.log('## Body bullets (paste into the template in VALIDATION.md)\n');
for (const vendor of withFindings.slice(0, 4)) {
  const events = findings[vendor.slug];
  const highlight = events[events.length - 1];
  console.log(`• **${vendor.name}** — ${events.length} change${events.length > 1 ? 's' : ''} in the last year.`);
  console.log(`  Most recent (${pretty(highlight.to)}): ${highlight.summary}`);
}

if (quiet.length) {
  console.log(`\n## Also monitored, no changes detected\n`);
  console.log(quiet.map((v: DirectoryVendor) => v.name).join(', '));
  console.log('\n(Useful if they ask what else you watch. Do not imply these changed.)');
}

if (unmonitorable.length) {
  console.log(`\n## Vendors of theirs nobody can monitor automatically\n`);
  console.log(unmonitorable.map((v: DirectoryVendor) => v.name).join(', '));
  console.log(
    '\nThese publish no page we can find, render it client-side, or block automated\n' +
      'requests. Say so plainly if it comes up — it is a more interesting conversation\n' +
      'than the pitch, and pretending otherwise is how you lose this buyer.',
  );
}

console.log(`\n---\nEvery finding above is from ${meta.source}.`);
console.log('The recipient can verify any of it at web.archive.org. Do not add anything you have not checked.');
