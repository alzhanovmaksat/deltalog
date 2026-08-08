import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractClauses } from './clauses.ts';
import { isMaterialChange } from './materiality.ts';
import type { Entity, MaterialityContext, PageKind, PageSnapshot } from './materiality.ts';

function snap(entities: Entity[], text = 'baseline text'): PageSnapshot {
  return { html: '', normalizedText: text, entities, fetchedAt: new Date().toISOString() };
}

function ctx(kind: PageKind = 'subprocessor_list', overrides: Partial<MaterialityContext> = {}): MaterialityContext {
  return { kind, falsePositivesReported: 0, learnedNoisePatterns: [], ...overrides };
}

const base: Entity[] = [
  { name: 'Snowflake Inc.', purpose: 'data warehousing', jurisdiction: 'US' },
  { name: 'Cloudflare, Inc.', purpose: 'CDN', jurisdiction: 'US' },
];

test('reformatted legal suffixes are not a change', () => {
  const after = [
    { name: 'Snowflake, Inc', purpose: 'data warehousing', jurisdiction: 'United States' },
    { name: 'Cloudflare Inc', purpose: 'CDN', jurisdiction: 'U.S.A.' },
  ];
  const v = isMaterialChange(snap(base), snap(after), ctx());
  assert.equal(v.material, false);
});

test('reordering the table is not a change', () => {
  const v = isMaterialChange(snap(base), snap([...base].reverse()), ctx());
  assert.equal(v.material, false);
});

test('an added subprocessor pages immediately', () => {
  const after = [...base, { name: 'OpenAI, L.L.C.', purpose: 'model inference', jurisdiction: 'US' }];
  const v = isMaterialChange(snap(base), snap(after), ctx());
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'high');
  assert.match(v.summary, /Added 1 subprocessor: OpenAI/);
});

test('a jurisdiction move pages immediately', () => {
  const after = [{ ...base[0], jurisdiction: 'DE' }, base[1]];
  const v = isMaterialChange(snap(base), snap(after), ctx());
  assert.equal(v.confidence, 'high');
  assert.match(v.summary, /Jurisdiction changed.*US → DE/);
});

test('a removal is material but waits for the digest', () => {
  const v = isMaterialChange(snap(base), snap([base[0]]), ctx());
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'low');
  assert.match(v.summary, /Removed 1 subprocessor: Cloudflare/);
});

test('a purpose rewrite is logged quietly', () => {
  const after = [{ ...base[0], purpose: 'model training' }, base[1]];
  const v = isMaterialChange(snap(base), snap(after), ctx());
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'low');
  assert.match(v.summary, /purpose changed/);
});

test('extraction going to zero is treated as a broken watch, not silence', () => {
  const v = isMaterialChange(snap(base), snap([], 'totally new layout'), ctx());
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'high');
  assert.match(v.summary, /no longer lists any entities/);
});

test('text fallback catches prose changes when no entities exist', () => {
  const v = isMaterialChange(snap([], 'we may transfer data'), snap([], 'we will transfer data'), ctx('dpa'));
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'high'); // DPA prose: small wording changes are the point
});

test('learned noise patterns suppress the text fallback', () => {
  const v = isMaterialChange(
    snap([], 'Policy body. Last updated March 3, 2026'),
    snap([], 'Policy body. Last updated March 4, 2026'),
    ctx('security_page', { learnedNoisePatterns: [/Last updated \w+ \d+, \d{4}/] }),
  );
  assert.equal(v.material, false);
});

test('status pages never fire on raw text', () => {
  const v = isMaterialChange(snap([], 'All systems operational'), snap([], 'Degraded performance'), ctx('status'));
  assert.equal(v.material, false);
});

test('a DPA with a parsed clause tree takes the clause path, not the character-count fallback', () => {
  const before = extractClauses('4. International Transfers\nThe Processor may transfer Personal Data outside the EEA.');
  const after = extractClauses('4. International Transfers\nThe Processor will transfer Personal Data outside the EEA.');
  const v = isMaterialChange(
    { ...snap([], 'irrelevant'), clauses: before },
    { ...snap([], 'irrelevant'), clauses: after },
    ctx('dpa'),
  );
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'high');
  assert.match(v.summary, /Section 4 \(International Transfers\) changed/);
  assert.doesNotMatch(v.summary, /characters/);
});

test('a clause tree that stops parsing is a broken watch, not a quiet one', () => {
  const before = extractClauses('1. Scope\nThis addendum applies to all processing.');
  const v = isMaterialChange({ ...snap([]), clauses: before }, { ...snap([]), clauses: [] }, ctx('dpa'));
  assert.equal(v.material, true);
  assert.equal(v.confidence, 'high');
  assert.match(v.summary, /structure disappeared/);
});

test('repeated false positives downgrade urgency but never materiality', () => {
  const after = [...base, { name: 'OpenAI, L.L.C.', purpose: 'model inference', jurisdiction: 'US' }];
  const v = isMaterialChange(snap(base), snap(after), ctx('subprocessor_list', { falsePositivesReported: 4 }));
  assert.equal(v.material, true); // still logged
  assert.equal(v.confidence, 'low'); // but stops paging
});
