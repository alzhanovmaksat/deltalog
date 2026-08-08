/**
 * Turns fetched HTML into the `PageSnapshot` the materiality filter compares.
 *
 * This is where the decision of *which extractor to run* lives, and it is a cost
 * decision as much as a correctness one: clause extraction on a 400-row subprocessor
 * table is wasted CPU on a Worker with a 50ms budget.
 */

import { extractClauses } from './clauses.ts';
import { extractEntities } from './entities.ts';
import { htmlToText } from './html.ts';
import type { PageKind, PageSnapshot } from './materiality.ts';

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildSnapshot(html: string, kind: PageKind, fetchedAt = new Date()): PageSnapshot {
  const normalizedText = htmlToText(html);
  const entities = extractEntities(html);

  // Clauses are parsed for DPAs only.
  //
  // This used to also run whenever entity extraction came up empty, on the theory that
  // some structure beats none. Backtesting a year of real pages disproved that: on a
  // subprocessor page we failed to parse, a clause tree is a category error — the page
  // is a table of vendors, not a legal document — and it produced confident nonsense.
  // Twilio reported the same nav link as a newly added clause in five consecutive
  // revisions, because site chrome built from <div>s survives stripChrome and matches
  // unstably from one capture to the next.
  //
  // The honest fallback for an unparseable subprocessor page is the text path: vague,
  // but it never invents a clause that was never there.
  const clauses = kind === 'dpa' ? extractClauses(normalizedText) : [];

  return { html, normalizedText, entities, clauses, fetchedAt: fetchedAt.toISOString() };
}

/**
 * Identity of a page's *content*, for the evidence log.
 *
 * Deliberately hashes the normalized text rather than the raw HTML: a vendor
 * redeploying their site with new asset hashes and inline nonces changes the bytes on
 * every single check, which would make the logged hash useless as proof that nothing
 * moved. The auditor's question is whether the content was stable, not the markup.
 */
export function contentHash(snapshot: PageSnapshot): Promise<string> {
  return sha256Hex(snapshot.normalizedText);
}
