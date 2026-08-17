/**
 * Subprocessor entity extraction.
 *
 * Feeds the precise path in `materiality.ts`. Everything good about this product
 * happens when this function returns a clean list, and everything bad happens when it
 * returns a *wrong* one: a bogus extraction doesn't degrade the alert, it manufactures
 * a diff. Twenty phantom subprocessors "added" because a pricing table got parsed is
 * worse than no extraction at all — the fallback paths handle silence gracefully, but
 * nothing downstream can tell a hallucinated entity from a real one.
 *
 * So this module is tuned for precision over recall throughout. The governing rule:
 *
 *   A table qualifies only if it has an identifiable NAME column *and* at least one
 *   purpose or jurisdiction column.
 *
 * Real subprocessor tables essentially always carry name + location and/or purpose.
 * A lone "Company" column is indistinguishable from a pricing table, a leadership
 * page, or an integrations directory — so we decline it and let the clause/text path
 * take over, where the failure mode is a vague alert rather than a fabricated one.
 *
 * No dependencies and no DOM: this runs inside a Cloudflare Worker on pages we do not
 * control. Known limitation: nested <table> markup terminates the outer table early.
 * Modern subprocessor pages don't nest tables; email-style layouts do.
 */

import { inlineText, stripNonContent } from './html.ts';

export interface Entity {
  name: string; // "Snowflake Inc."
  purpose?: string; // "data warehousing"
  jurisdiction?: string; // "US"
}

/** Trailing corporate suffixes. "Snowflake Inc." and "Snowflake, Inc" are one entity. */
const LEGAL_SUFFIX =
  /[,\s]+(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|b\.v|bv|s\.a\.s|sas|s\.a|sa|ag|plc|pty|oy|ab|k\.k|kk|pte)\.?$/i;

/**
 * Canonical identity for a subprocessor. Shared by the extractor (to dedupe) and the
 * differ (to match across revisions) — deliberately one function, because two copies
 * that drift apart would let a vendor be deduped under one rule and diffed under
 * another, which reads downstream as an entity that vanished and reappeared.
 */
export function normalizeEntityName(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  // Twice, so "Foo Company Ltd." collapses fully.
  for (let i = 0; i < 2; i++) {
    const stripped = s.replace(LEGAL_SUFFIX, '').trim();
    if (stripped === s || stripped === '') break;
    s = stripped;
  }
  return s.replace(/[.,]/g, '').trim();
}

/**
 * Vendors write the same jurisdiction a dozen ways. Keys are punctuation-free because
 * the normaliser strips punctuation before matching, and they are applied longest-first
 * so "united states of america" resolves before "united states".
 */
const JURISDICTION_ALIASES: Record<string, string> = {
  'united states of america': 'us',
  'united states': 'us',
  'great britain': 'uk',
  'united kingdom': 'uk',
  'european union': 'eu',
  'u s a': 'us',
  usa: 'us',
  'u s': 'us',
  'u k': 'uk',
  gb: 'uk',
  eea: 'eu',
  deutschland: 'de',
  germany: 'de',
  ireland: 'ie',
};

const ALIAS_PATTERNS = Object.entries(JURISDICTION_ALIASES)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) => [new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to] as const);

/**
 * Jurisdiction cells are lists, and vendors rewrite them constantly without changing
 * what they mean. Three real examples from live pages, all of which used to read as
 * moves:
 *
 *   "United States, Iceland, Germany"  →  "United States, Germany, Iceland"   reordered
 *   "United States, Germany"           →  "United States Germany"             commas dropped
 *   "USA"                              →  "United States"                     renamed
 *
 * Comparing a *set of words* handles all three, which separator-splitting could not:
 * without commas there is nothing to split on, and short of a table of every country
 * name there is no way to find the boundary. Aliases are applied to the whole string
 * first so multi-word names collapse to one token before the split.
 *
 * The compliance question is which jurisdictions, not how they were typed.
 */
export function normalizeJurisdiction(raw?: string): string {
  let s = (raw ?? '')
    .toLowerCase()
    .replace(/[.,;/()&]/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, replacement] of ALIAS_PATTERNS) s = s.replace(pattern, replacement);
  return [...new Set(s.split(' ').filter(Boolean))].sort().join(' ');
}

export function normalizePurpose(raw?: string): string {
  return (raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface EntityFieldChange {
  entity: Entity;
  from: string;
  to: string;
}

export interface EntityDiff {
  added: Entity[];
  removed: Entity[];
  moved: EntityFieldChange[];
  repurposed: EntityFieldChange[];
}

/**
 * The structured entity diff.
 *
 * Lives here, next to the identity rules it depends on, because two callers need the
 * *same* answer: `isMaterialChange` turns it into an alert summary, and the review UI
 * renders it as a table. A UI that recomputed the diff its own way could show a
 * reviewer something subtly different from what triggered the alert they are
 * reviewing — which is the one inconsistency an audit trail cannot tolerate.
 */
export function diffEntities(previous: Entity[], current: Entity[]): EntityDiff {
  const prev = new Map(previous.map((e) => [normalizeEntityName(e.name), e]));
  const curr = new Map(current.map((e) => [normalizeEntityName(e.name), e]));

  const diff: EntityDiff = { added: [], removed: [], moved: [], repurposed: [] };

  for (const [key, entity] of curr) {
    const before = prev.get(key);
    if (!before) {
      diff.added.push(entity);
      continue;
    }
    if (
      normalizeJurisdiction(before.jurisdiction) &&
      normalizeJurisdiction(entity.jurisdiction) &&
      normalizeJurisdiction(before.jurisdiction) !== normalizeJurisdiction(entity.jurisdiction)
    ) {
      diff.moved.push({ entity, from: before.jurisdiction!, to: entity.jurisdiction! });
    }
    if (
      normalizePurpose(before.purpose) &&
      normalizePurpose(entity.purpose) &&
      normalizePurpose(before.purpose) !== normalizePurpose(entity.purpose)
    ) {
      diff.repurposed.push({ entity, from: before.purpose!, to: entity.purpose! });
    }
  }
  for (const [key, entity] of prev) if (!curr.has(key)) diff.removed.push(entity);

  return diff;
}

// ── column classification ───────────────────────────────────────────────────────

type Role = 'name' | 'purpose' | 'jurisdiction' | 'ignore';

/**
 * First match wins, and the order is load-bearing: "Location of processing" and
 * "Entity country" would both classify as purpose/name respectively if jurisdiction
 * weren't tested first.
 */
const COLUMN_ROLES: { role: Exclude<Role, 'ignore'>; pattern: RegExp }[] = [
  { role: 'jurisdiction', pattern: /location|countr|region|jurisdiction|headquarter|\bhq\b|data cent(?:er|re)|territor|where|domicile/i },
  { role: 'name', pattern: /sub-?processor|sub-?contractor|entity|compan|\bname\b|vendor|provider|supplier|third[- ]part|organi[sz]ation|recipient|partner/i },
  { role: 'purpose', pattern: /purpose|service|descri|activit|function|scope|\buse\b|role|processing/i },
];

function classifyColumn(header: string): Role {
  const hit = COLUMN_ROLES.find((c) => c.pattern.test(header));
  return hit?.role ?? 'ignore';
}

// ── html → text ─────────────────────────────────────────────────────────────────

/** Cell text, minus the footnote markers vendors sprinkle through these tables. */
function textOf(html: string): string {
  return inlineText(html)
    .replace(/\[\d+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[*†‡]+$/, '')
    .trim();
}

/**
 * Rejects cells that are plainly not organisation names — sentences, URLs, dates,
 * empty strings. Cheap, but it is what keeps a stray table from producing entities.
 */
function looksLikeOrgName(s: string): boolean {
  if (s.length < 2 || s.length > 80) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)) return false;
  if (/[.!?]\s+\S/.test(s)) return false; // reads like prose, not a name
  return s.split(/\s+/).length <= 8;
}

// ── tables ──────────────────────────────────────────────────────────────────────

const TABLE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi;

function parseRow(rowHtml: string): { text: string; isHeader: boolean; colspan: number }[] {
  const cells: { text: string; isHeader: boolean; colspan: number }[] = [];
  for (const m of rowHtml.matchAll(CELL)) {
    const colspan = Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2])?.[1] ?? 1);
    cells.push({ text: textOf(m[3]), isHeader: m[1].toLowerCase() === 'th', colspan: Math.min(colspan, 10) });
  }
  return cells;
}

/** Expands colspan so header roles line up with the body columns underneath them. */
function expand(cells: { text: string; colspan: number }[]): string[] {
  return cells.flatMap((c) => Array(c.colspan).fill(c.text));
}

const THEAD = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i;

const rowsOf = (html: string) => [...html.matchAll(ROW)].map((m) => parseRow(m[1])).filter((r) => r.length > 0);

/**
 * Locates the header row.
 *
 * Note what this deliberately does NOT do: pick the first row containing a <th>.
 * Accessible tables mark the *name cell of every body row* as `<th scope="row">`, so
 * that rule silently selects a data row as the header and drops the table entirely.
 * Trust <thead> when present; otherwise take the first row that isn't a full-width
 * title row.
 */
function splitHeader(tableHtml: string): { header: string[]; body: { text: string; colspan: number }[][] } | null {
  const thead = THEAD.exec(tableHtml);
  if (thead) {
    const headRows = rowsOf(thead[1]);
    const body = rowsOf(tableHtml.replace(thead[0], ' '));
    // Multi-row headers exist (grouped columns); the last row is the column-level one.
    if (headRows.length && body.length) return { header: expand(headRows[headRows.length - 1]), body };
    return null;
  }

  const rows = rowsOf(tableHtml);
  let i = 0;
  while (i < rows.length - 1 && rows[i].length === 1) i++; // caption / section-title rows
  if (rows.length - i < 2) return null;
  return { header: expand(rows[i]), body: rows.slice(i + 1) };
}

function parseTable(tableHtml: string): Entity[] {
  const split = splitHeader(tableHtml);
  if (!split) return [];
  const { header, body } = split;

  const roles = header.map(classifyColumn);
  const purposeIdx = roles.indexOf('purpose');
  const jurisdictionIdx = roles.indexOf('jurisdiction');

  // The governing rule: a name column is not enough on its own.
  if (purposeIdx === -1 && jurisdictionIdx === -1) return [];

  let nameIdx = roles.indexOf('name');
  if (nameIdx === -1) {
    // Header didn't name its own name column ("Who", "Party"). Accept column 0 only if
    // its values actually read like organisations.
    const first = body.map((r) => r[0]?.text ?? '').filter(Boolean);
    const orgish = first.filter(looksLikeOrgName).length;
    if (first.length < 2 || orgish / first.length < 0.7) return [];
    nameIdx = 0;
  }

  const entities: Entity[] = [];
  for (const row of body) {
    // Section-divider rows ("EMEA", spanning the full width) have too few cells.
    if (row.length < Math.max(2, Math.ceil(header.length / 2))) continue;
    const name = row[nameIdx]?.text ?? '';
    if (!looksLikeOrgName(name)) continue;
    entities.push({
      name,
      purpose: row[purposeIdx]?.text || undefined,
      jurisdiction: row[jurisdictionIdx]?.text || undefined,
    });
  }
  return entities;
}

// ── lists ───────────────────────────────────────────────────────────────────────

const HEADING = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
const LIST = /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ITEM = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const SUBPROCESSOR_HEADING = /sub-?processor|sub-?contractor|third[- ]part|service provider|vendor/i;

/**
 * Only lists that follow a subprocessor-ish heading are considered. Without that
 * anchor, every nav menu and footer on the page becomes a roster of fake vendors —
 * this single guard is the difference between the list path being useful and being
 * the largest source of false diffs in the product.
 */
function parseLists(html: string): Entity[] {
  const anchors = [...html.matchAll(HEADING)]
    .filter((m) => SUBPROCESSOR_HEADING.test(textOf(m[1])))
    .map((m) => m.index + m[0].length);
  if (!anchors.length) return [];

  const entities: Entity[] = [];
  for (const list of html.matchAll(LIST)) {
    const anchor = anchors.find((a) => list.index >= a && list.index - a < 2000);
    if (anchor === undefined) continue;
    const items = [...list[2].matchAll(ITEM)].map((m) => textOf(m[1])).filter(Boolean);
    if (items.length < 3) continue; // too few to distinguish from a nav fragment
    const parsed = items.map(parseListItem).filter((e): e is Entity => e !== null);
    if (parsed.length / items.length >= 0.7) entities.push(...parsed);
  }
  return entities;
}

/** "Snowflake Inc. — data warehousing (United States)" and its common variants. */
function parseListItem(raw: string): Entity | null {
  let text = raw;
  let jurisdiction: string | undefined;

  const paren = /\(([^()]{2,40})\)\s*$/.exec(text);
  if (paren && paren[1].split(/\s+/).length <= 5) {
    jurisdiction = paren[1].trim();
    text = text.slice(0, paren.index).trim();
  }

  // Split on dashes, pipes, colons only. Never on commas — "Snowflake, Inc." would
  // lose its own suffix and stop matching itself across revisions.
  const [name, ...rest] = text.split(/\s+[–—|:]\s+|\s+-\s+/);
  const purpose = rest.join(' - ').trim();
  const clean = name.trim();
  return looksLikeOrgName(clean) ? { name: clean, purpose: purpose || undefined, jurisdiction } : null;
}

// ── entry point ─────────────────────────────────────────────────────────────────

/**
 * Later mentions fill in fields the first one lacked — vendors routinely split their
 * list into per-product tables where only one carries the jurisdiction column.
 */
function dedupe(entities: Entity[]): Entity[] {
  const byName = new Map<string, Entity>();
  for (const e of entities) {
    const key = normalizeEntityName(e.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...e });
      continue;
    }
    existing.purpose ??= e.purpose;
    existing.jurisdiction ??= e.jurisdiction;
  }
  return [...byName.values()];
}

export function extractEntities(html: string): Entity[] {
  const clean = stripNonContent(html);
  const fromTables = [...clean.matchAll(TABLE)].flatMap((m) => parseTable(m[1]));
  if (fromTables.length) return dedupe(fromTables);
  return dedupe(parseLists(clean));
}
