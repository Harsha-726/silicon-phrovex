import { INTENTS, parseCapture } from './core.js';
import { getAuthHeaders } from './platform.js';

const allowedIntents = new Set(Object.values(INTENTS).concat(['RESCHEDULE_TASK', 'COMPLETE_TASK', 'DELETE_TASK']));

function normalizeRemoteCommand(raw, fallback) {
  if (!raw || !allowedIntents.has(raw.intent)) return fallback;
  const title = typeof raw.title === 'string' && raw.title.trim().length <= 500 ? raw.title.trim() : fallback.title;
  const subject = typeof raw.subject === 'string' && raw.subject.length <= 100 ? raw.subject : fallback.subject;
  return { ...fallback, intent: raw.intent, title, subject };
}

export async function parseCaptureCommand(input, now = new Date()) {
  const fallback = parseCapture(input, now);
  try {
    const response = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) }, body: JSON.stringify({ input }) });
    if (!response.ok) return response.status >= 500 || response.status === 429 ? { ...fallback, warning: 'AI parsing is temporarily unavailable. Silico used its local parser.' } : fallback;
    const payload = await response.json();
    return normalizeRemoteCommand(payload.command, fallback);
  } catch {
    return { ...fallback, warning: 'Silico used its local parser because the parser service could not be reached.' };
  }
}
