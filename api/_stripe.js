import { createHmac, timingSafeEqual } from 'node:crypto';

export function stripeConfigured() { return Boolean(process.env.STRIPE_SECRET_KEY); }

export async function stripeRequest(path, { method = 'GET', params = null } = {}) {
  if (!stripeConfigured()) throw new Error('Stripe is not configured on the server');
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': process.env.STRIPE_API_VERSION || '2026-08-26.dahlia' },
    body: params ? new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])).toString() : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body?.error?.message || 'Stripe request failed'); error.status = response.status; throw error; }
  return body;
}

export function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map(part => part.split('=').map(value => value.trim())).filter(([key, value]) => key && value));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds || !parts.v1) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const received = Buffer.from(parts.v1, 'hex');
  const calculated = Buffer.from(expected, 'hex');
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

export async function readRawBody(request) {
  if (typeof request.rawBody === 'string') return request.rawBody;
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody.toString('utf8');
  if (typeof request.body === 'string') return request.body;
  if (Buffer.isBuffer(request.body)) return request.body.toString('utf8');
  if (!request[Symbol.asyncIterator]) return '';
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
