const DAY_MS = 86_400_000;

export const INTENTS = {
  CREATE_TASK: 'CREATE_TASK',
  CREATE_ASSESSMENT: 'CREATE_ASSESSMENT',
  CREATE_RECURRING_TASK: 'CREATE_RECURRING_TASK',
  EDIT_TASK: 'EDIT_TASK',
  DELETE_TASK: 'DELETE_TASK',
  COMPLETE_TASK: 'COMPLETE_TASK',
  RESCHEDULE_TASK: 'RESCHEDULE_TASK',
  QUERY_TODAY: 'QUERY_TODAY',
  QUERY_UPCOMING: 'QUERY_UPCOMING',
  QUERY_FREE_TIME: 'QUERY_FREE_TIME',
  QUERY_RECOMMENDATION: 'QUERY_RECOMMENDATION',
  STUDY_PLANNING: 'STUDY_PLANNING',
  GENERAL_QUERY: 'GENERAL_QUERY'
};

export const uid = (prefix = 'task') => `${prefix}_${crypto.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;

export function toDateKey(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

export function isDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = parseDateKey(key);
  return toDateKey(date) === key;
}

export function dateAt(dateKey, time = '09:00') {
  const [hour, minute] = time.split(':').map(Number);
  const date = parseDateKey(dateKey);
  date.setHours(hour || 0, minute || 0, 0, 0);
  return date;
}

export function formatDate(key, options = { month: 'short', day: 'numeric' }) {
  return parseDateKey(key).toLocaleDateString(undefined, options);
}

export function formatLongDate(key) {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatTime(time) {
  if (!time) return '';
  const [hour, minute] = time.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const normalized = hour % 12 || 12;
  return `${normalized}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function addDays(key, amount) {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
}

export function startOfWeek(key) {
  const date = parseDateKey(key);
  date.setDate(date.getDate() - date.getDay());
  return toDateKey(date);
}

export function resolveDatePhrase(text, now = new Date()) {
  const lower = text.toLowerCase();
  const today = toDateKey(now);
  if (/\btoday\b/.test(lower) || /\bright now\b/.test(lower)) return today;
  if (/\btonight\b/.test(lower)) return today;
  if (/\btom(?:orrow)?\b|\btmw\b/.test(lower)) return addDays(today, 1);
  const inDays = lower.match(/\bin\s+(\d+|one|two|three|four|five|six|seven)\s+days?\b/);
  if (inDays) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    return addDays(today, Number(inDays[1]) || words[inDays[1]]);
  }

  const weekdays = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const weekday = Object.entries(weekdays).find(([name]) => new RegExp(`\\b${name}\\b`).test(lower));
  if (weekday) {
    const target = weekday[1];
    const current = now.getDay();
    if (/\bthis\s+/.test(lower)) return addDays(today, target - current);
    let delta = (target - current + 7) % 7;
    if (/\bnext\s+/.test(lower)) delta += 7;
    return addDays(today, delta);
  }

  const explicit = lower.match(/\b(?:on\s+)?(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
  if (explicit) {
    const year = explicit[3] ? Number(explicit[3].length === 2 ? `20${explicit[3]}` : explicit[3]) : now.getFullYear();
    const candidate = new Date(year, Number(explicit[1]) - 1, Number(explicit[2]));
    if (candidate.getFullYear() !== year || candidate.getMonth() !== Number(explicit[1]) - 1 || candidate.getDate() !== Number(explicit[2])) return null;
    if (!explicit[3] && candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) candidate.setFullYear(year + 1);
    return toDateKey(candidate);
  }
  return null;
}

export function resolveTimePhrase(text) {
  const lower = text.toLowerCase();
  const match = lower.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3];
  if (hour > 23 || minute > 59 || (meridiem && hour > 12) || (meridiem && hour === 0)) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && hour < 8) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function resolveDuration(text) {
  const match = text.toLowerCase().match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)/);
  if (!match) return null;
  return Math.round(Number(match[1]) * (/hour|hr/.test(match[2]) ? 60 : 1));
}

export function recurrenceFromText(text) {
  const lower = text.toLowerCase();
  if (/every\s+weekday|weekdays/.test(lower)) return { frequency: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] };
  if (/every\s+day|daily/.test(lower)) return { frequency: 'daily', interval: 1, days: [] };
  if (/every\s+2\s+weeks?/.test(lower)) return { frequency: 'weekly', interval: 2, days: [] };
  const weekdayNames = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const weekday = Object.entries(weekdayNames).find(([name]) => new RegExp(`every\\s+${name}`).test(lower));
  if (weekday) return { frequency: 'weekly', interval: 1, days: [weekday[1]] };
  if (/every\s+week|weekly/.test(lower)) return { frequency: 'weekly', interval: 1, days: [] };
  if (/every\s+month|monthly/.test(lower)) return { frequency: 'monthly', interval: 1, days: [] };
  return null;
}

export function isOverdue(task, now = new Date()) {
  if (task.status === 'completed' || !task.dueDate) return false;
  return dateAt(task.dueDate, task.dueTime || '23:59') < now;
}

export function taskSort(a, b) {
  const aTime = dateAt(a.dueDate || '9999-12-31', a.dueTime || '23:59').getTime();
  const bTime = dateAt(b.dueDate || '9999-12-31', b.dueTime || '23:59').getTime();
  return aTime - bTime || (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title);
}

export function occurrenceKey(task, dateKey) {
  return `${task.id}::${dateKey}`;
}

export function expandRecurringTask(task, fromKey, toKey, completionMap = {}) {
  if (!task.recurrence) return [task];
  const results = [];
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  for (let cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
    const dateKey = toDateKey(cursor);
    const original = parseDateKey(task.dueDate || fromKey);
    const daysSinceStart = calendarDayDiff(original, cursor);
    const recurrence = task.recurrence;
    const matches = recurrence.frequency === 'daily'
      ? daysSinceStart >= 0 && daysSinceStart % recurrence.interval === 0
      : recurrence.frequency === 'monthly'
        ? cursor.getDate() === original.getDate() && cursor >= original
        : cursor >= original && (!recurrence.days?.length ? daysSinceStart >= 0 && daysSinceStart % (7 * recurrence.interval) < 7 : recurrence.days.includes(cursor.getDay()) && Math.floor(daysSinceStart / 7) % recurrence.interval === 0);
    if (matches) {
      const key = occurrenceKey(task, dateKey);
      results.push({ ...task, id: key, occurrenceKey: key, dueDate: dateKey, status: completionMap[key] ? 'completed' : 'open', recurrenceSourceId: task.id });
    }
  }
  return results;
}

function calendarDayDiff(start, end) {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / DAY_MS);
}

export function extractSubject(title) {
  const lower = title.toLowerCase();
  const aliases = { bio: 'Biology', biology: 'Biology', biolgy: 'Biology', chem: 'Chemistry', chemistry: 'Chemistry', calc: 'Calculus', calculus: 'Calculus', math: 'Mathematics', english: 'English', apush: 'AP US History', history: 'History' };
  const hit = Object.entries(aliases).find(([alias]) => new RegExp(`\\b${alias}\\b`).test(lower));
  return hit?.[1] || null;
}

export function parseCapture(input, now = new Date()) {
  const text = input.trim();
  const lower = text.toLowerCase();
  const date = resolveDatePhrase(text, now);
  const time = resolveTimePhrase(text);
  const duration = resolveDuration(text);
  const recurrence = recurrenceFromText(text);
  const subject = extractSubject(text);
  if (/what do i have|what is on my schedule|show me today/.test(lower) && /today|right now/.test(lower)) return { intent: INTENTS.QUERY_TODAY, raw: text, duration };
  if (/what do i have|what is on my schedule|what is upcoming|what's upcoming|show me/.test(lower) && /upcoming|tomorrow|this week|next week/.test(lower)) return { intent: INTENTS.QUERY_UPCOMING, raw: text, duration };
  if (/what should i do|what should i study|can i finish|when should i study|do i have time/.test(lower) && /right now|now|tonight|today|before|this week/.test(lower)) return { intent: INTENTS.QUERY_RECOMMENDATION, raw: text, duration };
  if (/what should i study|when should i study|what should i do|can i finish/.test(lower)) return { intent: INTENTS.QUERY_RECOMMENDATION, raw: text, duration };
  if (/\bfree\b|available/.test(lower)) return { intent: INTENTS.QUERY_FREE_TIME, raw: text, duration };
  if (/\btest\b|\bexam\b|\bquiz\b|assessment/.test(lower) && date) return { intent: INTENTS.CREATE_ASSESSMENT, title: cleanTitle(text), subject, dueDate: date, dueTime: time, duration: duration || 45, raw: text };
  if (/\bdelete\b|\bremove\b/.test(lower)) return { intent: INTENTS.DELETE_TASK, title: cleanTitle(text), raw: text };
  if (/\bcomplete\b|\bdone\b|\bfinish(?:ed)?\b/.test(lower)) return { intent: INTENTS.COMPLETE_TASK, title: cleanTitle(text), raw: text };
  if (/\bedit\b|\brename\b/.test(lower)) return { intent: INTENTS.EDIT_TASK, title: cleanTitle(text), raw: text };
  if (/move|reschedule/.test(lower)) return { intent: INTENTS.RESCHEDULE_TASK, title: cleanTitle(text), subject, dueDate: date, dueTime: time, raw: text };
  return { intent: recurrence ? INTENTS.CREATE_RECURRING_TASK : INTENTS.CREATE_TASK, title: cleanTitle(text), subject, dueDate: date || (recurrence ? toDateKey(now) : null), dueTime: time, duration: duration || null, recurrence, raw: text };
}

export function assessmentIdempotencyKey(command) {
  return `assessment:${(command.subject || '').toLowerCase()}:${(command.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}:${command.dueDate || ''}`;
}

function cleanTitle(text) {
  return text.replace(/\b(?:today|tomorrow|tmw|tonight|next|this|at|on|in\s+\d+\s+days?|every\s+(?:day|weekday|week|2\s+weeks?|month|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|daily|weekly|monthly)\b/gi, '').replace(/\bhw\b/gi, 'homework').replace(/\s{2,}/g, ' ').replace(/[,.]$/, '').trim().replace(/^(i have|remind me to|i need to|finish|do|delete|remove|complete|edit|rename|move|reschedule)\s+/i, '').replace(/^(?:a|an)\s+/i, '').replace(/\b(biolgy|bio)\b/i, 'Biology').replace(/\bchem\b/i, 'Chemistry').replace(/\btest\b/i, 'Test');
}

export function makeTask(command, overrides = {}) {
  const now = new Date().toISOString();
  return { id: uid(), title: command.title || 'Untitled task', description: '', status: 'open', priority: 1, dueDate: command.dueDate, dueTime: command.dueTime, duration: command.duration || 30, project: overrides.project || null, className: command.subject || null, recurrence: command.recurrence || null, relatedAssessmentId: overrides.relatedAssessmentId || null, source: overrides.source || 'capture', idempotencyKey: overrides.idempotencyKey || null, createdAt: now, updatedAt: now, completedAt: null };
}

export function findOpenSlot(tasks, dateKey, duration = 45, preferences = {}) {
  const preferredStart = preferences.preferredStart || '16:30';
  const latest = preferences.latestStudyTime || '21:00';
  const now = preferences.now || new Date();
  const schoolStart = preferences.schoolStart || '08:00';
  const schoolEnd = preferences.schoolEnd || '16:00';
  const schoolDays = Array.isArray(preferences.schoolDays) ? preferences.schoolDays : [1, 2, 3, 4, 5];
  const date = parseDateKey(dateKey);
  const schoolBlock = schoolDays.includes(date.getDay()) ? [{ start: toMinutes(schoolStart), end: toMinutes(schoolEnd) }] : [];
  const start = Math.max(dateKey === toDateKey(now) ? now.getHours() * 60 + now.getMinutes() + 15 : 0, toMinutes(preferredStart));
  const end = toMinutes(latest);
  const fixedBlocks = (preferences.blockedPeriods || []).filter(block => block.date === dateKey || (block.weekday !== undefined && Number(block.weekday) === date.getDay())).map(block => ({ start: toMinutes(block.start), end: toMinutes(block.end) }));
  const busy = tasks.filter(task => task.status !== 'completed' && task.dueDate === dateKey && task.dueTime).map(task => ({ start: toMinutes(task.dueTime), end: toMinutes(task.dueTime) + (task.duration || 30) })).concat(schoolBlock, fixedBlocks).sort((a, b) => a.start - b.start);
  for (let cursor = roundToQuarter(start); cursor + duration <= end; cursor += 15) {
    if (cursor < start) continue;
    const overlaps = busy.some(slot => cursor < slot.end && cursor + duration > slot.start);
    if (!overlaps) return toClock(cursor);
  }
  return null;
}

export function planStudySessions(assessment, tasks, profile = {}) {
  const classProfile = profile.classPreferences?.[assessment.className] || {};
  const settings = { ...profile, ...classProfile };
  const count = Math.min(5, Math.max(1, settings.sessionsPerAssessment || settings.sessionsPerWeek || 3));
  const due = parseDateKey(assessment.dueDate);
  const existing = tasks.filter(task => task.relatedAssessmentId === assessment.id && task.type === 'study_session');
  if (existing.length >= count) return [];
  const now = profile.now || new Date();
  const candidates = [];
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = new Date(due);
    date.setDate(date.getDate() - offset);
    if (date < parseDateKey(toDateKey(now))) continue;
    candidates.unshift(toDateKey(date));
  }
  const spread = distributeDates(candidates, count);
  const sessions = [];
  for (const dateKey of spread) {
    if (sessions.length >= count) break;
    const time = findOpenSlot([...tasks, ...sessions], dateKey, settings.sessionLength || 45, { ...settings, now });
    if (!time) continue;
    const identity = `${assessment.idempotencyKey || assessment.id}:${dateKey}:${time}`;
    if (tasks.some(task => task.schedulingIdentity === identity) || sessions.some(task => task.schedulingIdentity === identity)) continue;
    sessions.push({ ...makeTask({ title: `${assessment.className || 'Study'} Study`, dueDate: dateKey, dueTime: time, duration: settings.sessionLength || 45, subject: assessment.className }, { relatedAssessmentId: assessment.id, source: 'scheduler' }), type: 'study_session', schedulingIdentity: identity, priority: Math.max(1, assessment.priority || 1) });
  }
  return sessions;
}

function distributeDates(candidates, count) {
  if (count >= candidates.length) return candidates;
  if (count <= 1) return candidates.length ? [candidates[candidates.length - 1]] : [];
  const selected = [];
  const lastIndex = candidates.length - 1;
  for (let index = 0; index < count; index += 1) {
    const candidateIndex = Math.round((index * lastIndex) / (count - 1));
    const date = candidates[candidateIndex];
    if (date && !selected.includes(date)) selected.push(date);
  }
  return selected;
}

export function rankRecommendations(tasks, now = new Date(), availableMinutes = Infinity) {
  const current = now.getTime();
  return tasks.filter(task => task.status !== 'completed' && (!task.dueDate || (task.duration || 30) <= availableMinutes)).map(task => {
    const due = task.dueDate ? dateAt(task.dueDate, task.dueTime || '23:59').getTime() : current + DAY_MS * 30;
    const daysAway = Math.max(0, (due - current) / DAY_MS);
    const deadlineScore = Math.max(0, 100 - daysAway * 12);
    const priorityScore = (task.priority || 1) * 18;
    const assessmentScore = task.relatedAssessmentId || task.type === 'assessment' ? 20 : 0;
    return { task, score: deadlineScore + priorityScore + assessmentScore };
  }).sort((a, b) => b.score - a.score || taskSort(a.task, b.task)).map(item => item.task);
}

export function recordCompletion(gamification = {}, task, completedAt = new Date()) {
  const awarded = { ...(gamification.awardedTaskIds || {}) };
  const identity = task.occurrenceKey || task.id;
  if (!identity || awarded[identity]) return { ...gamification, awardedTaskIds: awarded };
  awarded[identity] = true;
  const amount = task.type === 'study_session' ? 12 : task.type === 'assessment' ? 15 : 10;
  const next = { ...gamification, xp: Math.max(0, Number(gamification.xp) || 0) + amount, awardedTaskIds: awarded };
  return updateStreak(next, completedAt);
}

export function updateStreak(gamification = {}, completedAt = new Date()) {
  const dateKey = toDateKey(completedAt);
  const completedDays = new Set(gamification.completedDays || []);
  completedDays.add(dateKey);
  let currentStreak = 0;
  let cursor = parseDateKey(dateKey);
  while (completedDays.has(toDateKey(cursor))) {
    currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  const longestStreak = Math.max(Number(gamification.longestStreak) || 0, currentStreak);
  return { ...gamification, currentStreak, longestStreak, completedDays: [...completedDays].sort(), lastCompletionDate: dateKey };
}

export function gamificationLevel(xp = 0) {
  return Math.max(1, Math.floor(Math.max(0, Number(xp) || 0) / 100) + 1);
}

function toMinutes(time) { const [h, m] = time.split(':').map(Number); return h * 60 + m; }
function toClock(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
function roundToQuarter(minutes) { return Math.ceil(minutes / 15) * 15; }

export const seedState = () => {
  const today = toDateKey();
  const tomorrow = addDays(today, 1);
  const friday = addDays(today, (5 - new Date().getDay() + 7) % 7 || 7);
  const now = new Date().toISOString();
  return {
    tasks: [
      { id: 'seed_bio', title: 'Biology Study', description: 'Review the current unit.', status: 'open', priority: 2, dueDate: today, dueTime: '17:00', duration: 45, className: 'Biology', project: null, recurrence: null, relatedAssessmentId: 'seed_test', source: 'scheduler', createdAt: now, updatedAt: now, completedAt: null, type: 'study_session', schedulingIdentity: 'seed_test:today:1700' },
      { id: 'seed_math', title: 'Math homework', description: '', status: 'open', priority: 3, dueDate: today, dueTime: '18:00', duration: 45, className: 'Mathematics', project: 'Homework', recurrence: null, relatedAssessmentId: null, source: 'capture', createdAt: now, updatedAt: now, completedAt: null },
      { id: 'seed_vex', title: 'VEX team meeting', description: '', status: 'open', priority: 2, dueDate: tomorrow, dueTime: '18:00', duration: 60, className: null, project: 'VEX Robotics', recurrence: null, relatedAssessmentId: null, source: 'calendar', createdAt: now, updatedAt: now, completedAt: null, type: 'fixed_event' },
      { id: 'seed_test', title: 'Biology Test', description: 'Unit 2 assessment', status: 'open', priority: 3, dueDate: friday, dueTime: null, duration: 60, className: 'Biology', project: null, recurrence: null, relatedAssessmentId: null, source: 'capture', createdAt: now, updatedAt: now, completedAt: null, type: 'assessment' },
      { id: 'seed_english', title: 'English reading', description: '', status: 'completed', priority: 1, dueDate: today, dueTime: null, duration: 30, className: 'English', project: null, recurrence: null, relatedAssessmentId: null, source: 'capture', createdAt: now, updatedAt: now, completedAt: now }
    ],
    profile: { onboardingComplete: false, schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '21:00', sessionLength: 45, sessionsPerAssessment: 3, sessionsPerWeek: 2, methods: ['Review notes'], classPreferences: { Biology: { sessionsPerWeek: 3, sessionLength: 45 }, Mathematics: { sessionsPerWeek: 2, sessionLength: 45 }, English: { sessionsPerWeek: 2, sessionLength: 30 }, Chemistry: { sessionsPerWeek: 2, sessionLength: 45 } }, gamification: { xp: 0, currentStreak: 0, longestStreak: 0, completedDays: [], awardedTaskIds: {} } },
    classes: ['Biology', 'Mathematics', 'English', 'Chemistry'],
    projects: ['Homework', 'VEX Robotics']
  };
};
