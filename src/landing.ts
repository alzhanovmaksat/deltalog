/**
 * The marketing landing page.
 *
 * Design thesis: this product's artifact is a log row, and its emotional truth is that
 * most days nothing happens. So the hero is the log — a run of near-identical "no
 * change" records with one that isn't, arriving last. Everything else on the page is
 * quiet so that one row lands.
 *
 * Two disciplines hold it together:
 *   - Monospace does the characterful work, not a display font we can't load anyway.
 *     Every timestamp, hash, price, and eyebrow is set in it. A product that sells a
 *     machine record should look like one.
 *   - `--signal` is the only chromatic colour on the page and it means exactly one
 *     thing: something moved. There is deliberately no green — a compliance tool that
 *     paints reassuring checkmarks is selling the wrong feeling.
 *
 * No client JavaScript, no webfonts, no external requests. The load-in sequence is CSS
 * animation-delay, and it is fully disabled under prefers-reduced-motion.
 */

const STYLE = `
:root{
  --paper:#fbfaf8; --ink:#1a1d23; --quiet:#6b7280; --rule:#e5e4e0;
  --signal:#c0362c; --link:#2c4a7c; --field:#f3f2ef;
}
@media (prefers-color-scheme:dark){
  :root{ --paper:#14161a; --ink:#e8eaed; --quiet:#8b93a1; --rule:#262a31;
         --signal:#e86a5e; --link:#93b4e8; --field:#1b1e24; }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-feature-settings:"kern" 1}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
a{color:var(--link)}
a:focus-visible,.btn:focus-visible{outline:2px solid var(--signal);outline-offset:3px;border-radius:2px}

.shell{max-width:880px;margin:0 auto;padding:0 24px}
.bar{display:flex;justify-content:space-between;align-items:center;padding:20px 0;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
.bar nav a{margin-left:20px;text-decoration:none;color:var(--quiet)}
.bar nav a:hover{color:var(--ink)}
.mark{color:var(--ink);text-decoration:none;letter-spacing:-.02em}
.mark b{color:var(--signal);font-weight:600}

.lede{padding:56px 0 8px}
h1{font-size:clamp(34px,6.2vw,58px);line-height:1.04;letter-spacing:-.035em;font-weight:700;margin:0 0 20px;max-width:16ch}
.lede p{font-size:clamp(17px,2.2vw,20px);color:var(--quiet);max-width:56ch;margin:0 0 28px}
.btn{display:inline-block;background:var(--ink);color:var(--paper);text-decoration:none;
  padding:13px 22px;border-radius:6px;font-weight:600;font-size:16px}
.btn:hover{opacity:.88}
/* Class selectors alone lose to .lede p / .band p, so the utility text is qualified to
   match their specificity. Cheaper than !important and it stays readable. */
.lede p.fine,.band p.fine,p.fine{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:13.5px;color:var(--quiet);margin:14px 0 0;max-width:none}

/* ── signature: the log ── */
.log{border:1px solid var(--rule);border-radius:6px;background:var(--field);
  margin:44px 0 12px;overflow-x:auto}
.log table{width:100%;border-collapse:collapse;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;white-space:nowrap}
.log td{padding:9px 14px;border-bottom:1px solid var(--rule);color:var(--quiet)}
.log tr:last-child td{border-bottom:0}
.log .vendor{color:var(--ink)}
.log .hash{opacity:.55}
.log tr.moved td{color:var(--ink)}
.log tr.moved .what{color:var(--signal);font-weight:600}
.log tr.moved .what::before{content:"▸ "}
.caption{color:var(--quiet);font-size:15px;margin:0 0 8px;max-width:60ch}
.caption strong{color:var(--ink);font-weight:600}

@media (prefers-reduced-motion:no-preference){
  .log tr{opacity:0;animation:settle .5s cubic-bezier(.2,.7,.3,1) forwards;
    animation-delay:calc(var(--i) * 190ms)}
}
@keyframes settle{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

/* ── sections ── */
.band{border-top:1px solid var(--rule);margin-top:64px;padding-top:44px}
.band h2{font-size:clamp(23px,3.4vw,30px);line-height:1.15;letter-spacing:-.025em;margin:0 0 16px;max-width:22ch}
.band p{max-width:62ch;color:var(--quiet)}
.band p.body{color:var(--ink)}
.ask{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:clamp(16px,2.4vw,20px);line-height:1.5;border-left:2px solid var(--signal);
  padding:4px 0 4px 18px;margin:0 0 24px;max-width:52ch;color:var(--ink)}

.steps{display:grid;gap:28px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));margin-top:8px}
.step h3{font-size:17px;margin:8px 0 6px;letter-spacing:-.01em}
.step p{font-size:15px;margin:0}
.stamp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  letter-spacing:.08em;text-transform:uppercase;color:var(--signal)}

.notes{display:grid;gap:26px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:8px}
.note h3{font-size:17px;margin:0 0 6px;letter-spacing:-.01em}
.note p{font-size:15px;margin:0}
.note .mono{font-size:13.5px;color:var(--ink);display:block;margin-top:8px;
  border-left:2px solid var(--rule);padding-left:12px}

.plans{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin:28px 0 16px}
.plan{border:1px solid var(--rule);border-radius:6px;padding:22px}
.plan.pick{border-color:var(--ink)}
.plan h3{margin:0;font-size:15px;letter-spacing:.04em;text-transform:uppercase;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--quiet)}
.price{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:30px;letter-spacing:-.03em;margin:10px 0 14px;color:var(--ink)}
.price span{font-size:13px;color:var(--quiet);letter-spacing:0}
.plan ul{list-style:none;margin:0;padding:0;font-size:14.5px;color:var(--quiet)}
.plan li{padding:5px 0;border-bottom:1px solid var(--rule)}
.plan li:last-child{border-bottom:0}
.plan li b{color:var(--ink);font-weight:600}

.faq{margin-top:8px}
.faq dt{font-weight:600;margin-top:22px}
.faq dd{margin:6px 0 0;color:var(--quiet);max-width:62ch}

.close{border-top:1px solid var(--rule);margin-top:64px;padding:44px 0 24px}
.close p{font-size:clamp(20px,3vw,26px);line-height:1.25;letter-spacing:-.02em;
  color:var(--ink);max-width:24ch;margin:0 0 24px}
footer{border-top:1px solid var(--rule);margin-top:56px;padding:20px 0 60px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--quiet)}
footer a{margin-right:18px}
`;

/**
 * Five days of one watch. Four are identical and grey; the fifth is why the other four
 * are worth paying for. The hashes are real-looking prefixes because the log's whole
 * claim is verifiability — a row without one would undercut the pitch.
 */
const LOG_ROWS: { date: string; outcome: string; hash: string; what: string; moved?: boolean }[] = [
  { date: '2026-02-24 06:00', outcome: 'ok', hash: 'a41f9c…', what: 'no change' },
  { date: '2026-02-25 06:00', outcome: 'ok', hash: 'a41f9c…', what: 'no change' },
  { date: '2026-02-26 06:00', outcome: 'ok', hash: 'a41f9c…', what: 'no change' },
  { date: '2026-02-27 06:00', outcome: 'ok', hash: '7de021…', what: 'Added subprocessor: OpenAI, L.L.C. (US)', moved: true },
  { date: '2026-02-28 06:00', outcome: 'ok', hash: '7de021…', what: 'no change' },
];

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    unit: 'forever',
    pick: false,
    lines: ['<b>3</b> vendors', 'Checked weekly', 'Email alerts', '30 days of history'],
  },
  {
    name: 'Team',
    price: '$39',
    unit: '/month',
    pick: true,
    lines: ['<b>25</b> vendors', 'Checked daily', 'Email and Slack', 'Full history', '<b>Evidence export</b>'],
  },
  {
    name: 'Compliance',
    price: '$99',
    unit: '/month',
    pick: false,
    lines: ['<b>100</b> vendors', 'Checked every 6 hours', 'Webhook and API', 'Hash-chain verification', 'Unlimited seats'],
  },
];

const FAQ: [string, string][] = [
  [
    'How is this different from Vanta or Drata?',
    'They manage your policies, access reviews, and control evidence. Neither watches what your vendors publish on their own websites. DeltaLog fills that gap and exports evidence you attach to the program you already run.',
  ],
  [
    'What happens when a vendor moves the page?',
    'We notice the 404, look for the new location, and adopt it only if the answer is unambiguous. If it is not, we tell you rather than guess — a watch pointed at the wrong page is worse than one that is visibly broken.',
  ],
  [
    'Can I monitor pages that are not in your directory?',
    'Any URL, on any plan. The directory is a shortcut for setup, not a limit on what you can watch.',
  ],
  [
    'What happens to my evidence log if I cancel?',
    'You export it in full before the period ends, and it stays available read-only for 90 days. We do not hold your audit evidence hostage.',
  ],
];

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function landingPage(baseUrl: string): string {
  const logRows = LOG_ROWS.map(
    (row, i) => `<tr class="${row.moved ? 'moved' : ''}" style="--i:${i}">
      <td>${escape(row.date)}</td>
      <td class="vendor">Datadog</td>
      <td>${escape(row.outcome)}</td>
      <td class="hash">${escape(row.hash)}</td>
      <td class="what">${escape(row.what)}</td>
    </tr>`,
  ).join('');

  const plans = PLANS.map(
    (plan) => `<div class="plan${plan.pick ? ' pick' : ''}">
      <h3>${escape(plan.name)}</h3>
      <div class="price">${escape(plan.price)} <span>${escape(plan.unit)}</span></div>
      <ul>${plan.lines.map((line) => `<li>${line}</li>`).join('')}</ul>
    </div>`,
  ).join('');

  const faq = FAQ.map(([q, a]) => `<dt>${escape(q)}</dt><dd>${escape(a)}</dd>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeltaLog — know the day a vendor changes its subprocessors</title>
<meta name="description" content="DeltaLog checks your vendors' subprocessor lists, DPAs, and trust pages every day, and keeps the timestamped evidence log your auditor asks for. Free for 3 vendors.">
<link rel="canonical" href="${escape(baseUrl)}/">
<meta property="og:title" content="Know the day a vendor changes its subprocessors">
<meta property="og:description" content="Daily checks on your vendors' subprocessor lists and DPAs, plus an evidence log you can export at audit time.">
<style>${STYLE}</style></head>
<body>
<div class="shell">

  <div class="bar">
    <a class="mark mono" href="/"><b>Δ</b> deltalog</a>
    <nav class="mono"><a href="/directory">Directory</a><a href="/login">Sign in</a></nav>
  </div>

  <section class="lede">
    <h1>Your vendors change their subprocessors. Nobody tells you.</h1>
    <p>DeltaLog checks your vendors' subprocessor lists, DPAs, and trust pages every day —
       and keeps the timestamped log your auditor asks for.</p>
    <a class="btn" href="/login">Watch 3 vendors free</a>
    <p class="fine">No credit card. First results in about four minutes.</p>
  </section>

  <div class="log"><table>${logRows}</table></div>
  <p class="caption"><strong>Four checks where nothing changed. One where something did.</strong>
     An audit needs both — you cannot prove continuous coverage with only the interesting days.</p>

  <section class="band">
    <p class="ask">"Show me evidence you monitored your critical vendors during the audit period."</p>
    <p class="body">You cannot produce that after the fact. Either you were watching, or you weren't.</p>
    <p>So it gets done by hand: a spreadsheet, a calendar reminder, four hours a quarter, and a quiet hope
       that no vendor added a subprocessor in a jurisdiction your DPA doesn't cover. Three quarters later,
       that spreadsheet was last touched in March.</p>
  </section>

  <section class="band">
    <h2>What using it actually looks like</h2>
    <div class="steps">
      <div class="step">
        <div class="stamp">Day 0</div>
        <h3>Pick your vendors</h3>
        <p>Paste the list you already have. Sixty vendors are pre-mapped to their subprocessor, DPA,
           and trust pages, so there are no URLs to hunt down.</p>
      </div>
      <div class="step">
        <div class="stamp">Every day</div>
        <h3>We check every page</h3>
        <p>And ignore the cookie banners, rotating testimonials, and "last updated" stamps.
           You hear from us when something that matters moves.</p>
      </div>
      <div class="step">
        <div class="stamp">Audit day</div>
        <h3>Export the period</h3>
        <p>Every check with its timestamp and content hash — including the thousands where nothing
           happened. PDF to read, CSV to sample.</p>
      </div>
    </div>
  </section>

  <section class="band">
    <h2>Three things it does differently</h2>
    <div class="notes">
      <div class="note">
        <h3>Alerts you'll actually read</h3>
        <p>Not "this page changed." The named entity, its purpose, its jurisdiction, and the date:</p>
        <span class="mono">Datadog added Snowflake Inc.<br>(data warehousing, US) on 4 March</span>
      </div>
      <div class="note">
        <h3>A log, not a notification feed</h3>
        <p>Append-only and hash-chained: every record commits to the one before it, so a row that was
           edited or removed is detectable rather than invisible.</p>
      </div>
      <div class="note">
        <h3>Quiet by design</h3>
        <p>Most weeks you will hear nothing from us but a monthly summary. That is the product working,
           and it is why the log matters more than the alerts.</p>
      </div>
    </div>
  </section>

  <section class="band">
    <h2>Cheaper than the spreadsheet</h2>
    <p>Four hours a quarter of your security lead's time runs about $250. Team is $39 a month and it does not forget.</p>
    <div class="plans">${plans}</div>
    <p class="fine">Annual billing takes two months off. Every plan is self-serve — no demo, no call.</p>
  </section>

  <section class="band">
    <h2>Questions worth asking first</h2>
    <dl class="faq">${faq}</dl>
  </section>

  <section class="close">
    <p>The next time your DPA obligations change, you'll find out that day — not in the audit.</p>
    <a class="btn" href="/login">Start watching 3 vendors free</a>
  </section>

  <footer>
    <a href="/directory">Vendor directory</a><a href="/feed.xml">Change feed</a><a href="/login">Sign in</a>
    <div style="margin-top:10px">Δ deltalog</div>
  </footer>

</div></body></html>`;
}
