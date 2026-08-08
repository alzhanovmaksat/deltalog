/**
 * Stripe Checkout, the Customer Portal, and webhook handling.
 *
 * Two rules shape this file, and both are about what we refuse to build:
 *
 * 1. **The portal is Stripe's, not ours.** Plan changes, card updates, cancellations,
 *    invoices, receipts, and failed-payment retries are all handled by Stripe's hosted
 *    portal. Building any of that in-app would create the single largest source of
 *    support email in a product that has to survive on ten minutes a week.
 *
 * 2. **Only the webhook grants a plan.** The redirect back from Stripe proves nothing —
 *    anyone can navigate to `/billing?success=1`. The success URL updates a message;
 *    the signed webhook updates the database. Conflating those two is the most common
 *    way a self-serve SaaS gives itself away for free.
 */

export type Plan = 'free' | 'team' | 'compliance';
export type Cadence = 'monthly' | 'annual';

export interface PlanLimits {
  vendors: number;
  /** Check frequency is a plan feature, so upgrading actually changes the product. */
  intervalMinutes: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { vendors: 3, intervalMinutes: 7 * 24 * 60 },
  team: { vendors: 25, intervalMinutes: 24 * 60 },
  compliance: { vendors: 100, intervalMinutes: 6 * 60 },
};

/** Price ids come from env, never from the browser. See `priceFor`. */
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: Record<`${Exclude<Plan, 'free'>}_${Cadence}`, string>;
  fetchImpl?: typeof fetch;
}

export interface BillingState {
  plan: Plan;
  status?: string;
  customerId?: string;
  subscriptionId?: string;
  vendorCount: number;
}

export interface BillingStore {
  workspaceBilling(workspaceId: string): Promise<BillingState | null>;
  workspaceIdByCustomer(customerId: string): Promise<string | null>;
  /** False when this event id has already been applied. Must be atomic. */
  claimEvent(eventId: string): Promise<boolean>;
  lastBillingEventAt(workspaceId: string): Promise<number | null>;
  applyBilling(input: {
    workspaceId: string;
    plan: Plan;
    status: string;
    customerId?: string;
    subscriptionId?: string;
    eventCreated: number;
  }): Promise<void>;
  /** Check frequency follows the plan, so a change has to reach existing watches. */
  applyCheckInterval(workspaceId: string, intervalMinutes: number): Promise<void>;
}

// ── Stripe REST ─────────────────────────────────────────────────────────────────

const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's API is form-encoded with bracket notation for nested values. */
function encode(params: Record<string, string | number | undefined>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value));
  }
  return body.toString();
}

async function stripePost<T>(config: StripeConfig, path: string, params: Record<string, string | number | undefined>, idempotencyKey?: string): Promise<T> {
  const response = await (config.fetchImpl ?? fetch)(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: encode(params),
  });
  if (!response.ok) throw new Error(`stripe ${path} ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()) as T;
}

/**
 * Maps a plan and cadence to a configured price id.
 *
 * The browser sends "team" and "annual", never a price id. Accepting a price id from
 * a form would let anyone check out at any price in the account — including the $0
 * one used for testing.
 */
export function priceFor(config: StripeConfig, plan: string, cadence: string): string | null {
  if (plan !== 'team' && plan !== 'compliance') return null;
  if (cadence !== 'monthly' && cadence !== 'annual') return null;
  return config.prices[`${plan}_${cadence}`] ?? null;
}

export async function createCheckoutSession(
  config: StripeConfig,
  input: { workspaceId: string; email: string; price: string; customerId?: string; appBaseUrl: string },
): Promise<{ url: string }> {
  return stripePost<{ url: string }>(
    config,
    '/checkout/sessions',
    {
      mode: 'subscription',
      'line_items[0][price]': input.price,
      'line_items[0][quantity]': 1,
      success_url: `${input.appBaseUrl}/billing?checkout=complete`,
      cancel_url: `${input.appBaseUrl}/billing`,
      client_reference_id: input.workspaceId,
      // Reusing the customer keeps one billing history per workspace instead of
      // creating a new Stripe customer on every upgrade.
      customer: input.customerId,
      customer_email: input.customerId ? undefined : input.email,
      allow_promotion_codes: 'true',
      // Carried on the subscription so a subscription.* event can resolve its
      // workspace even if it arrives before checkout.session.completed.
      'subscription_data[metadata][workspace_id]': input.workspaceId,
    },
    `checkout-${input.workspaceId}-${input.price}`,
  );
}

export async function createPortalSession(
  config: StripeConfig,
  input: { customerId: string; appBaseUrl: string },
): Promise<{ url: string }> {
  return stripePost<{ url: string }>(config, '/billing_portal/sessions', {
    customer: input.customerId,
    return_url: `${input.appBaseUrl}/billing`,
  });
}

// ── webhook verification ────────────────────────────────────────────────────────

const SIGNATURE_TOLERANCE_SECONDS = 300;

const hexToBytes = (hex: string) => {
  if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
};

/**
 * Verifies a Stripe webhook signature.
 *
 * This function is the entire security boundary for billing. The webhook URL is
 * public and unauthenticated by necessity, so without this check anyone who finds it
 * could POST themselves onto the Compliance plan forever.
 *
 * Three things must hold, not one:
 *   - the payload is the RAW body; re-serializing parsed JSON changes the bytes and
 *     every signature fails
 *   - the timestamp is recent, so a captured-and-replayed request eventually stops
 *     working
 *   - the comparison is constant-time, done by WebCrypto's verify rather than by hand
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  now = new Date(),
): Promise<boolean> {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...v] = p.trim().split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const signature = hexToBytes(parts.v1 ?? '');
  if (!signature) return false;

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return globalThis.crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`${timestamp}.${rawBody}`));
}

// ── event handling ──────────────────────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export type EventOutcome = 'applied' | 'duplicate' | 'stale' | 'ignored' | 'unresolved';

/** Reverse of `priceFor`: which plan does this price id represent? */
function planForPrice(config: StripeConfig, priceId: string | undefined): Plan | null {
  if (!priceId) return null;
  for (const [key, value] of Object.entries(config.prices)) {
    if (value === priceId) return key.split('_')[0] as Plan;
  }
  return null;
}

/** Stripe states where the customer no longer has what they paid for. */
const DEAD_STATUSES = new Set(['canceled', 'incomplete_expired', 'unpaid']);

function subscriptionPrice(subscription: Record<string, unknown>): string | undefined {
  const items = subscription.items as { data?: { price?: { id?: string } }[] } | undefined;
  return items?.data?.[0]?.price?.id;
}

/**
 * Applies a verified Stripe event.
 *
 * Webhooks are delivered at-least-once and out of order, so both hazards are handled
 * explicitly: `claimEvent` makes redelivery a no-op, and the `eventCreated` comparison
 * stops a delayed `subscription.updated` from resurrecting a plan that a later
 * `subscription.deleted` already removed.
 */
export async function handleStripeEvent(
  event: StripeEvent,
  config: StripeConfig,
  store: BillingStore,
): Promise<EventOutcome> {
  const object = event.data.object;

  const relevant =
    event.type === 'checkout.session.completed' ||
    event.type.startsWith('customer.subscription.');
  if (!relevant) return 'ignored';

  if (!(await store.claimEvent(event.id))) return 'duplicate';

  // Resolve the workspace from metadata first, then the customer binding. Metadata
  // survives event reordering; the binding only exists after checkout completed.
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  const customerId = typeof object.customer === 'string' ? object.customer : undefined;
  const workspaceId =
    metadata.workspace_id ??
    (typeof object.client_reference_id === 'string' ? object.client_reference_id : undefined) ??
    (customerId ? await store.workspaceIdByCustomer(customerId) : null);
  if (!workspaceId) return 'unresolved';

  const lastEventAt = await store.lastBillingEventAt(workspaceId);
  if (lastEventAt !== null && event.created < lastEventAt) return 'stale';

  // checkout.session.completed carries no price, so it only binds the customer. The
  // plan itself always comes from a subscription event, which is the object that
  // actually knows what is being paid for.
  if (event.type === 'checkout.session.completed') {
    const current = await store.workspaceBilling(workspaceId);
    await store.applyBilling({
      workspaceId,
      plan: current?.plan ?? 'free',
      status: 'checkout_complete',
      customerId,
      subscriptionId: typeof object.subscription === 'string' ? object.subscription : undefined,
      eventCreated: event.created,
    });
    return 'applied';
  }

  const status = String(object.status ?? '');
  const deleted = event.type === 'customer.subscription.deleted' || DEAD_STATUSES.has(status);
  const plan = deleted ? 'free' : planForPrice(config, subscriptionPrice(object)) ?? 'free';

  await store.applyBilling({
    workspaceId,
    plan,
    status: deleted ? 'canceled' : status,
    customerId,
    subscriptionId: typeof object.id === 'string' ? object.id : undefined,
    eventCreated: event.created,
  });
  // past_due keeps the plan: Stripe is still retrying the card, and cutting a
  // compliance customer off mid-dunning creates a gap in their evidence log over what
  // is usually an expired card.
  await store.applyCheckInterval(workspaceId, PLAN_LIMITS[plan].intervalMinutes);
  return 'applied';
}
