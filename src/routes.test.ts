import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueSession, sessionCookie, verifySession } from './auth.ts';
import type { Channels } from './channels.ts';
import type { PageSnapshot } from './materiality.ts';
import type { AlertRecord, Decision, QueueItem, ReviewStore } from './review.ts';
import { vendorBySlug } from './directory.ts';
import type { BillingState, BillingStore, Plan } from './billing.ts';
import { handleRequest, type AuthStore, type RouteDeps } from './routes.ts';

const APP = 'https://app.deltalog.test';
const SECRET = 'test-secret-value';
const NOW = new Date('2026-03-01T12:00:00.000Z');

// ── fakes ───────────────────────────────────────────────────────────────────────

function makeAlert(over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: 'alert-1',
    workspaceId: 'ws1',
    watchId: 'w1',
    vendor: 'Datadog',
    url: 'https://datadog.test/subprocessors',
    kind: 'subprocessor_list',
    severity: 'high',
    summary: 'Added 1 subprocessor: Snowflake Inc.',
    createdAt: '2026-02-28T06:00:00.000Z',
    ...over,
  };
}

const snapshot = (entities: { name: string; jurisdiction?: string }[], at: string): PageSnapshot => ({
  html: '',
  normalizedText: '',
  entities,
  clauses: [],
  fetchedAt: at,
});

class FakeReviewStore implements ReviewStore {
  alerts: AlertRecord[];
  decisions: { alertId: string; reviewer: string; decision: Decision; note: string }[] = [];

  constructor(alerts: AlertRecord[] = [makeAlert()]) {
    this.alerts = alerts;
  }
  async alert(alertId: string, workspaceId: string) {
    return this.alerts.find((a) => a.id === alertId && a.workspaceId === workspaceId) ?? null;
  }
  async queue(workspaceId: string): Promise<QueueItem[]> {
    return this.alerts.filter((a) => a.workspaceId === workspaceId);
  }
  async revisionsAround() {
    return {
      previous: snapshot([{ name: 'Cloudflare, Inc.', jurisdiction: 'US' }], '2026-02-27T06:00:00.000Z'),
      current: snapshot(
        [{ name: 'Cloudflare, Inc.', jurisdiction: 'US' }, { name: 'Snowflake Inc.', jurisdiction: 'US' }],
        '2026-02-28T06:00:00.000Z',
      ),
    };
  }
  async recordDecision(input: { alertId: string; decision: Decision; reviewer: string; note: string }) {
    const alert = this.alerts.find((a) => a.id === input.alertId);
    if (!alert || alert.decision) return 0;
    alert.decision = input.decision;
    alert.reviewedBy = input.reviewer;
    this.decisions.push(input);
    return 1;
  }
}

class FakeAuthStore implements AuthStore {
  links = new Map<string, { workspaceId: string; email: string; expiresAt: string; used: boolean }>();
  members = new Map([['jo@acme.test', 'ws1']]);

  async memberByEmail(email: string) {
    const workspaceId = this.members.get(email);
    return workspaceId ? { email, workspaceId } : null;
  }
  async saveMagicLink(input: { tokenHash: string; workspaceId: string; email: string; expiresAt: string }) {
    this.links.set(input.tokenHash, { ...input, used: false });
  }
  async consumeMagicLink(tokenHash: string, now: string) {
    const link = this.links.get(tokenHash);
    if (!link || link.used || link.expiresAt <= now) return null;
    link.used = true;
    return { workspaceId: link.workspaceId, email: link.email };
  }
  async workspaceName() {
    return 'Acme Corp';
  }
}

function makeDeps(over: Partial<RouteDeps> = {}) {
  const sentEmails: { to: string[]; text: string }[] = [];
  const channels: Channels = {
    async sendEmail(to, message) {
      sentEmails.push({ to, text: message.text });
      return { ok: true, retryable: false };
    },
    async sendSlack() {
      return { ok: true, retryable: false };
    },
  };
  const added: { workspaceId: string; slugs: string[] }[] = [];
  const billing: BillingState = { plan: 'team', vendorCount: 0, customerId: 'cus_1' };
  const billingStore: BillingStore = {
    workspaceBilling: async () => billing,
    workspaceIdByCustomer: async () => 'ws1',
    claimEvent: async () => true,
    lastBillingEventAt: async () => null,
    applyBilling: async (i) => { billing.plan = i.plan as Plan; },
    applyCheckInterval: async () => {},
  };
  const deps: RouteDeps = {
    billingStore,
    stripe: {
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
      prices: { team_monthly: 'price_tm', team_annual: 'price_ta', compliance_monthly: 'price_cm', compliance_annual: 'price_ca' },
      fetchImpl: async () => new Response(JSON.stringify({ url: 'https://checkout.stripe.test/c/pay/cs_1' }), { status: 200 }),
    },
    directoryStore: {
      gaps: async () => [
        { vendor: vendorBySlug('okta')!, reason: 'no_public_page' as const, checkedAt: '2026-03-01T00:00:00.000Z' },
        { vendor: vendorBySlug('gitlab')!, reason: 'blocked' as const },
        { vendor: vendorBySlug('zoom')!, reason: 'not_machine_readable' as const },
      ],
      entry: async (slug) => ({
        url: `https://${slug}.test/subprocessors`,
        lastCheckedAt: '2026-03-01T06:00:00.000Z',
        subprocessors: [{ name: 'Snowflake Inc.', purpose: 'Warehousing', jurisdiction: 'US' }],
        changes: [{ slug, vendorName: 'Datadog', at: '2026-03-01T06:00:00.000Z', summary: 'Added 1 subprocessor: OpenAI, L.L.C.' }],
      }),
      index: async () => [{ vendor: vendorBySlug('datadog')!, subprocessorCount: 12, lastCheckedAt: '2026-03-01T06:00:00.000Z' }],
      recentChanges: async () => [
        { slug: 'datadog', vendorName: 'Datadog', at: '2026-03-01T06:00:00.000Z', summary: 'Added 1 subprocessor: OpenAI, L.L.C.' },
      ],
    },
    onboardingStore: {
      addFromDirectory: async (workspaceId, slugs) => {
        added.push({ workspaceId, slugs });
        return slugs.length;
      },
    },
    reviewStore: new FakeReviewStore(),
    authStore: new FakeAuthStore(),
    evidenceStore: {
      workspace: async () => ({ id: 'ws1', name: 'Acme Corp', plan: 'team' }),
      workspaceByTokenHash: async () => null,
      checksInRange: async () => [],
      reviewedAlertsInRange: async () => [],
    },
    channels,
    sessionSecret: SECRET,
    fromAddress: 'alerts@deltalog.test',
    appBaseUrl: APP,
    now: () => NOW,
    ...over,
  };
  return { deps, sentEmails, added, billing };
}

async function signedIn(deps: RouteDeps, email = 'jo@acme.test', workspaceId = 'ws1') {
  return sessionCookie(await issueSession({ workspaceId, email }, deps.sessionSecret, NOW)).split(';')[0];
}

const get = (path: string, cookie?: string) =>
  new Request(`${APP}${path}`, { headers: cookie ? { cookie } : {} });

const post = (path: string, body: Record<string, string>, opts: { cookie?: string; origin?: string | null } = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.append(k, v);
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? APP;
  return new Request(`${APP}${path}`, { method: 'POST', body: form, headers });
};

// ── auth ────────────────────────────────────────────────────────────────────────

test('an unauthenticated visitor is sent to the login page', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/queue'), deps);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
});

test('an unknown email gets the same response as a known one', async () => {
  const { deps, sentEmails } = makeDeps();

  const known = await handleRequest(post('/login', { email: 'jo@acme.test' }), deps);
  const unknown = await handleRequest(post('/login', { email: 'stranger@elsewhere.test' }), deps);

  assert.equal(known.status, unknown.status);
  assert.equal(await known.text(), (await unknown.text()).replace('stranger@elsewhere.test', 'jo@acme.test'));
  assert.equal(sentEmails.length, 1, 'but only the real member is emailed');
});

test('a magic link signs the visitor in, once', async () => {
  const { deps, sentEmails } = makeDeps();
  await handleRequest(post('/login', { email: 'jo@acme.test' }), deps);
  const token = /token=([\w-]+)/.exec(sentEmails[0].text)![1];

  const first = await handleRequest(get(`/auth/verify?token=${token}`), deps);
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), '/queue');

  const cookie = first.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const session = await verifySession(cookie.split('=')[1].split(';')[0], SECRET, NOW);
  assert.equal(session?.email, 'jo@acme.test');

  const replay = await handleRequest(get(`/auth/verify?token=${token}`), deps);
  assert.match(await replay.text(), /expired or was already used/);
});

test('a session signed with the wrong secret is not a session', async () => {
  const { deps } = makeDeps();
  const forged = sessionCookie(await issueSession({ workspaceId: 'ws1', email: 'mallory@evil.test' }, 'other-secret', NOW)).split(';')[0];
  const response = await handleRequest(get('/queue', forged), deps);
  assert.equal(response.headers.get('location'), '/login');
});

// ── review ──────────────────────────────────────────────────────────────────────

test('the queue lists the workspace’s changes', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/queue', await signedIn(deps)), deps)).text();

  assert.match(body, /Acme Corp/);
  assert.match(body, /Added 1 subprocessor: Snowflake Inc\./);
  assert.match(body, /1 awaiting review/);
});

test('the detail page re-derives the diff rather than trusting the summary', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/alerts/alert-1', await signedIn(deps)), deps)).text();

  assert.match(body, /What changed/);
  assert.match(body, /Snowflake Inc\./);
  assert.match(body, /Added/);
  assert.doesNotMatch(body, /Cloudflare/, 'unchanged entities are not listed');
});

test('an alert from another workspace is indistinguishable from one that does not exist', async () => {
  const { deps } = makeDeps({ reviewStore: new FakeReviewStore([makeAlert({ workspaceId: 'ws-other' })]) });
  const response = await handleRequest(get('/alerts/alert-1', await signedIn(deps)), deps);

  assert.equal(response.status, 404);
  assert.match(await response.text(), /does not exist/);
});

test('the reviewer is taken from the session, not the form', async () => {
  const store = new FakeReviewStore();
  const { deps } = makeDeps({ reviewStore: store });
  const cookie = await signedIn(deps, 'jo@acme.test');

  const response = await handleRequest(
    post('/alerts/alert-1/review', { decision: 'accepted', note: 'Covered by DPA.', reviewed_by: 'ceo@acme.test' }, { cookie }),
    deps,
  );

  assert.equal(response.status, 302);
  assert.deepEqual(store.decisions, [
    { alertId: 'alert-1', workspaceId: 'ws1', decision: 'accepted', reviewer: 'jo@acme.test', note: 'Covered by DPA.', at: NOW.toISOString() },
  ]);
});

test('a cross-site form post is rejected', async () => {
  const { deps } = makeDeps();
  const cookie = await signedIn(deps);
  const response = await handleRequest(
    post('/alerts/alert-1/review', { decision: 'accepted' }, { cookie, origin: 'https://evil.test' }),
    deps,
  );
  assert.equal(response.status, 403);
});

test('a post with no Origin header is rejected', async () => {
  const { deps } = makeDeps();
  const cookie = await signedIn(deps);
  const response = await handleRequest(post('/alerts/alert-1/review', { decision: 'accepted' }, { cookie, origin: null }), deps);
  assert.equal(response.status, 403);
});

test('a second decision on the same change is refused', async () => {
  const { deps } = makeDeps({ reviewStore: new FakeReviewStore([makeAlert({ decision: 'accepted', reviewedBy: 'sam@acme.test' })]) });
  const response = await handleRequest(post('/alerts/alert-1/review', { decision: 'escalated' }, { cookie: await signedIn(deps) }), deps);

  assert.equal(response.status, 409);
  assert.match(await response.text(), /Decisions are final/);
});

test('a recorded decision is shown instead of the form', async () => {
  const { deps } = makeDeps({
    reviewStore: new FakeReviewStore([
      makeAlert({ decision: 'escalated', reviewedBy: 'sam@acme.test', reviewedAt: '2026-03-01T09:00:00.000Z', note: 'Conflicts with our commitments.' }),
    ]),
  });
  const body = await (await handleRequest(get('/alerts/alert-1', await signedIn(deps)), deps)).text();

  assert.match(body, /Escalated<\/strong> by\s*sam@acme\.test/);
  assert.match(body, /Conflicts with our commitments\./);
  assert.doesNotMatch(body, /<button/, 'no way to overwrite the record');
});

test('scraped vendor text cannot inject markup into the page', async () => {
  const { deps } = makeDeps({
    reviewStore: new FakeReviewStore([makeAlert({ vendor: '<script>alert(1)</script>', summary: 'Added <img src=x onerror=alert(1)>' })]),
  });
  const body = await (await handleRequest(get('/alerts/alert-1', await signedIn(deps)), deps)).text();

  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ── export, now reachable from the UI session ───────────────────────────────────

test('the export accepts a session cookie, not just an API token', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/export?from=2026-01-01&to=2026-01-31&format=csv', await signedIn(deps)), deps);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/csv/);
});

test('the export is gated behind a paid plan', async () => {
  const { deps } = makeDeps({
    evidenceStore: {
      workspace: async () => ({ id: 'ws1', name: 'Acme Corp', plan: 'free' }),
      workspaceByTokenHash: async () => null,
      checksInRange: async () => [],
      reviewedAlertsInRange: async () => [],
    },
  });
  const response = await handleRequest(get('/export?from=2026-01-01&to=2026-01-31', await signedIn(deps)), deps);

  assert.equal(response.status, 402);
  assert.match(JSON.stringify(await response.json()), /Team and Compliance plans/);
});

// ── public directory ────────────────────────────────────────────────────────────

test('directory pages are public — no session, no redirect', async () => {
  const { deps } = makeDeps();
  for (const path of ['/', '/directory', '/directory/datadog', '/feed.xml', '/feed.json', '/sitemap.xml', '/robots.txt']) {
    const response = await handleRequest(get(path), deps);
    assert.equal(response.status, 200, `${path} should be public`);
  }
});

test('public pages are cacheable; authenticated ones are never cached', async () => {
  const { deps } = makeDeps();
  const publicPage = await handleRequest(get('/directory/datadog'), deps);
  assert.match(publicPage.headers.get('cache-control')!, /public, max-age=300, s-maxage=3600/);

  const exportPage = await handleRequest(get('/export?from=2026-01-01&to=2026-01-31&format=csv', await signedIn(deps)), deps);
  assert.equal(exportPage.headers.get('cache-control'), 'no-store');
});

test('an unknown vendor slug is a 404, not an empty page', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/directory/not-a-real-vendor'), deps);
  assert.equal(response.status, 404);
});

test('robots.txt opens the directory and closes the app', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/robots.txt'), deps)).text();
  assert.match(body, /Allow: \/directory/);
  assert.match(body, /Disallow: \/alerts/);
  assert.match(body, /Sitemap: https:\/\/app\.deltalog\.test\/sitemap\.xml/);
});

test('the feed is served as RSS', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/feed.xml'), deps);
  assert.match(response.headers.get('content-type')!, /application\/rss\+xml/);
  assert.match(await response.text(), /<item>/);
});

// ── onboarding ──────────────────────────────────────────────────────────────────

test('a pasted vendor list becomes watches and lands on the queue', async () => {
  const { deps, added } = makeDeps();
  const response = await handleRequest(
    post('/onboarding', { vendors: 'Datadog\nStripe, Inc.\nOkta' }, { cookie: await signedIn(deps) }),
    deps,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/queue');
  assert.deepEqual(added, [{ workspaceId: 'ws1', slugs: ['datadog', 'stripe', 'okta'] }]);
});

test('names we could not match are shown rather than silently dropped', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(
    post('/onboarding', { vendors: 'Datadog\nSome Internal Tool' }, { cookie: await signedIn(deps) }),
    deps,
  );

  const body = await response.text();
  assert.match(body, /1 vendor added/);
  assert.match(body, /Some Internal Tool/);
  assert.match(body, /add these by URL/);
});

test('onboarding is not a way around the same-origin check', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(
    post('/onboarding', { vendors: 'Datadog' }, { cookie: await signedIn(deps), origin: 'https://evil.test' }),
    deps,
  );
  assert.equal(response.status, 403);
});

// ── landing page ────────────────────────────────────────────────────────────────

test('the landing page owns "/" and needs no session', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/'), deps);

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Your vendors change their subprocessors\. Nobody tells you\./);
  assert.match(body, /Watch 3 vendors free/);
  assert.match(body, /<link rel="canonical" href="https:\/\/app\.deltalog\.test\/">/);
});

test('the landing page ships no scripts and fetches nothing external', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/'), deps)).text();

  assert.doesNotMatch(body, /<script/i);
  assert.doesNotMatch(body, /https?:\/\/(?!app\.deltalog\.test)/, 'no third-party fonts, CDNs, or trackers');
});

test('the landing page makes no claims we cannot back', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/'), deps)).text();

  // Guards against reintroducing the placeholder social proof from the design doc
  // ("Trusted by security teams at 200+ SaaS companies"), which is not true yet.
  // Phrases only — the page legitimately mentions "rotating testimonials" as an
  // example of page noise we filter out.
  assert.doesNotMatch(body, /trusted by|loved by|as seen in|join \d|(companies|teams|customers) (use|trust|love)/i);
  assert.doesNotMatch(body, /\d+\+?\s+(companies|teams|customers)/i);
});

test('the landing page routes into both halves of the growth loop', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/'), deps)).text();

  assert.match(body, /href="\/directory"/, 'cross-links the SEO directory');
  assert.match(body, /href="\/login"/);
});

// ── billing ─────────────────────────────────────────────────────────────────────

const postRaw = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, { method: 'POST', body, headers });

test('the billing page reports state and hands changes to Stripe', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/billing', await signedIn(deps)), deps)).text();

  assert.match(body, /25 vendors/, 'shows the plan limit');
  assert.match(body, /Manage billing at Stripe/);
  assert.doesNotMatch(body, /card number|cancel my plan/i, 'no billing UI of our own');
});

test('checkout redirects to Stripe and never accepts a raw price', async () => {
  const { deps } = makeDeps();
  const cookie = await signedIn(deps);

  const ok = await handleRequest(post('/billing/checkout', { plan: 'compliance', cadence: 'annual' }, { cookie }), deps);
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location')!, /checkout\.stripe\.test/);

  const forged = await handleRequest(post('/billing/checkout', { plan: 'price_free_internal', cadence: 'monthly' }, { cookie }), deps);
  assert.equal(forged.status, 400);
});

test('checkout and portal are not reachable cross-site', async () => {
  const { deps } = makeDeps();
  const cookie = await signedIn(deps);
  for (const path of ['/billing/checkout', '/billing/portal']) {
    const response = await handleRequest(post(path, { plan: 'team' }, { cookie, origin: 'https://evil.test' }), deps);
    assert.equal(response.status, 403, path);
  }
});

test('the webhook refuses anything it cannot verify', async () => {
  const { deps, billing } = makeDeps();
  const payload = JSON.stringify({
    id: 'evt_forged', type: 'customer.subscription.updated', created: 1_772_000_000,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { workspace_id: 'ws1' },
      items: { data: [{ price: { id: 'price_cm' } }] } } },
  });

  const unsigned = await handleRequest(postRaw('/stripe/webhook', payload), deps);
  assert.equal(unsigned.status, 400);

  const badSig = await handleRequest(postRaw('/stripe/webhook', payload, { 'stripe-signature': 't=1,v1=deadbeef' }), deps);
  assert.equal(badSig.status, 400);
  assert.equal(billing.plan, 'team', 'an unverified request never changes a plan');
});

test('a verified webhook applies the plan', async () => {
  const { deps, billing } = makeDeps();
  const created = Math.floor(NOW.getTime() / 1000);
  const payload = JSON.stringify({
    id: 'evt_real', type: 'customer.subscription.updated', created,
    data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { workspace_id: 'ws1' },
      items: { data: [{ price: { id: 'price_cm' } }] } } },
  });

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${created}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const response = await handleRequest(postRaw('/stripe/webhook', payload, { 'stripe-signature': `t=${created},v1=${hex}` }), deps);
  assert.equal(response.status, 200);
  assert.equal(billing.plan, 'compliance');
});

test('the webhook needs no session and no same-origin header', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(postRaw('/stripe/webhook', '{}'), deps);
  assert.equal(response.status, 400, 'rejected on signature, not on auth');
  assert.doesNotMatch(await response.text(), /did not come from/);
});

// ── plan limits ─────────────────────────────────────────────────────────────────

test('a paste beyond the plan limit adds what fits and names the rest', async () => {
  const { deps, added, billing } = makeDeps();
  billing.plan = 'free';
  billing.vendorCount = 1; // 2 of 3 slots left

  const response = await handleRequest(
    post('/onboarding', { vendors: 'Datadog\nStripe\nOkta\nSnowflake' }, { cookie: await signedIn(deps) }),
    deps,
  );

  assert.deepEqual(added, [{ workspaceId: 'ws1', slugs: ['datadog', 'stripe'] }]);
  const body = await response.text();
  assert.match(body, /free plan covers 3 vendors/);
  assert.match(body, /Okta, Snowflake/);
  assert.match(body, /href="\/billing"/);
});

test('a workspace already at its limit adds nothing', async () => {
  const { deps, added, billing } = makeDeps();
  billing.plan = 'free';
  billing.vendorCount = 3;

  await handleRequest(post('/onboarding', { vendors: 'Datadog' }, { cookie: await signedIn(deps) }), deps);
  assert.deepEqual(added, []);
});

// ── the gap page ────────────────────────────────────────────────────────────────

test('the unmonitored page is public and groups vendors by reason', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/directory/unmonitored'), deps);

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Vendors we can’t monitor, and why/);
  assert.match(body, /blocks automated checks/);
  assert.match(body, /GitLab/);
  assert.match(body, /not machine-readable/i);
  assert.match(body, /Zoom/);
  assert.match(body, /No public list we could find/);
  assert.match(body, /Okta/);
});

test('the gap page states real counts rather than a round number', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/directory/unmonitored'), deps)).text();
  // 1 monitored vendor in the fake index, 3 gaps → 4 total.
  assert.match(body, /watch <strong>1<\/strong> of the 4 vendors/);
});

test('"unmonitored" is a page, not a vendor slug', async () => {
  const { deps } = makeDeps();
  const response = await handleRequest(get('/directory/unmonitored'), deps);
  assert.equal(response.status, 200, 'must not fall through to the :slug route and 404');
  assert.match(response.headers.get('cache-control')!, /s-maxage/);
});

test('every gap group tells the reader what to do about it', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/directory/unmonitored'), deps)).text();
  assert.match(body, /Ask the vendor directly/);
  assert.match(body, /Tell us which vendor you need/);
});

test('the sitemap includes the gap page', async () => {
  const { deps } = makeDeps();
  const xml = await (await handleRequest(get('/sitemap.xml'), deps)).text();
  assert.match(xml, /<loc>https:\/\/app\.deltalog\.test\/directory\/unmonitored<\/loc>/);
});

test('public pages claim only what this directory can show', async () => {
  const { deps } = makeDeps();
  const body = await (await handleRequest(get('/directory/unmonitored'), deps)).text();

  // The counts on this page come from a real crawl. Statements about vendors in
  // general do not, so they do not belong in shipped copy.
  assert.doesNotMatch(body, /roughly half|most (vendors|companies)|industry[- ]wide|majority of/i);
  assert.match(body, /structural/, 'the honest version of the point survives');
});
