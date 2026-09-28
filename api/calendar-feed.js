import { requireClerkUser, json } from './_auth.js';

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

export function normalizeCalendarFeedUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Calendar feed URL is required');
  const normalized = raw.replace(/^webcal:/i, 'https:');
  let url;
  try { url = new URL(normalized); } catch { throw new Error('Enter a valid webcal:// or https:// calendar feed URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) throw new Error('Only public webcal:// or https:// calendar feeds are supported');
  return url.toString();
}

async function readResponseBody(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_FEED_BYTES) throw new Error('Calendar feed is too large');
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FEED_BYTES) { await reader.cancel(); throw new Error('Calendar feed is too large'); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchCalendarFeed(value) {
  let url = normalizeCalendarFeedUrl(value);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, { headers: { Accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.1', 'User-Agent': 'SilicoCalendarSync/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === MAX_REDIRECTS) throw new Error('Calendar feed redirected too many times');
      const location = response.headers.get('location');
      if (!location) throw new Error('Calendar feed redirect was missing its destination');
      url = normalizeCalendarFeedUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Calendar feed returned HTTP ${response.status}`);
    const body = await readResponseBody(response);
    if (!/^\s*BEGIN:VCALENDAR\b/i.test(body)) throw new Error('The URL did not return a valid iCalendar feed');
    return { url, body };
  }
  throw new Error('Calendar feed could not be loaded');
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
  try {
    const result = await fetchCalendarFeed(requestBody(request).url);
    return json(response, 200, result);
  } catch (error) {
    const status = /required|valid|supported|too large|iCalendar/i.test(error.message) ? 422 : 502;
    return json(response, status, { error: error.message || 'Calendar feed could not be loaded' });
  }
}
