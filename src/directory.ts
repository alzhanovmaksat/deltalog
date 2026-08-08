/**
 * The public vendor directory.
 *
 * This is the growth engine, and its defining property is that **the product
 * maintains it for free**. Directory vendors are ordinary watches in a system-owned
 * workspace, so the same cron sweep that serves paying customers also keeps ~60 public
 * SEO pages permanently fresh, each accumulating a changelog that gets more valuable
 * every month. No content calendar, no marketing hours.
 *
 * It is also the onboarding accelerator: a new signup picks names off a list instead of
 * hunting URLs, and because the directory has been crawling those pages all along, the
 * very first screen can say "3 of your vendors changed in the last 90 days" — real
 * news, on day zero, before the customer's own monitoring has produced anything.
 *
 * ── On the URLs ──
 * This file deliberately does NOT hardcode subprocessor URLs. Vendor legal pages move
 * constantly, and a seed file full of asserted-but-stale URLs would be worse than
 * empty: it would silently monitor 404s. Instead each vendor carries a domain, and
 * `candidateUrls` generates the paths worth trying. `resolveVendorUrl` finds the one
 * that actually answers, and the relocation machinery in fetch.ts keeps it current.
 * Nothing here is a claim about where a page lives — only a guess to be verified.
 */

import { normalizeEntityName } from './entities.ts';

export const DIRECTORY_WORKSPACE_ID = 'system-directory';

export interface DirectoryVendor {
  slug: string;
  name: string;
  domain: string;
  category: string;
  aliases?: string[];
  /**
   * Hand-mapped URL for vendors whose page the path guesses cannot find — about 60%
   * of them, per the first live seeding run. Still verified before use: a stale
   * hand-mapping is exactly as harmful as a stale guess.
   */
  url?: string;
}

/** [slug, name, domain, category] */
const SEED: [string, string, string, string][] = [
  ['aws', 'Amazon Web Services', 'aws.amazon.com', 'Cloud infrastructure'],
  ['google-cloud', 'Google Cloud', 'cloud.google.com', 'Cloud infrastructure'],
  ['azure', 'Microsoft Azure', 'azure.microsoft.com', 'Cloud infrastructure'],
  ['digitalocean', 'DigitalOcean', 'digitalocean.com', 'Cloud infrastructure'],
  ['heroku', 'Heroku', 'heroku.com', 'Cloud infrastructure'],
  ['vercel', 'Vercel', 'vercel.com', 'Cloud infrastructure'],
  ['netlify', 'Netlify', 'netlify.com', 'Cloud infrastructure'],
  ['cloudflare', 'Cloudflare', 'cloudflare.com', 'CDN & security'],
  ['fastly', 'Fastly', 'fastly.com', 'CDN & security'],
  ['akamai', 'Akamai', 'akamai.com', 'CDN & security'],
  ['datadog', 'Datadog', 'datadoghq.com', 'Observability'],
  ['new-relic', 'New Relic', 'newrelic.com', 'Observability'],
  ['sentry', 'Sentry', 'sentry.io', 'Observability'],
  ['grafana', 'Grafana Labs', 'grafana.com', 'Observability'],
  ['elastic', 'Elastic', 'elastic.co', 'Observability'],
  ['pagerduty', 'PagerDuty', 'pagerduty.com', 'Incident response'],
  ['stripe', 'Stripe', 'stripe.com', 'Payments'],
  ['twilio', 'Twilio', 'twilio.com', 'Communications'],
  ['sendgrid', 'SendGrid', 'sendgrid.com', 'Communications'],
  ['slack', 'Slack', 'slack.com', 'Communications'],
  ['zoom', 'Zoom', 'zoom.us', 'Communications'],
  ['loom', 'Loom', 'loom.com', 'Communications'],
  ['calendly', 'Calendly', 'calendly.com', 'Productivity'],
  ['notion', 'Notion', 'notion.so', 'Productivity'],
  ['airtable', 'Airtable', 'airtable.com', 'Productivity'],
  ['asana', 'Asana', 'asana.com', 'Productivity'],
  ['linear', 'Linear', 'linear.app', 'Productivity'],
  ['monday', 'monday.com', 'monday.com', 'Productivity'],
  ['atlassian', 'Atlassian', 'atlassian.com', 'Productivity'],
  ['miro', 'Miro', 'miro.com', 'Productivity'],
  ['figma', 'Figma', 'figma.com', 'Design'],
  ['github', 'GitHub', 'github.com', 'Developer tools'],
  ['gitlab', 'GitLab', 'gitlab.com', 'Developer tools'],
  ['launchdarkly', 'LaunchDarkly', 'launchdarkly.com', 'Developer tools'],
  ['zapier', 'Zapier', 'zapier.com', 'Developer tools'],
  ['snowflake', 'Snowflake', 'snowflake.com', 'Data'],
  ['databricks', 'Databricks', 'databricks.com', 'Data'],
  ['mongodb', 'MongoDB', 'mongodb.com', 'Data'],
  ['segment', 'Segment', 'segment.com', 'Analytics'],
  ['amplitude', 'Amplitude', 'amplitude.com', 'Analytics'],
  ['mixpanel', 'Mixpanel', 'mixpanel.com', 'Analytics'],
  ['salesforce', 'Salesforce', 'salesforce.com', 'CRM & support'],
  ['hubspot', 'HubSpot', 'hubspot.com', 'CRM & support'],
  ['zendesk', 'Zendesk', 'zendesk.com', 'CRM & support'],
  ['intercom', 'Intercom', 'intercom.com', 'CRM & support'],
  ['mailchimp', 'Mailchimp', 'mailchimp.com', 'Marketing'],
  ['klaviyo', 'Klaviyo', 'klaviyo.com', 'Marketing'],
  ['braze', 'Braze', 'braze.com', 'Marketing'],
  ['okta', 'Okta', 'okta.com', 'Identity & security'],
  ['auth0', 'Auth0', 'auth0.com', 'Identity & security'],
  ['1password', '1Password', '1password.com', 'Identity & security'],
  ['docusign', 'DocuSign', 'docusign.com', 'Documents'],
  ['dropbox', 'Dropbox', 'dropbox.com', 'Documents'],
  ['box', 'Box', 'box.com', 'Documents'],
  ['workday', 'Workday', 'workday.com', 'HR & finance'],
  ['bamboohr', 'BambooHR', 'bamboohr.com', 'HR & finance'],
  ['gusto', 'Gusto', 'gusto.com', 'HR & finance'],
  ['rippling', 'Rippling', 'rippling.com', 'HR & finance'],
  ['openai', 'OpenAI', 'openai.com', 'AI'],
  ['anthropic', 'Anthropic', 'anthropic.com', 'AI'],
];

const ALIASES: Record<string, string[]> = {
  aws: ['amazon web services', 'amazon', 'aws'],
  'google-cloud': ['gcp', 'google cloud platform', 'google'],
  azure: ['microsoft azure', 'microsoft', 'azure'],
  atlassian: ['jira', 'confluence', 'bitbucket'],
  auth0: ['okta customer identity'],
  sendgrid: ['twilio sendgrid'],
  segment: ['twilio segment'],
  monday: ['monday'],
  'new-relic': ['newrelic'],
};

/**
 * URLs that path-guessing cannot find, discovered from each vendor's own legal hub and
 * sitemap by `scripts/discover-urls.ts`.
 *
 * Every entry here was fetched and passed `looksLikeTargetPage` when it was added.
 * Do not edit this map from memory — run the script. A URL written down because it
 * seemed right is the precise failure this whole module is built to avoid, and it
 * fails silently: the watch goes green while monitoring a 404 or somebody else's page.
 */
export const MANUAL_URLS: Record<string, string> = {
  '1password': 'https://1password.com/legal/saas-manager/third-party-sub-processors',
  amplitude: 'https://amplitude.com/subprocessor-list',
  calendly: 'https://calendly.com/help/calendly-sub-processors-gdpr-ccpa',
  cloudflare: 'https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/',
  fastly: 'https://docs.fastly.com/products/sub-processors',
  grafana: 'https://grafana.com/legal/list-of-subprocessors/',
  intercom: 'https://www.intercom.com/legal/subprocessors-list',
  snowflake: 'https://www.snowflake.com/en/legal/privacy/snowflake-sub-processors/',
};

export const DIRECTORY: DirectoryVendor[] = SEED.map(([slug, name, domain, category]) => ({
  slug,
  name,
  domain,
  category,
  aliases: ALIASES[slug],
  url: MANUAL_URLS[slug],
}));

const BY_SLUG = new Map(DIRECTORY.map((v) => [v.slug, v]));
export const vendorBySlug = (slug: string) => BY_SLUG.get(slug) ?? null;

// ── URL candidates ──────────────────────────────────────────────────────────────

/** Ordered by how often each pattern is the real one, so the first hit is usually right. */
const PATHS: Record<'subprocessor_list' | 'dpa' | 'trust_center', string[]> = {
  subprocessor_list: [
    '/legal/subprocessors',
    '/subprocessors',
    '/legal/sub-processors',
    '/sub-processors',
    '/trust/subprocessors',
    '/trust/sub-processors',
    '/privacy/subprocessors',
    '/terms/subprocessors',
    '/legal/subprocessor-list',
    '/security/subprocessors',
    '/legal/service-providers',
  ],
  dpa: ['/legal/dpa', '/dpa', '/legal/data-processing-addendum', '/legal/data-processing-agreement', '/privacy/dpa'],
  trust_center: ['/trust', '/security', '/trust-center', '/legal/privacy'],
};

export function candidateUrls(vendor: DirectoryVendor, kind: keyof typeof PATHS): string[] {
  return PATHS[kind].map((path) => `https://${vendor.domain}${path}`);
}

/** Last two labels. Adequate for this directory's TLDs (.com/.io/.co/.so/.app/.us). */
const registrableDomain = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');

const AUTH_PAGE = /\/(login|signin|sign-in|auth|account|register)\b/i;

/**
 * Decides whether a fetched page really is the thing we went looking for.
 *
 * Split out and exported because the loose version of this check produced genuinely
 * wrong seeds on the first live run — a login page (the word survived in a `?next=`
 * parameter), a parent company's privacy policy reached by redirect, and a
 * JavaScript trust-center shell all passed a bare "does the body mention
 * subprocessor" test. Each would have been monitored forever as though it were the
 * vendor's subprocessor list.
 */
export function looksLikeTargetPage(
  vendor: DirectoryVendor,
  kind: keyof typeof PATHS,
  finalUrl: string,
  html: string,
): boolean {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }

  // A redirect off the vendor's own domain means we found somebody else's page.
  // Subdomains are fine — GitHub publishes theirs on docs.github.com.
  if (registrableDomain(url.hostname) !== registrableDomain(vendor.domain)) return false;

  // Landing on a sign-in wall means the real page is gated, not that we found it.
  if (AUTH_PAGE.test(url.pathname) || url.searchParams.has('next') || url.searchParams.has('redirect')) return false;

  const marker = kind === 'dpa' ? /data processing (addendum|agreement)|\bdpa\b/i : /sub-?processors?\b/i;

  // The term has to be what the page is *about*, not a passing mention in a privacy
  // policy: either it titles the document, or it labels a table of actual entries.
  const headings = [...html.matchAll(/<(?:title|h1|h2)[^>]*>([\s\S]{0,200}?)<\/(?:title|h1|h2)>/gi)].map((m) => m[1]);
  if (headings.some((h) => marker.test(h))) return true;

  const mentions = html.match(new RegExp(marker.source, 'gi'))?.length ?? 0;
  const rows = html.match(/<tr\b/gi)?.length ?? 0;
  return mentions >= 3 && rows >= 3;
}

/**
 * Finds the URL that actually answers, by trying candidates in order and returning
 * the first that passes `looksLikeTargetPage`. A vendor with no convincing page is
 * reported as unresolved rather than pointed at the nearest 200.
 */
export async function resolveVendorUrl(
  vendor: DirectoryVendor,
  kind: keyof typeof PATHS,
  fetchPage: (url: string) => Promise<{ outcome: string; html?: string; url: string }>,
): Promise<string | null> {
  // A hand-mapped URL is tried first but is not trusted: it goes through the same
  // acceptance check, so a vendor who moves their page fails loudly rather than
  // leaving us monitoring a 404 that someone typed in a year ago.
  const candidates = vendor.url ? [vendor.url, ...candidateUrls(vendor, kind)] : candidateUrls(vendor, kind);
  for (const candidate of candidates) {
    const result = await fetchPage(candidate);
    if (result.outcome !== 'ok' || !result.html) continue;
    if (looksLikeTargetPage(vendor, kind, result.url, result.html)) return result.url;
  }
  return null;
}

// ── search & bulk matching ──────────────────────────────────────────────────────

const normalize = (s: string) => normalizeEntityName(s).replace(/[^a-z0-9 ]/g, '').trim();

const haystack = (v: DirectoryVendor) => [v.name, v.slug, v.domain, ...(v.aliases ?? [])].map(normalize);

/** Typeahead: exact, then prefix, then substring. Stable and good enough for 60 rows. */
export function searchDirectory(query: string, limit = 8): DirectoryVendor[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { vendor: DirectoryVendor; score: number }[] = [];
  for (const vendor of DIRECTORY) {
    const fields = haystack(vendor);
    let score = 0;
    if (fields.includes(q)) score = 3;
    else if (fields.some((f) => f.startsWith(q))) score = 2;
    else if (fields.some((f) => f.includes(q))) score = 1;
    if (score) scored.push({ vendor, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.vendor.name.localeCompare(b.vendor.name))
    .slice(0, limit)
    .map((s) => s.vendor);
}

/** Fragments that are only a corporate suffix, left over from splitting "Acme, Inc." */
const SUFFIX_ONLY = /^(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|bv|sa|sas|ag|plc|pty|oy|ab|kk|pte)\.?$/i;

/**
 * Turns a pasted vendor list into watches.
 *
 * Splitting on commas as well as newlines is what makes "paste your vendor list" work
 * against a spreadsheet column — but it also shreds "Snowflake, Inc." into two
 * fragments, so suffix-only pieces are dropped rather than reported as unmatched
 * vendors the customer has to explain.
 */
export function matchVendorNames(input: string): { matched: DirectoryVendor[]; unmatched: string[] } {
  const fragments = input
    .split(/[\n\r,;]+/)
    .map((s) => s.trim())
    .filter((s) => s && !SUFFIX_ONLY.test(s));

  const matched: DirectoryVendor[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  for (const fragment of fragments) {
    const [best] = searchDirectory(fragment, 1);
    // Only an exact or prefix match auto-adds. A loose substring hit ("data" →
    // Databricks) silently monitoring the wrong vendor is worse than asking.
    const q = normalize(fragment);
    const confident = best && haystack(best).some((f) => f === q || f.startsWith(q));
    if (confident && !seen.has(best.slug)) {
      seen.add(best.slug);
      matched.push(best);
    } else if (!confident) {
      unmatched.push(fragment);
    }
  }
  return { matched, unmatched };
}

/**
 * Why a vendor is not being monitored.
 *
 * These are deliberately distinguishable rather than collapsed into "unsupported":
 * a customer can act on three of the four, and which one it is changes what they
 * should do — chase the vendor, ask us to work around a bot wall, or accept that the
 * page cannot be diffed.
 */
export type GapReason =
  | 'no_public_page'        // nothing found at any path, in their sitemap, or on their legal hub
  | 'blocked'               // their site rejects automated requests
  | 'not_machine_readable'  // a page exists but renders client-side, so it cannot be diffed
  | 'stopped_answering';    // we were monitoring it and it broke

export interface DirectoryGap {
  vendor: DirectoryVendor;
  reason: GapReason;
  checkedAt?: string;
}

/** Maps the seeder's diagnosis strings onto the reasons shown publicly. */
export function gapReasonFor(diagnosis: string): GapReason {
  if (/blocked|timed out/i.test(diagnosis)) return 'blocked';
  if (/none proved/i.test(diagnosis)) return 'not_machine_readable';
  return 'no_public_page';
}

export const CATEGORIES = [...new Set(DIRECTORY.map((v) => v.category))].sort();
