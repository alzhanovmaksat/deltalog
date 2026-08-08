/**
 * DPA clause extraction and diffing.
 *
 * Prose legal pages have no entity table, so they fall through to the text-length
 * fallback in `materiality.ts` and produce the worst alert in the product:
 * "Page text changed (+140 characters)." Nobody acts on that.
 *
 * This module gives those pages structure. A DPA is not a blob — it is a numbered
 * tree of clauses, and clause identity is stable across revisions even when the
 * surrounding text is rewritten. Once you can say *which clause* moved, you can say
 * whether it was the international-transfer clause (page someone) or the notices
 * clause (log it and move on).
 *
 * Two detectors carry most of the value, and neither needs an LLM:
 *   - operative language: "may" → "will", "shall" → "may", "best efforts" → "reasonable efforts"
 *   - time periods: "72 hours" → "5 business days" in a breach-notification clause
 *
 * Those are the edits that change a customer's obligations, and they are almost
 * invisible in a character-count diff.
 */

export interface Clause {
  /** "7.2", "Annex II". Absent on unnumbered documents. */
  id?: string;
  /** "International Transfers". Absent when a clause runs straight into its body. */
  heading?: string;
  /** Clause body, whitespace-normalized. */
  text: string;
}

export interface ClauseChange {
  kind: 'added' | 'removed' | 'modified';
  id?: string;
  heading?: string;
  topic: string;
  topicWeight: 'high' | 'low';
  /** Human-readable reasons, e.g. `notification period 72 hours → 5 business days`. */
  signals: string[];
  /** First sentence that is new in this revision, truncated. Becomes the alert quote. */
  quote?: string;
  severity: 'high' | 'low';
}

/**
 * The materiality dial for legal prose. First pattern to match wins, headings are
 * tested before bodies. Edit freely — this table encodes a compliance opinion, not
 * a technical constraint, and different programs care about different clauses.
 */
export const CLAUSE_TOPICS: { topic: string; weight: 'high' | 'low'; pattern: RegExp }[] = [
  { topic: 'International transfers', weight: 'high', pattern: /international transfer|cross[- ]border|standard contractual clauses|\bsccs?\b|adequacy decision|third countr|onward transfer/i },
  { topic: 'Subprocessors', weight: 'high', pattern: /sub-?processor|sub-?contractor/i },
  { topic: 'Security measures', weight: 'high', pattern: /security measures|technical and organi[sz]ational|\btoms\b|encryption|pseudonymi[sz]/i },
  { topic: 'Breach notification', weight: 'high', pattern: /personal data breach|security incident|breach notification|notify .{0,40}breach/i },
  { topic: 'Audit rights', weight: 'high', pattern: /\baudit|inspection|on-?site review/i },
  { topic: 'Retention & deletion', weight: 'high', pattern: /retention|deletion|delete|erasure|return of (?:the )?(?:personal )?data/i },
  { topic: 'Data subject rights', weight: 'high', pattern: /data subject (?:request|right)|\bdsar\b|rectification|right to erasure/i },
  { topic: 'Liability', weight: 'high', pattern: /liabilit|indemnif/i },
  { topic: 'Definitions', weight: 'low', pattern: /^definitions|shall have the meaning|as defined in/i },
  { topic: 'Governing law', weight: 'low', pattern: /governing law|jurisdiction|venue|choice of law/i },
  { topic: 'Notices', weight: 'low', pattern: /notices? (?:shall|will|must) be|notice address/i },
  { topic: 'Boilerplate', weight: 'low', pattern: /order of precedence|entire agreement|counterparts|severability|headings are for/i },
];

/**
 * Phrases that carry legal weight, longest first — "shall not" is masked before
 * "shall" so a single occurrence isn't counted twice.
 */
const OPERATIVE_PHRASES = [
  'commercially reasonable efforts',
  'without undue delay',
  'is not required to',
  'at its discretion',
  'reasonable efforts',
  'best efforts',
  'shall not',
  'may not',
  'will not',
  'shall',
  'must',
  'may',
  'will',
  'should',
  'promptly',
];

const TIME_PERIOD = /\b(\d+)\s*(business days?|working days?|calendar days?|hours?|days?|weeks?|months?|years?)\b/gi;

const NAMED_SECTION = /^(annex|appendix|schedule|exhibit|section|article|clause|part)\s+([0-9]{1,3}|[ivxlc]{1,6}|[a-z])\b[:.–-]?\s*(.*)$/i;
const NUMBERED = /^(\d{1,3}(?:\.\d{1,3}){0,3})[.)]?\s+(.*)$/;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Some html-to-text pipelines hand back a single line. Re-break it on multi-level
 * clause numbers and named sections so the line scanner below has something to work
 * with. Deliberately does not split on bare single digits — "$5 00" and "2026" would
 * shred the document.
 */
function prepare(raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n');
  if (text.split('\n').length >= 3) return text;
  return text
    .replace(/\s+(?=\d{1,3}(?:\.\d{1,3})+[.)]?\s)/g, '\n')
    .replace(/\s+(?=(?:Annex|Appendix|Schedule|Exhibit|Section|Article|Clause)\s+[0-9IVXLC])/g, '\n');
}

function parseHeading(line: string): { id?: string; heading?: string; rest: string } | null {
  const named = NAMED_SECTION.exec(line);
  if (named) {
    const id = `${named[1][0].toUpperCase()}${named[1].slice(1).toLowerCase()} ${named[2].toUpperCase()}`;
    return splitHeadingAndBody(id, named[3]);
  }

  const numbered = NUMBERED.exec(line);
  if (numbered) {
    const id = numbered[1];
    // A bare "2026 was a good year" is prose, not clause 2026.
    const topLevel = Number(id.split('.')[0]);
    if (id.includes('.') || topLevel <= 99) return splitHeadingAndBody(id, numbered[2]);
  }

  // Unnumbered heading: a short, capitalized line that doesn't read as a sentence.
  if (line.length <= 80 && /^[A-Z0-9]/.test(line) && !/[.,;:]$/.test(line) && line.split(/\s+/).length <= 10) {
    return { heading: norm(line), rest: '' };
  }
  return null;
}

/** After the clause number, a short un-punctuated remainder is a heading; anything longer is body. */
function splitHeadingAndBody(id: string, rest: string): { id: string; heading?: string; rest: string } {
  const r = norm(rest);
  if (r && r.length <= 80 && !/[.;]$/.test(r) && r.split(/\s+/).length <= 12) {
    return { id, heading: r, rest: '' };
  }
  return { id, rest: r };
}

export function extractClauses(rawText: string): Clause[] {
  const lines = prepare(rawText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const clauses: Clause[] = [];
  let current: Clause | null = null;
  const flush = () => {
    if (!current) return;
    current.text = norm(current.text);
    if (current.text || current.heading) clauses.push(current);
  };

  for (const line of lines) {
    const head = parseHeading(line);
    if (head) {
      flush();
      current = { id: head.id, heading: head.heading, text: head.rest };
    } else {
      current ??= { text: '' };
      current.text = current.text ? `${current.text} ${line}` : line;
    }
  }
  flush();
  return clauses;
}

// ── matching ────────────────────────────────────────────────────────────────────

const wordSet = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Pairs clauses across two revisions.
 *
 * Heading before number, deliberately. Vendors renumber constantly — insert a new
 * clause 5 and every clause below it shifts — and matching on the number first would
 * report the entire back half of the document as rewritten. The heading survives
 * renumbering; the number does not.
 */
export function matchClauses(prev: Clause[], curr: Clause[]) {
  const pairs: [Clause, Clause][] = [];
  const prevLeft = new Set(prev.keys());
  const currLeft = new Set(curr.keys());

  const joinOn = (key: (c: Clause) => string | undefined) => {
    const index = new Map<string, number[]>();
    for (const i of prevLeft) {
      const k = key(prev[i]);
      if (k) index.set(k, [...(index.get(k) ?? []), i]);
    }
    for (const j of [...currLeft]) {
      const k = key(curr[j]);
      const hits = k ? index.get(k) : undefined;
      if (hits?.length !== 1 || !prevLeft.has(hits[0])) continue; // ambiguous keys are left to similarity
      pairs.push([prev[hits[0]], curr[j]]);
      prevLeft.delete(hits[0]);
      currLeft.delete(j);
    }
  };

  joinOn((c) => c.heading?.toLowerCase());
  joinOn((c) => c.id?.toLowerCase());

  // Whatever is left: best-effort content similarity, so a retitled clause reads as
  // modified rather than as a simultaneous add and remove.
  for (const j of [...currLeft]) {
    let best = -1;
    let bestScore = 0.6;
    for (const i of prevLeft) {
      const score = dice(wordSet(prev[i].text), wordSet(curr[j].text));
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    if (best >= 0) {
      pairs.push([prev[best], curr[j]]);
      prevLeft.delete(best);
      currLeft.delete(j);
    }
  }

  return {
    pairs,
    added: [...currLeft].map((j) => curr[j]),
    removed: [...prevLeft].map((i) => prev[i]),
  };
}

// ── change signals ──────────────────────────────────────────────────────────────

function classify(clause: Clause): { topic: string; weight: 'high' | 'low' } {
  for (const source of [clause.heading, clause.text.slice(0, 400)]) {
    if (!source) continue;
    const hit = CLAUSE_TOPICS.find((t) => t.pattern.test(source));
    if (hit) return { topic: hit.topic, weight: hit.weight };
  }
  return { topic: 'General', weight: 'low' };
}

function operativeCounts(text: string): Map<string, number> {
  let masked = ` ${text.toLowerCase()} `;
  const counts = new Map<string, number>();
  for (const phrase of OPERATIVE_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/ /g, '\\s+')}\\b`, 'g');
    const hits = masked.match(re)?.length ?? 0;
    if (hits) {
      counts.set(phrase, hits);
      masked = masked.replace(re, '   ');
    }
  }
  return counts;
}

function operativeSignal(before: string, after: string): string | null {
  const a = operativeCounts(before);
  const b = operativeCounts(after);
  const shifts: string[] = [];
  for (const phrase of new Set([...a.keys(), ...b.keys()])) {
    const from = a.get(phrase) ?? 0;
    const to = b.get(phrase) ?? 0;
    if (from !== to) shifts.push(`"${phrase}" ${from}→${to}`);
  }
  return shifts.length ? `operative language changed: ${shifts.slice(0, 4).join(', ')}` : null;
}

function timePeriodSignal(before: string, after: string): string | null {
  const read = (s: string) => (s.match(TIME_PERIOD) ?? []).map((m) => norm(m.toLowerCase()));
  const a = read(before);
  const b = read(after);
  const gone = a.filter((x) => !b.includes(x));
  const fresh = b.filter((x) => !a.includes(x));
  if (!gone.length && !fresh.length) return null;
  if (gone.length === 1 && fresh.length === 1) return `time period ${gone[0]} → ${fresh[0]}`;
  return `time periods changed: ${[...gone.map((x) => `-${x}`), ...fresh.map((x) => `+${x}`)].slice(0, 4).join(', ')}`;
}

const sentences = (s: string) => s.split(/(?<=[.;:])\s+/).map(norm).filter((x) => x.length > 15);

function firstNewSentence(before: string, after: string): string | undefined {
  const seen = new Set(sentences(before).map((x) => x.toLowerCase()));
  const fresh = sentences(after).find((x) => !seen.has(x.toLowerCase()));
  if (!fresh) return undefined;
  return fresh.length > 160 ? `${fresh.slice(0, 157)}…` : fresh;
}

export function diffClauses(prev: Clause[], curr: Clause[]): ClauseChange[] {
  const { pairs, added, removed } = matchClauses(prev, curr);
  const changes: ClauseChange[] = [];

  // A clause appearing or vanishing is structural, so it pages regardless of topic —
  // a deleted audit-rights section is exactly the thing you cannot afford to digest.
  for (const c of added) {
    changes.push({ kind: 'added', id: c.id, heading: c.heading, ...classify(c), signals: [], quote: firstNewSentence('', c.text), severity: 'high' });
  }
  for (const c of removed) {
    changes.push({ kind: 'removed', id: c.id, heading: c.heading, ...classify(c), signals: [], severity: 'high' });
  }

  for (const [before, after] of pairs) {
    if (norm(before.text) === norm(after.text) && before.heading === after.heading) continue;
    const topic = classify(after);
    const signals: string[] = [];
    if (before.heading && after.heading && before.heading !== after.heading) {
      signals.push(`retitled "${before.heading}" → "${after.heading}"`);
    }
    const period = timePeriodSignal(before.text, after.text);
    if (period) signals.push(period);
    const operative = operativeSignal(before.text, after.text);
    if (operative) signals.push(operative);

    changes.push({
      kind: 'modified',
      id: after.id ?? before.id,
      heading: after.heading ?? before.heading,
      ...topic,
      signals,
      quote: firstNewSentence(before.text, after.text),
      // A wording change in a low-stakes clause waits for the digest — unless it moved
      // a deadline or flipped an obligation, which matters wherever it happens.
      severity: topic.weight === 'high' || period || operative ? 'high' : 'low',
    });
  }

  return changes.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

export function clauseLabel(c: Pick<ClauseChange, 'id' | 'heading'>): string {
  const id = c.id ? (/^\d/.test(c.id) ? `Section ${c.id}` : c.id) : undefined;
  if (id && c.heading) return `${id} (${c.heading})`;
  if (id) return id;
  if (c.heading) return `"${c.heading}"`;
  return 'An unlabelled clause';
}

/** Renders a clause diff into the alert subject line, or null if nothing moved. */
export function summarizeClauseChanges(
  changes: ClauseChange[],
): { summary: string; confidence: 'high' | 'low' } | null {
  if (!changes.length) return null;
  const high = changes.filter((c) => c.severity === 'high');
  const lead = high[0] ?? changes[0];
  const verb = lead.kind === 'added' ? 'was added' : lead.kind === 'removed' ? 'was removed' : 'changed';

  let summary = `${clauseLabel(lead)} ${verb}`;
  if (lead.signals.length) summary += `: ${lead.signals.join('; ')}`;
  if (lead.quote) summary += ` — "${lead.quote}"`;

  const others = changes.length - 1;
  if (others > 0) summary += ` (+${others} other clause${others > 1 ? 's' : ''} changed)`;

  return { summary, confidence: high.length ? 'high' : 'low' };
}
