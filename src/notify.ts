/**
 * Alert delivery.
 *
 * The design constraint here is not throughput, it's restraint. Alert fatigue is the
 * churn mechanism in this category: the customer mutes the emails, stops reviewing
 * changes, and cancels at renewal because "we never look at it". So delivery is built
 * to send as few messages as it can get away with —
 *
 *   - high-severity alerts batch into ONE message per workspace per tick
 *   - low-severity alerts wait for the digest and never interrupt anyone
 *   - an empty digest is not sent at all
 *   - a repeat of a change we already delivered inside 24h is suppressed
 *
 * Suppressed and failed alerts stay in the table with a reason. Delivery is a
 * best-effort channel; the evidence log is the record, and the two must never be
 * confused — a message that was never emailed still happened and still exports.
 */

import type { Alert } from './check.ts';
import type { Channels, SendResult } from './channels.ts';
import { renderAlerts } from './render.ts';

export interface StoredAlert extends Alert {
  id: string;
}

export interface NotificationSettings {
  workspaceId: string;
  plan: 'free' | 'team' | 'compliance';
  emails: string[];
  slackWebhookUrl?: string;
  digestCadence: 'daily' | 'weekly' | 'off';
  digestHourUtc: number;
  lastDigestAt?: string;
}

export interface NotifyStore {
  pendingAlerts(limit: number, filter?: { workspaceId?: string; severity?: 'high' | 'low' }): Promise<StoredAlert[]>;
  notificationSettings(workspaceId: string): Promise<NotificationSettings | null>;
  recentlyDelivered(watchId: string, summary: string, since: string): Promise<boolean>;
  markDelivered(ids: string[], at: string): Promise<void>;
  markSuppressed(id: string, reason: string): Promise<void>;
  recordFailure(id: string, error: string, permanent: boolean): Promise<void>;
  disableSlack(workspaceId: string, reason: string): Promise<void>;
  dueDigests(now: Date): Promise<NotificationSettings[]>;
  recordDigestSent(workspaceId: string, at: string): Promise<void>;
}

export interface NotifyDeps {
  store: NotifyStore;
  channels: Channels;
  appBaseUrl: string;
  now(): Date;
}

export interface DeliveryReport {
  delivered: number;
  suppressed: number;
  failed: number;
  digestsSent: number;
}

const SUPPRESSION_WINDOW_HOURS = 24;
const IMMEDIATE_BATCH = 200;
const DIGEST_BATCH = 500;

const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

function groupByWorkspace(alerts: StoredAlert[]): Map<string, StoredAlert[]> {
  const groups = new Map<string, StoredAlert[]>();
  for (const alert of alerts) groups.set(alert.workspaceId, [...(groups.get(alert.workspaceId) ?? []), alert]);
  return groups;
}

/**
 * Sends one rendered message to every channel the workspace has configured.
 *
 * "Delivered" means *any* channel succeeded. If the email lands and Slack 500s, the
 * human was told — re-sending the email later to satisfy Slack would be worse than
 * dropping the webhook.
 */
async function dispatch(
  alerts: StoredAlert[],
  settings: NotificationSettings,
  deps: NotifyDeps,
  digest?: 'daily' | 'weekly',
): Promise<{ delivered: boolean; retryable: boolean; error: string }> {
  const message = renderAlerts(alerts, deps.appBaseUrl, digest);
  if (!message) return { delivered: false, retryable: false, error: 'nothing to send' };

  const results: SendResult[] = [await deps.channels.sendEmail(settings.emails, message)];

  // Slack is a paid feature. Gating it here rather than at write time means a
  // downgrade takes effect immediately without touching stored settings.
  if (settings.slackWebhookUrl && settings.plan !== 'free') {
    const slack = await deps.channels.sendSlack(settings.slackWebhookUrl, message);
    if (slack.destinationRevoked) {
      await deps.store.disableSlack(settings.workspaceId, 'Slack webhook no longer accepts messages');
    }
    results.push(slack);
  }

  const delivered = results.some((r) => r.ok);
  return {
    delivered,
    retryable: !delivered && results.some((r) => r.retryable),
    error: results.filter((r) => !r.ok).map((r) => r.error ?? 'unknown').join('; '),
  };
}

/** High-severity alerts, batched per workspace, sent now. */
export async function deliverImmediate(deps: NotifyDeps): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, suppressed: 0, failed: 0, digestsSent: 0 };
  const now = deps.now();
  const pending = await deps.store.pendingAlerts(IMMEDIATE_BATCH, { severity: 'high' });

  for (const [workspaceId, alerts] of groupByWorkspace(pending)) {
    const settings = await deps.store.notificationSettings(workspaceId);
    if (!settings) {
      // Nowhere to send it. Permanent by definition — retrying can't conjure an address.
      for (const alert of alerts) await deps.store.recordFailure(alert.id, 'no notification settings', true);
      report.failed += alerts.length;
      continue;
    }

    const sendable: StoredAlert[] = [];
    for (const alert of alerts) {
      // A page that flaps between two states would otherwise alert on every flip.
      if (await deps.store.recentlyDelivered(alert.watchId, alert.summary, hoursAgo(now, SUPPRESSION_WINDOW_HOURS))) {
        await deps.store.markSuppressed(alert.id, `identical alert delivered within ${SUPPRESSION_WINDOW_HOURS}h`);
        report.suppressed++;
      } else {
        sendable.push(alert);
      }
    }
    if (!sendable.length) continue;

    const result = await dispatch(sendable, settings, deps);
    if (result.delivered) {
      await deps.store.markDelivered(
        sendable.map((a) => a.id),
        now.toISOString(),
      );
      report.delivered += sendable.length;
    } else {
      for (const alert of sendable) await deps.store.recordFailure(alert.id, result.error, !result.retryable);
      report.failed += sendable.length;
    }
  }

  return report;
}

/** Low-severity alerts, swept on the workspace's cadence. */
export async function runDigests(deps: NotifyDeps): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, suppressed: 0, failed: 0, digestsSent: 0 };
  const now = deps.now();

  for (const settings of await deps.store.dueDigests(now)) {
    const alerts = await deps.store.pendingAlerts(DIGEST_BATCH, {
      workspaceId: settings.workspaceId,
      severity: 'low',
    });

    // Nothing to report: advance the clock anyway so this workspace stops coming up
    // as due on every tick, and say nothing. Silence is the product working.
    if (!alerts.length) {
      await deps.store.recordDigestSent(settings.workspaceId, now.toISOString());
      continue;
    }

    const cadence = settings.digestCadence === 'weekly' ? 'weekly' : 'daily';
    const result = await dispatch(alerts, settings, deps, cadence);
    if (result.delivered) {
      await deps.store.markDelivered(
        alerts.map((a) => a.id),
        now.toISOString(),
      );
      await deps.store.recordDigestSent(settings.workspaceId, now.toISOString());
      report.delivered += alerts.length;
      report.digestsSent++;
    } else {
      // Deliberately does NOT advance the digest clock: the alerts stay pending and
      // ride along with the next attempt rather than being silently skipped.
      for (const alert of alerts) await deps.store.recordFailure(alert.id, result.error, !result.retryable);
      report.failed += alerts.length;
    }
  }

  return report;
}

export async function runDelivery(deps: NotifyDeps): Promise<DeliveryReport> {
  const immediate = await deliverImmediate(deps);
  const digests = await runDigests(deps);
  return {
    delivered: immediate.delivered + digests.delivered,
    suppressed: immediate.suppressed + digests.suppressed,
    failed: immediate.failed + digests.failed,
    digestsSent: digests.digestsSent,
  };
}
