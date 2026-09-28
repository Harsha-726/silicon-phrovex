import { cleanCaptureInput, extractSubject, INTENTS, parseCapture, cleanTaskTitle, splitCaptureInput } from './core.js';
import { getAuthHeaders } from './platform.js';

const allowedIntents = new Set(Object.values(INTENTS).concat(['RESCHEDULE_TASK', 'COMPLETE_TASK', 'DELETE_TASK']));
// Leave enough time for the authenticated server hop and Groq response. The
// deterministic parser still renders immediately while this request is in flight.
const REMOTE_PARSER_TIMEOUT_MS = 7500;
const REMOTE_PARSER_COOLDOWN_MS = 60_000;
let remoteParserUnavailableUntil = 0;

function normalizeRemoteCommand(raw, fallback) {
  if (!raw || !allowedIntents.has(raw.intent)) return fallback;
  const cleanedTitle = typeof raw.title === 'string' && raw.title.trim().length <= 500 ? cleanTaskTitle(cleanCaptureInput(raw.title)) : '';
  const title = cleanedTitle || fallback.title;
  const remoteSubject = typeof raw.subject === 'string' && raw.subject.length <= 100 ? cleanCaptureInput(raw.subject) : '';
  const subject = extractSubject(remoteSubject) || fallback.subject;
  const isCreateIntent = [INTENTS.CREATE_TASK, INTENTS.CREATE_ASSESSMENT, INTENTS.CREATE_RECURRING_TASK].includes(fallback.intent);
  const remoteCreateIntent = [INTENTS.CREATE_TASK, INTENTS.CREATE_ASSESSMENT, INTENTS.CREATE_RECURRING_TASK].includes(raw.intent);
  const localQuestion = String(fallback.intent || '').startsWith('QUERY_') || fallback.intent === INTENTS.CLEAR_SCHEDULE;
  const localStudyPlan = fallback.intent === INTENTS.STUDY_PLANNING;
  const intent = localStudyPlan || (isCreateIntent && !remoteCreateIntent) || (localQuestion && remoteCreateIntent)
    ? fallback.intent
    : (fallback.intent === INTENTS.CREATE_ASSESSMENT && raw.intent !== INTENTS.CREATE_ASSESSMENT ? fallback.intent : raw.intent);
  return { ...fallback, intent, title, subject };
}

async function parseSingleCaptureCommand(input, now = new Date()) {
  const normalizedInput = cleanCaptureInput(input);
  const fallback = parseCapture(normalizedInput, now);
  if (Date.now() < remoteParserUnavailableUntil) return { ...fallback, warning: 'AI parsing is rate-limited right now. Silico used its local parser.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_PARSER_TIMEOUT_MS);
  try {
    const response = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()) }, body: JSON.stringify({ input: normalizedInput }), signal: controller.signal });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) remoteParserUnavailableUntil = Date.now() + REMOTE_PARSER_COOLDOWN_MS;
      if (response.status >= 500 || response.status === 429) return { ...fallback, warning: 'AI parsing is temporarily unavailable. Silico used its local parser.' };
      if (response.status === 401 || response.status === 403) return { ...fallback, warning: 'AI parsing could not authenticate. Silico used its local parser.' };
      return fallback;
    }
    const payload = await response.json();
    return normalizeRemoteCommand(payload.command, fallback);
  } catch {
    remoteParserUnavailableUntil = Date.now() + REMOTE_PARSER_COOLDOWN_MS;
    return controller.signal.aborted ? { ...fallback, warning: 'AI parsing timed out. Silico used its local parser.' } : { ...fallback, warning: 'Silico used its local parser because the parser service could not be reached.' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseCaptureCommand(input, now = new Date()) {
  const commands = await parseCaptureCommands(input, now);
  return commands.length === 1 ? commands[0] : { intent: 'MULTI_CREATE', commands, raw: cleanCaptureInput(input) };
}

export async function parseCaptureCommands(input, now = new Date()) {
  const commands = [];
  for (const part of splitCaptureInput(input, now)) commands.push(await parseSingleCaptureCommand(part, now));
  return commands;
}
