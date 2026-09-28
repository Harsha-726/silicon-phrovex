import { timingSafeEqual } from 'node:crypto';
import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const categories = new Set(['bug', 'feedback']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailCache = new Map();

function hasAdminKey(request) {
  const expected = String(process.env.FEEDBACK_ADMIN_KEY || '');
  const received = String(request.headers['x-feedback-admin-key'] || '');
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function hasAdminAccess(request, userId) {
  if (hasAdminKey(request)) {
    await ensureProfile(userId);
    await supabaseRequest('feedback_admin_access', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: userId }])
    });
    return true;
  }
  const rows = await supabaseRequest(`feedback_admin_access?user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`);
  return Boolean(rows?.[0]);
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

async function clerkEmail(userId) {
  if (!userId || !process.env.CLERK_SECRET_KEY) return null;
  if (emailCache.has(userId)) return emailCache.get(userId);
  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const user = await response.json();
    const primary = user.email_addresses?.find(address => address.id === user.primary_email_address_id) || user.email_addresses?.[0];
    const email = typeof primary?.email_address === 'string' ? primary.email_address : null;
    emailCache.set(userId, email);
    return email;
  } catch { return null; }
}

async function attachEmails(rows) {
  const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))];
  let cursor = 0;
  async function worker() {
    while (cursor < userIds.length) {
      const userId = userIds[cursor++];
      await clerkEmail(userId);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, userIds.length) }, () => worker()));
  return rows.map(row => ({ ...row, user_email: emailCache.get(row.user_id) || null }));
}

function normalizeFeedback(input = {}) {
  const category = String(input.category || 'feedback').trim().toLowerCase();
  if (!categories.has(category)) throw new Error('Feedback type is invalid');
  const message = String(input.message || '').trim();
  if (!message || message.length > 5000) throw new Error('Feedback must be between 1 and 5000 characters');
  const page = String(input.page || '').trim().slice(0, 80);
  return { category, message, page };
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  if (request.method === 'GET') {
    try {
      if (!await hasAdminAccess(request, auth.userId)) return json(response, 403, { error: 'Feedback access is restricted' });
      const rows = await supabaseRequest('feedback?select=id,user_id,category,message,page,created_at,resolved&order=created_at.desc&limit=200');
      return json(response, 200, { feedback: await attachEmails(Array.isArray(rows) ? rows : []) });
    } catch (error) {
      return json(response, error.status || 422, { error: error.message || 'Feedback could not be loaded' });
    }
  }
  if (request.method === 'PATCH') {
    try {
      if (!await hasAdminAccess(request, auth.userId)) return json(response, 403, { error: 'Feedback access is restricted' });
      const body = requestBody(request);
      const id = String(body.id || '').trim();
      if (!uuidPattern.test(id)) return json(response, 422, { error: 'Feedback item is invalid' });
      if (typeof body.resolved !== 'boolean') return json(response, 422, { error: 'Resolved status is invalid' });
      const rows = await supabaseRequest(`feedback?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ resolved: body.resolved }) });
      if (!rows?.[0]) return json(response, 404, { error: 'Feedback item not found' });
      return json(response, 200, { feedback: rows[0] });
    } catch (error) {
      return json(response, error.status || 422, { error: error.message || 'Feedback status could not be updated' });
    }
  }
  if (request.method === 'DELETE') {
    try {
      if (!await hasAdminAccess(request, auth.userId)) return json(response, 403, { error: 'Feedback access is restricted' });
      await supabaseRequest(`feedback_admin_access?user_id=eq.${encodeURIComponent(auth.userId)}`, { method: 'DELETE' });
      return json(response, 200, { revoked: true });
    } catch (error) {
      return json(response, error.status || 422, { error: error.message || 'Feedback access could not be revoked' });
    }
  }
  if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
  try {
    const feedback = normalizeFeedback(requestBody(request).feedback);
    await ensureProfile(auth.userId);
    const rows = await supabaseRequest('feedback', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ user_id: auth.userId, category: feedback.category, message: feedback.message, page: feedback.page }])
    });
    return json(response, 201, { received: true, feedback: rows?.[0] ? { id: rows[0].id, category: rows[0].category } : null });
  } catch (error) {
    return json(response, error.status || 422, { error: error.message || 'Feedback could not be submitted' });
  }
}

export { normalizeFeedback };
