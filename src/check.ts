/**
 * One check of one watch: fetch, extract, judge, and — always — log.
 *
 * The invariant that matters more than any other in this file: **every attempt
 * appends a row to the evidence log, including the failures.** The product's claim is
 * continuous coverage over an audit period, so a check that errors must show up as a
 * logged failure, never as a missing row. A gap in the log is indistinguishable from
 * "we weren't watching", which is the one thing the customer is buying against.
 *
 * Everything here takes its dependencies as arguments so the loop can be tested
 * without a network, a database, or a clock.
 */

import { chainCheckHash } from './evidence.ts';
import type { FetchResult } from './fetch.ts';
import { isMaterialChange, type PageKind, type PageSnapshot } from './materiality.ts';
import { buildSnapshot, contentHash } from './snapshot.ts';

export type WatchStatus = 'healthy' | 'degraded' | 'broken';

export interface Watch {
  id: string;
  workspaceId: string;
  vendor: string;
  url: string;
  kind: PageKind;
  intervalMinutes: number;
  status: WatchStatus;
  consecutiveFailures: number;
  firstFailureAt?: string;
  nextCheckAt: string;
  falsePositivesReported: number;
  /** Serialized `learnedNoisePatterns`, compiled per check. */
  noisePatterns: string[];
}

export interface CheckRecord {
  id: string;
  watchId: string;
  checkedAt: string;
  outcome: FetchResult['outcome'];
  httpStatus?: number;
  contentHash?: string;
  material: boolean;
  summary: string;
  revisionId?: string;
  /** Hash chain: each row commits to the one before it. */
  prevHash: string | null;
  hash: string;
  durationMs: number;
}

export interface Alert {
  workspaceId: string;
  watchId: string;
  kind: 'change' | 'watch_broken' | 'watch_relocated';
  severity: 'high' | 'low';
  summary: string;
  createdAt: string;
}

export interface Store {
  dueWatches(now: Date, limit: number): Promise<Watch[]>;
  latestSnapshot(watchId: string): Promise<PageSnapshot | null>;
  lastCheckHash(watchId: string): Promise<string | null>;
  appendCheck(record: CheckRecord): Promise<void>;
  saveRevision(watchId: string, snapshot: PageSnapshot, hash: string): Promise<string>;
  saveWatch(watch: Watch): Promise<void>;
  enqueueAlert(alert: Alert): Promise<void>;
}

export interface CheckDeps {
  store: Store;
  fetch(url: string): Promise<FetchResult>;
  discover(url: string): Promise<string | null>;
  now(): Date;
}

/** Transient blips shouldn't flip a dashboard to red; three in a row is a pattern. */
const FAILURES_BEFORE_DEGRADED = 3;
/** Matches the promise on the landing page: we self-heal for two days before asking. */
const ESCALATE_AFTER_HOURS = 48;
const MAX_BACKOFF_MINUTES = 24 * 60;

const minutesLater = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000).toISOString();
const hoursBetween = (from: string, to: Date) => (to.getTime() - new Date(from).getTime()) / 3_600_000;

/**
 * Patterns come from our own noise learning, not from users — but they are stored
 * data being compiled into regexes, so they are bounded in count and length and any
 * that fail to compile are dropped rather than throwing mid-check.
 */
function compileNoise(patterns: string[]): RegExp[] {
  return patterns
    .slice(0, 20)
    .filter((p) => p.length <= 200)
    .flatMap((p) => {
      try {
        return [new RegExp(p, 'i')];
      } catch {
        return [];
      }
    });
}


export async function runCheck(watch: Watch, deps: CheckDeps): Promise<CheckRecord> {
  const startedAt = deps.now();
  try {
    return await execute(watch, deps, startedAt);
  } catch (err) {
    // Even an unexpected throw has to leave a row behind.
    const message = err instanceof Error ? err.message : String(err);
    return recordFailure(watch, deps, startedAt, 'error', undefined, `Check failed: ${message}`);
  }
}

async function execute(watch: Watch, deps: CheckDeps, startedAt: Date): Promise<CheckRecord> {
  let result = await deps.fetch(watch.url);
  let url = watch.url;
  let relocated = false;

  if (result.outcome === 'not_found') {
    const candidate = await deps.discover(watch.url);
    if (candidate) {
      const retry = await deps.fetch(candidate);
      if (retry.outcome === 'ok') {
        result = retry;
        url = candidate;
        relocated = true;
      }
    }
  }

  if (result.outcome !== 'ok' || !result.html) {
    return recordFailure(watch, deps, startedAt, result.outcome, result.status, describeFailure(result));
  }

  const snapshot = buildSnapshot(result.html, watch.kind, startedAt);
  const hash = await contentHash(snapshot);
  const previous = await deps.store.latestSnapshot(watch.id);

  const verdict = previous
    ? isMaterialChange(previous, snapshot, {
        kind: watch.kind,
        falsePositivesReported: watch.falsePositivesReported,
        learnedNoisePatterns: compileNoise(watch.noisePatterns),
      })
    : { material: false, summary: 'Baseline established', confidence: 'low' as const };

  // A revision is stored on the baseline and on every material change. Immaterial
  // checks intentionally don't write one — the evidence log records that we looked,
  // and storing an identical snapshot every day would just inflate R2.
  const revisionId =
    !previous || verdict.material ? await deps.store.saveRevision(watch.id, snapshot, hash) : undefined;

  const record = await buildRecord(watch, deps, startedAt, {
    outcome: 'ok',
    httpStatus: result.status,
    contentHash: hash,
    material: verdict.material,
    summary: verdict.summary,
    revisionId,
  });
  await deps.store.appendCheck(record);

  await deps.store.saveWatch({
    ...watch,
    url,
    status: 'healthy',
    consecutiveFailures: 0,
    firstFailureAt: undefined,
    nextCheckAt: minutesLater(startedAt, watch.intervalMinutes),
  });

  if (relocated) {
    // The customer must know the watch now points somewhere else — otherwise the
    // evidence log silently changes subject mid-period.
    await deps.store.enqueueAlert({
      workspaceId: watch.workspaceId,
      watchId: watch.id,
      kind: 'watch_relocated',
      severity: 'low',
      summary: `${watch.vendor}: page moved, now watching ${url}`,
      createdAt: startedAt.toISOString(),
    });
  }
  if (previous && verdict.material) {
    await deps.store.enqueueAlert({
      workspaceId: watch.workspaceId,
      watchId: watch.id,
      kind: 'change',
      severity: verdict.confidence,
      summary: `${watch.vendor}: ${verdict.summary}`,
      createdAt: startedAt.toISOString(),
    });
  }

  return record;
}

function describeFailure(result: FetchResult): string {
  switch (result.outcome) {
    case 'blocked':
      return `Blocked by the vendor's bot protection${result.status ? ` (HTTP ${result.status})` : ''}`;
    case 'not_found':
      return 'Page not found and no unambiguous replacement located';
    case 'timeout':
      return 'Vendor did not respond in time';
    default:
      return `Fetch failed${result.status ? ` (HTTP ${result.status})` : ''}`;
  }
}

async function recordFailure(
  watch: Watch,
  deps: CheckDeps,
  startedAt: Date,
  outcome: FetchResult['outcome'],
  httpStatus: number | undefined,
  summary: string,
): Promise<CheckRecord> {
  const consecutiveFailures = watch.consecutiveFailures + 1;
  const firstFailureAt = watch.firstFailureAt ?? startedAt.toISOString();

  let status: WatchStatus = 'healthy';
  if (consecutiveFailures >= FAILURES_BEFORE_DEGRADED) status = 'degraded';
  if (status === 'degraded' && hoursBetween(firstFailureAt, startedAt) >= ESCALATE_AFTER_HOURS) status = 'broken';

  // Back off hard on a block: hammering a bot wall is how a soft block becomes a
  // permanent one.
  const multiplier = Math.min(2 ** Math.min(consecutiveFailures, 3), 8) * (outcome === 'blocked' ? 2 : 1);
  const delay = Math.min(watch.intervalMinutes * multiplier, MAX_BACKOFF_MINUTES);

  const record = await buildRecord(watch, deps, startedAt, {
    outcome,
    httpStatus,
    material: false,
    summary,
  });
  await deps.store.appendCheck(record);

  await deps.store.saveWatch({
    ...watch,
    status,
    consecutiveFailures,
    firstFailureAt,
    nextCheckAt: minutesLater(startedAt, delay),
  });

  // Escalate exactly once, on the transition. A watch that has been broken for a week
  // must not send seven alerts.
  if (status === 'broken' && watch.status !== 'broken') {
    await deps.store.enqueueAlert({
      workspaceId: watch.workspaceId,
      watchId: watch.id,
      kind: 'watch_broken',
      severity: 'high',
      summary: `${watch.vendor}: we haven't been able to check this page for ${Math.floor(
        hoursBetween(firstFailureAt, startedAt),
      )}h — ${summary}`,
      createdAt: startedAt.toISOString(),
    });
  }

  return record;
}

async function buildRecord(
  watch: Watch,
  deps: CheckDeps,
  startedAt: Date,
  fields: Pick<CheckRecord, 'outcome' | 'material' | 'summary'> &
    Partial<Pick<CheckRecord, 'httpStatus' | 'contentHash' | 'revisionId'>>,
): Promise<CheckRecord> {
  const checkedAt = startedAt.toISOString();
  const prevHash = await deps.store.lastCheckHash(watch.id);
  // Written with the same function the evidence export verifies with — see evidence.ts.
  const hash = await chainCheckHash(prevHash, { watchId: watch.id, checkedAt, ...fields });
  return {
    id: globalThis.crypto.randomUUID(),
    watchId: watch.id,
    checkedAt,
    prevHash,
    hash,
    durationMs: deps.now().getTime() - startedAt.getTime(),
    ...fields,
  };
}
