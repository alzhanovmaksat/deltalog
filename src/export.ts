/**
 * Renders an `EvidenceReport` into the two artifacts a customer hands to an auditor.
 *
 * The split is deliberate:
 *   - **PDF** is the narrative: coverage per vendor, every change with its review
 *     decision, and the verification statement. It is meant to be read.
 *   - **CSV** is the complete check-by-check log, including the thousands of rows
 *     where nothing happened. It is meant to be sampled and grepped.
 *
 * Putting the full log in the PDF would produce a 700-page document nobody opens;
 * omitting it entirely would drop the proof of continuous coverage. This is how real
 * evidence packages are assembled, and it costs nothing to do both.
 */

import type { EvidenceReport } from './evidence.ts';
import { PdfDocument } from './pdf.ts';

// ── CSV ─────────────────────────────────────────────────────────────────────────

/**
 * Spreadsheet formula injection defense.
 *
 * This file is *going to be opened in Excel* — that is its entire purpose — and its
 * contents include vendor names and page text scraped from third-party websites. A
 * cell beginning `=`, `+`, `-`, `@`, or a control character is executed as a formula
 * on open, which is a remote-code path that ends at the desk of the one person who
 * most needs to trust this document.
 */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');

export function toCsv(report: EvidenceReport): string {
  const header = [
    'checked_at', 'vendor', 'url', 'outcome', 'http_status',
    'material_change', 'summary', 'content_hash', 'prev_hash', 'record_hash', 'duration_ms',
  ];
  const rows = [...report.log]
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt) || a.vendor.localeCompare(b.vendor))
    .map((r) =>
      csvRow([
        r.checkedAt, r.vendor, r.url, r.outcome, r.httpStatus ?? '',
        r.material ? 'yes' : 'no', r.summary, r.contentHash ?? '', r.prevHash ?? '', r.hash, r.durationMs,
      ]),
    );
  // CRLF: the line ending Excel expects, and harmless everywhere else.
  return [csvRow(header), ...rows].join('\r\n') + '\r\n';
}

// ── PDF ─────────────────────────────────────────────────────────────────────────

const day = (iso: string) => iso.slice(0, 10);
const minute = (iso: string) => iso.replace('T', ' ').slice(0, 16);

function verificationStatement(report: EvidenceReport): string[] {
  const { verification: v } = report;
  if (!v.intact) {
    return [
      `VERIFICATION FAILED. The hash chain could not be verified at record ${v.brokenAt?.checkId} ` +
        `(${minute(v.brokenAt?.checkedAt ?? '')}): ${v.brokenAt?.reason}. ` +
        `${v.recordsVerified} records were verified before the break. This report should not be relied upon ` +
        `until the discrepancy is investigated.`,
    ];
  }
  const lines = [
    `Verified. All ${v.recordsVerified} check records in this period hash-match their contents, and each record ` +
      `correctly references the record before it. No record has been altered, inserted, or removed.`,
  ];
  lines.push(
    v.linkedToPriorPeriod
      ? 'The first record in this period references a check that precedes it, so the log is continuous with the prior period. That earlier record is outside this export and was not verified here.'
      : 'This period begins at the start of the monitoring record for these vendors.',
  );
  return lines;
}

export function toPdf(report: EvidenceReport): Uint8Array {
  const doc = new PdfDocument();

  doc.heading('Vendor Monitoring Evidence Report', 18);
  doc.text(report.workspaceName, { size: 11, gap: 10 });
  doc.keyValue('Period', `${day(report.period.from)} to ${day(report.period.to)}`);
  doc.keyValue('Generated', minute(report.generatedAt) + ' UTC');
  doc.keyValue('Vendors monitored', String(report.totals.watches));
  doc.keyValue('Checks performed', String(report.totals.checks));
  doc.keyValue('Changes detected', String(report.totals.changes));
  doc.keyValue('Awaiting review', String(report.totals.unreviewed));
  doc.rule();

  doc.heading('Integrity verification', 13);
  for (const line of verificationStatement(report)) doc.text(line, { gap: 4 });

  doc.heading('Coverage by vendor', 13);
  doc.text(
    'Coverage is successful checks as a share of attempts. "Longest gap" is the longest stretch in the period ' +
      'with no successful check, measured from the start of the period to its end.',
    { size: 9, gap: 6 },
  );
  doc.table(
    ['Vendor', 'Checks', 'Failed', 'Coverage', 'Longest gap', 'Changes'],
    report.watches.map((w) => [
      w.vendor,
      String(w.checks),
      String(w.failed),
      `${w.coveragePercent}%`,
      `${w.longestGapHours}h`,
      String(w.changes),
    ]),
    [34, 12, 12, 14, 16, 12],
  );

  doc.heading('Changes detected', 13);
  if (!report.changes.length) {
    doc.text('No changes were detected on any monitored page during this period.', { gap: 6 });
  } else {
    for (const change of report.changes) {
      doc.text(`${minute(change.at)}  ${change.vendor}`, { size: 10, bold: true });
      doc.text(change.summary, { size: 10, indent: 12 });
      doc.text(
        change.decision
          ? `Reviewed by ${change.reviewedBy ?? 'unknown'} on ${minute(change.reviewedAt ?? '')} - ${change.decision}${change.note ? `: ${change.note}` : ''}`
          : 'Not yet reviewed.',
        { size: 9, indent: 12, gap: 8 },
      );
    }
  }

  doc.heading('Complete check log', 13);
  doc.text(
    `The full record of all ${report.totals.checks} checks in this period — including every check where no change ` +
      'was detected — is provided as an accompanying CSV file, with the content hash and chain hash of each record.',
    { gap: 4 },
  );

  return doc.build();
}

// ── HTTP responses ──────────────────────────────────────────────────────────────

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

export function exportFilename(report: EvidenceReport, extension: 'csv' | 'pdf'): string {
  return `deltalog-evidence-${slug(report.workspaceName)}-${day(report.period.from)}-to-${day(report.period.to)}.${extension}`;
}

export function exportResponse(report: EvidenceReport, format: 'csv' | 'pdf'): Response {
  const body = format === 'csv' ? toCsv(report) : toPdf(report);
  return new Response(body, {
    headers: {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'content-disposition': `attachment; filename="${exportFilename(report, format)}"`,
      // Evidence is generated per request against live data; a cached copy could
      // silently omit checks that happened since.
      'cache-control': 'no-store',
    },
  });
}
