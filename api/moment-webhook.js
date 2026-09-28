import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ensureProfile, supabaseRequest, json } from './_auth.js';

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

function requestUrl(request) {
  try { return new URL(request.url || '', 'https://silico.local'); } catch { return new URL('https://silico.local'); }
}

function validUserId(value) { return typeof value === 'string' && /^user_[A-Za-z0-9]+$/.test(value); }

async function configuredOwnerId() {
  const configuredId = process.env.MOMENT_WEBHOOK_USER_ID || '';
  if (configuredId) return validUserId(configuredId) ? configuredId : null;
  const email = String(process.env.MOMENT_WEBHOOK_OWNER_EMAIL || '').trim().toLowerCase();
  const secretKey = String(process.env.CLERK_SECRET_KEY || '');
  if (!email || !secretKey) return null;
  const response = await fetch(`https://api.clerk.com/v1/users?query=${encodeURIComponent(email)}&limit=10`, { headers: { Authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Unable to resolve the Moment webhook account');
  const users = await response.json();
  const match = Array.isArray(users) ? users.find(user => user?.email_addresses?.some(address => String(address.email_address || '').toLowerCase() === email)) : null;
  return validUserId(match?.id) ? match.id : null;
}

function hasWebhookToken(request) {
  const expected = String(process.env.MOMENT_WEBHOOK_TOKEN || '');
  const url = requestUrl(request);
  const received = String(request.headers['x-moment-webhook-token'] || url.searchParams.get('token') || '');
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function textValue(body, url) {
  const value = body.title ?? body.text ?? body.value1 ?? body.message ?? url.searchParams.get('title') ?? url.searchParams.get('value1');
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function descriptionValue(body) {
  return typeof body.description === 'string' ? body.description.trim().slice(0, 10_000) : '';
}

function payloads(userId, title, description) {
  const idempotencyKey = `moment-webhook:${randomUUID()}`;
  return [
    { user_id: userId, title, description, status: 'open', priority: 1, due_date: null, due_time: null, duration_minutes: null, estimated_minutes: 0, task_type: 'task', source: 'capture', idempotency_key: idempotencyKey },
    { user_id: userId, title, description, status: 'open', priority: 1, due_date: null, due_time: null, duration_minutes: null, task_type: 'task', source: 'capture', idempotency_key: idempotencyKey },
    { user_id: userId, title, description, status: 'todo', priority: 'medium', due_date: null, due_time: null, estimated_minutes: 0 },
    { user_id: userId, title, description, status: 'todo', priority: 'medium', due_date: null, estimated_minutes: 0 }
  ];
}

function canRetry(error) { return [400, 422].includes(error.status) || ['42703', 'PGRST204', 'PGRST205'].includes(error.body?.code); }

export default async function handler(request, response) {
  if (request.method !== 'POST') return json(response, 405, { error: 'Only POST is supported' });
  if (!hasWebhookToken(request)) return json(response, 401, { error: 'Invalid Moment webhook token' });

  const body = requestBody(request);
  const url = requestUrl(request);
  let userId;
  try { userId = await configuredOwnerId(); } catch { return json(response, 503, { error: 'Moment webhook account could not be resolved' }); }
  if (!validUserId(userId)) return json(response, 422, { error: 'Moment webhook account is not configured' });
  const title = textValue(body, url) || 'Voice moment';
  const description = descriptionValue(body);

  try {
    await ensureProfile(userId);
    let row;
    let lastError;
    for (const payload of payloads(userId, title, description)) {
      try {
        const rows = await supabaseRequest('tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([payload]) });
        row = rows?.[0];
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!canRetry(error)) throw error;
      }
    }
    if (lastError) throw lastError;
    if (!row) throw new Error('Moment was not persisted by the database');
    return json(response, 201, { moment: row });
  } catch (error) {
    return json(response, error.status && error.status >= 500 ? error.status : 500, { error: error.message || 'Could not save Moment' });
  }
}
