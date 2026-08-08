/**
 * Cloudflare Worker entry point.
 *
 * Intentionally thin — it is glue, and glue is the part that can't be unit tested, so
 * the less of it there is the better. Routing lives in `routes.ts` and every decision
 * worth arguing about lives in `check.ts`.
 */

import { runCheck, type Watch } from './check.ts';
import { createChannels } from './channels.ts';
import { discoverRelocation, fetchPage } from './fetch.ts';
import { runDelivery } from './notify.ts';
import { handleRequest } from './routes.ts';
import { D1AuthStore, D1BillingStore, D1DirectoryStore, D1EvidenceStore, D1NotifyStore, D1ReviewStore, D1Store } from './store.ts';

interface Env {
  DB: ConstructorParameters<typeof D1Store>[0];
  SNAPSHOTS?: ConstructorParameters<typeof D1Store>[1];
  RESEND_API_KEY: string;
  ALERT_FROM_ADDRESS: string;
  APP_BASE_URL: string;
  /** Signs session cookies. Rotating it signs everyone out, which is the intended lever. */
  SESSION_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_TEAM_MONTHLY: string;
  STRIPE_PRICE_TEAM_ANNUAL: string;
  STRIPE_PRICE_COMPLIANCE_MONTHLY: string;
  STRIPE_PRICE_COMPLIANCE_ANNUAL: string;
  /** Watches per cron tick. See BATCH_SIZE below before raising this. */
  BATCH_SIZE?: string;
}

/**
 * Sized against the Workers subrequest ceiling, not against ambition: each check costs
 * 1–3 outbound fetches (more when relocation kicks in), and a tick that trips the
 * limit fails the *rest* of the batch, punching a hole in the evidence log. With a
 * 15-minute cron this still clears ~1,400 checks/day, which covers a few hundred
 * customers on daily frequency.
 */
const BATCH_SIZE = 12;

/** Concurrency, not parallelism: enough to hide network latency, low enough to be polite. */
const POOL = 4;

async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<unknown>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      // One failing watch must never abort the batch — the whole point of the loop is
      // that the other watches still get checked and still get their log rows.
      await work(item).catch(() => {});
    }
  });
  await Promise.all(runners);
}

const channelsFor = (env: Env) =>
  createChannels({ resendApiKey: env.RESEND_API_KEY, fromAddress: env.ALERT_FROM_ADDRESS });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const directory = new D1DirectoryStore(env.DB);
    return handleRequest(request, {
      reviewStore: new D1ReviewStore(env.DB),
      authStore: new D1AuthStore(env.DB),
      evidenceStore: new D1EvidenceStore(env.DB),
      directoryStore: directory,
      onboardingStore: directory,
      billingStore: new D1BillingStore(env.DB),
      stripe: {
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        prices: {
          team_monthly: env.STRIPE_PRICE_TEAM_MONTHLY,
          team_annual: env.STRIPE_PRICE_TEAM_ANNUAL,
          compliance_monthly: env.STRIPE_PRICE_COMPLIANCE_MONTHLY,
          compliance_annual: env.STRIPE_PRICE_COMPLIANCE_ANNUAL,
        },
      },
      channels: channelsFor(env),
      sessionSecret: env.SESSION_SECRET,
      fromAddress: env.ALERT_FROM_ADDRESS,
      appBaseUrl: env.APP_BASE_URL,
      now: () => new Date(),
    });
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const store = new D1Store(env.DB, env.SNAPSHOTS);
    const now = new Date();
    const batch = Number(env.BATCH_SIZE ?? BATCH_SIZE);

    const watches = await store.dueWatches(now, batch);
    await pooled(watches, POOL, (watch: Watch) =>
      runCheck(watch, {
        store,
        fetch: (url) => fetchPage(url),
        discover: (url) => discoverRelocation(url),
        // A live clock, not the tick's `now`: `runCheck` samples this once at the start
        // for the record's timestamp and again at the end to measure duration, and a
        // frozen clock would log every check as taking 0ms — which is exactly the
        // signal the Watch Health queue uses to spot vendors going slow.
        now: () => new Date(),
      }),
    );

    // Delivery runs after the checks, in the same tick, so a change detected now goes
    // out now rather than waiting 15 minutes for the next sweep.
    await runDelivery({
      store: new D1NotifyStore(env.DB),
      channels: channelsFor(env),
      appBaseUrl: env.APP_BASE_URL,
      now: () => new Date(),
    });
  },
};
