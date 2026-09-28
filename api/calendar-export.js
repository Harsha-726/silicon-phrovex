import { createHash, randomBytes } from 'node:crypto';
import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const CALENDAR_CONTENT_TYPE = 'text/calendar; charset=utf-8';
const DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

function queryParams(request) {
  if (request.query && typeof request.query === 'object') return request.query;
  return Object.fromEntries(new URL(request.url || 'http://localhost').searchParams.entries());
}

function appUrl(request) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = request.headers?.host || 'localhost:5173';
  return `${host.startsWith('localhost') ? 'http' : 'https'}://${host}`;
}

function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function newToken() { return randomBytes(32).toString('base64url'); }

function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function dateParts(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match.slice(1).map(Number) : null;
}

function icsDate(dateKey) {
  const parts = dateParts(dateKey);
  return parts ? `${String(parts[0]).padStart(4, '0')}${String(parts[1]).padStart(2, '0')}${String(parts[2]).padStart(2, '0')}` : '';
}

function addDays(dateKey, days) {
  const parts = dateParts(dateKey);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return date.toISOString().slice(0, 10);
}

function normalizedTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:00`;
}

function timedValue(dateKey, time) { return `${icsDate(dateKey)}T${normalizedTime(time).replace(/:/g, '')}`; }

function recurrenceRule(recurrence, dueDate) {
  if (!recurrence || typeof recurrence !== 'object') return null;
  const frequency = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[String(recurrence.frequency).toLowerCase()];
  if (!frequency) return null;
  const parts = [`FREQ=${frequency}`, `INTERVAL=${Math.max(1, Number(recurrence.interval) || 1)}`];
  if (frequency === 'WEEKLY' && Array.isArray(recurrence.days)) {
    const days = recurrence.days.filter(day => Number.isInteger(Number(day)) && Number(day) >= 0 && Number(day) <= 6).map(day => DAY_NAMES[Number(day)]);
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  }
  if (frequency === 'MONTHLY') {
    const day = dateParts(dueDate)?.[2];
    if (day) parts.push(`BYMONTHDAY=${day}`);
  }
  return parts.join(';');
}

function exportableTask(task, todayKey = new Date().toISOString().slice(0, 10)) {
  const scheduledDate = task?.scheduled_date || task?.due_date;
  if (!task || task.status === 'completed' || !scheduledDate) return false;
  if (!task.recurrence && scheduledDate < todayKey) return false;
  return Boolean(dateParts(scheduledDate));
}

function calendarEvent(task) {
  const dueDate = task.scheduled_date || task.due_date;
  const time = normalizedTime(task.scheduled_time || task.due_time);
  const duration = Math.max(1, Number(task.duration_minutes) || 30);
  const event = {
    uid: `silico-task-${task.id}@silico`,
    summary: task.title || 'Untitled task',
    description: task.description || '',
    categories: task.class_name || ''
  };
  if (time) {
    const start = new Date(`${dueDate}T${time}Z`);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    event.dtstart = `DTSTART:${timedValue(dueDate, time)}`;
    event.dtend = `DTEND:${timedValue(end.toISOString().slice(0, 10), end.toISOString().slice(11, 19))}`;
  } else {
    event.dtstart = `DTSTART;VALUE=DATE:${icsDate(dueDate)}`;
    event.dtend = `DTEND;VALUE=DATE:${icsDate(addDays(dueDate, 1))}`;
  }
  event.rrule = recurrenceRule(task.recurrence, dueDate);
  return event;
}

function buildCalendar(tasks, todayKey) {
  const events = tasks.filter(task => exportableTask(task, todayKey)).map(calendarEvent);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Silico//Silico Tasks//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Silico Tasks'
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `SUMMARY:${escapeIcsText(event.summary)}`, `DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.categories) lines.push(`CATEGORIES:${escapeIcsText(event.categories)}`);
    lines.push(event.dtstart, event.dtend);
    if (event.rrule) lines.push(`RRULE:${event.rrule}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export async function activeUserForToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const rows = await supabaseRequest(`calendar_feed_tokens?token_hash=eq.${encodeURIComponent(hashToken(token))}&active=eq.true&select=user_id&limit=1`);
  return rows?.[0]?.user_id || null;
}

async function generateFeed(userId, request, regenerate = false) {
  await ensureProfile(userId);
  if (regenerate) await supabaseRequest(`calendar_feed_tokens?user_id=eq.${encodeURIComponent(userId)}&active=eq.true`, { method: 'PATCH', body: JSON.stringify({ active: false, revoked_at: new Date().toISOString() }) });
  const token = newToken();
  await supabaseRequest('calendar_feed_tokens', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, token_hash: hashToken(token), active: true }]) });
  return { feedUrl: `${appUrl(request)}/api/calendar-export?token=${encodeURIComponent(token)}`, active: true };
}

async function revokeFeed(userId) {
  await supabaseRequest(`calendar_feed_tokens?user_id=eq.${encodeURIComponent(userId)}&active=eq.true`, { method: 'PATCH', body: JSON.stringify({ active: false, revoked_at: new Date().toISOString() }) });
  return { active: false };
}

function sendCalendar(response, body) {
  response.status(200);
  response.setHeader('Content-Type', CALENDAR_CONTENT_TYPE);
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return response.send(body);
}

export default async function handler(request, response) {
  const params = queryParams(request);
  try {
    if (request.method === 'GET' && params.token) {
      const userId = await activeUserForToken(params.token);
      if (!userId) return json(response, 404, { error: 'Calendar feed not found' });
      const tasks = await supabaseRequest(`tasks?user_id=eq.${encodeURIComponent(userId)}&select=id,title,description,status,due_date,due_time,scheduled_date,scheduled_time,duration_minutes,class_name,recurrence`);
      return sendCalendar(response, buildCalendar(tasks || []));
    }
    const auth = await requireClerkUser(request, response);
    if (auth.error) return auth.error;
    if (request.method === 'GET') {
      const rows = await supabaseRequest(`calendar_feed_tokens?user_id=eq.${encodeURIComponent(auth.userId)}&active=eq.true&select=user_id&limit=1`);
      return json(response, 200, { active: Boolean(rows?.length) });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
    const action = requestBody(request).action;
    if (action === 'generate' || action === 'regenerate') return json(response, 200, await generateFeed(auth.userId, request, action === 'regenerate'));
    if (action === 'revoke') return json(response, 200, await revokeFeed(auth.userId));
    return json(response, 400, { error: 'Unsupported calendar feed operation' });
  } catch (error) {
    return json(response, error.status || 422, { error: error.message || 'Calendar feed operation failed' });
  }
}

export { buildCalendar, calendarEvent, escapeIcsText, exportableTask, recurrenceRule };
