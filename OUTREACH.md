# The first 10

Send to these ten. Wait a week. Then decide whether to send forty more.

- **0–1 replies** → stop. You spent two hours finding out.
- **2+ replies asking for more** → send the other forty.

All hooks below came out of `scripts/gap-report.ts` against each company's own published
page. Every one is verifiable at web.archive.org — **check before you send**, because the
whole email rests on its facts surviving a look.

---

## Tier 1 — they publish a readable subprocessor list

These five already believe this matters. That is the strongest qualifier we found: of 27
companies scanned, only 7 published a list a tool could read.

### 1. PlanetScale — `planetscale.com` · database infrastructure
**Best target on the list.** 16 disclosed vendors, and the two that change most in our
whole dataset are both theirs.

> Six of the vendors on your subprocessor list publish nothing anyone can track —
> AWS, Okta, Salesforce, SendGrid, Segment, Zendesk. Meanwhile GitHub, also on your
> list, changed its own subprocessor list six times in the last twelve months, and
> Google Cloud four.

Find: Head of Security / Platform / Infrastructure.

### 2. Knock — `knock.app` · notifications infrastructure
19 disclosed vendors, five untrackable, and two are AI providers — the sharpest version
of the pitch.

> Five of your nineteen listed subprocessors publish nothing that can be tracked
> automatically — including both of your AI providers. Anthropic publishes theirs in a
> trust portal that renders in the browser, so its contents cannot be fetched, diffed,
> or archived. OpenAI's site returns 403 to automated requests. If either adds a
> downstream processor, there is no mechanism by which you would hear about it.

Find: co-founder or Head of Engineering (small company — founders answer email).

### 3. Secureframe — `secureframe.com` · compliance automation
They sell compliance software, so they will either get it immediately or explain exactly
why it does not matter. Both answers are worth more than a shrug.

> Five of the nineteen subprocessors you disclose publish nothing anyone can
> automatically track — including AWS, Azure, OpenAI, and Anthropic. You sell vendor
> management; how do your customers handle the vendors that publish nothing?

Find: Head of Security or a founder. **Ask them as a peer, not a prospect.**

### 4. Retool — `retool.com` · internal tools
> Three of your ten listed subprocessors are AI providers, and neither of the two
> largest publishes a list anyone can track. Anthropic's is behind a client-rendered
> trust portal — the page loads, but its contents cannot be fetched, diffed, or
> archived. OpenAI returns 403 to automated requests entirely.

Find: Security team via `retool.com/trust`.

### 5. Clerk — `clerk.com` · authentication
Clean readable list, no dramatic hook. Lead with the base rate and the question.

> You publish a proper subprocessor list, which most companies your size do not. Across
> the ~30 vendors I track, pages change about two to three times a year. Do you track
> that for yours, and how?

---

## Tier 2 — their trust page cannot be read by anything

These five publish a page that renders in the browser. The hook is not about their
vendors, it is about **them** — and it is a real problem they may not have noticed.

> Your trust page at {url} renders client-side. Its contents cannot be fetched,
> diffed, or archived — not by me, and not by your auditor. If someone asks what it
> said six months ago, there is no way to produce that.

| # | Company | Why them |
|---|---|---|
| 6 | **WorkOS** `workos.com` | Enterprise auth. Their buyers ask this exact question |
| 7 | **Doppler** `doppler.com` | Secrets management. Compliance is the product |
| 8 | **PostHog** `posthog.com` | Engineering-led, open culture, famously replies |
| 9 | **Ramp** `ramp.com` | Fintech — heaviest compliance burden on the list |
| 10 | **Statsig** `statsig.com` | Infra-adjacent, right size |

---

## Deliberately not on this list

**Vanta.** Their own trust page is client-rendered, which is a delicious hook, and they
are exactly the wrong first recipient. They are the best-resourced company that could
build this in a fortnight. Do not show them until you know whether anyone pays.

**Linear, Tailscale, Render.** No compliance urgency, or no published page at all — the
second is the clearest signal a company is not feeling this yet.

---

## Tracker

| # | Company | Person | Sent | Replied | "Keep sending" | Would pay $39 |
|---|---|---|---|---|---|---|
| 1 | PlanetScale | | | | | |
| 2 | Knock | | | | | |
| 3 | Secureframe | | | | | |
| 4 | Retool | | | | | |
| 5 | Clerk | | | | | |
| 6 | WorkOS | | | | | |
| 7 | Doppler | | | | | |
| 8 | PostHog | | | | | |
| 9 | Ramp | | | | | |
| 10 | Statsig | | | | | |

Full email template and the follow-up are in [VALIDATION.md](VALIDATION.md).

## Provenance

Every hook was regenerated after the jurisdiction fix (commit `dc18629`) and checked:
**zero spurious jurisdiction fragments remain** across all 37 findings. The earlier
warning about not pasting Datadog jurisdiction text no longer applies — that fragment
was a comma being removed, and it is gone.

Findings come from 12 months of Internet Archive captures run through the production
engine. Anything here can be checked at web.archive.org, and should be before it is sent.

**Re-verified the day before sending.** `anthropic.com/subprocessors` returns 200 and
redirects to a client-rendered trust portal at `trust.anthropic.com`; an earlier draft
of the Retool and Knock hooks claimed no page existed, which anyone clicking the link
would have disproved. OpenAI returns 403 on every candidate path. Both hooks now say
precisely what is true, which is also the more interesting claim.
