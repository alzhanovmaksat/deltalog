/**
 * Materiality filter — the core of DeltaLog.
 *
 * Every watch produces a fetched page on a schedule. This module decides the one
 * question the entire product rests on: was that a REAL change, or noise?
 *
 * Get this wrong in either direction and the business fails differently:
 *   - too sensitive  → alert fatigue → users mute alerts → churn
 *   - too permissive → a missed subprocessor addition → the one job, not done
 *
 * These two failure modes are NOT symmetric, and the asymmetry is a product
 * decision, not an engineering one. See `isMaterialChange` below.
 */

import { diffClauses, summarizeClauseChanges, type Clause } from './clauses.ts';
import { diffEntities, type Entity } from './entities.ts';

export type { Entity };

export type PageKind =
  | 'subprocessor_list'  // a table/list of named third parties — highly structured
  | 'dpa'                // legal prose — small wording changes can matter a lot
  | 'security_page'      // marketing-ish prose, frequently restyled
  | 'trust_center'       // often JS-rendered, often has live status widgets
  | 'status';            // changes constantly by design

export interface PageSnapshot {
  /** Raw HTML as fetched. */
  html: string;
  /** Visible text after boilerplate stripping (nav, footer, cookie banner removed). */
  normalizedText: string;
  /**
   * Named entities pulled out of lists/tables: subprocessor names, and where
   * available their purpose and jurisdiction. Empty for unstructured pages.
   */
  entities: Entity[];
  /**
   * Clause tree for prose pages (DPAs, terms), from `extractClauses`. Empty or absent
   * on pages with no legal structure.
   */
  clauses?: Clause[];
  fetchedAt: string; // ISO 8601
}

export interface MaterialityContext {
  kind: PageKind;
  /** How many times this watch has fired an alert the user later marked "not a real change". */
  falsePositivesReported: number;
  /** Text fragments this watch has learned to ignore (rotating banners, nonces, dates). */
  learnedNoisePatterns: RegExp[];
}

export interface MaterialityVerdict {
  material: boolean;
  /** Drives the alert subject line: "Datadog added 2 subprocessors" */
  summary: string;
  /** 'high' pages the user immediately; 'low' waits for the daily digest. */
  confidence: 'high' | 'low';
}

/** Consecutive user-reported false positives before this watch stops paging. */
const FALSE_POSITIVE_MUTE_THRESHOLD = 3;

/** "Snowflake, Cloudflare and 3 more" — alert subjects have to fit in a subject line. */
function nameList(names: string[], max = 3): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** Joins summary fragments without doubling the period after "OpenAI, L.L.C." */
const joinSentences = (parts: string[]) => parts.join('. ').replace(/\.\.(?=\s|$)/g, '.');

function stripNoise(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const p of patterns) {
    // Callers may hand us non-global patterns; force global so every hit is removed.
    out = out.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'), '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Decides whether a fetched page represents a real change.
 *
 * Policy, in order:
 *
 *   1. Both snapshots have extracted entities → diff them as sets. Additions and
 *      jurisdiction moves page immediately; removals and purpose rewording go to the
 *      daily digest. This is the precise path and it writes its own alert summary.
 *
 *   2. Extraction previously worked and now returns nothing → treat as material and
 *      page. This is almost always a restructured page (i.e. a broken watch), and a
 *      broken watch silently reporting "no change" forever is the worst outcome in
 *      the product.
 *
 *   3. Neither snapshot has entities → fall back to comparing noise-stripped text.
 *      Coverage over precision: we would rather send a vague alert than go blind on
 *      a prose DPA. Confidence is `low` except on DPAs, where a one-word change
 *      ("may transfer" → "will transfer") is exactly what the customer is paying for.
 *
 * `falsePositivesReported` only ever downgrades urgency, never materiality. A watch
 * the user keeps correcting stops paging them, but never stops being logged — the
 * evidence log is the product, and training it into silence would defeat it.
 */
export function isMaterialChange(
  previous: PageSnapshot,
  current: PageSnapshot,
  ctx: MaterialityContext,
): MaterialityVerdict {
  const noisy = ctx.falsePositivesReported >= FALSE_POSITIVE_MUTE_THRESHOLD;
  const verdict = (material: boolean, summary: string, confidence: 'high' | 'low'): MaterialityVerdict => ({
    material,
    summary,
    confidence: noisy ? 'low' : confidence,
  });

  const hadEntities = previous.entities.length > 0;
  const hasEntities = current.entities.length > 0;

  // ── 2. Extraction regression ────────────────────────────────────────────────
  if (hadEntities && !hasEntities) {
    return verdict(
      true,
      `Page no longer lists any entities (${previous.entities.length} previously found) — likely restructured`,
      'high',
    );
  }
  if (!hadEntities && hasEntities) {
    return verdict(true, `Now listing ${current.entities.length} entities where none were found before`, 'low');
  }

  // ── 1. Entity-set diff ──────────────────────────────────────────────────────
  if (hadEntities && hasEntities) {
    const diff = diffEntities(previous.entities, current.entities);

    // Additions and jurisdiction moves are the compliance-relevant facts — page now.
    const urgent: string[] = [];
    if (diff.added.length) {
      urgent.push(
        `Added ${diff.added.length} subprocessor${diff.added.length > 1 ? 's' : ''}: ${nameList(diff.added.map((e) => e.name))}`,
      );
    }
    if (diff.moved.length) {
      urgent.push(`Jurisdiction changed: ${nameList(diff.moved.map((m) => `${m.entity.name} (${m.from} → ${m.to})`), 2)}`);
    }
    if (urgent.length) return verdict(true, joinSentences(urgent), 'high');

    // Removals are rarely a compliance problem, but often signal a page rewrite.
    // Purpose text drifts as marketing copy, yet "analytics" → "model training" is
    // real — so both are logged and both wait for the digest.
    const quiet: string[] = [];
    if (diff.removed.length) {
      quiet.push(
        `Removed ${diff.removed.length} subprocessor${diff.removed.length > 1 ? 's' : ''}: ${nameList(diff.removed.map((e) => e.name))}`,
      );
    }
    if (diff.repurposed.length) {
      quiet.push(`Stated purpose changed: ${nameList(diff.repurposed.map((r) => `${r.entity.name} (${r.from} → ${r.to})`), 2)}`);
    }
    if (quiet.length) return verdict(true, joinSentences(quiet), 'low');

    return verdict(false, 'No change to the listed entities', 'low');
  }

  // ── 2b/3a. Clause tree (prose pages: DPAs, terms) ───────────────────────────
  const hadClauses = (previous.clauses?.length ?? 0) > 0;
  const hasClauses = (current.clauses?.length ?? 0) > 0;

  if (hadClauses && !hasClauses) {
    return verdict(
      true,
      `Document structure disappeared (${previous.clauses!.length} clauses previously parsed) — likely rewritten or replaced`,
      'high',
    );
  }
  if (hadClauses && hasClauses) {
    const summarized = summarizeClauseChanges(diffClauses(previous.clauses!, current.clauses!));
    // A parsed clause tree that comes back identical is a real "no change" — unlike the
    // text path, it has already discounted renumbering and reordering.
    if (!summarized) return verdict(false, 'No change to any clause', 'low');
    return verdict(true, summarized.summary, summarized.confidence);
  }

  // ── 3. Text fallback (no structure on either side) ──────────────────────────

  // Status pages change constantly by design. Without entity structure there is no
  // signal here worth sending, so we log the check and stay quiet.
  if (ctx.kind === 'status') {
    return verdict(false, 'Status page — text changes are not tracked as material', 'low');
  }

  const before = stripNoise(previous.normalizedText, ctx.learnedNoisePatterns);
  const after = stripNoise(current.normalizedText, ctx.learnedNoisePatterns);
  if (before === after) return verdict(false, 'No change to page text', 'low');

  const delta = after.length - before.length;
  const direction = delta > 0 ? `+${delta}` : `${delta}`;
  return verdict(
    true,
    `Page text changed (${direction} characters) — no structured list on this page, review the diff`,
    // A DPA is prose, and small wording changes there are the whole point.
    ctx.kind === 'dpa' ? 'high' : 'low',
  );
}
