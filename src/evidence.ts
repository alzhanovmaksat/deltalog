/**
 * Evidence assembly and verification.
 *
 * This is the artifact the product is actually sold on. Detection creates the habit;
 * this is what someone pays for, on the afternoon an auditor asks them to prove they
 * were watching.
 *
 * Which means the standard here is different from the rest of the codebase: an
 * evidence report that overstates coverage is worse than no report. Gaps get reported,
 * failed checks get counted as failures, and a chain we cannot verify is called
 * unverified rather than quietly omitted.
 */

import type { CheckRecord } from './check.ts';
import { sha256Hex } from './snapshot.ts';

/**
 * The hash chain, in one place.
 *
 * `check.ts` writes with this and the verifier below reads with it. Two
 * implementations that drifted apart would produce a verification pass that proves
 * nothing — the failure mode is silent and total, so there is exactly one function.
 */
export async function chainCheckHash(
  prevHash: string | null,
  record: Pick<CheckRecord, 'watchId' | 'checkedAt' | 'outcome' | 'material'> & { contentHash?: string },
): Promise<string> {
  return sha256Hex(
    [prevHash ?? 'genesis', record.watchId, record.checkedAt, record.outcome, record.contentHash ?? '', String(record.material)].join('|'),
  );
}

// ── report shape ────────────────────────────────────────────────────────────────

export interface EvidenceLogRow extends CheckRecord {
  vendor: string;
  url: string;
}

export interface WatchCoverage {
  watchId: string;
  vendor: string;
  url: string;
  checks: number;
  successful: number;
  failed: number;
  /** Successful checks as a share of attempts. Attempts that failed are not coverage. */
  coveragePercent: number;
  /** The number auditors actually probe: the longest stretch with no successful check. */
  longestGapHours: number;
  firstCheck?: string;
  lastCheck?: string;
  changes: number;
}

export interface ChangeEvent {
  at: string;
  vendor: string;
  summary: string;
  severity: 'high' | 'low';
  contentHash?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  decision?: 'accepted' | 'escalated';
  note?: string;
}

export interface VerificationResult {
  intact: boolean;
  recordsVerified: number;
  /** True when the first record in the window links to a check before it. */
  linkedToPriorPeriod: boolean;
  brokenAt?: { checkId: string; checkedAt: string; reason: string };
}

export interface EvidenceReport {
  workspaceName: string;
  generatedAt: string;
  period: { from: string; to: string };
  watches: WatchCoverage[];
  changes: ChangeEvent[];
  totals: { watches: number; checks: number; changes: number; unreviewed: number };
  verification: VerificationResult;
  log: EvidenceLogRow[];
}

export interface ReviewedAlert {
  watchId: string;
  vendor: string;
  createdAt: string;
  summary: string;
  severity: 'high' | 'low';
  contentHash?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  decision?: 'accepted' | 'escalated';
  note?: string;
}

export interface EvidenceStore {
  workspace(id: string): Promise<{ id: string; name: string; plan: string } | null>;
  checksInRange(workspaceId: string, from: string, to: string): Promise<EvidenceLogRow[]>;
  reviewedAlertsInRange(workspaceId: string, from: string, to: string): Promise<ReviewedAlert[]>;
}

// ── verification ────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/**
 * Recomputes the chain and reports the first break.
 *
 * Two distinct claims, deliberately kept apart:
 *   1. each row's own hash matches its contents — catches an edited row
 *   2. each row's `prevHash` equals the previous row's hash — catches a deleted or
 *      inserted one, which claim 1 alone would happily accept
 *
 * The first row in an export window is a special case: its `prevHash` points at a
 * check *outside* the window. That link cannot be verified from this data, so it is
 * surfaced as `linkedToPriorPeriod` rather than asserted or ignored.
 */
export async function verifyChain(rows: EvidenceLogRow[]): Promise<VerificationResult> {
  const byWatch = new Map<string, EvidenceLogRow[]>();
  for (const row of rows) byWatch.set(row.watchId, [...(byWatch.get(row.watchId) ?? []), row]);

  let verified = 0;
  let linkedToPriorPeriod = false;

  for (const chain of byWatch.values()) {
    const ordered = [...chain].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
    if (ordered[0]?.prevHash) linkedToPriorPeriod = true;

    for (let i = 0; i < ordered.length; i++) {
      const row = ordered[i];
      const expected = await chainCheckHash(row.prevHash, row);
      if (expected !== row.hash) {
        return {
          intact: false,
          recordsVerified: verified,
          linkedToPriorPeriod,
          brokenAt: { checkId: row.id, checkedAt: row.checkedAt, reason: 'record contents do not match its hash' },
        };
      }
      if (i > 0 && row.prevHash !== ordered[i - 1].hash) {
        return {
          intact: false,
          recordsVerified: verified,
          linkedToPriorPeriod,
          brokenAt: { checkId: row.id, checkedAt: row.checkedAt, reason: 'chain link broken — a record may have been removed or inserted' },
        };
      }
      verified++;
    }
  }

  return { intact: true, recordsVerified: verified, linkedToPriorPeriod };
}

// ── coverage ────────────────────────────────────────────────────────────────────

/**
 * Longest stretch without a *successful* check, measured against the period edges as
 * well as between checks. A watch that started mid-period or died before the end has
 * a gap, and pretending otherwise is the exact overstatement this report exists to
 * avoid.
 */
function longestGapHours(successTimes: number[], from: number, to: number): number {
  const points = [from, ...successTimes, to];
  let longest = 0;
  for (let i = 1; i < points.length; i++) longest = Math.max(longest, points[i] - points[i - 1]);
  return Math.round((longest / HOUR) * 10) / 10;
}

export async function buildEvidenceReport(
  store: EvidenceStore,
  params: { workspaceId: string; from: string; to: string; generatedAt?: Date },
): Promise<EvidenceReport> {
  const workspace = await store.workspace(params.workspaceId);
  if (!workspace) throw new Error(`unknown workspace: ${params.workspaceId}`);

  const log = await store.checksInRange(params.workspaceId, params.from, params.to);
  const alerts = await store.reviewedAlertsInRange(params.workspaceId, params.from, params.to);
  const verification = await verifyChain(log);

  const from = Date.parse(params.from);
  const to = Date.parse(params.to);

  const byWatch = new Map<string, EvidenceLogRow[]>();
  for (const row of log) byWatch.set(row.watchId, [...(byWatch.get(row.watchId) ?? []), row]);

  const watches: WatchCoverage[] = [...byWatch.entries()]
    .map(([watchId, rows]) => {
      const ordered = [...rows].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
      const successful = ordered.filter((r) => r.outcome === 'ok');
      return {
        watchId,
        vendor: ordered[0].vendor,
        url: ordered[0].url,
        checks: ordered.length,
        successful: successful.length,
        failed: ordered.length - successful.length,
        coveragePercent: Math.round((successful.length / ordered.length) * 1000) / 10,
        longestGapHours: longestGapHours(successful.map((r) => Date.parse(r.checkedAt)), from, to),
        firstCheck: ordered[0].checkedAt,
        lastCheck: ordered[ordered.length - 1].checkedAt,
        changes: ordered.filter((r) => r.material).length,
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  const changes: ChangeEvent[] = alerts
    .map((a) => ({
      at: a.createdAt,
      vendor: a.vendor,
      summary: a.summary,
      severity: a.severity,
      contentHash: a.contentHash,
      reviewedBy: a.reviewedBy,
      reviewedAt: a.reviewedAt,
      decision: a.decision,
      note: a.note,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    workspaceName: workspace.name,
    generatedAt: (params.generatedAt ?? new Date()).toISOString(),
    period: { from: params.from, to: params.to },
    watches,
    changes,
    totals: {
      watches: watches.length,
      checks: log.length,
      changes: changes.length,
      unreviewed: changes.filter((c) => !c.decision).length,
    },
    verification,
    log,
  };
}
