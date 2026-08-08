import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCheck, type Alert, type CheckDeps, type CheckRecord, type Store, type Watch } from './check.ts';
import type { FetchResult } from './fetch.ts';
import type { PageSnapshot } from './materiality.ts';

// ── fakes ───────────────────────────────────────────────────────────────────────

class MemoryStore implements Store {
  checks: CheckRecord[] = [];
  alerts: Alert[] = [];
  revisions: PageSnapshot[] = [];
  saved: Watch[] = [];

  async dueWatches() {
    return [];
  }
  async latestSnapshot() {
    return this.revisions.at(-1) ?? null;
  }
  async lastCheckHash() {
    return this.checks.at(-1)?.hash ?? null;
  }
  async appendCheck(record: CheckRecord) {
    this.checks.push(record);
  }
  async saveRevision(_watchId: string, snapshot: PageSnapshot) {
    this.revisions.push(snapshot);
    return `rev-${this.revisions.length}`;
  }
  async saveWatch(watch: Watch) {
    this.saved.push(watch);
  }
  async enqueueAlert(alert: Alert) {
    this.alerts.push(alert);
  }
  /** The watch as it stands after the last save. */
  get watch() {
    return this.saved.at(-1)!;
  }
}

const page = (rows: string) => `
<h2>Subprocessors</h2>
<table><thead><tr><th>Subprocessor</th><th>Purpose</th><th>Location</th></tr></thead>
<tbody>${rows}</tbody></table>`;

const ONE_VENDOR = page('<tr><td>Snowflake Inc.</td><td>Warehousing</td><td>United States</td></tr>');
const TWO_VENDORS = `${ONE_VENDOR.replace('</tbody>', '<tr><td>OpenAI, L.L.C.</td><td>Inference</td><td>United States</td></tr></tbody>')}`;

const ok = (html: string): FetchResult => ({ outcome: 'ok', status: 200, html, url: 'https://v.example/sub', attempts: 1 });
const fail = (outcome: FetchResult['outcome'], status?: number): FetchResult => ({ outcome, status, url: 'https://v.example/sub', attempts: 3 });

function makeWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    workspaceId: 'ws1',
    vendor: 'Vendor Inc.',
    url: 'https://v.example/sub',
    kind: 'subprocessor_list',
    intervalMinutes: 1440,
    status: 'healthy',
    consecutiveFailures: 0,
    nextCheckAt: '2026-01-01T00:00:00.000Z',
    falsePositivesReported: 0,
    noisePatterns: [],
    ...overrides,
  };
}

function makeDeps(
  store: MemoryStore,
  responses: FetchResult[],
  opts: { at?: string; discover?: string | null } = {},
): CheckDeps {
  const queue = [...responses];
  return {
    store,
    fetch: async () => queue.shift() ?? fail('error'),
    discover: async () => opts.discover ?? null,
    now: () => new Date(opts.at ?? '2026-03-01T12:00:00.000Z'),
  };
}

// ── tests ───────────────────────────────────────────────────────────────────────

test('the first check establishes a baseline without alerting', async () => {
  const store = new MemoryStore();
  const record = await runCheck(makeWatch(), makeDeps(store, [ok(ONE_VENDOR)]));

  assert.equal(record.material, false);
  assert.equal(record.summary, 'Baseline established');
  assert.equal(store.revisions.length, 1);
  assert.deepEqual(store.alerts, []);
});

test('an unchanged page logs a check but writes no revision and no alert', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch(), makeDeps(store, [ok(ONE_VENDOR)]));
  await runCheck(makeWatch(), makeDeps(store, [ok(ONE_VENDOR)]));

  assert.equal(store.checks.length, 2, 'every attempt is logged');
  assert.equal(store.revisions.length, 1, 'identical content is not re-stored');
  assert.deepEqual(store.alerts, []);
  assert.equal(store.checks[1].material, false);
});

test('an added subprocessor stores a revision and pages the workspace', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch(), makeDeps(store, [ok(ONE_VENDOR)]));
  const record = await runCheck(makeWatch(), makeDeps(store, [ok(TWO_VENDORS)]));

  assert.equal(record.material, true);
  assert.equal(record.revisionId, 'rev-2');
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].kind, 'change');
  assert.equal(store.alerts[0].severity, 'high');
  assert.match(store.alerts[0].summary, /Vendor Inc\.: Added 1 subprocessor: OpenAI/);
});

test('a failed fetch still appends an evidence row — the log must have no gaps', async () => {
  const store = new MemoryStore();
  const record = await runCheck(makeWatch(), makeDeps(store, [fail('blocked', 403)]));

  assert.equal(store.checks.length, 1);
  assert.equal(record.outcome, 'blocked');
  assert.match(record.summary, /bot protection/);
  assert.equal(store.watch.consecutiveFailures, 1);
});

test('a blocked watch backs off harder than the normal interval', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch({ intervalMinutes: 60 }), makeDeps(store, [fail('blocked', 429)]));
  const gap = (new Date(store.watch.nextCheckAt).getTime() - Date.parse('2026-03-01T12:00:00.000Z')) / 60000;
  assert.equal(gap, 240); // 60m × 2 failures-backoff × 2 blocked-penalty
});

test('a single blip does not mark the watch degraded', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch(), makeDeps(store, [fail('timeout')]));
  assert.equal(store.watch.status, 'healthy');
});

test('three consecutive failures degrade the watch', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch({ consecutiveFailures: 2, firstFailureAt: '2026-03-01T10:00:00.000Z' }), makeDeps(store, [fail('timeout')]));
  assert.equal(store.watch.status, 'degraded');
  assert.deepEqual(store.alerts, [], 'still self-healing, not the user’s problem yet');
});

test('after 48h of failure the watch escalates to the user, exactly once', async () => {
  const store = new MemoryStore();
  const failing = makeWatch({ consecutiveFailures: 9, firstFailureAt: '2026-02-27T09:00:00.000Z' });

  await runCheck(failing, makeDeps(store, [fail('timeout')]));
  assert.equal(store.watch.status, 'broken');
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].kind, 'watch_broken');

  // Already broken: the next failure must not alert again.
  await runCheck({ ...failing, status: 'broken', consecutiveFailures: 10 }, makeDeps(store, [fail('timeout')]));
  assert.equal(store.alerts.length, 1);
});

test('a 404 with one unambiguous replacement relocates the watch and says so', async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store, [fail('not_found', 404), ok(ONE_VENDOR)], { discover: 'https://v.example/legal/subprocessors' });
  const record = await runCheck(makeWatch(), deps);

  assert.equal(record.outcome, 'ok');
  assert.equal(store.watch.url, 'https://v.example/legal/subprocessors');
  assert.equal(store.watch.status, 'healthy');
  assert.equal(store.alerts.length, 1);
  assert.equal(store.alerts[0].kind, 'watch_relocated');
});

test('a 404 with no unambiguous replacement fails rather than guessing', async () => {
  const store = new MemoryStore();
  const record = await runCheck(makeWatch(), makeDeps(store, [fail('not_found', 404)], { discover: null }));

  assert.equal(record.outcome, 'not_found');
  assert.equal(store.watch.url, 'https://v.example/sub', 'the watch is never silently re-pointed');
  assert.match(record.summary, /no unambiguous replacement/);
});

test('a store that throws still leaves a check row behind', async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store, [ok(ONE_VENDOR)]);
  const exploding: CheckDeps = { ...deps, store: Object.assign(Object.create(store), { saveRevision: async () => { throw new Error('D1 unavailable'); } }) };

  const record = await runCheck(makeWatch(), exploding);
  assert.equal(record.outcome, 'error');
  assert.match(record.summary, /Check failed: D1 unavailable/);
});

test('each check commits to the hash of the one before it', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch(), makeDeps(store, [ok(ONE_VENDOR)]));
  await runCheck(makeWatch(), makeDeps(store, [fail('timeout')]));
  await runCheck(makeWatch(), makeDeps(store, [ok(TWO_VENDORS)]));

  assert.equal(store.checks[0].prevHash, null, 'genesis');
  assert.equal(store.checks[1].prevHash, store.checks[0].hash);
  assert.equal(store.checks[2].prevHash, store.checks[1].hash);
  assert.equal(new Set(store.checks.map((c) => c.hash)).size, 3);
});

test('a successful check clears the failure state', async () => {
  const store = new MemoryStore();
  await runCheck(makeWatch({ consecutiveFailures: 4, status: 'degraded', firstFailureAt: '2026-02-28T00:00:00.000Z' }), makeDeps(store, [ok(ONE_VENDOR)]));

  assert.equal(store.watch.status, 'healthy');
  assert.equal(store.watch.consecutiveFailures, 0);
  assert.equal(store.watch.firstFailureAt, undefined);
});
