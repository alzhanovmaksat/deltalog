import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEvidenceReport,
  chainCheckHash,
  verifyChain,
  type EvidenceLogRow,
  type EvidenceStore,
  type ReviewedAlert,
} from './evidence.ts';
import { exportFilename, exportResponse, toCsv, toPdf } from './export.ts';
import { measure, PdfDocument, toAscii } from './pdf.ts';

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Builds a correctly chained run of checks for one watch, as `check.ts` would write it. */
async function chainOf(
  watchId: string,
  vendor: string,
  entries: { at: string; outcome?: EvidenceLogRow['outcome']; material?: boolean; summary?: string }[],
): Promise<EvidenceLogRow[]> {
  const rows: EvidenceLogRow[] = [];
  let prevHash: string | null = null;
  for (const entry of entries) {
    const base = {
      watchId,
      checkedAt: entry.at,
      outcome: entry.outcome ?? ('ok' as const),
      material: entry.material ?? false,
      contentHash: `content-${entry.at}`,
    };
    const hash = await chainCheckHash(prevHash, base);
    rows.push({
      ...base,
      id: `check-${watchId}-${rows.length}`,
      summary: entry.summary ?? 'No change to the listed entities',
      prevHash,
      hash,
      durationMs: 120,
      vendor,
      url: `https://${vendor.toLowerCase()}.test/sub`,
    });
    prevHash = hash;
  }
  return rows;
}

class FakeEvidenceStore implements EvidenceStore {
  private log: EvidenceLogRow[];
  private alerts: ReviewedAlert[];

  constructor(log: EvidenceLogRow[], alerts: ReviewedAlert[] = []) {
    this.log = log;
    this.alerts = alerts;
  }
  async workspace() {
    return { id: 'ws1', name: 'Acme Corp', plan: 'team' };
  }
  async checksInRange() {
    return this.log;
  }
  async reviewedAlertsInRange() {
    return this.alerts;
  }
}

// ── verification ────────────────────────────────────────────────────────────────

test('an untouched chain verifies', async () => {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-01-01T00:00:00.000Z' }, { at: '2026-01-02T00:00:00.000Z' }]);
  const result = await verifyChain(rows);

  assert.equal(result.intact, true);
  assert.equal(result.recordsVerified, 2);
  assert.equal(result.linkedToPriorPeriod, false);
});

test('editing a record is caught by its own hash', async () => {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-01-01T00:00:00.000Z' }, { at: '2026-01-02T00:00:00.000Z', material: true }]);
  rows[1].material = false; // someone quietly downgrades a detected change

  const result = await verifyChain(rows);
  assert.equal(result.intact, false);
  assert.match(result.brokenAt!.reason, /do not match its hash/);
  assert.equal(result.recordsVerified, 1, 'reports how far it got');
});

test('deleting a record is caught by the chain link, not the row hash', async () => {
  const rows = await chainOf('w1', 'Datadog', [
    { at: '2026-01-01T00:00:00.000Z' },
    { at: '2026-01-02T00:00:00.000Z' },
    { at: '2026-01-03T00:00:00.000Z' },
  ]);
  const withHole = [rows[0], rows[2]]; // every remaining row still hashes correctly

  const result = await verifyChain(withHole);
  assert.equal(result.intact, false);
  assert.match(result.brokenAt!.reason, /removed or inserted/);
});

test('a mid-period export reports its link to the prior period rather than asserting it', async () => {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-02-01T00:00:00.000Z' }, { at: '2026-02-02T00:00:00.000Z' }]);
  const result = await verifyChain(rows.slice(1)); // window starts mid-chain

  assert.equal(result.intact, true);
  assert.equal(result.linkedToPriorPeriod, true);
});

test('each watch is verified as its own chain', async () => {
  const rows = [
    ...(await chainOf('w1', 'Datadog', [{ at: '2026-01-01T00:00:00.000Z' }, { at: '2026-01-02T00:00:00.000Z' }])),
    ...(await chainOf('w2', 'Stripe', [{ at: '2026-01-01T06:00:00.000Z' }])),
  ];
  const result = await verifyChain(rows);
  assert.equal(result.intact, true);
  assert.equal(result.recordsVerified, 3);
});

// ── coverage ────────────────────────────────────────────────────────────────────

test('failed checks reduce coverage instead of being ignored', async () => {
  const rows = await chainOf('w1', 'Datadog', [
    { at: '2026-01-01T00:00:00.000Z' },
    { at: '2026-01-02T00:00:00.000Z', outcome: 'blocked' },
    { at: '2026-01-03T00:00:00.000Z' },
    { at: '2026-01-04T00:00:00.000Z' },
  ]);
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-04T00:00:00.000Z',
  });

  const [watch] = report.watches;
  assert.equal(watch.checks, 4);
  assert.equal(watch.failed, 1);
  assert.equal(watch.coveragePercent, 75);
});

test('the longest gap counts the period edges, not just the space between checks', async () => {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-01-05T00:00:00.000Z' }, { at: '2026-01-06T00:00:00.000Z' }]);
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z', // monitoring only started on the 5th
    to: '2026-01-06T00:00:00.000Z',
  });

  assert.equal(report.watches[0].longestGapHours, 96, 'the unmonitored first four days are a gap');
});

test('a blocked stretch shows up as a gap even though checks were attempted', async () => {
  const rows = await chainOf('w1', 'Datadog', [
    { at: '2026-01-01T00:00:00.000Z' },
    { at: '2026-01-02T00:00:00.000Z', outcome: 'blocked' },
    { at: '2026-01-03T00:00:00.000Z', outcome: 'blocked' },
    { at: '2026-01-04T00:00:00.000Z' },
  ]);
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-04T00:00:00.000Z',
  });
  assert.equal(report.watches[0].longestGapHours, 72);
});

test('unreviewed changes are counted, because that is what an auditor asks about', async () => {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-01-01T00:00:00.000Z', material: true }]);
  const alerts: ReviewedAlert[] = [
    { watchId: 'w1', vendor: 'Datadog', createdAt: '2026-01-01T00:00:00.000Z', summary: 'Added 1 subprocessor: Snowflake Inc.', severity: 'high', reviewedBy: 'jo@acme.test', reviewedAt: '2026-01-01T09:00:00.000Z', decision: 'accepted', note: 'Covered by existing DPA.' },
    { watchId: 'w1', vendor: 'Datadog', createdAt: '2026-01-02T00:00:00.000Z', summary: 'Removed 1 subprocessor: Twilio', severity: 'low' },
  ];
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows, alerts), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T00:00:00.000Z',
  });

  assert.equal(report.totals.changes, 2);
  assert.equal(report.totals.unreviewed, 1);
  assert.equal(report.changes[0].decision, 'accepted');
});

// ── CSV ─────────────────────────────────────────────────────────────────────────

async function sampleReport() {
  const rows = await chainOf('w1', 'Datadog', [{ at: '2026-01-01T00:00:00.000Z', material: true, summary: 'Added 1 subprocessor: Snowflake Inc.' }]);
  return buildEvidenceReport(new FakeEvidenceStore(rows), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T00:00:00.000Z',
    generatedAt: new Date('2026-02-01T10:00:00.000Z'),
  });
}

test('a cell that would execute as a spreadsheet formula is neutralized', async () => {
  const rows = await chainOf('w1', '=cmd|calc', [{ at: '2026-01-01T00:00:00.000Z', summary: '@SUM(A1:A9)' }]);
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows), {
    workspaceId: 'ws1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-02T00:00:00.000Z',
  });

  const csv = toCsv(report);
  assert.match(csv, /'=cmd\|calc/);
  assert.match(csv, /'@SUM\(A1:A9\)/);
  assert.doesNotMatch(csv, /,=cmd/);
});

test('commas and quotes in scraped text do not break the columns', async () => {
  const rows = await chainOf('w1', 'Acme, Inc.', [{ at: '2026-01-01T00:00:00.000Z', summary: 'Added "Snowflake, Inc." as a subprocessor' }]);
  const report = await buildEvidenceReport(new FakeEvidenceStore(rows), { workspaceId: 'ws1', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });

  const csv = toCsv(report);
  assert.match(csv, /"Acme, Inc\."/);
  assert.match(csv, /"Added ""Snowflake, Inc\."" as a subprocessor"/);
  assert.equal(csv.trim().split('\r\n').length, 2);
});

test('the CSV carries the hashes that make the log verifiable', async () => {
  const csv = toCsv(await sampleReport());
  const [header] = csv.split('\r\n');
  assert.equal(header, 'checked_at,vendor,url,outcome,http_status,material_change,summary,content_hash,prev_hash,record_hash,duration_ms');
});

// ── PDF ─────────────────────────────────────────────────────────────────────────

test('the PDF is structurally valid and has an xref table', async () => {
  const bytes = toPdf(await sampleReport());
  const text = new TextDecoder().decode(bytes);

  assert.match(text, /^%PDF-1\.4\n/);
  assert.match(text, /\nxref\n/);
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /startxref\n\d+\n%%EOF\n$/);
});

test('xref offsets point at the objects they claim to', async () => {
  const text = new TextDecoder().decode(toPdf(await sampleReport()));
  const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));

  assert.ok(offsets.length >= 4);
  offsets.forEach((offset, i) => {
    assert.match(text.slice(offset, offset + 20), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1} is where xref says`);
  });
});

test('characters outside WinAnsi are transliterated, not mangled', () => {
  assert.equal(toAscii('72 hours → 5 business days'), '72 hours -> 5 business days');
  assert.equal(toAscii('“may” — ‘will’'), '"may" - \'will\'');
  assert.equal(toAscii('Ünicode'), '?nicode');
});

test('PDF string literals escape their structural characters', () => {
  const doc = new PdfDocument();
  doc.text('Vendor (EU) \\ subsidiary');
  const text = new TextDecoder().decode(doc.build());
  assert.match(text, /\(Vendor \\\(EU\\\) \\\\ subsidiary\) Tj/);
});

test('long text wraps onto multiple pages', () => {
  const doc = new PdfDocument();
  for (let i = 0; i < 200; i++) doc.text(`Line ${i} — a vendor changed something and here is a reasonably long description of it.`);
  const text = new TextDecoder().decode(doc.build());
  const pageCount = Number(/\/Count (\d+)/.exec(text)![1]);

  assert.ok(pageCount > 1, `expected multiple pages, got ${pageCount}`);
  assert.match(text, /\(Page 1 of \d+\)/);
});

test('measurement distinguishes narrow from wide glyphs', () => {
  assert.ok(measure('iiii', 10) < measure('mmmm', 10));
});

// ── response wiring ─────────────────────────────────────────────────────────────

test('the download arrives as an attachment with a period-stamped filename', async () => {
  const report = await sampleReport();
  assert.equal(exportFilename(report, 'csv'), 'deltalog-evidence-acme-corp-2026-01-01-to-2026-01-31.csv');

  const response = exportResponse(report, 'pdf');
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition')!, /attachment; filename="deltalog-evidence-acme-corp/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
