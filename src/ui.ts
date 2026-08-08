/**
 * Server-rendered HTML for the review UI.
 *
 * No framework, no build step, no client-side JavaScript. That is a maintenance
 * decision before it is an aesthetic one: a React app in this product would need a
 * bundler, a dependency tree, and a security-update cadence, in exchange for
 * interactivity that three static pages do not need. Forms and links have worked for
 * thirty years and will still work when nobody has touched this repo in two.
 *
 * Every interpolation is escaped. The vendor names, purposes, and clause quotes on
 * these pages were scraped from third-party websites — see the note in render.ts.
 */

import type { ClauseChange } from './clauses.ts';
import { clauseLabel } from './clauses.ts';
import type { EntityDiff } from './entities.ts';
import { escapeHtml } from './render.ts';
import type { QueueItem, ReviewView } from './review.ts';
import { PLAN_LIMITS, type BillingState, type Plan } from './billing.ts';

const STYLE = `
:root { --fg:#101828; --muted:#667085; --line:#e4e7ec; --bg:#fff; --accent:#175cd3; --high:#b42318; --ok:#067647; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e7e9ee; --muted:#98a2b3; --line:#2a2f3a; --bg:#14161b; --accent:#84adff; --high:#f97066; --ok:#47cd89; }
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif }
.wrap { max-width:760px; margin:0 auto; padding:32px 20px 64px }
header { display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:12px; margin-bottom:24px }
h1 { font-size:20px; margin:0 }
h2 { font-size:15px; margin:28px 0 8px }
a { color:var(--accent) }
.muted { color:var(--muted); font-size:13px }
.item { display:block; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:10px; text-decoration:none; color:inherit }
.item:hover { border-color:var(--accent) }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; vertical-align:middle }
.dot.high { background:var(--high) } .dot.low { background:var(--muted) }
.summary { margin:4px 0 0 }
table { width:100%; border-collapse:collapse; font-size:14px; margin:8px 0 }
th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top }
th { font-weight:600; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em }
.tag { font-size:12px; padding:2px 7px; border-radius:99px; border:1px solid var(--line) }
.tag.added { color:var(--high) } .tag.removed { color:var(--muted) }
form { border:1px solid var(--line); border-radius:8px; padding:16px; margin-top:24px }
textarea { width:100%; min-height:72px; font:inherit; font-size:14px; padding:8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit }
button { font:inherit; font-size:14px; padding:8px 16px; border-radius:6px; border:1px solid var(--line); background:transparent; color:inherit; cursor:pointer; margin-right:8px }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff }
input[type=email] { font:inherit; padding:9px 10px; border:1px solid var(--line); border-radius:6px; width:280px; background:transparent; color:inherit }
.decided { border:1px solid var(--line); border-left:3px solid var(--ok); border-radius:6px; padding:12px 14px; margin-top:24px }
.empty { color:var(--muted); padding:32px 0; text-align:center }
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — DeltaLog</title><style>${STYLE}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

const when = (iso?: string) => (iso ? escapeHtml(iso.replace('T', ' ').slice(0, 16)) + ' UTC' : '');

export function loginPage(sentTo?: string, error?: string): string {
  const body = sentTo
    ? `<h1>Check your email</h1>
       <p>We sent a sign-in link to <strong>${escapeHtml(sentTo)}</strong>. It works once and expires in 15 minutes.</p>`
    : `<h1>Sign in to DeltaLog</h1>
       ${error ? `<p class="muted">${escapeHtml(error)}</p>` : ''}
       <form method="post" action="/login">
         <input type="email" name="email" placeholder="you@company.com" required autofocus>
         <button class="primary" type="submit">Email me a link</button>
         <p class="muted" style="margin:12px 0 0">No password. We email you a one-time link.</p>
       </form>`;
  return layout('Sign in', body);
}

/**
 * Bulk paste, not a search-and-click loop.
 *
 * The realistic starting point is a vendor list that already exists — in a
 * spreadsheet, a SOC 2 questionnaire, a procurement export. Making someone re-enter it
 * one autocomplete at a time is where onboarding dies, so the primary input is a
 * textarea you paste a column into.
 */
export function onboardingPage(
  matched: { name: string }[] = [],
  unmatched: string[] = [],
  added?: number,
  capped?: { limit: number; plan: Plan; overflow: string[] },
): string {
  const result =
    added !== undefined
      ? `<p><strong>${added} vendor${added === 1 ? '' : 's'} added.</strong> ${escapeHtml(
          matched.map((m) => m.name).join(', '),
        )}</p>`
      : '';

  const overCap = capped
    ? `<div class="decided" style="border-left-color:var(--high)">
         <strong>Your ${escapeHtml(capped.plan)} plan covers ${capped.limit} vendors.</strong>
         <p style="margin:8px 0 0">We did not add ${escapeHtml(capped.overflow.join(', '))}.
         Upgrading raises the limit and starts checking every page daily.</p>
         <p style="margin:10px 0 0"><a href="/billing">See plans</a></p>
       </div>`
    : '';

  const missed = unmatched.length
    ? `<h2>Not in our directory yet</h2>
       <p class="muted">We couldn’t match ${unmatched.length} name${unmatched.length === 1 ? '' : 's'}:
       ${escapeHtml(unmatched.join(', '))}. You can add these by URL — any page works, the directory is a shortcut.</p>`
    : '';

  return layout(
    'Add vendors',
    `<header><h1>Add your vendors</h1><a href="/queue">Skip</a></header>
     ${result}${overCap}${missed}
     <form method="post" action="/onboarding">
       <label for="vendors">Paste your vendor list <span class="muted">— one per line, or comma separated</span></label>
       <textarea id="vendors" name="vendors" style="min-height:160px" placeholder="Datadog&#10;Stripe, Inc.&#10;Amazon Web Services&#10;Okta"></textarea>
       <div style="margin-top:12px"><button class="primary" type="submit">Add these vendors</button></div>
       <p class="muted" style="margin:12px 0 0">We already know where each one publishes its subprocessor list, and we
       have been checking those pages daily — so your history starts today, not in three months.</p>
     </form>`,
  );
}

/**
 * Deliberately not a billing UI. Everything a customer might want to *change* — card,
 * plan, cancellation, invoices, receipts — is one button that hands them to Stripe's
 * hosted portal. This page only reports state.
 */
export function billingPage(billing: BillingState, checkoutJustCompleted = false): string {
  const limits = PLAN_LIMITS[billing.plan];
  const usage = `${billing.vendorCount} of ${limits.vendors} vendors`;
  const frequency = limits.intervalMinutes >= 10080 ? 'weekly' : limits.intervalMinutes >= 1440 ? 'daily' : 'every 6 hours';

  // The redirect back from Stripe is a message, never a grant: the plan shown below is
  // whatever the signed webhook has written, which may lag this page by a second.
  const banner = checkoutJustCompleted
    ? `<div class="decided"><strong>Payment received.</strong>
         <p style="margin:8px 0 0">Your plan updates as soon as Stripe confirms it — usually within a few seconds.
         Reload if this page still shows the old plan.</p></div>`
    : '';

  const upgrade = (plan: Plan, label: string) => `
    <form method="post" action="/billing/checkout" style="border:0;padding:0;margin:0;display:inline">
      <input type="hidden" name="plan" value="${escapeHtml(plan)}">
      <input type="hidden" name="cadence" value="monthly">
      <button class="primary" type="submit">${escapeHtml(label)}</button>
    </form>`;

  const actions =
    billing.plan === 'compliance'
      ? ''
      : `<h2>Upgrade</h2>
         <p class="muted">Annual billing takes two months off — choose it in the checkout.</p>
         <div style="margin-top:12px">
           ${billing.plan === 'free' ? upgrade('team', 'Team — $39/month') : ''}
           ${upgrade('compliance', 'Compliance — $99/month')}
         </div>`;

  const manage = billing.customerId
    ? `<form method="post" action="/billing/portal">
         <p class="muted" style="margin:0 0 12px">Update your card, switch plans, download invoices, or cancel.</p>
         <button type="submit">Manage billing at Stripe</button>
       </form>`
    : '';

  const dunning =
    billing.status === 'past_due'
      ? `<div class="decided" style="border-left-color:var(--high)">
           <strong>Your last payment did not go through.</strong>
           <p style="margin:8px 0 0">Monitoring continues while Stripe retries the card. Update it to avoid interruption.</p>
         </div>`
      : '';

  return layout(
    'Billing',
    `<header><h1>Billing</h1><a href="/queue">Back to queue</a></header>
     ${banner}${dunning}
     <table>
       <tr><th>Plan</th><td>${escapeHtml(billing.plan)}</td></tr>
       <tr><th>Vendors</th><td>${escapeHtml(usage)}</td></tr>
       <tr><th>Checked</th><td>${escapeHtml(frequency)}</td></tr>
       <tr><th>Evidence export</th><td>${billing.plan === 'free' ? 'Not included' : 'Included'}</td></tr>
     </table>
     ${actions}
     ${manage}`,
  );
}

export function queuePage(items: QueueItem[], workspaceName: string): string {
  const unreviewed = items.filter((i) => !i.decision);

  const row = (item: QueueItem) => `
    <a class="item" href="/alerts/${escapeHtml(item.id)}">
      <div class="muted"><span class="dot ${item.severity === 'high' ? 'high' : 'low'}"></span>${escapeHtml(item.vendor)} · ${when(item.createdAt)}${
        item.decision ? ` · ${escapeHtml(item.decision)} by ${escapeHtml(item.reviewedBy ?? '')}` : ''
      }</div>
      <p class="summary">${escapeHtml(item.summary)}</p>
    </a>`;

  const body = `
    <header><h1>${escapeHtml(workspaceName)}</h1><span class="muted">${unreviewed.length} awaiting review</span></header>
    ${
      items.length
        ? items.map(row).join('')
        : '<p class="empty">Nothing to review. Every monitored page is being checked on schedule.</p>'
    }
    <p class="muted" style="margin-top:24px">Every check is logged, including the ones where nothing changed.</p>`;
  return layout('Review queue', body);
}

function entityTable(diff: EntityDiff): string {
  const rows = [
    ...diff.added.map((e) => ({ tag: 'added', label: 'Added', e, detail: '' })),
    ...diff.removed.map((e) => ({ tag: 'removed', label: 'Removed', e, detail: '' })),
    ...diff.moved.map((m) => ({ tag: 'added', label: 'Jurisdiction', e: m.entity, detail: `${m.from} → ${m.to}` })),
    ...diff.repurposed.map((r) => ({ tag: 'removed', label: 'Purpose', e: r.entity, detail: `${r.from} → ${r.to}` })),
  ];
  if (!rows.length) return '';
  return `<table><tr><th>Change</th><th>Subprocessor</th><th>Purpose</th><th>Location</th></tr>
    ${rows
      .map(
        (r) => `<tr>
          <td><span class="tag ${r.tag}">${escapeHtml(r.label)}</span></td>
          <td>${escapeHtml(r.e.name)}</td>
          <td>${escapeHtml(r.detail && r.label === 'Purpose' ? r.detail : (r.e.purpose ?? ''))}</td>
          <td>${escapeHtml(r.detail && r.label === 'Jurisdiction' ? r.detail : (r.e.jurisdiction ?? ''))}</td>
        </tr>`,
      )
      .join('')}</table>`;
}

function clauseList(changes: ClauseChange[]): string {
  return `<div style="margin-top:16px">${changes
    .map(
      (c) => `<div style="margin-bottom:12px">
        <div><strong>${escapeHtml(clauseLabel(c))}</strong> <span class="muted">${escapeHtml(c.topic)}</span></div>
        ${c.signals.map((s) => `<div class="muted">${escapeHtml(s)}</div>`).join('')}
        ${c.quote ? `<div style="margin-top:4px">“${escapeHtml(c.quote)}”</div>` : ''}
      </div>`,
    )
    .join('')}</div>`;
}

export function alertPage(view: ReviewView): string {
  const changed = [
    view.entityDiff ? entityTable(view.entityDiff) : '',
    view.clauseChanges?.length ? clauseList(view.clauseChanges) : '',
  ]
    .filter(Boolean)
    .join('');

  const reviewBlock = view.decision
    ? `<div class="decided">
         <strong>${escapeHtml(view.decision === 'accepted' ? 'Accepted' : 'Escalated')}</strong> by
         ${escapeHtml(view.reviewedBy ?? 'unknown')} on ${when(view.reviewedAt)}
         ${view.note ? `<p style="margin:8px 0 0">${escapeHtml(view.note)}</p>` : ''}
         <p class="muted" style="margin:8px 0 0">Recorded decisions are final and appear in your evidence export.</p>
       </div>`
    : `<form method="post" action="/alerts/${escapeHtml(view.id)}/review">
         <label for="note">Note <span class="muted">(optional, goes on the audit record)</span></label>
         <textarea id="note" name="note" placeholder="e.g. Covered by existing DPA — no action needed."></textarea>
         <div style="margin-top:12px">
           <button class="primary" type="submit" name="decision" value="accepted">Accept</button>
           <button type="submit" name="decision" value="escalated">Escalate</button>
         </div>
       </form>`;

  const body = `
    <header><h1>${escapeHtml(view.vendor)}</h1><a href="/queue">Back to queue</a></header>
    <p class="muted">Detected ${when(view.createdAt)} · <a href="${escapeHtml(view.url)}" rel="noopener noreferrer nofollow">${escapeHtml(view.url)}</a></p>
    <p style="font-size:17px">${escapeHtml(view.summary)}</p>
    ${
      changed
        ? `<h2>What changed</h2>${changed}
           <p class="muted">Comparing the page as captured ${when(view.comparedFrom)} with ${when(view.comparedTo)}.</p>`
        : '<p class="muted">The stored snapshots for this change are no longer available.</p>'
    }
    ${reviewBlock}`;
  return layout(`${view.vendor} — review`, body);
}

export function messagePage(title: string, message: string, status = 200): Response {
  return new Response(layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/queue">Back to queue</a></p>`), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
