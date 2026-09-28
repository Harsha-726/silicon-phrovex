import { requireClerkUser } from './_auth.js';

// Server-side parser boundary for Vercel. Deterministic client parsing remains
// the offline fallback, but Groq is only reachable from an authenticated request.
const PARSER_COOLDOWN_MS = 60_000;
let parserUnavailableUntil = 0;

function parserBusy(response) {
  response.setHeader?.('Retry-After', String(Math.ceil(Math.max(1, parserUnavailableUntil - Date.now()) / 1000)));
  return response.status(429).json({ error: 'Parser is busy. Silico will use its local parser for a moment.' });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  if (!process.env.GROQ_API_KEY) return response.status(503).json({ error: 'Parser service is not configured' });
  if (Date.now() < parserUnavailableUntil) return parserBusy(response);
  let body = request.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { input } = body;
  if (typeof input !== 'string' || input.length < 1 || input.length > 500) return response.status(400).json({ error: 'Invalid input' });
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return only a JSON intent command. Allowed intents: CREATE_TASK, CREATE_ASSESSMENT, CREATE_RECURRING_TASK, EDIT_TASK, DELETE_TASK, COMPLETE_TASK, RESCHEDULE_TASK, QUERY_TODAY, QUERY_UPCOMING, QUERY_FREE_TIME, QUERY_RECOMMENDATION, QUERY_CAPACITY, QUERY_DAY_SUMMARY, QUERY_WHEN_TO_DO, CLEAR_SCHEDULE, STUDY_PLANNING, GENERAL_QUERY. Questions must use a QUERY_* intent and must never create work. Use CLEAR_SCHEDULE only for an explicit request to remove planned work, which the application will confirm. Use CREATE_ASSESSMENT for a test, exam, quiz, or assessment with a due date. Use STUDY_PLANNING only for an explicit request to plan studying. Never include database IDs, user IDs, authorization decisions, or mutations.' }, { role: 'user', content: input }], max_tokens: 300 })
    });
    if (upstream.status === 429) { parserUnavailableUntil = Date.now() + PARSER_COOLDOWN_MS; return parserBusy(response); }
    if (!upstream.ok) {
      if (upstream.status >= 500) parserUnavailableUntil = Date.now() + PARSER_COOLDOWN_MS;
      return response.status(502).json({ error: 'Parser provider failed' });
    }
    const payload = await upstream.json();
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
    const allowed = ['CREATE_TASK', 'CREATE_ASSESSMENT', 'CREATE_RECURRING_TASK', 'EDIT_TASK', 'DELETE_TASK', 'COMPLETE_TASK', 'RESCHEDULE_TASK', 'QUERY_TODAY', 'QUERY_UPCOMING', 'QUERY_FREE_TIME', 'QUERY_RECOMMENDATION', 'QUERY_CAPACITY', 'QUERY_DAY_SUMMARY', 'QUERY_WHEN_TO_DO', 'CLEAR_SCHEDULE', 'STUDY_PLANNING', 'GENERAL_QUERY'];
    if (!allowed.includes(parsed.intent)) return response.status(422).json({ error: 'Unsupported parser intent' });
    if (parsed.title !== undefined && (typeof parsed.title !== 'string' || parsed.title.length > 500)) return response.status(422).json({ error: 'Invalid parser title' });
    if (parsed.subject !== undefined && (typeof parsed.subject !== 'string' || parsed.subject.length > 100)) return response.status(422).json({ error: 'Invalid parser subject' });
    delete parsed.user_id;
    delete parsed.userId;
    delete parsed.task_id;
    delete parsed.taskId;
    return response.status(200).json({ command: parsed });
  } catch { parserUnavailableUntil = Date.now() + PARSER_COOLDOWN_MS; return response.status(502).json({ error: 'Invalid parser response' }); }
}
