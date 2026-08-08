# DeltaLog — product design

> Monitors your vendors' subprocessor, DPA, security, and trust pages. Tells you the moment
> one changes, and keeps a timestamped evidence log your auditor will accept.

Name is a placeholder — swap freely. `deltalog.io` / `deltalog.app` class of domain.

---

## 1. Why this product

### Selection criteria (applied before picking)

A passive-income SaaS has to satisfy all six of these, not four:

| # | Criterion | Why it kills products that fail it |
|---|---|---|
| 1 | The value is *continuous*, not one-time | One-time value → users cancel after month 1. You need "it keeps watching" |
| 2 | Buyer has a budget line already | Consumers churn at 8%/mo. Compliance/ops budgets churn at <2% |
| 3 | Cost of failure is high, cost of tool is low | Makes price insensitive; nobody negotiates a $49 line item |
| 4 | No user-generated content, no moderation, no marketplace | Those are jobs, not products |
| 5 | Free infra at realistic scale | Zero fixed cost = zero pressure = truly passive |
| 6 | Support burden ≈ 0 | No integrations that break; no per-customer configuration work |

### Alternatives considered and rejected

- **Uptime monitoring** — fails #3 (UptimeRobot's free tier is the market price) and is brutally commoditized.
- **Cron/heartbeat monitoring** — Healthchecks.io is open source and free; buyers are developers, who self-host.
- **Generic "watch any webpage"** — Visualping/Distill already own it at $8/mo. Generic framing caps your price.
- **Invoice/receipt inbox parsing** — fails #6. Parsers break every time a vendor changes an email template.
- **Shopify/Slack app** — fails #6. Platform API churn is a permanent part-time job.
- **Stripe dunning / failed-payment recovery** — payment-adjacent, so it inherits PCI questions and high-stakes support.

### The pick

The same "watch a page, diff it, email me" machine — which is genuinely trivial to build — sold to
**GRC / vendor-management buyers** instead of to consumers. Identical code, 6× the price, a tenth of the churn.

**The pain is real and boring:** every SOC 2 / ISO 27001 / GDPR program requires vendor
oversight. DPAs typically require the vendor to give notice before adding a subprocessor, and
require *you* to track it. Nobody does. It's a manual quarterly spreadsheet review that gets
skipped for three quarters and then panic-reconstructed the week before the audit.

**The buying trigger** is sharp and recurring: an auditor asks *"show me evidence you monitored
your critical vendors over the audit period."* You cannot retroactively produce a monitoring
log. That's what makes this a subscription instead of a purchase — and what makes cancellation
painful, since cancelling creates a gap in the evidence period.

---

## 2. ICP

**Primary:** the person who owns compliance at a 30–300 person SaaS company. Usually titled Head
of Security, Security Engineer, Head of Ops, or CTO-who-drew-the-short-straw. Owns 40–150 vendors.
Has a Vanta/Drata subscription that handles policies and access reviews but does *not* watch
vendor pages.

**Secondary (highest leverage):** **fractional CISOs and compliance consultants.** Each manages
8–30 client companies. One sale = 8–30 workspaces. They are the entire go-to-market (see §8).

**Explicitly not the ICP:** enterprises (they want SSO, a security review, an MSA, and a
procurement cycle — none of which is passive), and individual developers (won't pay, will self-host).

---

## 3. Core features

### v1 — ship this and nothing else

1. **Watches.** A watch = a URL + a page type (`subprocessor list` | `DPA/terms` | `security page` | `trust center` | `status`) + a check frequency.
2. **Vendor directory.** ~500 major SaaS vendors pre-mapped to their subprocessor/DPA/trust URLs. Onboarding is *picking from a list*, not pasting URLs. Also the SEO asset (§8).
3. **Change detection with a materiality filter.** The hard part, and the only real IP. See §9.
4. **Diff view.** Side-by-side rendered text diff, with entity add/remove called out separately: *"Added subprocessor: Cloudflare, Inc. (CDN, US)"*.
5. **Alerts.** Email + Slack incoming webhook. Per-workspace routing rules, immediate or daily digest.
6. **Evidence log.** Append-only record: every check, its timestamp, result hash, and archived page snapshot — including the boring "no change" checks, which are the ones auditors actually want.
7. **Evidence export.** One button → PDF + CSV covering a date range, per-vendor, with hashes. This is the paywall.
8. **Acknowledgement workflow.** Each detected change gets `open → reviewed → accepted/escalated` with a reviewer name, timestamp, and free-text note. Auditors want a human decision on record, not just a diff.

### Deliberately deferred

SSO, on-prem, an integration marketplace, a mobile app, AI risk scoring, questionnaire
automation, browser extension, JS-rendered page support beyond a fallback. Each of these
converts a passive product into a job.

### The one feature that creates the moat

The evidence log. A diff engine is copyable in a weekend. **Eighteen months of timestamped,
hash-chained evidence is not**, and it is worth strictly more every month it accumulates. Price
and retention both ride on this, not on the detection quality.

---

## 4. User flow

**Time to first value target: 4 minutes. Time to first *paid* value: ~6 weeks (first real change detected).**

```
Landing → "Check your vendors free" (no credit card, email only)
   │
   ├─ 1. Pick vendors from directory  ──── typeahead, logos, 8 clicks
   │      "Add all 12" from a pasted list of vendor names
   │
   ├─ 2. Instant baseline (~20s)  ──────── fetches every page NOW, shows
   │      what's on them today. This is the aha: they see their actual
   │      subprocessor lists side by side for the first time ever.
   │
   ├─ 3. "3 of your vendors changed their subprocessor list in the last
   │      90 days" (computed from your own historical archive of the
   │      directory — a free-tier user's very first screen has real news)
   │
   ├─ 4. Alert routing: email + optional Slack webhook
   │
   └─ 5. Done. Dashboard. Close the tab.

── weeks pass, product is silent ──

Change detected
   → Email: "Datadog added 2 subprocessors" + inline diff + [Review] button
   → One click → diff page → Accept / Escalate + note → logged
   → Total user time: 40 seconds

Audit season (the conversion + renewal moment)
   → "Export evidence" → date range → paywall → upgrade → PDF in 10s
```

**The retention loop is not engagement — it's the opposite.** The product should be silent for
weeks. Retention comes from three scheduled contacts: (a) the monthly digest that says *"18
vendors monitored, 412 checks, 2 changes, 0 unreviewed"* — a receipt that justifies the line
item, (b) the real change alerts, (c) the annual audit export. Never build streaks, badges, or
daily emails; alert fatigue is the churn mechanism in this category.

---

## 5. Architecture (free tier, ~10 min/week maintenance)

```
Cloudflare Workers (cron trigger, every 15 min)
    → pull due watches from D1
    → fetch page (Worker fetch; 6s timeout, 2 retries w/ backoff)
    → strip boilerplate → normalize → extract entities
    → isMaterialChange()  ← the entire product (src/materiality.ts)
    → on material change: write revision + snapshot to R2, enqueue alert
    → always: append check record to evidence log

Cloudflare D1 (SQLite)     — watches, revisions, evidence log, workspaces
Cloudflare R2              — page snapshots (10 GB free; snapshots are ~30 KB gzipped)
Resend                     — 3,000 emails/mo free
Stripe Checkout + Portal   — billing, upgrades, cancellation, dunning: all hosted by Stripe
Cloudflare Pages           — marketing site + app (Next.js/SvelteKit static + Worker API)
```

**Cost at 100 paying customers (~$5k MRR): $0–20/month.** 100 customers × 25 vendors × 4
checks/day ≈ 10k requests/day, against a 100k/day free limit. Alert email volume is low by
nature — a subprocessor page changes maybe 2–4×/year — so ~500 alerts + 400 digests/month sits
inside Resend's free tier. First real bill arrives around $8–10k MRR.

**Auth:** email magic links only. No passwords → no password reset support tickets, no
credential-stuffing, no breach exposure.

**Billing:** Stripe Checkout + the hosted Customer Portal, exclusively. Never build an in-app
billing screen — plan changes, card updates, cancellations, invoices, and failed-payment retries
all become Stripe's problem, which removes the single largest source of support email.

---

## 6. Pricing

| | **Free** | **Team — $39/mo** | **Compliance — $99/mo** |
|---|---|---|---|
| Vendors | 3 | 25 | 100 |
| Check frequency | weekly | daily | every 6 hours |
| Alerts | email | email + Slack | + webhook, API |
| History retained | 30 days | full | full |
| **Evidence export (PDF/CSV)** | — | ✅ | ✅ + hash-chain verification |
| Acknowledgement workflow | — | ✅ | ✅ |
| SOC 2 report expiry tracking | — | — | ✅ |
| Seats | 1 | 3 | unlimited |
| Custom vendor mapping requests | — | — | 10/mo |

Annual: **2 months free** (~17% off). Push it hard — it doubles cash-on-hand and removes 12
churn decisions per customer per year.

**Why these numbers:**

- **$39 and $99 both sit under $100/mo** — the near-universal threshold below which a manager
  expenses it on a card with no purchase order, no procurement, no security questionnaire. Cross
  $100 and you've bought yourself a sales process, which is the opposite of passive.
- **Anchor is not competitors, it's labor.** The manual alternative is ~4 hours/quarter of a
  $120k-salary person = ~$250/quarter. $39/mo is a visible discount to doing nothing well.
- **Free tier is capped by *vendors*, not by time.** A 14-day trial forces a decision while the
  product has produced nothing (changes take weeks to appear). A permanent 3-vendor free tier
  lets them stay until a real change fires — which is the actual sales pitch — and it keeps the
  directory-SEO traffic converting into accounts.
- **Export is the paywall, not detection.** Detection creates the habit for free. The wall
  arrives at the exact moment of maximum urgency (auditor asked, deadline is Friday). Highest-
  converting possible moment, and it requires zero sales effort from you.
- **The metering dimension is vendor count**, which grows on its own as the customer's company
  buys more software. Expansion revenue with no upsell motion — this is the single most
  important pricing decision in the doc for passive income.

**Never do a lifetime deal.** AppSumo-style LTDs convert a recurring-revenue asset into a
one-time payment plus permanent support obligations. It is the direct inverse of this product's goal.

---

## 7. Landing page copy

### Hero

**Your vendors change their subprocessors. Nobody tells you.**

DeltaLog watches your vendors' subprocessor lists, DPAs, and trust pages every day — and keeps
the timestamped evidence log your auditor asks for.

`[ Watch 3 vendors free ]`   No credit card. First results in 4 minutes.

*Trusted by security teams at 200+ SaaS companies* ← (only once true)

---

### The problem block

> **"Show me evidence you monitored your critical vendors during the audit period."**

You can't produce that after the fact. Either you were watching, or you weren't.

So it gets done manually: a spreadsheet, a calendar reminder, four hours a quarter, and a
quiet hope that no vendor quietly added a subprocessor in a jurisdiction your DPA doesn't cover.

**Three quarters later, that spreadsheet was last touched in March.**

---

### How it works — three steps

**1. Pick your vendors.**
500+ vendors pre-mapped to their subprocessor, DPA, and trust pages. Paste a list of names, or
click through the directory. No URL hunting.

**2. We check them every day.**
Every page. Every day. We ignore the cookie banners, the rotating testimonials, and the
"last updated" timestamps — and alert you only when something that matters actually moves.

**3. You get the receipt.**
Every check is logged with a timestamp and a content hash, including the ones where nothing
changed. Export the whole period as a PDF whenever your auditor asks.

---

### Feature blocks

**Alerts you'll actually read.**
Not "this page changed." Instead: *"Datadog added Snowflake Inc. (data warehousing, US) as a
subprocessor on March 4."* Named entity, category, jurisdiction, date. Review it in 40 seconds
and move on.

**An evidence log, not a notification feed.**
Append-only. Hash-chained. Includes the boring checks where nothing happened — because those are
the ones that prove continuous coverage. Export to PDF or CSV over any date range.

**Reviews on the record.**
Every change gets accepted or escalated by a named human, with a note and a timestamp. Auditors
want the decision, not just the diff.

**Quiet by design.**
Most weeks you'll hear nothing from us but a monthly summary. That's the product working.

---

### Pricing section header

**Cheaper than the spreadsheet.**
Four hours a quarter of your security lead's time costs about $250. Team is $39/month, and it
doesn't forget.

---

### FAQ

**How is this different from Vanta or Drata?**
They manage your policies, access reviews, and control evidence. Neither continuously monitors
what your vendors publish on their own websites. DeltaLog fills that specific gap and exports
evidence you can attach to your existing program.

**What if a vendor's page moves?**
We detect the 404, look for the new location automatically, and only bother you if we can't find
it within 48 hours. Broken watches are our problem, not yours.

**Do you catch changes on JavaScript-heavy pages?**
Yes, with a rendered fallback for pages that need it. If a page is genuinely unmonitorable we
tell you at setup rather than silently reporting "no change" forever.

**Can I monitor pages that aren't in your directory?**
Any URL, any plan. The directory is a shortcut, not a limit.

**What happens to my evidence log if I cancel?**
You can export it in full before your period ends, and we keep it available read-only for 90
days. We never hold your audit evidence hostage.

---

### Final CTA

**The next time your DPA obligations change, you'll find out on the day — not in the audit.**

`[ Start watching 3 vendors free ]`

---

## 8. Monetization & distribution

Every channel below must be *build-once, run-forever*. Anything requiring weekly effort is out.

### 1. The vendor directory (primary, compounding, free)

Publish a public page per vendor: **"Where is Datadog's subprocessor list? (and what changed
recently)"** — with the live current list, the last 12 months of detected changes, and the date
of the last check. 500 pages × long-tail intent queries (`{vendor} subprocessor list`,
`{vendor} DPA`, `{vendor} sub-processors change notification`).

This is the whole strategy, and it has a rare property: **the product maintains the marketing
asset.** The same crawler that serves customers keeps 500 SEO pages permanently fresh, with a
growing changelog per page, at zero marginal effort. Genuinely passive content marketing.

Every page CTA: *"Get notified when this changes — free."*

### 2. Consultant/vCISO affiliate program (highest leverage)

20% recurring commission, forever. A fractional CISO with 15 clients who standardizes on
DeltaLog generates ~$500/mo recurring for one conversation you never had. Recruit once via a
one-time outreach push to ~200 consultants, then let it run. This channel is why the secondary
ICP matters more than it looks.

### 3. The "gap report" cold email (one-time build, reusable)

For a target company, pre-generate a report of what their 10 most likely vendors changed in the
last 6 months — from data you already have. Send it. The email *is* the product demo, and it
costs nothing per send because the data is already computed. Ship it as a template you can fire
in batches whenever you want growth, then walk away.

### 4. Free public "subprocessor change feed"

An RSS/JSON feed of every change detected across the directory. Zero marginal cost, gets embedded
and cited by compliance newsletters, generates permanent backlinks. Attribution requirement links
back to you.

### Revenue model summary

- **Base:** $39/$99 self-serve subscriptions, Stripe-hosted end to end.
- **Expansion:** automatic, driven by customer vendor-count growth. No upsell motion.
- **Retention:** the evidence log appreciates with age; cancelling creates an audit gap.
- **Secondary:** affiliate-driven volume from consultants managing many workspaces.
- **Refused:** lifetime deals, one-time audits, custom work, enterprise contracts.

---

## 9. Maintenance model

Realistically **10–15 minutes per week**, all of it in one queue.

**The three things that break, and their automatic responses:**

| Failure | Auto-response | Escalates to you when |
|---|---|---|
| Fetch blocked (403/bot wall) | Retry w/ backoff, rotate UA, fall back to rendered fetch | 3 consecutive failures |
| Page moved (404) | Crawl the vendor's `/legal`, `/trust`, sitemap for a replacement candidate | No candidate found in 48h |
| Noisy diffs (false positives) | Materiality filter (§ below) + per-watch boilerplate learning | User clicks "this wasn't a real change" |

The weekly ritual: open the **Watch Health** queue, fix broken URL mappings (usually 0–3), close
it. Everything else is a state machine that heals itself.

**Support burden is minimized structurally, not with effort:** magic-link auth (no password
resets), Stripe Portal (no billing tickets), no integrations beyond a Slack webhook (nothing to
break), and a directory-based setup flow (no configuration help needed).

---

## 10. Validation before writing any code

Two weeks, zero code, real signal:

1. Manually monitor 30 well-known vendors' subprocessor pages — a spreadsheet and 90 minutes.
2. Wait three weeks. **Count the actual changes.** If fewer than ~5 real changes appear across
   30 vendors in 3 weeks, alert volume is too low to sustain perceived value → reposition toward
   the evidence log and away from alerting (or kill it).
3. Email 50 GRC/security leads with the real diffs you found on *their* vendors. Ask one
   question: *"Want me to keep sending these?"*

**Kill criteria:** fewer than 8 replies asking you to continue, or fewer than 3 people who say
they'd pay $39/mo when asked directly. That's a weekend of work to avoid three months of building
the wrong thing.

---

## 11. Honest risks

- **Vanta or Drata ships this as a feature.** Real, and the most likely ending. Mitigations: the
  independent evidence log (a compliance platform grading its own vendor monitoring is a weaker
  artifact), serving companies too small for Vanta, and the consultant channel. Realistically,
  plan for this to be a $3–15k MRR business, not a $1M ARR one — which is exactly what a passive-
  income tool should be.
- **Change frequency may be too low to feel valuable.** The mitigation is the monthly digest and
  the evidence framing: you're selling proof of continuous coverage, not a stream of news. Step 2
  of validation exists specifically to test this.
- **Bot-blocking gets worse over time.** Cloudflare-fronted vendor pages increasingly block
  automated fetches. This is the one thing that could turn maintenance from 10 min/week into a
  real job. Budget for a paid unblocking service (~$30/mo) as a contingency, and check the block
  rate weekly in the Watch Health queue.
- **You are one person, and the buyer is a security team.** Expect security questionnaires as you
  move upmarket. Answer: stay downmarket. Publish a one-page security summary and decline the
  questionnaires. The moment you fill out a 200-row spreadsheet for a customer, it stopped being
  passive.
```
