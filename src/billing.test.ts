import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCheckoutSession,
  handleStripeEvent,
  priceFor,
  verifyStripeSignature,
  PLAN_LIMITS,
  type BillingState,
  type BillingStore,
  type Plan,
  type StripeConfig,
  type StripeEvent,
} from './billing.ts';

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-03-01T12:00:00.000Z');

const config: StripeConfig = {
  secretKey: 'sk_test_x',
  webhookSecret: SECRET,
  prices: {
    team_monthly: 'price_team_m',
    team_annual: 'price_team_a',
    compliance_monthly: 'price_comp_m',
    compliance_annual: 'price_comp_a',
  },
};

class FakeBillingStore implements BillingStore {
  state: BillingState = { plan: 'free', vendorCount: 0 };
  seen = new Set<string>();
  lastEventAt: number | null = null;
  intervals: number[] = [];
  applied: { plan: Plan; status: string; eventCreated: number }[] = [];
  customerBinding = new Map<string, string>();

  async workspaceBilling() {
    return this.state;
  }
  async workspaceIdByCustomer(customerId: string) {
    return this.customerBinding.get(customerId) ?? null;
  }
  async claimEvent(id: string) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
  async lastBillingEventAt() {
    return this.lastEventAt;
  }
  async applyBilling(input: { plan: Plan; status: string; customerId?: string; subscriptionId?: string; eventCreated: number }) {
    this.state = { ...this.state, plan: input.plan, status: input.status, customerId: input.customerId ?? this.state.customerId };
    this.lastEventAt = input.eventCreated;
    this.applied.push({ plan: input.plan, status: input.status, eventCreated: input.eventCreated });
  }
  async applyCheckInterval(_workspaceId: string, minutes: number) {
    this.intervals.push(minutes);
  }
}

async function sign(payload: string, at: Date, secret = SECRET): Promise<string> {
  const t = Math.floor(at.getTime() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

function subscriptionEvent(over: Partial<StripeEvent> & { price?: string; status?: string; type?: string } = {}): StripeEvent {
  return {
    id: over.id ?? 'evt_1',
    type: over.type ?? 'customer.subscription.updated',
    created: over.created ?? 1_772_000_000,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: over.status ?? 'active',
        metadata: { workspace_id: 'ws1' },
        items: { data: [{ price: { id: over.price ?? 'price_team_m' } }] },
      },
    },
  };
}

// ── price allowlist ─────────────────────────────────────────────────────────────

test('a plan and cadence map to a configured price', () => {
  assert.equal(priceFor(config, 'team', 'monthly'), 'price_team_m');
  assert.equal(priceFor(config, 'compliance', 'annual'), 'price_comp_a');
});

test('a price id supplied by the browser is never honoured', () => {
  assert.equal(priceFor(config, 'price_free_internal_testing', 'monthly'), null);
  assert.equal(priceFor(config, 'free', 'monthly'), null, 'free is not a checkout target');
  assert.equal(priceFor(config, 'team', 'weekly'), null);
});

// ── signature verification ──────────────────────────────────────────────────────

test('a correctly signed payload verifies', async () => {
  const payload = '{"id":"evt_1"}';
  assert.equal(await verifyStripeSignature(payload, await sign(payload, NOW), SECRET, NOW), true);
});

test('a tampered payload does not verify', async () => {
  const header = await sign('{"plan":"team"}', NOW);
  assert.equal(await verifyStripeSignature('{"plan":"compliance"}', header, SECRET, NOW), false);
});

test('a signature from the wrong secret does not verify', async () => {
  const payload = '{"id":"evt_1"}';
  assert.equal(await verifyStripeSignature(payload, await sign(payload, NOW, 'whsec_attacker'), SECRET, NOW), false);
});

test('a replayed signature stops working once it ages out', async () => {
  const payload = '{"id":"evt_1"}';
  const header = await sign(payload, NOW);
  const muchLater = new Date(NOW.getTime() + 20 * 60_000);

  assert.equal(await verifyStripeSignature(payload, header, SECRET, NOW), true);
  assert.equal(await verifyStripeSignature(payload, header, SECRET, muchLater), false);
});

test('a missing or malformed signature header is rejected', async () => {
  assert.equal(await verifyStripeSignature('{}', null, SECRET, NOW), false);
  assert.equal(await verifyStripeSignature('{}', 'nonsense', SECRET, NOW), false);
  assert.equal(await verifyStripeSignature('{}', 't=abc,v1=zz', SECRET, NOW), false);
});

// ── event handling ──────────────────────────────────────────────────────────────

test('an active subscription sets the plan and the check frequency', async () => {
  const store = new FakeBillingStore();
  const outcome = await handleStripeEvent(subscriptionEvent({ price: 'price_comp_m' }), config, store);

  assert.equal(outcome, 'applied');
  assert.equal(store.state.plan, 'compliance');
  assert.deepEqual(store.intervals, [PLAN_LIMITS.compliance.intervalMinutes]);
});

test('a redelivered event is applied exactly once', async () => {
  const store = new FakeBillingStore();
  const event = subscriptionEvent();

  assert.equal(await handleStripeEvent(event, config, store), 'applied');
  assert.equal(await handleStripeEvent(event, config, store), 'duplicate');
  assert.equal(store.applied.length, 1);
});

test('an out-of-order event cannot resurrect a cancelled plan', async () => {
  const store = new FakeBillingStore();
  await handleStripeEvent(subscriptionEvent({ id: 'evt_cancel', type: 'customer.subscription.deleted', created: 2000 }), config, store);
  assert.equal(store.state.plan, 'free');

  // An "active" update that Stripe generated *before* the cancellation, delivered late.
  const outcome = await handleStripeEvent(subscriptionEvent({ id: 'evt_old', created: 1000 }), config, store);
  assert.equal(outcome, 'stale');
  assert.equal(store.state.plan, 'free');
});

test('cancellation drops to free and slows the checks back down', async () => {
  const store = new FakeBillingStore();
  await handleStripeEvent(subscriptionEvent({ id: 'a', created: 1000 }), config, store);
  await handleStripeEvent(subscriptionEvent({ id: 'b', created: 2000, type: 'customer.subscription.deleted' }), config, store);

  assert.equal(store.state.plan, 'free');
  assert.deepEqual(store.intervals, [PLAN_LIMITS.team.intervalMinutes, PLAN_LIMITS.free.intervalMinutes]);
});

test('past_due keeps the plan — Stripe is still retrying the card', async () => {
  const store = new FakeBillingStore();
  await handleStripeEvent(subscriptionEvent({ status: 'past_due' }), config, store);

  assert.equal(store.state.plan, 'team', 'monitoring must not gap over an expired card');
  assert.equal(store.state.status, 'past_due');
});

test('an unpaid subscription does drop to free', async () => {
  const store = new FakeBillingStore();
  await handleStripeEvent(subscriptionEvent({ status: 'unpaid' }), config, store);
  assert.equal(store.state.plan, 'free');
});

test('an unknown price falls back to free rather than guessing', async () => {
  const store = new FakeBillingStore();
  await handleStripeEvent(subscriptionEvent({ price: 'price_from_another_product' }), config, store);
  assert.equal(store.state.plan, 'free');
});

test('checkout.session.completed binds the customer without granting a plan', async () => {
  const store = new FakeBillingStore();
  const outcome = await handleStripeEvent(
    {
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      created: 1500,
      data: { object: { customer: 'cus_1', subscription: 'sub_1', client_reference_id: 'ws1' } },
    },
    config,
    store,
  );

  assert.equal(outcome, 'applied');
  assert.equal(store.state.customerId, 'cus_1');
  assert.equal(store.state.plan, 'free', 'the plan comes from the subscription event, not the checkout');
});

test('a subscription event arriving before checkout still resolves via metadata', async () => {
  const store = new FakeBillingStore(); // no customer binding recorded yet
  assert.equal(await handleStripeEvent(subscriptionEvent(), config, store), 'applied');
  assert.equal(store.state.plan, 'team');
});

test('an event for an unknown workspace is reported, not misapplied', async () => {
  const store = new FakeBillingStore();
  const orphan = subscriptionEvent();
  orphan.data.object.metadata = {};
  assert.equal(await handleStripeEvent(orphan, config, store), 'unresolved');
  assert.equal(store.applied.length, 0);
});

test('unrelated event types are ignored without consuming an id', async () => {
  const store = new FakeBillingStore();
  const outcome = await handleStripeEvent(
    { id: 'evt_ping', type: 'invoice.upcoming', created: 1000, data: { object: {} } },
    config,
    store,
  );
  assert.equal(outcome, 'ignored');
  assert.equal(store.seen.size, 0);
});

// ── checkout session creation ───────────────────────────────────────────────────

test('checkout carries the workspace on the subscription, not just the session', async () => {
  let body = '';
  const withFetch: StripeConfig = {
    ...config,
    fetchImpl: async (_url, init) => {
      body = String((init as RequestInit).body);
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/c/pay/cs_1' }), { status: 200 });
    },
  };

  const session = await createCheckoutSession(withFetch, {
    workspaceId: 'ws1',
    email: 'jo@acme.test',
    price: 'price_team_m',
    appBaseUrl: 'https://app.deltalog.test',
  });

  assert.equal(session.url, 'https://checkout.stripe.test/c/pay/cs_1');
  const params = new URLSearchParams(body);
  assert.equal(params.get('client_reference_id'), 'ws1');
  assert.equal(params.get('subscription_data[metadata][workspace_id]'), 'ws1');
  assert.equal(params.get('mode'), 'subscription');
  assert.equal(params.get('customer_email'), 'jo@acme.test');
});

test('an existing customer is reused instead of creating a second billing history', async () => {
  let body = '';
  const withFetch: StripeConfig = {
    ...config,
    fetchImpl: async (_url, init) => {
      body = String((init as RequestInit).body);
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/c' }), { status: 200 });
    },
  };
  await createCheckoutSession(withFetch, {
    workspaceId: 'ws1',
    email: 'jo@acme.test',
    price: 'price_comp_m',
    customerId: 'cus_existing',
    appBaseUrl: 'https://app.deltalog.test',
  });

  const params = new URLSearchParams(body);
  assert.equal(params.get('customer'), 'cus_existing');
  assert.equal(params.get('customer_email'), null);
});
