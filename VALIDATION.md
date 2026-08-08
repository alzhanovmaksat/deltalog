# Validation

The plan from [`PRODUCT.md §10`](PRODUCT.md). What it is really testing:

> **Do enough vendors change their subprocessor pages often enough that a security lead
> would pay to be told — and if not, is the evidence log alone worth $39/month?**

Everything else about this product is settled. That question is not, and no amount of
engineering answers it.

---

## Step 1–2 — How often do vendor pages actually change?

**Method.** Rather than snapshot 30 vendors and wait three weeks, the check was run
against history: 12 months of Internet Archive captures for each of the 31 resolved
vendors, with consecutive pairs fed through the production materiality engine
(`scripts/backtest-changes.ts`). Same code path that would send a customer an alert.

### Result: roughly 2–3 material changes per vendor per year

| | |
|---|---|
| Vendors with usable Archive history | 26 of 31 |
| Observed vendor-years | 18.9 |
| Changes detected (all) | 56 → **2.96 / vendor / year** |
| Changes detected (entity-level only) | 41 → **2.17 / vendor / year** |

Both figures are reported because the difference is a known weakness, not a rounding
choice. 15 of the 56 came through the *clause* path on pages where entity extraction
returned nothing, and they look like this:

```
airtable: "Entity" was added (+49 other clauses changed)
```

That is a subprocessor table being parsed as a 49-clause document, not a vendor change.
All 15 come from five vendors (Airtable 6, Twilio 5, Amplitude 2, Sentry 1, Braze 1).
**2.17 is the defensible number**; 2.96 is the ceiling.

Either way this clears the top band of the table below: **alerting leads.** A 25-vendor
Team customer sees roughly four to six alerts a month.

### The distribution matters more than the mean

It is not a uniform 2–3 per vendor. Of the 26 vendors with history:

- **5 vendors** produced 5+ changes each (Google Cloud, Airtable, Figma, GitHub, Twilio)
- **median vendor** produced **1**
- **3 vendors** produced none at all in a full year

Google Cloud alone changed six times, adding IBM, NTT DATA, Uber Technologies, and
seven Eviden/Bull entities across the year. Anyone running GCP under a DPA was
obligated to track every one of those.

**This changes onboarding.** Value concentrates in *which* vendors a customer watches,
not how many. Someone monitoring Google Cloud, GitHub, and Figma gets alerts monthly;
someone monitoring Snowflake, Mailchimp, and 1Password may hear nothing for a year and
churn believing the product does not work. The directory already knows which vendors
change most — surfacing that during onboarding is now a priority, not a nicety.

### What kind of changes

| Count | Change |
|---|---|
| 37 | Subprocessor added |
| 2 | Subprocessor removed |
| 2 | Jurisdiction moved |
| 15 | Clause-path artifacts (see above) |

The dominant event is exactly the one the product is named for.

### Real findings, straight from the engine

```
Google Cloud  2025-11 → 2026-01   Added 2 subprocessors: Innodata Inc, Uber Technologies
Google Cloud  2026-01 → 2026-03   Added 7: Eviden USA, BULL LTDA, Eviden Canada +4
Google Cloud  2026-06 → 2026-08   Added 3: IBM Corporation, NTT DATA Americas, Quantiphi
```

These are verifiable and are the raw material for the step 3 emails.

**What the number means**

| Changes per vendor per year | Read |
|---|---|
| **< 0.5** | Alerting is not the product. A 25-vendor customer sees ~1 alert a year. Sell the evidence log, drop the alerting from the pitch, and expect the free tier to convert badly |
| **0.5 – 2** | The design is right as built: quiet most weeks, with the monthly digest and the export carrying retention between real events |
| **> 2** | Alerting leads. A 25-vendor customer sees an alert most months, which is frequent enough to build a habit around — **← the observed result** |

**Limits of this method, stated plainly.** The Archive samples irregularly, so this
*undercounts* — changes between captures are invisible. Pages it never crawled produce
no data rather than a zero. A vendor who redesigned their page may read as one large
change instead of several small ones. Treat the figure as a floor, not a point estimate.

---

## Step 3 — Will anyone pay? (not started — this part is yours)

This step requires emailing ~50 real people. That is your action to take, not something
to automate: it needs your name on it, your judgment about who to contact, and it should
not be sent by a tool that compiled a stranger list.

Below is everything else needed.

### Who to contact

Fifty people matching **all** of:

- Company of **30–300 employees** (small enough to lack a GRC team, large enough to have
  a compliance obligation)
- **B2B SaaS**, so a SOC 2 report is table stakes for their own sales
- Title: Head of Security, Security Engineer, Head of IT/Ops, or CTO at companies with
  no security hire
- Public evidence they care: a trust page, a listed SOC 2, a security page

**Where to find them without buying a list:** companies that recently published a trust
center; SOC 2 announcement posts on LinkedIn; the r/SecurityCareers and
/r/grc communities; local ISSA or CISO-circle Slack groups; and — the highest-signal
source — the customer logos of Vanta and Drata, who are exactly your market.

**Also worth 10 of the 50: fractional CISOs and compliance consultants.** They carry
8–30 clients each. One yes is worth ten of the others, and they are the channel the
business plan actually rests on.

### The email

Send it one at a time, personalized with **their own vendors**. The diff is the demo —
this is not a pitch email that mentions a product, it is a useful artifact that happens
to come from one.

> **Subject:** Google Cloud added 7 subprocessors in Q1 — did you catch it?
>
> Hi {name},
>
> I've been tracking subprocessor pages for ~30 SaaS vendors for the last year. Some of
> the ones on your trust page changed in that time:
>
> • **Google Cloud** added Uber Technologies and Innodata as subprocessors in December,
>   then seven more (Eviden USA, BULL LTDA, Eviden Canada…) in Q1 — six changes in
>   twelve months
> • **GitHub** changed its subprocessor list six times over the year
> • **Figma** changed its list six times
>
> No pitch — I'm trying to find out whether this is useful or whether everyone already
> has it covered. Two questions, one line each is plenty:
>
> 1. Did you know about these?
> 2. Want me to keep sending them?
>
> {your name}

**Use only findings you have actually verified.** Every example above came out of the
backtest and can be checked against the Internet Archive. Swap in the recipient's own
vendors before sending — and if you cannot verify a change, leave it out. The entire
credibility of this email is that the facts in it are true and checkable.

**Why this shape.** It leads with a fact about *their* vendors, not a claim about a
product. It asks a question that is cheap to answer. It does not mention pricing, a
demo, or a trial — those come only if they say yes. And "no pitch" is true, which is why
it works.

### Ask about money only after a yes

When someone says keep sending, reply:

> Glad it's useful. I'm turning this into a proper tool — daily checks on your vendors,
> plus an exportable log for audit evidence. Would you pay $39/month for it?

Ask directly. "Would you find that valuable?" gets a polite yes that means nothing.

### Track it

| Contact | Company | Sent | Replied | "Keep sending" | Would pay $39 | Notes |
|---|---|---|---|---|---|---|

### Kill criteria — decided in advance, on purpose

Of 50 sent:

- **Fewer than 8** ask you to keep sending → the alerts are not interesting enough. Stop
  or reposition entirely around the evidence log.
- **Fewer than 3** say they would pay $39/month → there is no business here at this
  price. Stop.
- **8+ and 3+** → build the list to 60 vendors, deploy, and take the first ten customers
  by hand.

Write down which outcome you got before you rationalize it. The whole point of setting
the threshold in advance is that it is easy to move afterwards.

---

## What is already true, and what is not

**Established:** the product works end to end, runs for free, and 31 of 60 target
vendors publish a monitorable page. Half of any vendor list resists monitoring, which
constrains what can honestly be promised.

**Established as of the backtest:** vendor pages change often enough to alert on —
roughly 2–3 material changes per vendor per year, concentrated in a handful of
fast-moving vendors. The signal is real.

**Not established:** that anyone will pay for it. Step 3 has not been run. Everything in
this repository is a well-built answer to a question that has not been asked of a single
real buyer.
