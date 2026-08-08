/**
 * Fetching, retry, and relocation discovery.
 *
 * The interesting problem here isn't HTTP, it's telling the four failure modes apart.
 * "Blocked by a bot wall", "page moved", "vendor's server is briefly down", and
 * "the page is genuinely unchanged" demand completely different responses, and a
 * fetcher that lumps them into `catch (e)` produces a watch that either cries wolf
 * or goes quietly blind.
 */

export type FetchOutcome = 'ok' | 'blocked' | 'not_found' | 'timeout' | 'error';

export interface FetchResult {
  outcome: FetchOutcome;
  status?: number;
  html?: string;
  /** After redirects. A permanent redirect is the polite version of relocation. */
  url: string;
  attempts: number;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Rotated on a block, not on every request. Presenting as a plain crawler first is
 * both honest and usually sufficient; the browser strings are a fallback for walls
 * that reject anything without them.
 */
const USER_AGENTS = [
  'DeltaLogBot/1.0 (+https://deltalog.app/bot; compliance monitoring)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

/** Body markers for interstitials that return 200 while showing nothing of substance. */
const CHALLENGE = /(cf-browser-verification|Just a moment\.\.\.|Attention Required!|Checking your browser|Enable JavaScript and cookies to continue)/i;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function classify(status: number, body: string): FetchOutcome {
  if (status === 404 || status === 410) return 'not_found';
  if (status === 403 || status === 429 || status === 451) return 'blocked';
  if (status >= 500) return 'error';
  if (status >= 400) return 'error';
  // A 200 that is really a challenge page is the nastiest case: left unclassified it
  // would be stored as the vendor's new content, wiping the real page from the log.
  return CHALLENGE.test(body.slice(0, 4000)) ? 'blocked' : 'ok';
}

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { fetchImpl = fetch, timeoutMs = 6000, maxAttempts = 3, sleep = defaultSleep } = opts;
  let last: FetchResult = { outcome: 'error', url, attempts: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENTS[Math.min(attempt - 1, USER_AGENTS.length - 1)],
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const html = await response.text();
      const outcome = classify(response.status, html);
      last = { outcome, status: response.status, html, url: response.url || url, attempts: attempt };
    } catch (err) {
      const timedOut = err instanceof Error && /timeout|abort/i.test(err.name + err.message);
      last = { outcome: timedOut ? 'timeout' : 'error', url, attempts: attempt };
    }

    // Retrying a 404 just asks the same question again — the page is gone, and the
    // answer is relocation, not persistence.
    if (last.outcome === 'ok' || last.outcome === 'not_found') return last;
    if (attempt < maxAttempts) await sleep(250 * 3 ** (attempt - 1));
  }
  return last;
}

// ── relocation ──────────────────────────────────────────────────────────────────

const ANCHOR = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SUBPROCESSOR_LINK = /sub-?processor/i;
const SECONDARY_LINK = /\bdpa\b|data processing|trust cent|privacy/i;

/**
 * Looks for the page's new home after a 404, by scanning the vendor's legal hub for a
 * link that names what we were watching.
 *
 * Returns a candidate ONLY when the answer is unambiguous. Silently re-pointing a
 * watch at the wrong page is worse than leaving it broken: the watch keeps reporting
 * green while monitoring something the customer never asked about, and the evidence
 * log records checks against a URL nobody chose. Ambiguity escalates to a human.
 */
export async function discoverRelocation(originalUrl: string, opts: FetchOptions = {}): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(originalUrl).origin;
  } catch {
    return null;
  }

  for (const path of ['/legal', '/trust', '/privacy', '/']) {
    const page = await fetchPage(`${origin}${path}`, { ...opts, maxAttempts: 1 });
    if (page.outcome !== 'ok' || !page.html) continue;

    for (const pattern of [SUBPROCESSOR_LINK, SECONDARY_LINK]) {
      const hits = new Set<string>();
      for (const m of page.html.matchAll(ANCHOR)) {
        const [, href, label] = m;
        if (!pattern.test(href) && !pattern.test(label)) continue;
        try {
          const resolved = new URL(href, `${origin}${path}`);
          if (resolved.origin !== origin) continue; // never follow a vendor offsite
          resolved.hash = '';
          hits.add(resolved.toString());
        } catch {
          /* unparseable href */
        }
      }
      if (hits.size === 1) return [...hits][0];
      if (hits.size > 1) return null; // ambiguous — a human decides
    }
  }
  return null;
}
