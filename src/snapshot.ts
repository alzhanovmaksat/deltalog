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

  // Always parse clauses on a DPA. Elsewhere, only bother when the entity path came up
  // empty — a page that yielded a clean subprocessor table has nothing to gain from a
  // clause tree, and running both doubles the work on every check forever.
  const clauses = kind === 'dpa' || entities.length === 0 ? extractClauses(normalizedText) : [];

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
