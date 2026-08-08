import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffClauses, extractClauses, summarizeClauseChanges } from './clauses.ts';

const V1 = `
Data Processing Addendum

1. Definitions
Capitalised terms not defined here shall have the meaning given in the Agreement.

2. Subprocessors
The Processor may engage the Subprocessors listed in Annex II. The Processor shall notify the Controller of any intended changes.

3. International Transfers
The Processor may transfer Personal Data outside the EEA where an adequacy decision applies.

4. Breach Notification
The Processor shall notify the Controller without undue delay and in any event within 72 hours of becoming aware of a Personal Data Breach.

5. Notices
Notices shall be sent to legal@example.com and copied to the account owner.
`;

/** Same document, everything below clause 2 renumbered by the insertion of a new clause 3. */
const RENUMBERED = V1.replace('5. Notices', '6. Notices')
  .replace('4. Breach Notification', '5. Breach Notification')
  .replace('3. International Transfers', '4. International Transfers');

const V2 = RENUMBERED.replace(
  '4. International Transfers',
  `3. Security Measures
The Processor shall implement the technical and organisational measures described in Annex I.

4. International Transfers`,
)
  .replace('may transfer Personal Data', 'will transfer Personal Data')
  .replace('within 72 hours', 'within 5 business days')
  .replace('legal@example.com', 'privacy@example.com');

test('extracts numbered clauses with headings and bodies', () => {
  const clauses = extractClauses(V1);
  assert.deepEqual(
    clauses.filter((c) => c.id).map((c) => c.id),
    ['1', '2', '3', '4', '5'],
  );
  const transfers = clauses.find((c) => c.id === '3')!;
  assert.equal(transfers.heading, 'International Transfers');
  assert.match(transfers.text, /^The Processor may transfer Personal Data/);
});

test('re-breaks a document that arrives as a single line', () => {
  const clauses = extractClauses('1.1 Scope This addendum applies. 1.2 Term It lasts. 1.3 Fees None apply.');
  assert.deepEqual(clauses.map((c) => c.id), ['1.1', '1.2', '1.3']);
});

test('renumbering alone is not a change', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(RENUMBERED));
  assert.deepEqual(changes, []);
});

test('an inserted clause is reported as added, at high severity', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(V2));
  const added = changes.find((c) => c.kind === 'added')!;
  assert.equal(added.heading, 'Security Measures');
  assert.equal(added.severity, 'high');
});

test('"may" → "will" is caught as an operative language change', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(V2));
  const transfers = changes.find((c) => c.heading === 'International Transfers')!;
  assert.equal(transfers.severity, 'high');
  assert.equal(transfers.topic, 'International transfers');
  assert.ok(transfers.signals.some((s) => /operative language changed/.test(s)));
  assert.ok(transfers.signals.some((s) => /"may" 1→0/.test(s) && /"will" 0→1/.test(s)));
  assert.match(transfers.quote!, /will transfer Personal Data/);
});

test('a moved deadline is caught even though the wording is otherwise identical', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(V2));
  const breach = changes.find((c) => c.heading === 'Breach Notification')!;
  assert.equal(breach.severity, 'high');
  assert.ok(breach.signals.includes('time period 72 hours → 5 business days'));
});

test('an edit to a low-stakes clause is logged but does not page', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(V2));
  const notices = changes.find((c) => c.heading === 'Notices')!;
  assert.equal(notices.topic, 'Notices');
  assert.equal(notices.severity, 'low');
  assert.deepEqual(notices.signals, []);
});

test('"shall not" is not double-counted as "shall"', () => {
  const before = extractClauses('1. Retention\nThe Processor shall not retain Personal Data after termination.');
  const after = extractClauses('1. Retention\nThe Processor shall retain Personal Data after termination.');
  const [change] = diffClauses(before, after);
  assert.ok(change.signals.some((s) => /"shall not" 1→0/.test(s) && /"shall" 0→1/.test(s)));
});

test('a retitled clause reads as modified, not as an add plus a remove', () => {
  const before = extractClauses('7. Audit Rights\nThe Controller may audit the Processor once per year on thirty days notice.');
  const after = extractClauses('7. Audits and Inspections\nThe Controller may audit the Processor once per year on thirty days notice.');
  const changes = diffClauses(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modified');
  assert.ok(changes[0].signals.some((s) => /retitled/.test(s)));
});

test('summary leads with a high-severity clause and names it', () => {
  const changes = diffClauses(extractClauses(V1), extractClauses(V2));
  const out = summarizeClauseChanges(changes)!;
  assert.equal(out.confidence, 'high');
  assert.match(out.summary, /Section \d+ \(.+\)/);
  assert.match(out.summary, /other clauses changed\)$/);
});

test('an unchanged document summarizes to nothing', () => {
  assert.equal(summarizeClauseChanges(diffClauses(extractClauses(V1), extractClauses(V1))), null);
});

// ── tabular content is not a clause tree ────────────────────────────────────────
// Regression: backtesting a year of live pages showed subprocessor tables surviving
// htmlToText as one short line per cell, each parsing as an unnumbered heading. The
// differ then reported '"Entity" was added (+49 other clauses changed)' every revision.

const TABLE_AS_TEXT = `Airtable Subprocessors | Airtable
Airtable Subprocessors
Third Parties
Entity
Description/Purpose
Countries
Amazon Web Services
Cloud hosting
United States
Snowflake Inc.
Data warehousing
United States
Twilio Inc.
Communications
United States`;

test('a shredded table does not become a clause tree', () => {
  assert.deepEqual(extractClauses(TABLE_AS_TEXT), []);
});

test('a table that changes produces no clause diff at all', () => {
  const after = TABLE_AS_TEXT.replace('Twilio Inc.', 'OpenAI, L.L.C.');
  assert.deepEqual(diffClauses(extractClauses(TABLE_AS_TEXT), extractClauses(after)), []);
  assert.equal(summarizeClauseChanges(diffClauses(extractClauses(TABLE_AS_TEXT), extractClauses(after))), null);
});

test('real prose with mostly-bodied clauses still parses', () => {
  const clauses = extractClauses(V1);
  assert.ok(clauses.length >= 5, 'the DPA fixture is above the size threshold');
  const bodied = clauses.filter((c) => c.text.trim()).length;
  assert.ok(bodied / clauses.length >= 0.5, 'and is mostly bodies, so it survives');
});

test('a short heading-only fragment is still trusted (too small to judge)', () => {
  // Under the threshold we take it at face value rather than guessing.
  const clauses = extractClauses('Scope\nTerm\nFees');
  assert.ok(clauses.length > 0);
});
