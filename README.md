# DeltaLog

[![CI](https://github.com/alzhanovmaksat/deltalog/actions/workflows/ci.yml/badge.svg)](https://github.com/alzhanovmaksat/deltalog/actions/workflows/ci.yml)

Watches your vendors' subprocessor lists, DPAs, and trust pages every day — and keeps
the timestamped, hash-chained evidence log an auditor asks for.

> **Status: complete implementation, unproven product.** Every piece described below is
> built and tested, but this has never been deployed, has no users, and has not been
> validated with real buyers. [`PRODUCT.md §10`](PRODUCT.md) sets out the two-week
> validation that should have come *before* any of this was written. Treat the code as
> finished and the business case as an untested hypothesis.

---

## The problem

Every SOC 2 / ISO 27001 / GDPR program requires vendor oversight. DPAs typically
require notice before a vendor adds a subprocessor, and require *you* to track it.
Almost nobody does — it becomes a spreadsheet, a calendar reminder, four hours a
quarter, and three skipped quarters.

Then an auditor asks:

> *"Show me evidence you monitored your critical vendors during the audit period."*

You can't produce that after the fact. Either you were watching, or you weren't.

## What it does

```
cron (15 min)
  └─ fetch due watches ──> extract ──> judge materiality ──> append to evidence log
                                            │
                                            ├─ material? ──> store revision ──> alert (email / Slack)
                                            └─ always ─────> log the check, even failures
                                                                      │
  review UI (accept / escalate, named reviewer) ──────────────────────┤
  evidence export (PDF narrative + CSV log, chain-verified) ──────────┘
```

Plus the acquisition surface: a landing page, a public vendor directory that doubles as
the SEO engine, onboarding by pasting a vendor list, and Stripe billing.

## Running it

No dependencies, no build step. Tests run on erasable TypeScript under Node's own test
runner.

```bash
npm test
```

173 tests, ~1 second. Node 22.18+ (the version where TypeScript type stripping stopped
needing a flag). CI runs the suite on 22.x and 24.x.

## Layout

| Module | Responsibility |
|---|---|
| [`check.ts`](src/check.ts) | One check of one watch: fetch → judge → log. Watch health state machine |
| [`materiality.ts`](src/materiality.ts) | Is this a real change or noise? The core decision |
| [`entities.ts`](src/entities.ts) | Subprocessor table/list extraction and diffing |
| [`clauses.ts`](src/clauses.ts) | DPA clause tree, operative-language and time-period detection |
| [`fetch.ts`](src/fetch.ts) | Retry, outcome classification, relocation discovery |
| [`evidence.ts`](src/evidence.ts) | Hash chain, verification, coverage math |
| [`export.ts`](src/export.ts) / [`pdf.ts`](src/pdf.ts) | PDF + CSV evidence artifacts (hand-rolled PDF writer) |
| [`notify.ts`](src/notify.ts) | Batching, suppression, digests, retry decisions |
| [`review.ts`](src/review.ts) / [`ui.ts`](src/ui.ts) | Acknowledgement workflow, server-rendered app |
| [`directory.ts`](src/directory.ts) | 60-vendor directory, URL resolution, bulk matching |
| [`billing.ts`](src/billing.ts) | Stripe Checkout, portal, webhook handling |
| [`routes.ts`](src/routes.ts) / [`worker.ts`](src/worker.ts) | HTTP routing; Cloudflare entry point |

~5,600 lines of source, ~2,300 of tests. Stores are behind interfaces so every decision
is testable without D1, a network, or a clock.

## Design decisions worth knowing before you change things

These are the places where an innocent-looking edit breaks something silently.

**Every check appends a row to the evidence log, including failures.** A gap in the log
is indistinguishable from "we weren't watching", which is the exact claim customers are
buying. `runCheck` wraps its whole body so even a thrown database error leaves a row.

**Extractors fail loudly, never quietly.** If entity or clause extraction previously
worked and now returns nothing, that pages the user. The alternative — a watch that
reports "no change" forever while monitoring a restructured page — looks green on a
dashboard and is worthless in an audit.

**Identity has exactly one definition.** `normalizeEntityName`, `chainCheckHash`, and
`diffEntities` are each defined once and shared by producer and consumer. Two copies
that drift would make the verification prove nothing, and the failure would be silent.

**Scraped vendor text reaches four renderers with four different escape rules.** HTML
(`escapeHtml`), CSV formula injection (`'` prefix on `=+-@`), XML (five entities, or the
whole feed is malformed), and PDF (transliteration to ASCII). Same untrusted source,
four sinks, four defenses.

**Only the Stripe webhook grants a plan.** The success redirect proves nothing — anyone
can navigate to it. Webhooks are deduped by event id (`INSERT OR IGNORE` on a primary
key) and ordered by event timestamp, because delivery is at-least-once *and* out of
order, and those are two separate hazards.

**Directory URLs are discovered, never written from memory.** `src/directory.ts` holds
domains and candidate paths; `scripts/seed-directory.ts` and `scripts/discover-urls.ts`
find the real URLs and verify each against `looksLikeTargetPage`. A URL written down
because it looked right fails silently — the watch goes green while monitoring a 404 or
somebody else's page. The first live run proved the point by resolving Vercel to a login
wall and Loom to Atlassian's privacy policy.

## Deploying

```bash
wrangler d1 create deltalog                       # paste the id into wrangler.toml
wrangler d1 execute deltalog --file=src/schema.sql
wrangler d1 execute deltalog --file=scripts/seed-directory.sql
wrangler secret put RESEND_API_KEY
wrangler secret put SESSION_SECRET
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler deploy
```

Then create the Stripe products, paste four price ids into `wrangler.toml`, and point a
Stripe webhook endpoint at `https://<host>/stripe/webhook` subscribed to
`checkout.session.completed` and `customer.subscription.*`.

Costs nothing to run at realistic scale: Workers cron, D1, R2, and Resend free tiers
carry roughly the first 100 customers.

## Directory coverage

**31 of 60 vendors** resolve to a verified subprocessor page. The other 29 are published
at `/directory/unmonitored` with the reason for each, rather than quietly omitted:

| Reason | Count |
|---|---|
| No public list found at any path, sitemap, or legal hub | 15 |
| Published but client-rendered / no stable structure | 9 |
| Site blocks automated requests | 5 |

Re-run `node scripts/seed-directory.ts` to refresh; it re-verifies everything and is
idempotent. That ~8% bot-block rate is the measured version of the risk in
[`PRODUCT.md §11`](PRODUCT.md) — the one that could turn this from a low-maintenance
product into a job.

## Validation

Step 1–2 are done and recorded in [VALIDATION.md](VALIDATION.md): a 12-month backtest
against Internet Archive captures, run through the production materiality engine, found
**2.17 actionable changes per vendor per year** across 26 vendors and 18.9 vendor-years.
Enough to alert on — heavily concentrated, with a median vendor changing once and Google
Cloud, GitHub, and Figma each changing six times. The run also found a false-positive
bug in the clause path, since fixed.

Step 3 — asking ~50 real buyers whether they would pay — has **not** been run. That is
the open question. `scripts/gap-report.ts` generates the per-prospect findings that
outreach needs, from verified data only.

## Not built

- Step 3 of validation: talking to real buyers (the actual next step)
- JS-rendered page support beyond a plain fetch
- SSO, questionnaire automation, AI risk scoring — deliberately out of scope; each one
  converts a passive product into a job

## License

MIT — see [LICENSE](LICENSE).

## Reading order

Start with [`PRODUCT.md`](PRODUCT.md) for why this product and not another one — the
selection criteria, the rejected alternatives, the pricing logic, and the honest risks.
Then [`src/materiality.ts`](src/materiality.ts), which is the decision everything else
exists to serve.
