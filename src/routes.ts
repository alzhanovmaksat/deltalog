/**
 * HTTP routing for the app.
 *
 * Deps are injected so every route can be tested without D1, a network, or a clock —
 * `worker.ts` is then a five-line adapter from Cloudflare bindings to this function.
 */

import {
  clearedSessionCookie,
  createMagicLink,
  hashMagicToken,
  issueSession,
  readCookie,
  requireSameOrigin,
  sessionCookie,
  verifySession,
  type Session,
} from './auth.ts';
import type { Channels } from './channels.ts';
import {
  createCheckoutSession,
  createPortalSession,
  handleStripeEvent,
  priceFor,
  verifyStripeSignature,
  PLAN_LIMITS,
  type BillingStore,
  type StripeConfig,
  type StripeEvent,
} from './billing.ts';
import { DIRECTORY, matchVendorNames, vendorBySlug, type DirectoryVendor } from './directory.ts';
import {
  directoryIndexPage,
  unmonitoredPage,
  feedJson,
  feedXml,
  sitemapXml,
  vendorPage,
  type DirectoryChange,
  type DirectoryIndexRow,
} from './directory-ui.ts';
import { buildEvidenceReport, type EvidenceStore } from './evidence.ts';
import { exportResponse } from './export.ts';
import { landingPage } from './landing.ts';
import { buildReviewView, recordDecision, sortQueue, type Decision, type ReviewStore } from './review.ts';
import { sha256Hex } from './snapshot.ts';
import { alertPage, billingPage, html, loginPage, messagePage, onboardingPage, queuePage } from './ui.ts';

export interface AuthStore {
  memberByEmail(email: string): Promise<{ workspaceId: string; email: string } | null>;
  saveMagicLink(input: { tokenHash: string; workspaceId: string; email: string; expiresAt: string }): Promise<void>;
  /** Single use: must mark the token consumed atomically and return null if already used. */
  consumeMagicLink(tokenHash: string, now: string): Promise<{ workspaceId: string; email: string } | null>;
  workspaceName(workspaceId: string): Promise<string>;
}

/**
 * Reads only the system-owned directory workspace. Note there is no workspace
 * parameter anywhere in this interface — a public page has no way to ask for a
 * customer's watches even by accident, which is a stronger guarantee than remembering
 * to filter.
 */
export interface DirectoryStore {
  /** Vendors we are not monitoring, with the reason. Powers /directory/unmonitored. */
  gaps(): Promise<import('./directory.ts').DirectoryGap[]>;
  entry(slug: string): Promise<{
    url?: string;
    lastCheckedAt?: string;
    subprocessors: import('./entities.ts').Entity[];
    changes: DirectoryChange[];
  } | null>;
  index(): Promise<DirectoryIndexRow[]>;
  recentChanges(limit: number): Promise<DirectoryChange[]>;
}

export interface OnboardingStore {
  /** Copies directory-resolved URLs, so a new watch starts on a page we know answers. */
  addFromDirectory(workspaceId: string, slugs: string[]): Promise<number>;
}

export interface RouteDeps {
  reviewStore: ReviewStore;
  authStore: AuthStore;
  evidenceStore: EvidenceStore & {
    workspaceByTokenHash(hash: string): Promise<{ id: string; name: string; plan: string } | null>;
  };
  directoryStore: DirectoryStore;
  onboardingStore: OnboardingStore;
  billingStore: BillingStore;
  stripe: StripeConfig;
  channels: Channels;
  sessionSecret: string;
  fromAddress: string;
  appBaseUrl: string;
  now(): Date;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const QUEUE_LIMIT = 200;

const redirect = (location: string, cookie?: string) =>
  new Response(null, {
    status: 302,
    headers: cookie ? { location, 'set-cookie': cookie } : { location },
  });

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleRequest(request: Request, deps: RouteDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/login' && method === 'GET') return html(loginPage());
  if (path === '/login' && method === 'POST') return startLogin(request, deps);
  if (path === '/auth/verify' && method === 'GET') return finishLogin(url, deps);
  if (path === '/logout' && method === 'POST') return redirect('/login', clearedSessionCookie);
  if (path === '/export' && method === 'GET') return handleExport(request, url, deps);
  // Server-to-server, so no session and no same-origin check — the Stripe signature is
  // the authentication, and it is stronger than either.
  if (path === '/stripe/webhook' && method === 'POST') return handleWebhook(request, deps);

  // ── public, anonymous, cacheable ──
  // The marketing page owns "/" and the app lives at "/queue". Serving both from one
  // path would make the highest-traffic page on the site vary by cookie, which is
  // exactly the thing an edge cache cannot help with.
  if (path === '/' && method === 'GET') return cached(landingPage(deps.appBaseUrl), 'text/html; charset=utf-8');
  if (path === '/directory' && method === 'GET') return renderDirectoryIndex(deps);
  if (path === '/feed.xml' && method === 'GET') return renderFeed(deps, 'xml');
  if (path === '/feed.json' && method === 'GET') return renderFeed(deps, 'json');
  if (path === '/sitemap.xml' && method === 'GET') {
    return cached(sitemapXml(['unmonitored', ...DIRECTORY.map((v) => v.slug)], deps.appBaseUrl), 'application/xml; charset=utf-8');
  }
  if (path === '/robots.txt' && method === 'GET') {
    return cached(`User-agent: *\nAllow: /\nAllow: /directory\nDisallow: /alerts\nDisallow: /export\nSitemap: ${deps.appBaseUrl}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  }
  // Before the :slug pattern below, which would otherwise swallow "unmonitored" and
  // hand it to vendorBySlug as a 404.
  if (path === '/directory/unmonitored' && method === 'GET') return renderUnmonitored(deps);
  const vendorMatch = /^\/directory\/([a-z0-9-]{1,64})$/.exec(path);
  if (vendorMatch && method === 'GET') return renderVendorPage(vendorMatch[1], deps);

  const session = await verifySession(readCookie(request.headers.get('cookie'), 'dl_session'), deps.sessionSecret, deps.now());
  if (!session) return redirect('/login');

  if (path === '/queue' && method === 'GET') return renderQueue(session, deps);

  if (path === '/billing' && method === 'GET') return renderBilling(request, session, deps);
  if (path === '/billing/checkout' && method === 'POST') return startCheckout(request, session, deps);
  if (path === '/billing/portal' && method === 'POST') return openPortal(request, session, deps);

  if (path === '/onboarding' && method === 'GET') return html(onboardingPage());
  if (path === '/onboarding' && method === 'POST') return submitOnboarding(request, session, deps);

  const alertMatch = /^\/alerts\/([\w-]{1,64})$/.exec(path);
  if (alertMatch && method === 'GET') return renderAlert(alertMatch[1], session, deps);

  const reviewMatch = /^\/alerts\/([\w-]{1,64})\/review$/.exec(path);
  if (reviewMatch && method === 'POST') return submitReview(request, reviewMatch[1], session, deps);

  return messagePage('Not found', 'That page does not exist.', 404);
}

// ── auth ────────────────────────────────────────────────────────────────────────

async function startLogin(request: Request, deps: RouteDeps): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();

  const member = email ? await deps.authStore.memberByEmail(email) : null;
  if (member) {
    const link = await createMagicLink(deps.now());
    await deps.authStore.saveMagicLink({
      tokenHash: link.tokenHash,
      workspaceId: member.workspaceId,
      email: member.email,
      expiresAt: link.expiresAt,
    });
    const url = `${deps.appBaseUrl}/auth/verify?token=${link.token}`;
    await deps.channels.sendEmail([member.email], {
      subject: 'Your DeltaLog sign-in link',
      text: `Sign in: ${url}\n\nThis link works once and expires in 15 minutes.`,
      html: `<p><a href="${url}">Sign in to DeltaLog</a></p><p>This link works once and expires in 15 minutes.</p>`,
      slack: '',
    });
  }

  // The same page renders whether or not that address exists. Telling a stranger
  // "no such account" turns the login form into a directory of who uses the product,
  // which for a compliance tool is itself a disclosure.
  return html(loginPage(email || 'that address'));
}

async function finishLogin(url: URL, deps: RouteDeps): Promise<Response> {
  const token = url.searchParams.get('token');
  if (!token) return html(loginPage(undefined, 'That sign-in link is not valid.'), 400);

  const claim = await deps.authStore.consumeMagicLink(await hashMagicToken(token), deps.now().toISOString());
  if (!claim) return html(loginPage(undefined, 'That link has expired or was already used. Request a new one.'), 400);

  const cookie = await issueSession({ workspaceId: claim.workspaceId, email: claim.email }, deps.sessionSecret, deps.now());
  return redirect('/queue', sessionCookie(cookie, deps.appBaseUrl.startsWith('https')));
}

// ── review ──────────────────────────────────────────────────────────────────────

async function renderQueue(session: Session, deps: RouteDeps): Promise<Response> {
  const [items, name] = await Promise.all([
    deps.reviewStore.queue(session.workspaceId, QUEUE_LIMIT),
    deps.authStore.workspaceName(session.workspaceId),
  ]);
  return html(queuePage(sortQueue(items), name));
}

async function renderAlert(alertId: string, session: Session, deps: RouteDeps): Promise<Response> {
  // Every lookup is scoped by the session's workspace. An id from another tenant must
  // be indistinguishable from an id that does not exist — anything else confirms the
  // record is real to someone who should not know that.
  const alert = await deps.reviewStore.alert(alertId, session.workspaceId);
  if (!alert) return messagePage('Not found', 'That change does not exist, or is not part of your workspace.', 404);
  return html(alertPage(await buildReviewView(deps.reviewStore, alert)));
}

async function submitReview(request: Request, alertId: string, session: Session, deps: RouteDeps): Promise<Response> {
  if (!requireSameOrigin(request, deps.appBaseUrl)) {
    return messagePage('Rejected', 'This request did not come from the DeltaLog app.', 403);
  }

  const form = await request.formData();
  const decision = String(form.get('decision') ?? '');
  if (decision !== 'accepted' && decision !== 'escalated') {
    return messagePage('Rejected', 'Choose whether to accept or escalate this change.', 400);
  }

  const outcome = await recordDecision(deps.reviewStore, {
    alertId,
    workspaceId: session.workspaceId,
    decision: decision as Decision,
    // From the session. A `reviewed_by` form field would let anyone write a
    // colleague's name onto an audit record.
    reviewer: session.email,
    note: String(form.get('note') ?? ''),
    at: deps.now().toISOString(),
  });

  if (outcome === 'not_found') return messagePage('Not found', 'That change does not exist in your workspace.', 404);
  if (outcome === 'already_reviewed') {
    return messagePage('Already reviewed', 'Someone recorded a decision on this change first. Decisions are final.', 409);
  }
  return redirect(`/alerts/${alertId}`);
}

// ── export ──────────────────────────────────────────────────────────────────────

/**
 * Accepts either an API token (scripts, Compliance plan) or a signed session cookie
 * (the "Export evidence" button in the UI).
 */
async function handleExport(request: Request, url: URL, deps: RouteDeps): Promise<Response> {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  let workspace: { id: string; name: string; plan: string } | null = null;

  if (token) {
    workspace = await deps.evidenceStore.workspaceByTokenHash(await sha256Hex(token));
  } else {
    const session = await verifySession(readCookie(request.headers.get('cookie'), 'dl_session'), deps.sessionSecret, deps.now());
    if (session) workspace = await deps.evidenceStore.workspace(session.workspaceId);
  }
  if (!workspace) return json({ error: 'authentication required' }, 401);

  if (workspace.plan === 'free') {
    return json(
      { error: 'Evidence export is available on Team and Compliance plans.', upgrade: `${deps.appBaseUrl}/billing` },
      402,
    );
  }

  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'pdf';
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    return json({ error: 'from and to must be ISO dates, with from <= to' }, 400);
  }

  const report = await buildEvidenceReport(deps.evidenceStore, { workspaceId: workspace.id, from, to });
  return exportResponse(report, format);
}

// ── directory ───────────────────────────────────────────────────────────────────

/**
 * Public pages are cached at the edge for an hour. They change at most once a day —
 * when the crawler finds something — and serving them from cache is what keeps a
 * traffic spike from a well-ranked page off the Workers request budget.
 */
function cached(body: string, contentType: string): Response {
  return new Response(body, {
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=300, s-maxage=3600' },
  });
}

async function renderDirectoryIndex(deps: RouteDeps): Promise<Response> {
  return cached(directoryIndexPage(await deps.directoryStore.index(), deps.appBaseUrl), 'text/html; charset=utf-8');
}

async function renderVendorPage(slug: string, deps: RouteDeps): Promise<Response> {
  const vendor = vendorBySlug(slug);
  if (!vendor) return messagePage('Not found', 'We do not track that vendor yet.', 404);

  const live = await deps.directoryStore.entry(slug);
  return cached(
    vendorPage({ vendor, subprocessors: [], changes: [], ...(live ?? {}) }, deps.appBaseUrl),
    'text/html; charset=utf-8',
  );
}

async function renderUnmonitored(deps: RouteDeps): Promise<Response> {
  const [gaps, index] = await Promise.all([deps.directoryStore.gaps(), deps.directoryStore.index()]);
  return cached(unmonitoredPage(gaps, index.length, deps.appBaseUrl), 'text/html; charset=utf-8');
}

async function renderFeed(deps: RouteDeps, format: 'xml' | 'json'): Promise<Response> {
  const changes = await deps.directoryStore.recentChanges(50);
  return format === 'xml'
    ? cached(feedXml(changes, deps.appBaseUrl), 'application/rss+xml; charset=utf-8')
    : cached(feedJson(changes, deps.appBaseUrl), 'application/feed+json; charset=utf-8');
}

// ── onboarding ──────────────────────────────────────────────────────────────────

async function submitOnboarding(request: Request, session: Session, deps: RouteDeps): Promise<Response> {
  if (!requireSameOrigin(request, deps.appBaseUrl)) {
    return messagePage('Rejected', 'This request did not come from the DeltaLog app.', 403);
  }
  const form = await request.formData();
  const { matched, unmatched } = matchVendorNames(String(form.get('vendors') ?? ''));

  if (!matched.length) return html(onboardingPage([], unmatched), 400);

  // The plan's vendor cap is enforced here rather than at the pricing page, because
  // this is the only place a workspace can exceed it. Over-cap names are trimmed and
  // reported instead of rejecting the whole paste — the customer keeps what fits and
  // meets the paywall at the moment the product is proving useful.
  const billing = await deps.billingStore.workspaceBilling(session.workspaceId);
  const limit = PLAN_LIMITS[billing?.plan ?? 'free'].vendors;
  const room = Math.max(0, limit - (billing?.vendorCount ?? 0));
  const overflow = matched.slice(room).map((v: DirectoryVendor) => v.name);
  const fitting = matched.slice(0, room);

  const added = fitting.length
    ? await deps.onboardingStore.addFromDirectory(
        session.workspaceId,
        fitting.map((v: DirectoryVendor) => v.slug),
      )
    : 0;

  if (overflow.length) {
    return html(onboardingPage(fitting, unmatched, added, { limit, plan: billing?.plan ?? 'free', overflow }));
  }
  // Unmatched names are shown rather than silently dropped — a customer who pasted
  // twelve vendors and got nine watches needs to know which three to add by URL.
  return unmatched.length ? html(onboardingPage(matched, unmatched, added)) : redirect('/queue');
}

// ── billing ─────────────────────────────────────────────────────────────────────

async function renderBilling(request: Request, session: Session, deps: RouteDeps): Promise<Response> {
  const billing = await deps.billingStore.workspaceBilling(session.workspaceId);
  if (!billing) return messagePage('Not found', 'That workspace does not exist.', 404);
  const checkoutJustCompleted = new URL(request.url).searchParams.get('checkout') === 'complete';
  return html(billingPage(billing, checkoutJustCompleted));
}

async function startCheckout(request: Request, session: Session, deps: RouteDeps): Promise<Response> {
  if (!requireSameOrigin(request, deps.appBaseUrl)) {
    return messagePage('Rejected', 'This request did not come from the DeltaLog app.', 403);
  }
  const form = await request.formData();
  // The form names a plan and a cadence. It never names a price.
  const price = priceFor(deps.stripe, String(form.get('plan') ?? ''), String(form.get('cadence') ?? 'monthly'));
  if (!price) return messagePage('Rejected', 'Choose a plan to continue.', 400);

  const billing = await deps.billingStore.workspaceBilling(session.workspaceId);
  const checkout = await createCheckoutSession(deps.stripe, {
    workspaceId: session.workspaceId,
    email: session.email,
    price,
    customerId: billing?.customerId,
    appBaseUrl: deps.appBaseUrl,
  });
  return redirect(checkout.url);
}

async function openPortal(request: Request, session: Session, deps: RouteDeps): Promise<Response> {
  if (!requireSameOrigin(request, deps.appBaseUrl)) {
    return messagePage('Rejected', 'This request did not come from the DeltaLog app.', 403);
  }
  const billing = await deps.billingStore.workspaceBilling(session.workspaceId);
  if (!billing?.customerId) {
    return messagePage('No billing account', 'This workspace has never had a paid plan, so there is nothing to manage yet.', 400);
  }
  const portal = await createPortalSession(deps.stripe, { customerId: billing.customerId, appBaseUrl: deps.appBaseUrl });
  return redirect(portal.url);
}

async function handleWebhook(request: Request, deps: RouteDeps): Promise<Response> {
  // Raw text, before any parsing: the signature covers these exact bytes, and
  // re-serializing parsed JSON would change them.
  const raw = await request.text();
  const verified = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), deps.stripe.webhookSecret, deps.now());
  if (!verified) return json({ error: 'invalid signature' }, 400);

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return json({ error: 'malformed payload' }, 400);
  }

  const outcome = await handleStripeEvent(event, deps.stripe, deps.billingStore);
  // Always 200 once the signature checks out. A non-2xx makes Stripe retry, and
  // retrying an event we understood but chose not to act on achieves nothing.
  return json({ outcome }, 200);
}
