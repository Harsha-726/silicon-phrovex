import { randomBytes } from 'node:crypto';
import { requireClerkUser, supabaseRequest, json } from './_auth.js';
import { readRawBody, stripeConfigured, stripeRequest, verifyStripeSignature } from './_stripe.js';

export const config = { api: { bodyParser: false } };

const baseUrl = () => String(process.env.APP_URL || 'https://silico.phrovex.com').replace(/\/$/, '');
const checkoutIdentifier = () => `silico_${Array.from(randomBytes(8), byte => String.fromCharCode(97 + (byte % 26))).join('')}`;

async function bodyOf(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') { try { return JSON.parse(request.body); } catch { return {}; } }
  const rawBody = await readRawBody(request);
  if (rawBody) { try { return JSON.parse(rawBody); } catch { return {}; } }
  return {};
}

const paidPlans = new Set(['student', 'advanced']);
const planForPrice = priceId => {
  if (priceId && priceId === process.env.STRIPE_PRICE_ADVANCED_MONTHLY) return 'advanced';
  if (priceId && [process.env.STRIPE_PRICE_STUDENT_MONTHLY, process.env.STRIPE_PRICE_STUDENT_ANNUAL].includes(priceId)) return 'student';
  return 'free';
};
function paid(row) { return paidPlans.has(row?.plan) && ['active', 'trialing'].includes(row.status); }

async function subscriptionFor(userId) {
  const rows = await supabaseRequest(`billing_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  return rows?.[0] || null;
}

function publicBilling(row) {
  const active = paid(row);
  const priceId = active ? row.stripe_price_id || null : null;
  return { configured: stripeConfigured() && Boolean(process.env.STRIPE_PRICE_STUDENT_MONTHLY || process.env.STRIPE_PRICE_STUDENT_ANNUAL || process.env.STRIPE_PRICE_ADVANCED_MONTHLY), available: { studentMonthly: Boolean(process.env.STRIPE_PRICE_STUDENT_MONTHLY), studentAnnual: Boolean(process.env.STRIPE_PRICE_STUDENT_ANNUAL), advancedMonthly: Boolean(process.env.STRIPE_PRICE_ADVANCED_MONTHLY) }, plan: active ? row.plan : 'free', cycle: priceId === process.env.STRIPE_PRICE_STUDENT_ANNUAL ? 'annual' : 'monthly', priceId, status: row?.status || 'inactive', currentPeriodEnd: row?.current_period_end || null, cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end), hasCustomer: Boolean(row?.stripe_customer_id) };
}

function userIdFrom(object) { return object?.metadata?.user_id || object?.client_reference_id || null; }
function subscriptionStatus(value) { return ['inactive', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'].includes(value) ? value : 'inactive'; }
function endTime(value) { return Number.isFinite(Number(value)) ? new Date(Number(value) * 1000).toISOString() : null; }
async function existingSubscription(stripeSubscriptionId) {
  const rows = await supabaseRequest(`billing_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(stripeSubscriptionId)}&select=*&limit=1`);
  return rows?.[0] || null;
}
async function saveSubscription(subscription, fallbackUserId = null) {
  const userId = userIdFrom(subscription) || fallbackUserId || (subscription?.id ? (await existingSubscription(subscription.id))?.user_id : null);
  if (!userId) throw new Error('Stripe subscription is missing a Silico user ID');
  const priceId = subscription.items?.data?.[0]?.price?.id || subscription.plan?.id || null;
  const plan = paidPlans.has(subscription.metadata?.plan) ? subscription.metadata.plan : planForPrice(priceId);
  const productId = subscription.items?.data?.[0]?.price?.product;
  const rows = await supabaseRequest('billing_subscriptions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ user_id: userId, stripe_customer_id: subscription.customer || null, stripe_subscription_id: subscription.id || null, stripe_product_id: typeof productId === 'string' ? productId : productId?.id || null, stripe_price_id: priceId, plan, status: subscriptionStatus(subscription.status), current_period_end: endTime(subscription.current_period_end), cancel_at_period_end: Boolean(subscription.cancel_at_period_end), updated_at: new Date().toISOString() }]) });
  return rows?.[0] || null;
}
async function markEvent(event) {
  try { await supabaseRequest('stripe_webhook_events', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([{ event_id: event.id, event_type: event.type }]) }); } catch { /* Subscription upserts are idempotent if Stripe retries an event. */ }
}
async function handleStripeWebhook(request, response) {
  const rawBody = await readRawBody(request);
  if (!verifyStripeSignature(rawBody, request.headers['stripe-signature'] || request.headers['Stripe-Signature'], process.env.STRIPE_WEBHOOK_SECRET)) return json(response, 400, { error: 'Invalid Stripe signature' });
  let event;
  try { event = JSON.parse(rawBody); } catch { return json(response, 400, { error: 'Invalid webhook payload' }); }
  try {
    await markEvent(event);
    const object = event.data?.object;
    if (event.type === 'checkout.session.completed') {
      const userId = userIdFrom(object);
      if (object?.subscription) {
        const subscription = typeof object.subscription === 'string' ? await stripeRequest(`/v1/subscriptions/${encodeURIComponent(object.subscription)}`) : object.subscription;
        await saveSubscription({ ...subscription, metadata: { ...(subscription.metadata || {}), ...(object.metadata || {}) }, customer: subscription.customer || object.customer }, userId);
      }
    } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused' || event.type === 'customer.subscription.resumed') {
      await saveSubscription(object);
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const subscriptionId = typeof object?.subscription === 'string' ? object.subscription : object?.subscription?.id;
      if (subscriptionId) {
        const existing = await existingSubscription(subscriptionId);
        if (existing) await supabaseRequest(`billing_subscriptions?user_id=eq.${encodeURIComponent(existing.user_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: event.type === 'invoice.paid' ? 'active' : 'past_due', updated_at: new Date().toISOString() }) });
      }
    }
    return json(response, 200, { received: true });
  } catch (error) {
    return json(response, 500, { error: error.message || 'Webhook processing failed' });
  }
}

export default async function handler(request, response) {
  if (request.method === 'POST' && (request.headers['stripe-signature'] || request.headers['Stripe-Signature'])) return handleStripeWebhook(request, response);
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  response.setHeader('Cache-Control', 'no-store');
  try {
    const subscription = await subscriptionFor(auth.userId);
    if (request.method === 'GET') return json(response, 200, { billing: publicBilling(subscription) });
    if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
    if (!stripeConfigured()) return json(response, 503, { error: 'Paid plans are not configured yet.' });
    const body = await bodyOf(request);
    if (body.action === 'portal') {
      if (!subscription?.stripe_customer_id) return json(response, 409, { error: 'No active Stripe customer was found for this account.' });
      const portal = await stripeRequest('/v1/billing_portal/sessions', { method: 'POST', params: { customer: subscription.stripe_customer_id, return_url: `${baseUrl()}/?billing=portal#study` } });
      return json(response, 200, { url: portal.url });
    }
    if (body.action !== 'checkout') return json(response, 400, { error: 'Unknown billing action' });
    if (paid(subscription)) return json(response, 409, { error: 'This account already has an active Study plan.' });
    const plan = body.plan === 'advanced' ? 'advanced' : 'student';
    const interval = plan === 'student' && body.interval === 'annual' ? 'annual' : 'monthly';
    const price = plan === 'advanced' ? process.env.STRIPE_PRICE_ADVANCED_MONTHLY : interval === 'annual' ? process.env.STRIPE_PRICE_STUDENT_ANNUAL : process.env.STRIPE_PRICE_STUDENT_MONTHLY;
    if (!price) return json(response, 503, { error: `The ${interval} Study price is not configured yet.` });
    const params = {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      client_reference_id: auth.userId,
      'metadata[user_id]': auth.userId,
      'metadata[plan]': plan,
      'subscription_data[metadata][user_id]': auth.userId,
      'subscription_data[metadata][plan]': plan,
      success_url: `${baseUrl()}/?billing=success#study`,
      cancel_url: `${baseUrl()}/?billing=cancelled#study`,
      allow_promotion_codes: 'true',
      integration_identifier: checkoutIdentifier()
    };
    if (subscription?.stripe_customer_id) params.customer = subscription.stripe_customer_id;
    const checkout = await stripeRequest('/v1/checkout/sessions', { method: 'POST', params });
    return json(response, 200, { url: checkout.url });
  } catch (error) {
    return json(response, error.status >= 400 && error.status < 500 ? error.status : 500, { error: error.message || 'Billing request failed' });
  }
}
