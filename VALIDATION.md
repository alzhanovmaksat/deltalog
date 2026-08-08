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

### Result: 2.17 actionable changes per vendor per year

| | |
|---|---|
| Vendors with usable Archive history | 26 of 31 |
| Observed vendor-years | 18.9 |
| **Entity-level events** (named, actionable) | **41 → 2.17 / vendor / year** |
| Clause-path events | 0 |
| Text-only events (vague; digest, never a page) | 8 |

This clears the `> 2` band in the table below, which was written down before the data
came in: **alerting leads the pitch.** A 25-vendor Team customer sees roughly four to
five actionable alerts a month.

Only **entity-level** events count toward the headline. Those are named facts — *"added
Snowflake Inc. (data warehousing, US)"* — that a reviewer can act on in forty seconds.
The 8 text-only events are real page edits the extractor could not resolve into named
entities; they are worth logging and worth a digest line, but nobody would pay to
receive *"+140 characters"*, so counting them would inflate the number with noise.

#### An earlier version of this figure was wrong

The first run reported 2.96, with 15 additional changes arriving through the clause
path. Inspecting them rather than the summary statistic showed they were fabricated:

```
airtable: "Entity" was added (+49 other clauses changed)
twilio:   "Supplier Data Protection Addendum" was added   ← in 5 consecutive revisions
```

A subprocessor table was being parsed as a legal document, and a nav link as a clause.
Both are fixed (commit `50baac0`), and the re-run reports **0 clause-path events**.
Notably the 15 phantom events did not reappear as 8 text events one-for-one — Twilio's
underlying page had only changed 3 times, and Sentry's not at all. The old path was
inventing changes, not merely mislabelling them.

**2.96 should not be quoted.** It was 41 real events plus 15 that never happened.

### The distribution matters more than the mean

It is not a uniform 2–3 per vendor. Of the 26 vendors with history:

- **3 vendors** produced 6 changes each: Google Cloud, Figma, GitHub
- **median vendor** produced **1**
- **6 of 26** produced no actionable change at all in a full year

Airtable and Twilio were in the top group before the fix and produce **no actionable
signal at all** — a reminder that the pre-fix leaderboard would have pointed customers
at exactly the wrong vendors.

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

Fifty people, in three tiers, contacted in this order. The order matters — the first
ten teach you how to talk about it before you spend the other forty.

#### Tier 1 — Fractional CISOs and compliance consultants (aim for 10, contact first)

Each carries 8–30 client companies. One yes is worth ten of any other kind, and they
will tell you in one reply whether this is a real problem, because they hit it across a
dozen clients rather than one.

**Where they are:** LinkedIn title search for "fractional CISO", "virtual CISO", "vCISO";
the partner directories of Vanta, Drata, and Secureframe (consultants list themselves
there to get referrals); guest lists of GRC and security podcasts; ISACA and ISSA local
chapter events.

**Why they reply:** your tool makes their service delivery cheaper. They are not buying
software, they are buying back billable hours.

#### Tier 2 — Security or ops leads at 30–300 person B2B SaaS (aim for 30)

Find the *company* first, then the person. Company-level signals are public and fast to
filter; that is where the leverage is.

**Companies that have just proved they care:**

- **Trust-center directories.** SafeBase, Conveyor, and Vanta Trust Center publish
  indexes of companies with live trust pages. A company that stood one up this year has
  a compliance owner and a budget.
- **SOC 2 announcement posts on LinkedIn.** Companies announce Type II certification.
  Anyone posting that in the last six months just went through the vendor-review pain.
- **The subprocessor pages themselves.** Every company that publishes one is a company
  that takes this seriously — including the 31 in this repo's own directory, and every
  vendor named *inside* those lists.
- **Vanta and Drata customer logos and case studies.** Exactly your market, already
  spending on compliance tooling, and already discovering what those tools do not cover.

**Then find the person:** the company's `/security` or `/trust` page usually names a
contact; otherwise search the company on LinkedIn for Head of Security, Security
Engineer, Head of IT/Ops, or — at companies with no security hire — the CTO.

**Reject fast** if: no public trust page or subprocessor list (they do not feel this
yet), fewer than 30 employees (no obligation), or more than ~300 (they have a GRC team
and a procurement process, and you do not want that customer yet).

#### Tier 3 — Communities (aim for 10, and post rather than DM)

`r/grc`, `r/cybersecurity`, ISC2 and ISACA chapter Slacks, and Cloud Security Forum.

In these places **post the finding, do not message individuals.** "Google Cloud added 7
subprocessors in Q1 and I only noticed because I was tracking it — does anyone actually
monitor this?" is a genuine question that surfaces the people who care, and it inverts
the dynamic: they contact you. It is also the only channel here with no privacy
question at all.

### Before you send anything: the legal part

You are selling a compliance product. Breaking email law in the first message is the
single worst first impression available, and your buyers are exactly the people who
will notice.

- **GDPR (EU/UK recipients).** B2B cold email can rest on legitimate interest, but you
  must be able to justify the relevance, identify yourself, link a privacy notice, and
  honour opt-outs immediately. Some member states (Germany, Italy) are stricter — when
  in doubt, skip the recipient rather than argue the point.
- **CAN-SPAM (US).** Identify yourself honestly, include a physical postal address, and
  honour opt-outs within 10 days.
- **Practically:** send from your own domain, one email per person, genuinely
  personalised, no automated sequence, no tracking pixels, and stop the moment anyone
  says stop. All of that also happens to be what makes the email work.

### Budget the time honestly

Fifty genuinely personalised emails is **4–6 hours**, because each needs real findings
about that recipient's own vendors. Ten a day for a week. Anything faster is a mail
merge, and a mail merge will not answer the question you are asking.

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
**2.17 actionable changes per vendor per year**, measured through the corrected engine
across 18.9 vendor-years, and heavily concentrated in a handful of fast-moving vendors.
The signal is real.

**Not established:** that anyone will pay for it. Step 3 has not been run. Everything in
this repository is a well-built answer to a question that has not been asked of a single
real buyer.
