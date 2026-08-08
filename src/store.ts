/**
 * D1 + R2 implementation of the `Store` interface `runCheck` depends on.
 *
 * Kept behind an interface for one practical reason: the check loop holds all the
 * product logic worth testing, and binding it to D1 would mean every test needed a
 * live database. The fake in `check.test.ts` implements this same contract.
 */

import type { Alert, CheckRecord, Store, Watch } from './check.ts';
import type { NotificationSettings, NotifyStore, StoredAlert } from './notify.ts';
import type { EvidenceLogRow, EvidenceStore, ReviewedAlert } from './evidence.ts';
import type { Entity, PageKind, PageSnapshot } from './materiality.ts';
import type { Clause } from './clauses.ts';
import type { AuthStore, DirectoryStore, OnboardingStore } from './routes.ts';
import type { BillingState, BillingStore, Plan } from './billing.ts';
import { DIRECTORY_WORKSPACE_ID, vendorBySlug, type DirectoryGap, type GapReason } from './directory.ts';
import type { DirectoryChange, DirectoryIndexRow } from './directory-ui.ts';
import type { AlertRecord, QueueItem, ReviewStore } from './review.ts';

/** Minimal structural types for the Cloudflare bindings, so this file needs no SDK. */
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
interface R2Bucket {
  put(key: string, value: string): Promise<unknown>;
}

interface WatchRow {
  id: string;
  workspace_id: string;
  vendor: string;
  url: string;
  kind: string;
  interval_minutes: number;
  status: string;
  consecutive_failures: number;
  first_failure_at: string | null;
  next_check_at: string;
  false_positives_reported: number;
  noise_patterns: string;
}

const uuid = () => globalThis.crypto.randomUUID();

/** Stored JSON is our own, but a corrupt row must not take down the whole cron tick. */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class D1Store implements Store {
  // Plain fields rather than constructor parameter properties: those emit runtime code
  // and so are not erasable TypeScript, which would break `node --test` and force a
  // build step on a repo that currently has neither dependencies nor a toolchain.
  private readonly db: D1Database;
  private readonly bucket?: R2Bucket;

  constructor(db: D1Database, bucket?: R2Bucket) {
    this.db = db;
    this.bucket = bucket;
  }

  async dueWatches(now: Date, limit: number): Promise<Watch[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM watches
         WHERE next_check_at <= ?1 AND status != 'broken'
         ORDER BY next_check_at ASC
         LIMIT ?2`,
      )
      .bind(now.toISOString(), limit)
      .all<WatchRow>();
    return results.map(toWatch);
  }

  async latestSnapshot(watchId: string): Promise<PageSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT captured_at, normalized_text, entities_json, clauses_json
         FROM revisions WHERE watch_id = ?1
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .bind(watchId)
      .first<{ captured_at: string; normalized_text: string; entities_json: string; clauses_json: string }>();
    if (!row) return null;
    return {
      // Raw HTML deliberately not loaded: the differ never reads it, and pulling a
      // megabyte out of R2 on every check to satisfy a type would be pure cost.
      html: '',
      normalizedText: row.normalized_text,
      entities: parseJson<Entity[]>(row.entities_json, []),
      clauses: parseJson<Clause[]>(row.clauses_json, []),
      fetchedAt: row.captured_at,
    };
  }

  async lastCheckHash(watchId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT hash FROM checks WHERE watch_id = ?1 ORDER BY checked_at DESC LIMIT 1`)
      .bind(watchId)
      .first<{ hash: string }>();
    return row?.hash ?? null;
  }

  async appendCheck(record: CheckRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO checks
           (id, watch_id, checked_at, outcome, http_status, content_hash, material, summary, revision_id, prev_hash, hash, duration_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        record.id,
        record.watchId,
        record.checkedAt,
        record.outcome,
        record.httpStatus ?? null,
        record.contentHash ?? null,
        record.material ? 1 : 0,
        record.summary,
        record.revisionId ?? null,
        record.prevHash,
        record.hash,
        record.durationMs,
      )
      .run();
  }

  async saveRevision(watchId: string, snapshot: PageSnapshot, hash: string): Promise<string> {
    const id = uuid();
    const key = `snapshots/${watchId}/${id}.html`;
    // R2 first: a revision row pointing at a body that was never written would leave
    // a hole in the evidence export exactly when someone is relying on it.
    if (this.bucket && snapshot.html) await this.bucket.put(key, snapshot.html);
    await this.db
      .prepare(
        `INSERT INTO revisions (id, watch_id, captured_at, content_hash, normalized_text, entities_json, clauses_json, r2_key)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
      )
      .bind(
        id,
        watchId,
        snapshot.fetchedAt,
        hash,
        snapshot.normalizedText,
        JSON.stringify(snapshot.entities),
        JSON.stringify(snapshot.clauses ?? []),
        this.bucket ? key : null,
      )
      .run();
    return id;
  }

  async saveWatch(watch: Watch): Promise<void> {
    await this.db
      .prepare(
        `UPDATE watches SET url=?2, status=?3, consecutive_failures=?4, first_failure_at=?5,
           next_check_at=?6, noise_patterns=?7
         WHERE id=?1`,
      )
      .bind(
        watch.id,
        watch.url,
        watch.status,
        watch.consecutiveFailures,
        watch.firstFailureAt ?? null,
        watch.nextCheckAt,
        JSON.stringify(watch.noisePatterns),
      )
      .run();
  }

  async enqueueAlert(alert: Alert): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO alerts (id, workspace_id, watch_id, kind, severity, summary, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      )
      .bind(uuid(), alert.workspaceId, alert.watchId, alert.kind, alert.severity, alert.summary, alert.createdAt)
      .run();
  }
}

interface AlertRow {
  id: string;
  workspace_id: string;
  watch_id: string;
  kind: string;
  severity: string;
  summary: string;
  created_at: string;
}

interface SettingsRow {
  workspace_id: string;
  plan: string;
  emails: string;
  slack_webhook_url: string | null;
  digest_cadence: string;
  digest_hour_utc: number;
  last_digest_at: string | null;
}

/** Retries per alert before we stop trying and leave the failure on the record. */
const MAX_DELIVERY_ATTEMPTS = 5;

export class D1NotifyStore implements NotifyStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async pendingAlerts(limit: number, filter: { workspaceId?: string; severity?: 'high' | 'low' } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT id, workspace_id, watch_id, kind, severity, summary, created_at
         FROM alerts
         WHERE delivered_at IS NULL
           AND suppressed_reason IS NULL
           AND delivery_failed = 0
           AND delivery_attempts < ?1
           AND (?2 IS NULL OR workspace_id = ?2)
           AND (?3 IS NULL OR severity = ?3)
         ORDER BY created_at ASC
         LIMIT ?4`,
      )
      .bind(MAX_DELIVERY_ATTEMPTS, filter.workspaceId ?? null, filter.severity ?? null, limit)
      .all<AlertRow>();
    return results.map(toAlert);
  }

  async notificationSettings(workspaceId: string): Promise<NotificationSettings | null> {
    const row = await this.db
      .prepare(
        `SELECT s.*, w.plan FROM notification_settings s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.workspace_id = ?1`,
      )
      .bind(workspaceId)
      .first<SettingsRow>();
    return row ? toSettings(row) : null;
  }

  async recentlyDelivered(watchId: string, summary: string, since: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM alerts
         WHERE watch_id = ?1 AND summary = ?2 AND delivered_at IS NOT NULL AND delivered_at >= ?3
         LIMIT 1`,
      )
      .bind(watchId, summary, since)
      .first<{ hit: number }>();
    return row !== null;
  }

  async markDelivered(ids: string[], at: string): Promise<void> {
    if (!ids.length) return;
    // Ids are our own UUIDs, but they are still interpolated, so they are constrained
    // to the UUID shape before they go anywhere near the statement.
    const safe = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!safe.length) return;
    await this.db
      .prepare(`UPDATE alerts SET delivered_at = ?1 WHERE id IN (${safe.map(() => '?').join(',')})`)
      .bind(at, ...safe)
      .run();
  }

  async markSuppressed(id: string, reason: string): Promise<void> {
    await this.db.prepare(`UPDATE alerts SET suppressed_reason = ?2 WHERE id = ?1`).bind(id, reason).run();
  }

  async recordFailure(id: string, error: string, permanent: boolean): Promise<void> {
    await this.db
      .prepare(
        `UPDATE alerts
         SET delivery_attempts = delivery_attempts + 1,
             delivery_error = ?2,
             delivery_failed = CASE WHEN ?3 = 1 OR delivery_attempts + 1 >= ?4 THEN 1 ELSE 0 END
         WHERE id = ?1`,
      )
      .bind(id, error.slice(0, 500), permanent ? 1 : 0, MAX_DELIVERY_ATTEMPTS)
      .run();
  }

  async disableSlack(workspaceId: string, _reason: string): Promise<void> {
    await this.db
      .prepare(`UPDATE notification_settings SET slack_webhook_url = NULL WHERE workspace_id = ?1`)
      .bind(workspaceId)
      .run();
  }

  async dueDigests(now: Date): Promise<NotificationSettings[]> {
    // Approximate on purpose. The cadence windows are shortened (20h / 6.5d) so a
    // digest is never *skipped* by clock drift or a late tick; the hour check keeps it
    // landing in the workspace's morning.
    const cutoffs = {
      daily: new Date(now.getTime() - 20 * 3_600_000).toISOString(),
      weekly: new Date(now.getTime() - 6.5 * 24 * 3_600_000).toISOString(),
    };
    const { results } = await this.db
      .prepare(
        `SELECT s.*, w.plan FROM notification_settings s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.digest_cadence != 'off'
           AND ?1 >= s.digest_hour_utc
           AND (s.last_digest_at IS NULL
                OR (s.digest_cadence = 'daily'  AND s.last_digest_at < ?2)
                OR (s.digest_cadence = 'weekly' AND s.last_digest_at < ?3))`,
      )
      .bind(now.getUTCHours(), cutoffs.daily, cutoffs.weekly)
      .all<SettingsRow>();
    return results.map(toSettings);
  }

  async recordDigestSent(workspaceId: string, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE notification_settings SET last_digest_at = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, at)
      .run();
  }
}

/** Guard against an export request that would try to page a decade into memory. */
const MAX_EXPORT_ROWS = 200_000;

export class D1EvidenceStore implements EvidenceStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async workspace(id: string) {
    return this.db
      .prepare(`SELECT id, name, plan FROM workspaces WHERE id = ?1`)
      .bind(id)
      .first<{ id: string; name: string; plan: string }>();
  }

  /** Token lookup is by hash — the plaintext token is never stored. */
  async workspaceByTokenHash(tokenHash: string) {
    return this.db
      .prepare(`SELECT id, name, plan FROM workspaces WHERE api_token_hash = ?1`)
      .bind(tokenHash)
      .first<{ id: string; name: string; plan: string }>();
  }

  async checksInRange(workspaceId: string, from: string, to: string): Promise<EvidenceLogRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.watch_id, c.checked_at, c.outcome, c.http_status, c.content_hash,
                c.material, c.summary, c.revision_id, c.prev_hash, c.hash, c.duration_ms,
                w.vendor, w.url
         FROM checks c JOIN watches w ON w.id = c.watch_id
         WHERE w.workspace_id = ?1 AND c.checked_at >= ?2 AND c.checked_at <= ?3
         ORDER BY c.watch_id ASC, c.checked_at ASC
         LIMIT ?4`,
      )
      .bind(workspaceId, from, to, MAX_EXPORT_ROWS)
      .all<Record<string, never>>();
    return results.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      watchId: r.watch_id as string,
      checkedAt: r.checked_at as string,
      outcome: r.outcome as EvidenceLogRow['outcome'],
      httpStatus: (r.http_status as number | null) ?? undefined,
      contentHash: (r.content_hash as string | null) ?? undefined,
      material: r.material === 1,
      summary: r.summary as string,
      revisionId: (r.revision_id as string | null) ?? undefined,
      prevHash: (r.prev_hash as string | null) ?? null,
      hash: r.hash as string,
      durationMs: r.duration_ms as number,
      vendor: r.vendor as string,
      url: r.url as string,
    }));
  }

  async reviewedAlertsInRange(workspaceId: string, from: string, to: string): Promise<ReviewedAlert[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.watch_id, a.created_at, a.summary, a.severity,
                a.reviewed_by, a.reviewed_at, a.decision, a.note, w.vendor
         FROM alerts a JOIN watches w ON w.id = a.watch_id
         WHERE a.workspace_id = ?1 AND a.kind = 'change'
           AND a.created_at >= ?2 AND a.created_at <= ?3
         ORDER BY a.created_at ASC`,
      )
      .bind(workspaceId, from, to)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      watchId: r.watch_id as string,
      vendor: r.vendor as string,
      createdAt: r.created_at as string,
      summary: r.summary as string,
      severity: r.severity as ReviewedAlert['severity'],
      // Alerts don't carry the content hash; it lives on the check record that
      // produced them, and the CSV log is where hash-level detail belongs.
      reviewedBy: (r.reviewed_by as string | null) ?? undefined,
      reviewedAt: (r.reviewed_at as string | null) ?? undefined,
      decision: (r.decision as ReviewedAlert['decision']) ?? undefined,
      note: (r.note as string | null) ?? undefined,
    }));
  }
}

function toAlert(row: AlertRow): StoredAlert {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    watchId: row.watch_id,
    kind: row.kind as StoredAlert['kind'],
    severity: row.severity as StoredAlert['severity'],
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function toSettings(row: SettingsRow): NotificationSettings {
  return {
    workspaceId: row.workspace_id,
    plan: row.plan as NotificationSettings['plan'],
    emails: parseJson<string[]>(row.emails, []),
    slackWebhookUrl: row.slack_webhook_url ?? undefined,
    digestCadence: row.digest_cadence as NotificationSettings['digestCadence'],
    digestHourUtc: row.digest_hour_utc,
    lastDigestAt: row.last_digest_at ?? undefined,
  };
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    vendor: row.vendor,
    url: row.url,
    kind: row.kind as PageKind,
    intervalMinutes: row.interval_minutes,
    status: row.status as Watch['status'],
    consecutiveFailures: row.consecutive_failures,
    firstFailureAt: row.first_failure_at ?? undefined,
    nextCheckAt: row.next_check_at,
    falsePositivesReported: row.false_positives_reported,
    noisePatterns: parseJson<string[]>(row.noise_patterns, []),
  };
}

// ── review + auth ───────────────────────────────────────────────────────────────

interface AlertDetailRow {
  id: string; workspace_id: string; watch_id: string; vendor: string; url: string; kind: string;
  severity: string; summary: string; created_at: string;
  reviewed_by: string | null; reviewed_at: string | null; decision: string | null; note: string | null;
}

const toAlertRecord = (r: AlertDetailRow): AlertRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  watchId: r.watch_id,
  vendor: r.vendor,
  url: r.url,
  kind: r.kind,
  severity: r.severity as AlertRecord['severity'],
  summary: r.summary,
  createdAt: r.created_at,
  reviewedBy: r.reviewed_by ?? undefined,
  reviewedAt: r.reviewed_at ?? undefined,
  decision: (r.decision as AlertRecord['decision']) ?? undefined,
  note: r.note ?? undefined,
});

const ALERT_COLUMNS = `a.id, a.workspace_id, a.watch_id, a.kind, a.severity, a.summary, a.created_at,
       a.reviewed_by, a.reviewed_at, a.decision, a.note, w.vendor, w.url`;

export class D1ReviewStore implements ReviewStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async alert(alertId: string, workspaceId: string): Promise<AlertRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ALERT_COLUMNS} FROM alerts a JOIN watches w ON w.id = a.watch_id
         WHERE a.id = ?1 AND a.workspace_id = ?2`,
      )
      .bind(alertId, workspaceId)
      .first<AlertDetailRow>();
    return row ? toAlertRecord(row) : null;
  }

  async queue(workspaceId: string, limit: number): Promise<QueueItem[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${ALERT_COLUMNS} FROM alerts a JOIN watches w ON w.id = a.watch_id
         WHERE a.workspace_id = ?1 AND a.kind = 'change'
         ORDER BY a.created_at DESC LIMIT ?2`,
      )
      .bind(workspaceId, limit)
      .all<AlertDetailRow>();
    return results.map(toAlertRecord);
  }

  async revisionsAround(watchId: string, at: string) {
    const load = async (sql: string) => {
      const row = await this.db
        .prepare(sql)
        .bind(watchId, at)
        .first<{ captured_at: string; normalized_text: string; entities_json: string; clauses_json: string }>();
      if (!row) return null;
      return {
        html: '',
        normalizedText: row.normalized_text,
        entities: parseJson<Entity[]>(row.entities_json, []),
        clauses: parseJson<Clause[]>(row.clauses_json, []),
        fetchedAt: row.captured_at,
      };
    };
    const columns = 'captured_at, normalized_text, entities_json, clauses_json';
    return {
      previous: await load(
        `SELECT ${columns} FROM revisions WHERE watch_id = ?1 AND captured_at < ?2 ORDER BY captured_at DESC LIMIT 1`,
      ),
      current: await load(
        `SELECT ${columns} FROM revisions WHERE watch_id = ?1 AND captured_at >= ?2 ORDER BY captured_at ASC LIMIT 1`,
      ),
    };
  }

  async recordDecision(input: {
    alertId: string; workspaceId: string; decision: string; reviewer: string; note: string; at: string;
  }): Promise<number> {
    // `decision IS NULL` is the guard that makes two simultaneous reviewers resolve to
    // one winner, and makes a recorded decision permanent.
    const result = await this.db
      .prepare(
        `UPDATE alerts SET decision = ?3, reviewed_by = ?4, reviewed_at = ?5, note = ?6
         WHERE id = ?1 AND workspace_id = ?2 AND decision IS NULL`,
      )
      .bind(input.alertId, input.workspaceId, input.decision, input.reviewer, input.at, input.note)
      .run();
    return result?.meta?.changes ?? 0;
  }
}

export class D1AuthStore implements AuthStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async memberByEmail(email: string) {
    const row = await this.db
      .prepare(`SELECT email, workspace_id FROM members WHERE email = ?1 LIMIT 1`)
      .bind(email)
      .first<{ email: string; workspace_id: string }>();
    return row ? { email: row.email, workspaceId: row.workspace_id } : null;
  }

  async saveMagicLink(input: { tokenHash: string; workspaceId: string; email: string; expiresAt: string }) {
    await this.db
      .prepare(`INSERT INTO magic_links (token_hash, workspace_id, email, expires_at) VALUES (?1,?2,?3,?4)`)
      .bind(input.tokenHash, input.workspaceId, input.email, input.expiresAt)
      .run();
  }

  async consumeMagicLink(tokenHash: string, now: string) {
    // Consume and validate in one statement: a SELECT-then-UPDATE would let the same
    // link be redeemed twice by two requests arriving together.
    const result = await this.db
      .prepare(`UPDATE magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`)
      .bind(tokenHash, now)
      .run();
    if (!result?.meta?.changes) return null;

    const row = await this.db
      .prepare(`SELECT workspace_id, email FROM magic_links WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<{ workspace_id: string; email: string }>();
    return row ? { workspaceId: row.workspace_id, email: row.email } : null;
  }

  async workspaceName(workspaceId: string): Promise<string> {
    const row = await this.db.prepare(`SELECT name FROM workspaces WHERE id = ?1`).bind(workspaceId).first<{ name: string }>();
    return row?.name ?? 'Workspace';
  }
}

// ── directory ───────────────────────────────────────────────────────────────────

/**
 * Every query here is pinned to DIRECTORY_WORKSPACE_ID. Directory watches are ordinary
 * watches owned by a system workspace, which is what lets one crawl serve the public
 * pages, the onboarding baseline, and paying customers at once — but it also means the
 * scoping is the only thing standing between a public page and customer data, so it is
 * hardcoded here rather than passed in.
 */
export class D1DirectoryStore implements DirectoryStore, OnboardingStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async entry(slug: string) {
    const watch = await this.db
      .prepare(`SELECT id, url FROM watches WHERE workspace_id = ?1 AND vendor = ?2 AND kind = 'subprocessor_list' LIMIT 1`)
      .bind(DIRECTORY_WORKSPACE_ID, slug)
      .first<{ id: string; url: string }>();
    if (!watch) return null;

    const revision = await this.db
      .prepare(`SELECT entities_json FROM revisions WHERE watch_id = ?1 ORDER BY captured_at DESC LIMIT 1`)
      .bind(watch.id)
      .first<{ entities_json: string }>();

    const lastCheck = await this.db
      .prepare(`SELECT checked_at FROM checks WHERE watch_id = ?1 AND outcome = 'ok' ORDER BY checked_at DESC LIMIT 1`)
      .bind(watch.id)
      .first<{ checked_at: string }>();

    const { results } = await this.db
      .prepare(
        `SELECT checked_at, summary FROM checks
         WHERE watch_id = ?1 AND material = 1 ORDER BY checked_at DESC LIMIT 25`,
      )
      .bind(watch.id)
      .all<{ checked_at: string; summary: string }>();

    return {
      url: watch.url,
      lastCheckedAt: lastCheck?.checked_at,
      subprocessors: parseJson<Entity[]>(revision?.entities_json, []),
      changes: results.map((r) => ({
        slug,
        vendorName: vendorBySlug(slug)?.name ?? slug,
        at: r.checked_at,
        summary: r.summary,
      })),
    };
  }

  async gaps(): Promise<DirectoryGap[]> {
    const [recorded, broken] = await Promise.all([
      this.db.prepare(`SELECT slug, reason, checked_at FROM directory_gaps`).all<{ slug: string; reason: string; checked_at: string }>(),
      // Live degradation: a watch that was working and has since broken belongs on the
      // page too, and only the watches table knows about it.
      this.db
        .prepare(
          `SELECT vendor AS slug, first_failure_at FROM watches
           WHERE workspace_id = ?1 AND status = 'broken'`,
        )
        .bind(DIRECTORY_WORKSPACE_ID)
        .all<{ slug: string; first_failure_at: string | null }>(),
    ]);

    const gaps = new Map<string, DirectoryGap>();
    for (const row of recorded.results) {
      const vendor = vendorBySlug(row.slug);
      if (vendor) gaps.set(row.slug, { vendor, reason: row.reason as GapReason, checkedAt: row.checked_at });
    }
    // A watch that broke wins over a stale seed row — it is the more recent truth.
    for (const row of broken.results) {
      const vendor = vendorBySlug(row.slug);
      if (vendor) gaps.set(row.slug, { vendor, reason: 'stopped_answering', checkedAt: row.first_failure_at ?? undefined });
    }
    return [...gaps.values()].sort((a, b) => a.vendor.name.localeCompare(b.vendor.name));
  }

  async index(): Promise<DirectoryIndexRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT w.vendor AS slug,
                (SELECT checked_at FROM checks c WHERE c.watch_id = w.id AND c.outcome = 'ok' ORDER BY c.checked_at DESC LIMIT 1) AS last_checked_at,
                (SELECT checked_at FROM checks c WHERE c.watch_id = w.id AND c.material = 1 ORDER BY c.checked_at DESC LIMIT 1) AS last_change_at,
                (SELECT entities_json FROM revisions r WHERE r.watch_id = w.id ORDER BY r.captured_at DESC LIMIT 1) AS entities_json
         FROM watches w WHERE w.workspace_id = ?1 AND w.kind = 'subprocessor_list'`,
      )
      .bind(DIRECTORY_WORKSPACE_ID)
      .all<{ slug: string; last_checked_at: string | null; last_change_at: string | null; entities_json: string | null }>();

    return results.flatMap((r) => {
      const vendor = vendorBySlug(r.slug);
      if (!vendor) return [];
      return [{
        vendor,
        subprocessorCount: parseJson<Entity[]>(r.entities_json, []).length,
        lastCheckedAt: r.last_checked_at ?? undefined,
        lastChangeAt: r.last_change_at ?? undefined,
      }];
    });
  }

  async recentChanges(limit: number): Promise<DirectoryChange[]> {
    const { results } = await this.db
      .prepare(
        `SELECT w.vendor AS slug, c.checked_at, c.summary
         FROM checks c JOIN watches w ON w.id = c.watch_id
         WHERE w.workspace_id = ?1 AND c.material = 1
         ORDER BY c.checked_at DESC LIMIT ?2`,
      )
      .bind(DIRECTORY_WORKSPACE_ID, limit)
      .all<{ slug: string; checked_at: string; summary: string }>();

    return results.flatMap((r) => {
      const vendor = vendorBySlug(r.slug);
      return vendor ? [{ slug: r.slug, vendorName: vendor.name, at: r.checked_at, summary: r.summary }] : [];
    });
  }

  async addFromDirectory(workspaceId: string, slugs: string[]): Promise<number> {
    let added = 0;
    for (const slug of slugs) {
      const vendor = vendorBySlug(slug);
      if (!vendor) continue;
      const source = await this.db
        .prepare(`SELECT url, kind FROM watches WHERE workspace_id = ?1 AND vendor = ?2 LIMIT 1`)
        .bind(DIRECTORY_WORKSPACE_ID, slug)
        .first<{ url: string; kind: string }>();
      if (!source) continue;

      const now = new Date().toISOString();
      const result = await this.db
        .prepare(
          `INSERT INTO watches (id, workspace_id, vendor, url, kind, next_check_at, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
           WHERE NOT EXISTS (SELECT 1 FROM watches WHERE workspace_id = ?2 AND url = ?4)`,
        )
        .bind(uuid(), workspaceId, vendor.name, source.url, source.kind, now)
        .run();
      added += result?.meta?.changes ?? 0;
    }
    return added;
  }
}

// ── billing ─────────────────────────────────────────────────────────────────────

export class D1BillingStore implements BillingStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async workspaceBilling(workspaceId: string): Promise<BillingState | null> {
    const row = await this.db
      .prepare(
        `SELECT w.plan, w.billing_status, w.stripe_customer_id, w.stripe_subscription_id,
                (SELECT COUNT(*) FROM watches x WHERE x.workspace_id = w.id) AS vendor_count
         FROM workspaces w WHERE w.id = ?1`,
      )
      .bind(workspaceId)
      .first<{
        plan: string; billing_status: string | null; stripe_customer_id: string | null;
        stripe_subscription_id: string | null; vendor_count: number;
      }>();
    if (!row) return null;
    return {
      plan: row.plan as Plan,
      status: row.billing_status ?? undefined,
      customerId: row.stripe_customer_id ?? undefined,
      subscriptionId: row.stripe_subscription_id ?? undefined,
      vendorCount: row.vendor_count,
    };
  }

  async workspaceIdByCustomer(customerId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT id FROM workspaces WHERE stripe_customer_id = ?1`)
      .bind(customerId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async claimEvent(eventId: string): Promise<boolean> {
    // INSERT OR IGNORE on a primary key is the atomic claim: exactly one concurrent
    // delivery of the same event reports a row change.
    const result = await this.db
      .prepare(`INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?1, ?2)`)
      .bind(eventId, new Date().toISOString())
      .run();
    return (result?.meta?.changes ?? 0) > 0;
  }

  async lastBillingEventAt(workspaceId: string): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT last_billing_event_at FROM workspaces WHERE id = ?1`)
      .bind(workspaceId)
      .first<{ last_billing_event_at: number | null }>();
    return row?.last_billing_event_at ?? null;
  }

  async applyBilling(input: {
    workspaceId: string; plan: Plan; status: string;
    customerId?: string; subscriptionId?: string; eventCreated: number;
  }): Promise<void> {
    // COALESCE keeps an existing customer/subscription id when an event omits it,
    // rather than blanking the binding we need to resolve later events.
    await this.db
      .prepare(
        `UPDATE workspaces
         SET plan = ?2,
             billing_status = ?3,
             stripe_customer_id = COALESCE(?4, stripe_customer_id),
             stripe_subscription_id = COALESCE(?5, stripe_subscription_id),
             last_billing_event_at = ?6
         WHERE id = ?1`,
      )
      .bind(
        input.workspaceId, input.plan, input.status,
        input.customerId ?? null, input.subscriptionId ?? null, input.eventCreated,
      )
      .run();
  }

  async applyCheckInterval(workspaceId: string, intervalMinutes: number): Promise<void> {
    await this.db
      .prepare(`UPDATE watches SET interval_minutes = ?2 WHERE workspace_id = ?1`)
      .bind(workspaceId, intervalMinutes)
      .run();
  }
}
