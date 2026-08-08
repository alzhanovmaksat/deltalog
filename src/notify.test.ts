import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channels, SendResult } from './channels.ts';
import {
  deliverImmediate,
  runDigests,
  type NotificationSettings,
  type NotifyDeps,
  type NotifyStore,
  type StoredAlert,
} from './notify.ts';
import { renderAlerts } from './render.ts';

// ── fakes ───────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-01T14:00:00.000Z');

function alert(overrides: Partial<StoredAlert> = {}): StoredAlert {
  return {
    id: crypto.randomUUID(),
    workspaceId: 'ws1',
    watchId: 'w1',
    kind: 'change',
    severity: 'high',
    summary: 'Datadog: Added 1 subprocessor: Snowflake Inc.',
    createdAt: '2026-03-01T13:00:00.000Z',
    ...overrides,
  };
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    workspaceId: 'ws1',
    plan: 'team',
    emails: ['security@acme.test'],
    digestCadence: 'daily',
    digestHourUtc: 14,
    ...overrides,
  };
}

class FakeStore implements NotifyStore {
  delivered: string[] = [];
  suppressed: { id: string; reason: string }[] = [];
  failures: { id: string; error: string; permanent: boolean }[] = [];
  digestsRecorded: string[] = [];
  slackDisabled: string[] = [];
  alreadyDelivered = false;

  private pending: StoredAlert[];
  private config: NotificationSettings | null;
  private due: NotificationSettings[];

  constructor(pending: StoredAlert[] = [], config: NotificationSettings | null = settings(), due: NotificationSettings[] = []) {
    this.pending = pending;
    this.config = config;
    this.due = due;
  }

  async pendingAlerts(_limit: number, filter: { workspaceId?: string; severity?: 'high' | 'low' } = {}) {
    return this.pending.filter(
      (a) =>
        (!filter.severity || a.severity === filter.severity) &&
        (!filter.workspaceId || a.workspaceId === filter.workspaceId),
    );
  }
  async notificationSettings() {
    return this.config;
  }
  async recentlyDelivered() {
    return this.alreadyDelivered;
  }
  async markDelivered(ids: string[]) {
    this.delivered.push(...ids);
  }
  async markSuppressed(id: string, reason: string) {
    this.suppressed.push({ id, reason });
  }
  async recordFailure(id: string, error: string, permanent: boolean) {
    this.failures.push({ id, error, permanent });
  }
  async disableSlack(workspaceId: string) {
    this.slackDisabled.push(workspaceId);
  }
  async dueDigests() {
    return this.due;
  }
  async recordDigestSent(workspaceId: string) {
    this.digestsRecorded.push(workspaceId);
  }
}

const sent = { ok: true, retryable: false } as SendResult;

function fakeChannels(email: SendResult = sent, slack: SendResult = sent) {
  const calls = { emails: [] as string[][], slacks: [] as string[], messages: [] as string[] };
  const channels: Channels = {
    async sendEmail(to, message) {
      calls.emails.push(to);
      calls.messages.push(message.subject);
      return email;
    },
    async sendSlack(url) {
      calls.slacks.push(url);
      return slack;
    },
  };
  return { channels, calls };
}

const deps = (store: NotifyStore, channels: Channels): NotifyDeps => ({
  store,
  channels,
  appBaseUrl: 'https://app.deltalog.test',
  now: () => NOW,
});

// ── immediate delivery ──────────────────────────────────────────────────────────

test('high-severity alerts for one workspace batch into a single message', async () => {
  const store = new FakeStore([alert(), alert({ watchId: 'w2', summary: 'Stripe: Added 1 subprocessor: Plaid' })]);
  const { channels, calls } = fakeChannels();

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(calls.emails.length, 1, 'one email, not one per alert');
  assert.equal(calls.messages[0], '2 vendor changes need review');
  assert.equal(report.delivered, 2);
  assert.equal(store.delivered.length, 2);
});

test('low-severity alerts are never sent immediately', async () => {
  const store = new FakeStore([alert({ severity: 'low' })]);
  const { channels, calls } = fakeChannels();

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(calls.emails.length, 0);
  assert.equal(report.delivered, 0);
});

test('a repeat of an alert delivered in the last 24h is suppressed, not resent', async () => {
  const store = new FakeStore([alert()]);
  store.alreadyDelivered = true;
  const { channels, calls } = fakeChannels();

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(calls.emails.length, 0);
  assert.equal(report.suppressed, 1);
  assert.match(store.suppressed[0].reason, /within 24h/);
});

test('Slack is used on paid plans and skipped on free', async () => {
  const paid = new FakeStore([alert()], settings({ plan: 'team', slackWebhookUrl: 'https://hooks.slack.test/x' }));
  const paidChannels = fakeChannels();
  await deliverImmediate(deps(paid, paidChannels.channels));
  assert.deepEqual(paidChannels.calls.slacks, ['https://hooks.slack.test/x']);

  const free = new FakeStore([alert()], settings({ plan: 'free', slackWebhookUrl: 'https://hooks.slack.test/x' }));
  const freeChannels = fakeChannels();
  await deliverImmediate(deps(free, freeChannels.channels));
  assert.deepEqual(freeChannels.calls.slacks, [], 'Slack is a paid feature');
});

test('email succeeding is enough — a failing Slack does not hold up delivery', async () => {
  const store = new FakeStore([alert()], settings({ slackWebhookUrl: 'https://hooks.slack.test/x' }));
  const { channels } = fakeChannels(sent, { ok: false, retryable: true, error: 'slack 500' });

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(report.delivered, 1);
  assert.deepEqual(store.failures, []);
});

test('a revoked Slack webhook is cleared so it stops failing forever', async () => {
  const store = new FakeStore([alert()], settings({ slackWebhookUrl: 'https://hooks.slack.test/gone' }));
  const { channels } = fakeChannels(sent, { ok: false, retryable: false, destinationRevoked: true, error: 'slack 404' });

  await deliverImmediate(deps(store, channels));

  assert.deepEqual(store.slackDisabled, ['ws1']);
});

test('when every channel fails the alert stays pending and the error is recorded', async () => {
  const store = new FakeStore([alert()]);
  const { channels } = fakeChannels({ ok: false, retryable: true, error: 'resend 503' });

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(report.failed, 1);
  assert.deepEqual(store.delivered, []);
  assert.equal(store.failures[0].permanent, false, 'a 503 is worth retrying');
  assert.match(store.failures[0].error, /resend 503/);
});

test('a workspace with no notification settings fails permanently', async () => {
  const store = new FakeStore([alert()], null);
  const { channels } = fakeChannels();

  const report = await deliverImmediate(deps(store, channels));

  assert.equal(report.failed, 1);
  assert.equal(store.failures[0].permanent, true, 'retrying cannot conjure an address');
});

// ── digests ─────────────────────────────────────────────────────────────────────

test('a due digest sends the pending low-severity alerts', async () => {
  const store = new FakeStore([alert({ severity: 'low' }), alert({ severity: 'high' })], settings(), [settings()]);
  const { channels, calls } = fakeChannels();

  const report = await runDigests(deps(store, channels));

  assert.equal(calls.messages[0], 'Your daily digest — 1 change logged');
  assert.equal(report.digestsSent, 1);
  assert.equal(store.delivered.length, 1, 'the high-severity alert is not swept into the digest');
});

test('an empty digest is not sent, but the clock still advances', async () => {
  const store = new FakeStore([], settings(), [settings()]);
  const { channels, calls } = fakeChannels();

  const report = await runDigests(deps(store, channels));

  assert.equal(calls.emails.length, 0, 'silence is the product working');
  assert.equal(report.digestsSent, 0);
  assert.deepEqual(store.digestsRecorded, ['ws1'], 'not re-evaluated on every tick');
});

test('a failed digest does not advance the clock — the alerts ride along next time', async () => {
  const store = new FakeStore([alert({ severity: 'low' })], settings(), [settings()]);
  const { channels } = fakeChannels({ ok: false, retryable: true, error: 'resend 500' });

  await runDigests(deps(store, channels));

  assert.deepEqual(store.digestsRecorded, []);
  assert.deepEqual(store.delivered, []);
});

// ── rendering ───────────────────────────────────────────────────────────────────

test('vendor-supplied text is escaped before it reaches an inbox', async () => {
  const hostile = alert({ summary: 'Evil Co: Added <img src=x onerror="alert(1)"> & "friends"' });
  const message = renderAlerts([hostile], 'https://app.deltalog.test')!;

  assert.doesNotMatch(message.html, /<img/);
  assert.match(message.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(message.html, /&amp; &quot;friends&quot;/);
  assert.match(message.text, /<img src=x/, 'the plain-text part is left verbatim');
});

test('Slack output escapes only the three characters Slack cares about', () => {
  const message = renderAlerts([alert({ summary: 'A & B <script>' })], 'https://app.deltalog.test')!;
  assert.match(message.slack, /A &amp; B &lt;script&gt;/);
});

test('a single alert leads with its own summary; nothing renders for an empty list', () => {
  const one = renderAlerts([alert()], 'https://app.deltalog.test')!;
  assert.equal(one.subject, 'Datadog: Added 1 subprocessor: Snowflake Inc.');
  assert.match(one.text, /Review → https:\/\/app\.deltalog\.test\/alerts\//);
  assert.equal(renderAlerts([], 'https://app.deltalog.test'), null);
});

test('operational alerts are labelled rather than dressed up as vendor changes', () => {
  const broken = renderAlerts([alert({ kind: 'watch_broken', summary: 'Okta: no response for 51h' })], 'https://x.test')!;
  assert.match(broken.subject, /^Can't check — Okta/);
});
