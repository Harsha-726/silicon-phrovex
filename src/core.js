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
  QUERY_CAPACITY: 'QUERY_CAPACITY',
  QUERY_DAY_SUMMARY: 'QUERY_DAY_SUMMARY',
  QUERY_WHEN_TO_DO: 'QUERY_WHEN_TO_DO',
  CLEAR_SCHEDULE: 'CLEAR_SCHEDULE',
  STUDY_PLANNING: 'STUDY_PLANNING',
  GENERAL_QUERY: 'GENERAL_QUERY'
};

// A schedule is part of the task's meaning, not just a derived timestamp.
// Keep the source of that decision explicit so later planner passes cannot
// mistake an existing allocation for unscheduled work.
export const SCHEDULE_ORIGINS = Object.freeze({
  USER_SCHEDULED: 'USER_SCHEDULED',
  SILICO_SCHEDULED: 'SILICO_SCHEDULED',
  UNSCHEDULED: 'UNSCHEDULED'
});

export const SCHEDULE_CHANGE_REASONS = Object.freeze({
  OVERDUE_RECOVERY: 'OVERDUE_RECOVERY',
  HARD_STOP_CONFLICT: 'HARD_STOP_CONFLICT',
  HARD_COMMITMENT_CONFLICT: 'HARD_COMMITMENT_CONFLICT',
  TIME_CONFLICT: 'TIME_CONFLICT',
  DURATION_REORDERING: 'DURATION_REORDERING'
});

export const ASSIGNMENT_TYPES = [
  { value: 'study', label: 'Study' },
  { value: 'test', label: 'Test' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'homework', label: 'Homework' },
  { value: 'club_meeting', label: 'Club Meeting' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'project', label: 'Project' },
  { value: 'essay', label: 'Essay' },
  { value: 'presentation', label: 'Presentation' },
  { value: 'event', label: 'Event' },
  { value: 'reminder', label: 'Reminder' },
  { value: 'other', label: 'Other' }
];

const assignmentTypeValues = new Set(ASSIGNMENT_TYPES.map(type => type.value));
export function assignmentTypeLabel(value) { return ASSIGNMENT_TYPES.find(type => type.value === value)?.label || 'Other'; }
export function inferAssignmentType(title = '', taskType = 'task', source = 'capture') {
  const text = String(title || '').toLowerCase();
  if (/\bclub\b.*\b(meet|meeting)\b|\b(meet|meeting)\b.*\bclub\b/.test(text)) return 'club_meeting';
  if (/\b(exam|midterm|final|test)\b/.test(text)) return 'test';
  if (/\bquiz\b/.test(text)) return 'quiz';
  if (/\b(hw|homework|assignment|worksheet)\b/.test(text)) return 'homework';
  if (/\b(essay|paper)\b/.test(text)) return 'essay';
  if (/\b(presentation|present)\b/.test(text)) return 'presentation';
  if (/\b(project|capstone)\b/.test(text)) return 'project';
  if (/\b(meet|meeting|appointment|call)\b/.test(text)) return 'meeting';
  if (/\b(study|review|read|flashcard|practice)\b/.test(text)) return 'study';
  if (taskType === 'study_session') return 'study';
  if (taskType === 'assessment') return 'test';
  if (taskType === 'fixed_event' || source === 'calendar') return 'event';
  return assignmentTypeValues.has('homework') ? 'homework' : ASSIGNMENT_TYPES[0].value;
}

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

export function taskSyncTimestamp(task) {
  return Date.parse(task?.updatedAt || task?.updated_at || task?.createdAt || task?.created_at || '') || 0;
}

export function teamTaskFeedRecord(task) {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || typeof task.team_project_id !== 'string') return null;
  const dueDate = isDateKey(task.due_date) ? task.due_date : null;
  const dueTime = typeof task.due_time === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(task.due_time) ? task.due_time.slice(0, 8) : null;
  const priority = Number(task.priority);
  const duration = Number(task.duration_minutes);
  return {
    id: `team_${task.team_project_id}_${task.id}`,
    teamTaskId: task.id,
    teamProjectId: task.team_project_id,
    teamProjectName: typeof task.project_name === 'string' ? task.project_name : '',
    title: String(task.title || 'Untitled team task').trim().slice(0, 500) || 'Untitled team task',
    description: typeof task.description === 'string' ? task.description : '',
    status: task.completed || task.completed_by_me ? 'completed' : 'open',
    priority: [1, 2, 3, 4].includes(priority) ? priority : 1,
    dueDate,
    dueTime,
    duration: Number.isFinite(duration) && duration > 0 ? Math.min(1440, duration) : 30,
    subprojectId: typeof task.subproject_id === 'string' ? task.subproject_id : null,
    subprojectName: typeof task.subproject_name === 'string' ? task.subproject_name : null,
    assigneeId: typeof task.assignee_id === 'string' ? task.assignee_id : null,
    assigneeName: typeof task.assignee_name === 'string' ? task.assignee_name : null,
    className: null,
    project: null,
    recurrence: null,
    relatedAssessmentId: null,
    source: 'team',
    type: 'team_task',
    createdAt: task.created_at || null,
    updatedAt: task.updated_at || task.created_at || null,
    completedAt: task.completed || task.completed_by_me ? task.completed_at || null : null,
    teamCompletionCount: Number.isInteger(Number(task.completion_count)) ? Number(task.completion_count) : 0,
    teamMemberCount: Number.isInteger(Number(task.member_count)) ? Number(task.member_count) : 0
  };
}

export function isClearedByTaskTombstone(task, clearedAt) {
  const timestamp = Date.parse(clearedAt || '');
  return Number.isFinite(timestamp) && taskSyncTimestamp(task) <= timestamp;
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
  const lower = String(text || '').toLowerCase();
  const today = toDateKey(now);
  if (/\btoday\b/.test(lower) || /\bright now\b/.test(lower)) return today;
  if (/\btonight\b/.test(lower)) return today;
  if (/\btom(?:orrow)?\b|\btmw\b|\btmrw\b|\btmr\b|\btomoz\b|\b2moro\b/.test(lower)) return addDays(today, 1);
  const inDays = lower.match(/\bin\s+(\d+|one|two|three|four|five|six|seven)\s+days?\b/);
  if (inDays) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    return addDays(today, Number(inDays[1]) || words[inDays[1]]);
  }
  const inWeeks = lower.match(/\bin\s+(\d+|one|two|three|four)\s+weeks?\b/);
  if (inWeeks) {
    const words = { one: 1, two: 2, three: 3, four: 4 };
    return addDays(today, (Number(inWeeks[1]) || words[inWeeks[1]]) * 7);
  }
  if (/\bthis\s+weekend\b/.test(lower)) {
    const daysUntilSaturday = (6 - now.getDay() + 7) % 7;
    return addDays(today, daysUntilSaturday || 7);
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

  const months = { january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 };
  const named = lower.match(/\b(?:on\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,?\s+(\d{2,4}))?\b/);
  if (named) {
    const year = named[3] ? Number(named[3].length === 2 ? '20' + named[3] : named[3]) : now.getFullYear();
    const candidate = new Date(year, months[named[1]], Number(named[2]));
    if (candidate.getFullYear() !== year || candidate.getMonth() !== months[named[1]] || candidate.getDate() !== Number(named[2])) return null;
    if (!named[3] && candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) candidate.setFullYear(year + 1);
    return toDateKey(candidate);
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

const weekdayNames = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

// Study requests can name several days in one sentence. Keep this separate
// from resolveDatePhrase, whose contract is intentionally one date.
export function resolveStudyDates(text, now = new Date()) {
  const lower = String(text || '').toLowerCase();
  const matches = [];
  for (const [name, weekday] of Object.entries(weekdayNames)) {
    const match = lower.match(new RegExp(`\\b${name}\\b`));
    if (!match) continue;
    const current = now.getDay();
    let delta = (weekday - current + 7) % 7;
    if (/\bnext\s+/.test(lower.slice(Math.max(0, match.index - 8), match.index + name.length))) delta += 7;
    if (/\bthis\s+/.test(lower.slice(Math.max(0, match.index - 8), match.index + name.length))) delta = weekday - current;
    matches.push(addDays(toDateKey(now), delta));
  }
  return [...new Set(matches)].sort();
}

export function resolveTimePhrase(text) {
  const lower = String(text || '').toLowerCase();
  let match = lower.match(/\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) {
    // Casual student shorthand often omits "at": "vex thurs 6".
    if (!/\b(?:meet|meeting|practice|vex|today|tomorrow|tonight|sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat)\b/.test(lower)) return null;
    const trailing = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/);
    if (!trailing) return null;
    match = trailing;
  }
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
  const match = String(text || '').toLowerCase().match(/(?:for\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven)\s*(minutes?|mins?|hours?|hrs?)/);
  if (!match) return null;
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  return Math.round((Number(match[1]) || words[match[1]]) * (/hour|hr/.test(match[2]) ? 60 : 1));
}

export function resolvePriority(text) {
  const lower = String(text || '').toLowerCase();
  const match = lower.match(/!!([1-4])\b|\bp([1-4])\b|\bpriority\s*[:#-]?\s*([1-4])\b/);
  if (!match) return null;
  const todoistPriority = Number(match[1] || match[2] || match[3]);
  return todoistPriority === 1 ? 4 : todoistPriority === 2 ? 3 : todoistPriority === 3 ? 2 : 1;
}

export function recurrenceFromText(text) {
  const lower = String(text || '').toLowerCase();
  if (/every\s+weekday|weekdays/.test(lower)) return normalizeRecurrence({ frequency: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] });
  if (/every\s*day|daily/.test(lower)) return normalizeRecurrence({ frequency: 'daily', interval: 1, days: [] });
  if (/every\s+2\s+weeks?/.test(lower)) return normalizeRecurrence({ frequency: 'weekly', interval: 2, days: [] });
  const weekdayNames = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  const weekday = Object.entries(weekdayNames).find(([name]) => new RegExp(`every\\s+${name}`).test(lower));
  if (weekday) return normalizeRecurrence({ frequency: 'weekly', interval: 1, days: [weekday[1]] });
  if (/every\s+week|weekly/.test(lower)) return normalizeRecurrence({ frequency: 'weekly', interval: 1, days: [] });
  if (/every\s+month|monthly/.test(lower)) return normalizeRecurrence({ frequency: 'monthly', interval: 1, days: [] });
  return null;
}

// Recurrence is persisted JSON and therefore cannot be trusted to have the
// shape produced by the current parser. Normalize it at every model boundary
// so one malformed row can never crash the date expansion/render path.
export function normalizeRecurrence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frequency = ['daily', 'weekly', 'monthly'].includes(value.frequency) ? value.frequency : null;
  if (!frequency) return null;
  const interval = Math.max(1, Math.min(365, Math.floor(Number(value.interval) || 1)));
  const days = [...new Set((Array.isArray(value.days) ? value.days : []).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))];
  return { frequency, interval, days };
}

export function isOverdue(task, now = new Date()) {
  if (task.status === 'completed') return false;
  const execution = taskExecution(task);
  const executionDate = execution.date || task.dueDate;
  if (!executionDate) return false;
  const executionTime = execution.time || task.dueTime || '23:59';
  return dateAt(executionDate, executionTime) < now;
}

// User-created schedules may never point behind the current wall clock. A
// date-only task scheduled for today is still valid until the day ends; a
// same-day task with an explicit time must be at or after the current time.
// Existing overdue records are intentionally not mutated here—this helper is
// for validating new or edited user intent at the write boundary.
export function isPastSchedule(dateKey, time = null, now = new Date()) {
  if (!isDateKey(dateKey)) return false;
  const todayKey = toDateKey(now);
  if (dateKey < todayKey) return true;
  if (dateKey > todayKey || !time) return false;
  return dateAt(dateKey, time) < now;
}

function validClock(value) {
  return typeof value === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(value);
}

// One execution timestamp for every kind of work. `dueDate`/`dueTime` remain
// the deadline fields; they are not allowed to double as a planned start for
// ordinary tasks. The legacy scheduled_* columns are mirrored for backwards
// compatibility with the existing database and are kept in sync by the
// setters below.
export function taskExecution(task = {}) {
  const legacyDate = isDateKey(task.scheduledDate) ? task.scheduledDate : null;
  const legacyTime = validClock(task.scheduledTime) ? task.scheduledTime.slice(0, 8) : null;
  const stored = task.schedule?.execution;
  const storedDate = isDateKey(stored?.date) ? stored.date : null;
  const storedTime = validClock(stored?.time) ? stored.time.slice(0, 8) : null;
  if (legacyDate || legacyTime) return { date: legacyDate, time: legacyTime };
  if (storedDate || storedTime) return { date: storedDate, time: storedTime };
  const legacyExecution = task.type === 'study_session'
    || task.type === 'fixed_event'
    || task.source === 'calendar'
    || task.source === 'scheduler'
    || task.autoScheduled === true
    || task.assignmentType === 'study';
  return legacyExecution && isDateKey(task.dueDate)
    ? { date: task.dueDate, time: validClock(task.dueTime) ? task.dueTime.slice(0, 8) : null }
    : { date: null, time: null };
}

// Study-session identity must survive edits and migrations. Older rows used
// the assessment's capture/idempotency key, while edited rows could be
// rewritten with the assessment UUID. The assessment anchor plus the actual
// execution slot is the stable identity shared by both forms.
export function assessmentSessionIdentity(assessment, session) {
  const anchor = assessment?.idempotencyKey || assessment?.id || session?.relatedAssessmentId || null;
  const execution = taskExecution(session || {});
  const identitySlot = String(session?.schedulingIdentity || '').match(/:(\d{4}-\d{2}-\d{2}):(\d{2}:?\d{2})(?::\d{2})?$/);
  const date = execution.date || session?.dueDate || identitySlot?.[1] || null;
  const time = execution.time || session?.dueTime || (identitySlot?.[2] ? `${identitySlot[2].slice(0, 2)}:${identitySlot[2].slice(-2)}` : null);
  return anchor && date && time ? `${anchor}:${date}:${time}` : null;
}

function preferAssessmentSession(left, right) {
  if (left?.status === 'completed' && right?.status !== 'completed') return left;
  if (right?.status === 'completed' && left?.status !== 'completed') return right;
  const leftUpdated = taskSyncTimestamp(left);
  const rightUpdated = taskSyncTimestamp(right);
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? left : right;
  const leftRemote = typeof left?.id === 'string' && /^[0-9a-f-]{36}$/i.test(left.id);
  const rightRemote = typeof right?.id === 'string' && /^[0-9a-f-]{36}$/i.test(right.id);
  if (leftRemote !== rightRemote) return leftRemote ? left : right;
  return String(left?.id || '').localeCompare(String(right?.id || '')) <= 0 ? left : right;
}

export function taskDeadline(task = {}) {
  return {
    date: isDateKey(task.dueDate) ? task.dueDate : null,
    time: validClock(task.dueTime) ? task.dueTime.slice(0, 8) : null
  };
}

export function setTaskExecution(task, date, time = null) {
  if (!task || typeof task !== 'object') return task;
  const nextDate = isDateKey(date) ? date : null;
  const nextTime = validClock(time) ? time.slice(0, 8) : null;
  task.scheduledDate = nextDate;
  task.scheduledTime = nextTime;
  task.schedule = {
    ...(task.schedule && typeof task.schedule === 'object' ? task.schedule : {}),
    execution: { date: nextDate, time: nextTime }
  };
  return task;
}

export function clearTaskExecution(task) {
  return setTaskExecution(task, null, null);
}

export function withTaskExecution(task, date, time = null) {
  return setTaskExecution({ ...(task || {}) }, date, time);
}

export function taskExecutionIsPast(task, now = new Date()) {
  const execution = taskExecution(task);
  return isPastSchedule(execution.date, execution.time, now);
}

export function scheduleOriginOf(task = {}) {
  if (Object.values(SCHEDULE_ORIGINS).includes(task.scheduleOrigin)) return task.scheduleOrigin;
  if (task.userPinned === true || task.userScheduled === true || task.type === 'fixed_event' || task.source === 'calendar') return SCHEDULE_ORIGINS.USER_SCHEDULED;
  if (task.autoScheduled === true && (task.scheduledDate || task.scheduledTime || task.dueTime)) return SCHEDULE_ORIGINS.SILICO_SCHEDULED;
  if (!task.scheduledDate && !task.scheduledTime && !task.dueTime) return SCHEDULE_ORIGINS.UNSCHEDULED;
  return task.scheduledDate || task.scheduledTime ? SCHEDULE_ORIGINS.USER_SCHEDULED : SCHEDULE_ORIGINS.UNSCHEDULED;
}

export function isUserControlledSchedule(task = {}) {
  return scheduleOriginOf(task) === SCHEDULE_ORIGINS.USER_SCHEDULED || task.userPinned === true;
}

// Explicit execution times, imported commitments, and assessments are rigid
// anchors. A date-only task is anchored to its date but can receive a flexible
// after-school time.
export function isRigidExecution(task = {}) {
  const assignmentType = String(task.assignmentType || '').toLowerCase();
  const flexibleAssignment = ['study', 'homework', 'reminder', 'project', 'essay', 'other'].includes(assignmentType);
  const userFixedExecution = task.userPinned === true
    || task.explicitExecution === true
    || task.scheduleOrigin === SCHEDULE_ORIGINS.USER_SCHEDULED && task.flexibility === 'fixed' && Boolean(task.scheduledDate && task.scheduledTime)
    || task.userScheduled === true && task.flexibility === 'fixed' && Boolean(task.scheduledDate && task.scheduledTime);
  // Older rows may carry executionPinned from the old planner even though
  // their time was only a previous allocation. Ordinary work is flexible
  // unless the new explicitExecution marker (or a user pin) says otherwise.
  if (flexibleAssignment
    && !userFixedExecution
    && task.type !== 'fixed_event'
    && task.source !== 'calendar') return false;
  return userFixedExecution
    || task.type === 'fixed_event'
    || task.type === 'assessment'
    || task.source === 'calendar'
    // Legacy records without authority metadata are treated conservatively
    // when they already contain a complete scheduled timestamp.
    || !flexibleAssignment && task.autoScheduled !== true && task.userScheduled !== true && task.source !== 'scheduler' && task.type !== 'study_session' && task.assignmentType !== 'study' && Boolean(task.scheduledDate && task.scheduledTime)
    || ['test', 'quiz', 'event', 'meeting', 'club_meeting', 'presentation'].includes(assignmentType);
}

export function isFlexibleSchedule(task = {}) {
  return task.status !== 'completed'
    && (!task.type || task.type === 'task')
    && Boolean(task.scheduledDate && task.scheduledTime)
    && task.scheduleOrigin === SCHEDULE_ORIGINS.SILICO_SCHEDULED
    && task.userPinned !== true
    && task.userScheduled !== true
    && ['flexible', 'planned', undefined, null].includes(task.flexibility);
}

export function taskSort(a, b) {
  // Display order follows the execution timestamp. A due date is only the
  // fallback for work that has not received a separate execution allocation.
  const aDate = a.scheduledDate || a.dueDate || '9999-12-31';
  const bDate = b.scheduledDate || b.dueDate || '9999-12-31';
  const aTime = dateAt(aDate, a.scheduledTime || a.dueTime || '23:59').getTime();
  const bTime = dateAt(bDate, b.scheduledTime || b.dueTime || '23:59').getTime();
  return aTime - bTime
    || String(a.id || '').localeCompare(String(b.id || ''))
    || String(a.title || '').localeCompare(String(b.title || ''));
}

export function occurrenceKey(task, dateKey) {
  return `${task.id}::${dateKey}`;
}

export function expandRecurringTask(task, fromKey, toKey, completionMap = {}) {
  const recurrence = normalizeRecurrence(task.recurrence);
  if (!recurrence) return [task];
  const results = [];
  const from = parseDateKey(fromKey);
  const to = parseDateKey(toKey);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
  const original = parseDateKey(task.dueDate || fromKey);
  if (Number.isNaN(original.getTime())) return [task];
  for (let cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
    const dateKey = toDateKey(cursor);
    const daysSinceStart = calendarDayDiff(original, cursor);
    const matches = recurrence.frequency === 'daily'
      ? daysSinceStart >= 0 && daysSinceStart % recurrence.interval === 0
      : recurrence.frequency === 'monthly'
        ? cursor.getDate() === original.getDate() && cursor >= original
        : cursor >= original && (!recurrence.days.length ? daysSinceStart >= 0 && daysSinceStart % (7 * recurrence.interval) < 7 : recurrence.days.includes(cursor.getDay()) && Math.floor(daysSinceStart / 7) % recurrence.interval === 0);
    if (matches) {
      const key = occurrenceKey(task, dateKey);
      const occurrence = { ...task, id: key, occurrenceKey: key, dueDate: dateKey, status: completionMap[key] ? 'completed' : 'open', recurrenceSourceId: task.id, recurrence };
      // A planner allocation belongs to this occurrence, not to every future
      // occurrence. Keep a recurring task's time-of-day while rebasing the
      // execution date so upcoming/calendar views do not collapse onto the
      // first generated day.
      if (task.scheduledDate || task.scheduledTime || task.schedule?.execution?.date || task.schedule?.execution?.time) {
        setTaskExecution(occurrence, dateKey, task.scheduledTime || task.schedule?.execution?.time || task.dueTime || null);
      }
      results.push(occurrence);
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
  const lower = String(title || '').toLowerCase();
  const aliases = {
    bio: 'Biology', biology: 'Biology', biolgy: 'Biology', bioogy: 'Biology',
    chem: 'Chemistry', chemistry: 'Chemistry', chemestry: 'Chemistry', chemisty: 'Chemistry',
    calc: 'Calculus', calculus: 'Calculus', calculas: 'Calculus', calclus: 'Calculus',
    math: 'Mathematics', maths: 'Mathematics', mathematics: 'Mathematics',
    english: 'English', ela: 'English', engish: 'English',
    apush: 'AP US History', history: 'History', histroy: 'History',
    physics: 'Physics', phys: 'Physics', spanish: 'Spanish', french: 'French'
  };
  const hit = Object.entries(aliases).find(([alias]) => new RegExp(`\\b${alias}\\b`).test(lower));
  return hit?.[1] || null;
}

const classNoiseWords = new Set(['a', 'an', 'and', 'assignment', 'assignments', 'calendar', 'class', 'course', 'event', 'exam', 'homework', 'hw', 'quiz', 'school', 'schoology', 'subject', 'test', 'the']);
const classAliases = { bio: 'biology', biolgy: 'biology', biology: 'biology', chem: 'chemistry', chemical: 'chemistry', chemistry: 'chemistry', calc: 'calculus', calculus: 'calculus', math: 'mathematics', mathematics: 'mathematics', trig: 'mathematics', precalc: 'mathematics', precalculus: 'mathematics', apush: 'history', 'ap us history': 'history', ushistory: 'history', ela: 'english', english: 'english', literature: 'english', writing: 'english', ap: 'advanced', history: 'history' };
const classFamilies = [
  new Set(['math', 'mathematics', 'calculus', 'calc', 'geometry', 'algebra', 'statistics', 'stats']),
  new Set(['history', 'world', 'apush', 'ushistory', 'economics', 'econ', 'government', 'civics']),
  new Set(['science', 'biology', 'bio', 'chemistry', 'chem', 'physics']),
  new Set(['english', 'ela', 'literature', 'writing'])
];

function classKey(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
function classTokens(value) { return classKey(value).split(' ').filter(token => token && !classNoiseWords.has(token)).map(token => classAliases[token] || token); }
function classFamily(value) {
  const tokens = classKey(value).split(' ').filter(Boolean);
  return classFamilies.find(family => tokens.some(token => family.has(token))) || null;
}

export function matchExistingClass(command = {}, classes = []) {
  const available = classes.filter(name => typeof name === 'string' && name.trim());
  if (!available.length) return null;
  const metadata = [command.subject, command.classHint, ...(Array.isArray(command.hints) ? command.hints : [])]
    .filter(Boolean)
    .flatMap(value => String(value).split(/[,;|/]+/).map(part => part.trim()).filter(Boolean));
  const title = String(command.title || '');
  const source = [command.subject, command.classHint, ...metadata, title, command.raw].filter(Boolean).join(' ');

  // Feed metadata is the most reliable signal. A category such as
  // "APUSH, Assignment" must be split before comparing it with a saved
  // class label, otherwise the generic event category hides the course.
  for (const hint of metadata) {
    const exact = available.find(name => classKey(name) === classKey(hint));
    if (exact) return exact;
  }

  const named = available
    .map((name, index) => ({ name, index, key: classKey(name) }))
    .filter(({ key }) => key.length >= 3 && (` ${classKey(source)} `).includes(` ${key} `))
    .sort((a, b) => b.key.length - a.key.length || a.index - b.index)[0];
  if (named) return named.name;

  const sourceTokens = new Set(classTokens(source));
  const candidates = available.map((name, index) => {
    const tokens = classTokens(name).filter(token => token.length >= 4);
    const overlap = tokens.filter(token => sourceTokens.has(token));
    const metadataOverlap = metadata.flatMap(hint => classTokens(hint)).filter(token => tokens.includes(token));
    return { name, index, score: metadataOverlap.length * 20 + overlap.length * 5, overlap: overlap.length };
  }).filter(candidate => candidate.overlap > 0).sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.index - b.index);
  if (candidates.length && candidates[0].score > (candidates[1]?.score || 0)) return candidates[0].name;

  const requestedFamily = classFamily(metadata.join(' ') || command.subject) || classFamily(title);
  if (!requestedFamily) return null;
  const familyMatches = available.filter(name => classFamily(name) === requestedFamily);
  return familyMatches.length === 1 ? familyMatches[0] : null;
}

const typoCorrections = {
  // Common shorthand and keyboard slips for task types.
  tst: 'test', tset: 'test', tesst: 'test', tstt: 'test',
  qui: 'quiz', qiz: 'quiz', quizz: 'quiz', qizz: 'quiz',
  exm: 'exam', asess: 'assessment', assessmnt: 'assessment',
  asg: 'assignment', asgn: 'assignment', asignment: 'assignment', assinment: 'assignment',
  hwk: 'homework', proj: 'project', pres: 'presentation', mtg: 'meeting', appt: 'appointment', tast: 'task', taks: 'task',
  // Canonicalize day abbreviations before date resolution and title cleanup.
  sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday',
  wed: 'wednesday', weds: 'wednesday', thu: 'thursday', thurs: 'thursday',
  fri: 'friday', sat: 'saturday',
  biolgy: 'biology', bioogy: 'biology',
  chemestry: 'chemistry', chemisty: 'chemistry',
  calculas: 'calculus', calclus: 'calculus',
  geometery: 'geometry', geomtry: 'geometry',
  algerba: 'algebra', algabra: 'algebra',
  histroy: 'history', engish: 'english',
  wednesdayy: 'wednesday', thursdy: 'thursday', thursdayy: 'thursday',
  frday: 'friday', saturdy: 'saturday', saterday: 'saturday',
  tommorow: 'tomorrow', tomorow: 'tomorrow', tmrw: 'tomorrow', tmr: 'tomorrow', tmw: 'tomorrow', tomoz: 'tomorrow',
  tonite: 'tonight', tdy: 'today', nxt: 'next', pls: 'please', plz: 'please',
  tuesdy: 'tuesday', wednsday: 'wednesday',
  hw: 'homework', ws: 'worksheet'
};
const fillerPatterns = [
  /^(?:hey[ ,]+)?(?:i(?:'m| am)|im)\s+(?:really|so|very|extremely)?\s*stressed\s*(?:about|over|with)?[ ,:;-]*/i,
  /^(?:i(?:'m| am)|im)\s+(?:overwhelmed|swamped|buried|busy|stressed)[,.!?;:\s]+/i,
  /^(?:please\s+)?(?:can|could|would)\s+you\s+/i,
  /^(?:please\s+)?(?:remind\s+me\s+to|i\s+need\s+to|i\s+wanted\s+to)\s+/i,
  /^(?:please\s+)?(?:add|create|make|put|schedule)\s+(?:(?:a|an|the)\s+)?/i,
  /^(?:just|please)\s+/i
];

export function cleanCaptureInput(input) {
  let text = String(input || '').replace(/[’‘]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  text = text.replace(/\b2moro\b/gi, 'tomorrow');
  text = text.replace(/\b[a-z]+\b/gi, word => typoCorrections[word.toLowerCase()] || word);
  for (let pass = 0; pass < 3; pass += 1) fillerPatterns.forEach(pattern => { text = text.replace(pattern, ''); });
  return text.trim();
}

export function splitCaptureInput(input) {
  const normalized = cleanCaptureInput(input);
  if (/^(?:what|show|when should|can i|do i|how much|how many)\b/i.test(normalized)) return [normalized];
  // Mixed turns can contain useful state followed by a question. Preserve
  // both halves so the caller can mutate state first and then answer from the
  // updated plan instead of turning the whole sentence into a task title.
  const mixedQuestion = normalized.match(/^(.*?)(?:[.!?]\s+|\s+)((?:what|when|can i|do i|will i|am i|how)\b.*\??)$/i);
  if (mixedQuestion && /\b(?:test|exam|quiz|homework|assignment|essay|project|meet|meeting|event|due|study)\b/i.test(mixedQuestion[1])) {
    const prefixParts = splitCaptureInput(mixedQuestion[1].trim());
    return [...prefixParts, mixedQuestion[2].trim()];
  }
  const dayToken = '(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)';
  const multipleDayList = new RegExp(`\\b${dayToken}\\b\\s*(?:,|and)\\s*\\b${dayToken}\\b`, 'i').test(normalized);
  // “study for chemistry on Thursday, Wednesday and Friday” is one plan,
  // even though the generic conjunction splitter normally creates commands.
  if ((/\b(?:study|review|prepare|prep|practice)\b/i.test(normalized) && (normalized.match(new RegExp(`\\b${dayToken}\\b`, 'gi')) || []).length > 1) || multipleDayList) return [normalized];
  const taskLike = part => /\b(?:test|exam|quiz|assessment|homework|assignment|essay|project|study|read|review|practice|submit|meet|meeting|appointment|call|event|due|finish|buy|email|write|prepare)\b/i.test(part) || /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/.]\d{1,2})\b/i.test(part);
  const commaParts = normalized.split(/,\s*(?:and\s+)?/i).map(part => part.trim()).filter(Boolean);
  const addSharedDate = parts => {
    if (parts.length < 2) return parts;
    const sharedDate = normalized.match(/((?:\b(?:on|due)\s+)?(?:today|tomorrow|tonight|sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)\s*)$/i)?.[1]?.trim();
    if (!sharedDate) return parts;
    return parts.map(part => resolveDatePhrase(part) ? part : `${part} ${sharedDate}`);
  };
  if (commaParts.length > 1 && commaParts.every(taskLike)) return addSharedDate(commaParts);
  const parts = normalized.split(/\s+(?:and then|and|also|plus|then)\s+/i).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return [normalized];
  return parts.every(taskLike) ? addSharedDate(parts) : [normalized];
}

export function parseCapture(input, now = new Date()) {
  const text = cleanCaptureInput(input);
  const lower = text.toLowerCase();
  const date = resolveDatePhrase(text, now);
  const dateSpecified = Boolean(date);
  const time = resolveTimePhrase(text);
  const duration = resolveDuration(text);
  const priority = resolvePriority(text);
  const recurrence = recurrenceFromText(text);
  const subject = extractSubject(text);
  const studyAssessmentRequest = /\b(?:study|review|prepare|prep|practice)\b.*\b(?:for|before)\b.*\b(?:test|exam|quiz|assessment)\b/.test(lower);
  const mentionedStudyDates = /\b(?:study|review|prepare|prep|practice)\b/.test(lower) ? resolveStudyDates(text, now) : [];
  // “Study for the X test on Saturday and Sunday” names preparation dates,
  // not an assessment deadline on Sunday. When no existing assessment is
  // available, the physical assessment is placed on the next day after the
  // final requested study date.
  const studyDates = mentionedStudyDates.length > 1 ? mentionedStudyDates : (!studyAssessmentRequest ? mentionedStudyDates : []);
  const inferredStudyAssessmentDate = studyAssessmentRequest && studyDates.length > 1 ? addDays(studyDates[studyDates.length - 1], 1) : null;
  const dueDates = !studyDates.length && !studyAssessmentRequest && resolveStudyDates(text, now).length > 1 && /\b(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b\s*(?:,|and)\s*\b(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/i.test(lower) ? resolveStudyDates(text, now) : [];
  const multiDateTitle = dueDates.length > 1 ? cleanTaskTitle(text).replace(/\band\b/gi, '').replace(/\s{2,}/g, ' ').trim() : null;
  if (/what(?:'s| is)?[ ]+(?:my|the)[ ]+day[ ]+look[ ]+like|what do i need to do[ ]+(?:today|tonight)|what(?:'s| is)?[ ]+going[ ]+on/.test(lower)) return { intent: INTENTS.QUERY_DAY_SUMMARY, raw: text, duration, subject, title: cleanTaskTitle(text) };
  if (/can i finish|will i finish|do i have enough time|is there enough time/.test(lower)) return { intent: INTENTS.QUERY_CAPACITY, raw: text, duration, subject, dueDate: date, title: cleanTaskTitle(text) };
  if (/when should i (?:do|work on)|when can i (?:do|work on)/.test(lower)) return { intent: INTENTS.QUERY_WHEN_TO_DO, raw: text, duration, subject, title: cleanTaskTitle(text) };
  if (/what(?:'s| is)?[ ]+most urgent|what do i need to do[ ]+(?:first|next)|what should i do[ ]+(?:after|tonight)/.test(lower)) return { intent: INTENTS.QUERY_RECOMMENDATION, raw: text, duration, subject, title: cleanTaskTitle(text) };
  if (/^(?:clear|empty|wipe)[ ]+(?:my[ ]+)?schedule(?:[ ]+(?:for[ ]+)?(?:tonight|today))?/.test(lower)) return { intent: INTENTS.CLEAR_SCHEDULE, raw: text, duration, subject, title: cleanTaskTitle(text) };
  if (/what do i have|what is on my schedule|show me today/.test(lower) && /today|right now/.test(lower)) return { intent: INTENTS.QUERY_TODAY, raw: text, duration };
  if (/what do i have|what is on my schedule|what is upcoming|what's upcoming|show me/.test(lower) && /upcoming|tomorrow|this week|next week/.test(lower)) return { intent: INTENTS.QUERY_UPCOMING, raw: text, duration };
  if (/what should i do|what should i study|what should i work on|do i have time/.test(lower) && /right now|now|tonight|today|before|this week|first|next/.test(lower)) return { intent: INTENTS.QUERY_RECOMMENDATION, raw: text, duration, subject, dueDate: date, title: cleanTaskTitle(text) };
  if (/what should i study|what should i do|what should i work on|when should i study|do i have time/.test(lower)) return { intent: INTENTS.QUERY_RECOMMENDATION, raw: text, duration, subject, dueDate: date, title: cleanTaskTitle(text) };
  if (duration && /\b(?:i have|got|have got)\b/.test(lower) && !/\b(?:add|create|finish|do|study|review|work on)\b/.test(lower)) return { intent: INTENTS.QUERY_FREE_TIME, raw: text, duration };
  if (/\bfree\b|available/.test(lower)) return { intent: INTENTS.QUERY_FREE_TIME, raw: text, duration };
  // A study request targets an assessment; it is not an assessment itself.
  // Keep this before the generic test/exam rule so it cannot create a test
  // named "Study for Chemistry Test".
  if (studyAssessmentRequest || studyDates.length) {
    return { intent: INTENTS.STUDY_PLANNING, title: cleanStudyTitle(text, subject), subject, dueDate: inferredStudyAssessmentDate || (studyAssessmentRequest ? date : null), dueDateExplicit: Boolean(inferredStudyAssessmentDate || dateSpecified), studyDates, dueTime: time, duration: duration || 45, priority: priority || 1, raw: text };
  }
  if (/^(?:move|reschedule|push)\b/.test(lower) || /\b(?:got|was)\s+moved\b|\bdeadline\s+(?:moved|changed)\b/.test(lower)) return { intent: INTENTS.RESCHEDULE_TASK, title: cleanTaskTitle(text), subject, dueDate: date, dueDateExplicit: dateSpecified, dueTime: time, raw: text };
  if (/\btest\b|\bexam\b|\bquiz\b|assessment/.test(lower) && date) return { intent: INTENTS.CREATE_ASSESSMENT, title: cleanTaskTitle(text), subject, dueDate: date, dueDateExplicit: dateSpecified, dueTime: time, duration: duration || 45, priority: priority || 1, raw: text };
  if (/^(?:delete|remove)\b/.test(lower)) return { intent: INTENTS.DELETE_TASK, title: cleanTaskTitle(text), raw: text };
  // “I need to complete X on Friday” is a scheduling request, not an action
  // against an existing row. cleanCaptureInput removes the conversational
  // prefix, so preserve the original intent before the completion-command
  // branch consumes it.
  const completionAsRequirement = /\b(?:i\s+(?:need|have)\s+to|must)\s+(?:complete|finish)\b/i.test(String(input || '')) && dateSpecified;
  if (/^(?:complete|done)\b/.test(lower) && !completionAsRequirement) return { intent: INTENTS.COMPLETE_TASK, title: cleanTaskTitle(text), raw: text };
  if (/^(?:edit|rename)\b/.test(lower)) return { intent: INTENTS.EDIT_TASK, title: cleanTaskTitle(text), raw: text };
  return { intent: recurrence ? INTENTS.CREATE_RECURRING_TASK : INTENTS.CREATE_TASK, title: multiDateTitle || cleanTaskTitle(text), subject, dueDate: date || toDateKey(now), dueDateExplicit: dateSpecified, dueDates, dueTime: time, duration: duration || null, priority: priority || 1, recurrence, raw: text };
}

export function assessmentIdempotencyKey(command) {
  return `assessment:${(command.subject || '').toLowerCase()}:${(command.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}:${command.dueDate || ''}`;
}

export function assessmentTitle(command = {}, className) {
  const source = cleanCaptureInput(command.raw || command.title || '');
  const kind = source.match(/\b(test|exam|quiz|assessment)\b/i)?.[1] || 'Test';
  if (!className) {
    // A study request can be the only description of an assessment. Do not
    // persist parser glue such as “study for … on and” as the physical test's
    // title when there is no class to provide the anchor name.
    const detail = cleanTaskTitle(source)
      .replace(/^\s*(?:study|review|prepare|prep|practice)\s+(?:for|before)\s+/i, '')
      .replace(/\b(test|exam|quiz|assessment)\b/gi, '')
      .replace(/\bon\s+and\b/gi, '')
      .replace(/\band\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    return `${detail ? `${titleCaseTaskTitle(detail)} ` : ''}${label}`.trim() || 'Assessment';
  }
  const subjectTokens = new Set(classTokens(command.subject));
  const subjectFamily = classFamily(command.subject) || classFamily(source);
  const detail = cleanTaskTitle(source).replace(/\bon\s*$/i, '').replace(/\b(test|exam|quiz|assessment)\b/gi, '').split(/\s+/).filter(Boolean).filter(word => !subjectTokens.has(classAliases[classKey(word)] || classKey(word)) && classFamily(word) !== subjectFamily).join(' ').trim();
  const prettyDetail = detail ? `${detail.slice(0, 1).toUpperCase()}${detail.slice(1)}` : '';
  return `${className}${prettyDetail ? ` ${prettyDetail}` : ''} ${kind.charAt(0).toUpperCase()}${kind.slice(1).toLowerCase()}`;
}

function legacyCleanTaskTitle(text) {
  return text
    .replace(/\b(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\bfor\s+(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven)\s*(?:minutes?|mins?|hours?|hrs?)\b/gi, '')
    .replace(/\b(?:on|by|due|__silico_on__)?\s*(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+\d{1,2}(?:,?\s+\d{2,4})?\b/gi, '')
    .replace(/\b(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/(?:!![1-4]|\bp[1-4]\b|\bpriority\s*[:#-]?\s*[1-4]\b|\b(?:today|tom(?:orrow)?|tmw|tmrw|tmr|tomoz|2moro|tonight|tonite|next|this|at|on|in\s+(?:\d+|one|two|three|four|five|six|seven)\s+days?|every\s+(?:day|weekday|week|2\s+weeks?|month|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rsday)?|fri(?:day)?|sat(?:urday)?|daily|weekly|monthly)\b)/gi, '')
    .replace(/\b(?:\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)\b/g, '')
    .replace(/\b(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
    .replace(/\bhw\b/gi, 'homework')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,.]$/, '')
    .trim()
    .replace(/\b(?:by|due)\s*$/i, '')
    .replace(/^(i have to|i need to|i've got to|i must|i have|remind me to|finish|do|add|create|make|put|schedule|delete|remove|complete|edit|rename|move|reschedule)\s+/i, '')
    .replace(/^(?:complete|finish)\s+/i, '')
    .replace(/^(?:a|an)\s+/i, '')
    .replace(/\b(biolgy|bio|biology)\b/i, 'Biology')
    .replace(/\b(chem|chemistry)\b/i, 'Chemistry')
    .replace(/\b(calculas|calclus|calculus)\b/i, 'Calculus')
    .replace(/\b(geometery|geomtry|geometry)\b/i, 'Geometry')
    .replace(/\btest\b/i, 'Test');
}

export function cleanTaskTitle(text) {
  const protectedOn = cleanCaptureInput(text).replace(/\bon\b/gi, '__silico_on__');
  return legacyCleanTaskTitle(protectedOn).replace(/\bthurs\b/gi, '').replace(/^push\s+/i, '').replace(/__silico_on__/gi, 'on').replace(/\bon\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
}

function cleanStudyTitle(text, subject) {
  let title = cleanTaskTitle(text).replace(/^(?:study|review|prepare|prep|practice)\s+(?:for|before)\s+/i, '');
  if (subject) title = removeClassFromTitle(title, subject);
  return title || 'Study';
}

export function removeClassFromTitle(title, className) {
  const original = String(title || '').trim();
  if (!original || !className) return original;
  const normalized = classKey(className);
  const variants = [String(className).trim()];
  if (normalized === 'ap us history') variants.push('APUSH');
  if (normalized === 'apush') variants.push('AP US History');
  if (normalized === 'us history') variants.push('USH');
  if (/\benglish\b|\bela\b/.test(normalized)) variants.push('English', 'ELA');
  if (/\bmathematics\b|\bmath\b/.test(normalized)) variants.push('Mathematics', 'MATH');
  if (/\bchemistry\b|\bchem\b/.test(normalized)) variants.push('Chemistry', 'CHEM');
  if (/\bbiology\b|\bbio\b/.test(normalized)) variants.push('Biology', 'BIO');
  let result = original;
  for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?:^|[\\s([{])${escaped}(?=$|[\\s)\\]}:|–—])\\s*(?:[-:|–—]\\s*)?`, 'gi'), ' ');
  }
  return result.replace(/\s{2,}/g, ' ').replace(/^\s*[-:|–—]\s*/, '').replace(/\s*[-:|–—]\s*$/, '').trim() || original;
}

const titleCaseAcronyms = new Map([['ab', 'AB'], ['act', 'ACT'], ['ap', 'AP'], ['apush', 'APUSH'], ['gpa', 'GPA'], ['sat', 'SAT'], ['uk', 'UK'], ['us', 'US'], ['usa', 'USA'], ['vex', 'VEX']]);

export function titleCaseTaskTitle(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  return words.map(word => word.split('-').map(part => {
    const match = part.match(/^(\W*)(.*?)(\W*)$/);
    if (!match?.[2]) return part;
    const lower = match[2].toLowerCase();
    const core = titleCaseAcronyms.get(lower) || (match[2].length > 1 && /^[A-Z0-9]+$/.test(match[2]) ? match[2] : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`);
    return `${match[1]}${core}${match[3]}`;
  }).join('-')).join(' ');
}

export function stableColorHue(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}

const classColorPalette = [12, 34, 58, 82, 116, 145, 174, 202, 230, 258, 286, 312, 338];

export function normalizeClassColorKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function assignUniqueClassHues(classes = [], saved = {}) {
  const names = [...new Map((Array.isArray(classes) ? classes : []).map(name => [normalizeClassColorKey(name), name])).entries()]
    .filter(([key]) => key)
    .map(([, name]) => name);
  const assigned = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
  const retained = new Set();
  const used = new Set();

  for (const name of names) {
    const key = normalizeClassColorKey(name);
    const hue = Number(assigned[key]);
    if (Number.isInteger(hue) && hue >= 0 && hue < 360 && !used.has(hue)) {
      retained.add(key);
      used.add(hue);
    }
  }

  for (const name of names) {
    const key = normalizeClassColorKey(name);
    if (retained.has(key)) continue;
    const start = stableColorHue(name);
    let hue = classColorPalette[start % classColorPalette.length];
    let paletteIndex = classColorPalette.indexOf(hue);
    while (used.has(hue) && paletteIndex < classColorPalette.length * 2) {
      paletteIndex = (paletteIndex + 1) % classColorPalette.length;
      hue = classColorPalette[paletteIndex];
    }
    if (used.has(hue)) {
      hue = start;
      while (used.has(hue)) hue = (hue + 7) % 360;
    }
    assigned[key] = hue;
    used.add(hue);
  }
  return assigned;
}

export function makeTask(command, overrides = {}) {
  const now = new Date().toISOString();
  const type = overrides.type || 'task';
  const source = overrides.source || 'capture';
  const title = titleCaseTaskTitle(command.title || 'Untitled task');
  const datePinned = overrides.datePinned ?? command.datePinned ?? Boolean(command.dueDateExplicit || command.scheduledDate || type === 'fixed_event');
  const executionPinned = overrides.executionPinned ?? command.executionPinned ?? Boolean(command.scheduledTime || type === 'fixed_event' || source === 'calendar');
  const userScheduled = overrides.userScheduled ?? command.userScheduled ?? Boolean(datePinned || executionPinned || type === 'fixed_event');
  const autoScheduled = overrides.autoScheduled ?? command.autoScheduled ?? false;
  const scheduledDate = overrides.scheduledDate ?? command.scheduledDate ?? (datePinned && command.dueDate ? command.dueDate : null);
  const scheduledTime = overrides.scheduledTime ?? command.scheduledTime ?? (executionPinned ? command.dueTime || null : null);
  const scheduleOrigin = overrides.scheduleOrigin
    || command.scheduleOrigin
    || (userScheduled ? SCHEDULE_ORIGINS.USER_SCHEDULED : autoScheduled || source === 'scheduler' && (scheduledDate || scheduledTime) ? SCHEDULE_ORIGINS.SILICO_SCHEDULED : SCHEDULE_ORIGINS.UNSCHEDULED);
  const task = {
    id: uid(), title, description: '', status: 'open', priority: Math.max(1, Math.min(4, Number(command.priority) || 1)),
    dueDate: command.dueDate || null, dueTime: command.dueTime || null,
    scheduledDate: null, scheduledTime: null,
    duration: command.duration || 30, remainingDuration: command.remainingDuration ?? command.duration ?? 30,
    project: overrides.project || null, className: command.subject || null,
    assignmentType: overrides.assignmentType || inferAssignmentType(title, type, source), recurrence: normalizeRecurrence(command.recurrence),
    relatedAssessmentId: overrides.relatedAssessmentId || null, source, type, idempotencyKey: overrides.idempotencyKey || null,
    userPinned: overrides.userPinned ?? command.userPinned ?? false, userScheduled, datePinned, executionPinned, explicitExecution: overrides.explicitExecution ?? command.explicitExecution ?? executionPinned, autoScheduled,
    scheduleOrigin, flexibility: overrides.flexibility || command.flexibility || (executionPinned || type === 'fixed_event' ? 'fixed' : 'flexible'),
    schedulingReason: overrides.schedulingReason || null, createdAt: now, updatedAt: now, completedAt: null
  };
  setTaskExecution(task, scheduledDate, scheduledTime);
  return task;
}

export function findOpenSlot(tasks, dateKey, duration = 45, preferences = {}) {
  const preferredStart = preferences.preferredStart || '16:00';
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
  const breakMinutes = Math.max(0, Math.min(30, Number(preferences.preferredBreakMinutes || preferences.preferredBreakLength) || 10));
  const busy = tasks.filter(task => task.status !== 'completed' && taskExecution(task).date === dateKey && taskExecution(task).time).map(task => {
    const time = taskExecution(task).time;
    const transition = task.type === 'fixed_event' || task.source === 'calendar' ? 0 : breakMinutes;
    return { start: toMinutes(time), end: toMinutes(time) + (task.duration || 30) + transition };
  }).concat(schoolBlock, fixedBlocks).sort((a, b) => a.start - b.start);
  for (let cursor = roundToQuarter(start); cursor + duration <= end; cursor += 15) {
    if (cursor < start) continue;
    const overlaps = busy.some(slot => cursor < slot.end && cursor + duration > slot.start);
    if (!overlaps) return toClock(cursor);
  }
  return null;
}

function assessmentSessionCount(assessment, profile = {}) {
  const classProfile = profile.classPreferences?.[assessment.className] || {};
  // Sessions/week is the canonical setting: it is also the number of
  // consecutive days immediately before an assessment that receive sessions.
  // Keep the older fields as a fallback so existing profiles remain usable.
  const configured = classProfile.sessionsPerWeek
    ?? profile.sessionsPerWeek
    ?? classProfile.sessionsPerAssessment
    ?? profile.sessionsPerAssessment
    ?? 3;
  return Math.min(14, Math.max(1, Number(configured) || 3));
}

function assessmentPreparationDates(assessment, count, now) {
  if (!assessment?.dueDate) return [];
  const due = parseDateKey(assessment.dueDate);
  const todayKey = toDateKey(now);
  const dates = [];
  // Preparation belongs in the final configured number of days before the
  // assessment. A test two weeks away must not create a session today just
  // because the planner can find an empty window today.
  for (let offset = count; offset >= 1; offset -= 1) {
    const date = new Date(due);
    date.setDate(date.getDate() - offset);
    const dateKey = toDateKey(date);
    if (dateKey >= todayKey && dateKey < assessment.dueDate) dates.push(dateKey);
  }
  return dates;
}

export function planStudySessions(assessment, tasks, profile = {}) {
  const classProfile = profile.classPreferences?.[assessment.className] || {};
  const settings = { ...profile, ...classProfile };
  const count = assessmentSessionCount(assessment, profile);
  const identityPrefixes = [assessment.id, assessment.idempotencyKey].filter(Boolean).map(value => `${value}:`);
  const existing = tasks.filter(task => task.type === 'study_session' && (task.relatedAssessmentId === assessment.id || identityPrefixes.some(prefix => String(task.schedulingIdentity || '').startsWith(prefix))));
  const existingIdentities = new Set(existing.map(session => assessmentSessionIdentity(assessment, session)).filter(Boolean));
  if (existingIdentities.size >= count) return [];
  const now = profile.now || new Date();
  // Reserve realistic slots for competing assignments before placing study
  // sessions. This is what makes an assessment aware of the whole workload
  // instead of treating every item as an independent empty-slot search.
  const workload = planWorkload(buildPlanningState({ tasks, profile, currentTime: now }), { horizonDays: 14 });
  const plannedWork = workload.scheduled.map(action => ({ ...action.item, dueDate: action.dateKey, dueTime: action.time, duration: action.duration, type: 'planned_work' }));
  const busyTasks = [...tasks, ...plannedWork];
  const candidates = assessmentPreparationDates(assessment, count, now);
  const spread = distributeDates(candidates, count);
  const sessions = [];
  for (const dateKey of spread) {
    if (sessions.length >= count) break;
    const time = findOpenSlot([...busyTasks, ...sessions], dateKey, settings.sessionLength || 45, { ...settings, now });
    if (!time) continue;
    const identity = `${assessment.idempotencyKey || assessment.id}:${dateKey}:${time}`;
    if (existingIdentities.has(identity) || sessions.some(task => assessmentSessionIdentity(assessment, task) === identity)) continue;
    sessions.push({ ...makeTask({ title: `${assessment.className || 'Study'} Study`, dueDate: dateKey, dueTime: time, duration: settings.sessionLength || 45, subject: assessment.className }, { relatedAssessmentId: assessment.id, source: 'scheduler', userScheduled: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }), type: 'study_session', autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, schedulingIdentity: identity, schedulingReason: `Preparation for ${assessment.title || 'assessment'}`, priority: Math.max(1, assessment.priority || 1) });
  }
  return sessions;
}

export function planStudySessionsOnDates(target, dates, tasks, profile = {}) {
  const classProfile = profile.classPreferences?.[target.className] || {};
  const settings = { ...profile, ...classProfile };
  const duration = settings.sessionLength || 45;
  const identityPrefix = String(target.id) + ':';
  const sessions = [];
  const requestedDates = [...new Set((Array.isArray(dates) ? dates : []).filter(isDateKey))].sort();
  for (const dateKey of requestedDates) {
    const time = findOpenSlot([...tasks, ...sessions], dateKey, duration, { ...settings, now: profile.now || new Date() });
    if (!time) continue;
    const identity = `${target.idempotencyKey || target.id}:${dateKey}:${time}`;
    if (tasks.some(task => task.schedulingIdentity === identity || String(task.schedulingIdentity || '').startsWith(identityPrefix)) || sessions.some(task => task.schedulingIdentity === identity)) continue;
    sessions.push({ ...makeTask({ title: `${target.className || 'Study'} Study`, dueDate: dateKey, dueTime: time, duration, subject: target.className }, { relatedAssessmentId: target.id, source: 'scheduler', userScheduled: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }), type: 'study_session', autoScheduled: true, studyDateLocked: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, schedulingIdentity: identity, schedulingReason: target.title ? `Study plan for ${target.title}` : 'Requested study session', priority: Math.max(1, target.priority || 1) });
  }
  return sessions;
}

/**
 * Reconcile an assessment's preparation without manufacturing a second copy
 * of a missed session. Open sessions that are stale or invalid are moved in
 * place; only missing capacity creates a new study session.
 */
export function replanAssessmentSessions(assessment, tasks = [], profile = {}, options = {}) {
  if (!assessment?.dueDate || assessment.status === 'completed') return { updates: [], created: [], duplicates: [], sessions: [] };
  const now = profile.now instanceof Date ? profile.now : new Date(profile.now || Date.now());
  const classProfile = profile.classPreferences?.[assessment.className] || {};
  const settings = { ...profile, ...classProfile };
  const targetCount = assessmentSessionCount(assessment, profile);
  const preparationDates = new Set(assessmentPreparationDates(assessment, targetCount, now));
  const assessmentTime = dateAt(assessment.dueDate, assessment.dueTime || '23:59').getTime();
  const latestStudyTime = toMinutes(settings.latestStudyTime);
  const identityPrefixes = [assessment.id, assessment.idempotencyKey].filter(Boolean).map(value => `${value}:`);
  const rawSessions = tasks.filter(task => task.type === 'study_session' && (task.relatedAssessmentId === assessment.id || identityPrefixes.some(prefix => String(task.schedulingIdentity || '').startsWith(prefix))));
  const sessionsByIdentity = new Map();
  const duplicates = [];
  rawSessions.forEach(session => {
    const identity = assessmentSessionIdentity(assessment, session);
    if (!identity) {
      sessionsByIdentity.set(`${session.id}:unkeyed`, session);
      return;
    }
    const previous = sessionsByIdentity.get(identity);
    if (!previous) sessionsByIdentity.set(identity, session);
    else {
      const winner = preferAssessmentSession(previous, session);
      sessionsByIdentity.set(identity, winner);
      duplicates.push(winner === previous ? session : previous);
    }
  });
  const sessions = [...sessionsByIdentity.values()];
  const completed = sessions.filter(task => task.status === 'completed').length;
  const active = sessions.filter(task => task.status !== 'completed');
  const future = active.filter(task => {
    if (!task.dueDate || !task.dueTime) return false;
    const startMinutes = toMinutes(task.dueTime);
    const duration = Math.max(15, Number(task.remainingDuration ?? task.duration) || Number(settings.sessionLength) || 45);
    const fitsHardStop = !Number.isFinite(latestStudyTime) || !Number.isFinite(startMinutes) || startMinutes + duration <= latestStudyTime;
    const start = dateAt(task.dueDate, task.dueTime).getTime();
    // Explicit “study on Monday/Wednesday” dates are commitments. Keep them
    // on the requested date even when the assessment deadline is earlier or
    // a later planner pass would otherwise treat the session as displaced.
    return start >= now.getTime()
      && (fitsHardStop || task.studyDateLocked || task.userPinned || task.userScheduled)
      && (task.studyDateLocked || task.userPinned || task.userScheduled || (start < assessmentTime && preparationDates.has(task.dueDate)));
  });
  const displaced = active
    .filter(task => !future.includes(task) && !task.userPinned && !task.userScheduled && !task.studyDateLocked)
    .sort((a, b) => dateAt(a.dueDate || '9999-12-31', a.dueTime || '23:59') - dateAt(b.dueDate || '9999-12-31', b.dueTime || '23:59'));
  let needed = Math.max(0, targetCount - completed - future.length);
  // Rendering and syncing must be observational. New preparation sessions are
  // created only by an explicit study-planning request; ordinary assessment
  // maintenance may still recover existing missed sessions in place.
  if (options.createMissing === false) needed = Math.min(displaced.length, preparationDates.size);
  if (!needed && !(options.createMissing === false && displaced.length)) return { updates: [], created: [], duplicates, sessions };
  const baseTasks = tasks.filter(task => !sessions.includes(task));
  const workingTasks = [...baseTasks, ...future.map(task => ({ ...task }))];
  const updates = [];
  const created = [];
  const target = { ...assessment, type: 'study_session', duration: Number(settings.sessionLength) || 45, dueTime: null };
  const horizonDays = Math.max(0, Math.ceil((assessmentTime - now.getTime()) / DAY_MS));
  while (needed > 0) {
    const state = buildPlanningState({ tasks: workingTasks, profile: settings, currentTime: now });
    const usedPreparationDates = new Set([...future, ...created].map(session => session.dueDate).filter(dateKey => preparationDates.has(dateKey)));
    const candidates = generateCandidateWindows(state, target, { horizonDays, allowFlexibleFallback: true, allowBeforePreferredStart: false })
      .filter(window => window.dateKey < assessment.dueDate && preparationDates.has(window.dateKey) && !usedPreparationDates.has(window.dateKey))
      .map(window => ({ window, score: scoreTimeWindow(window, target, state, { lastClassDate: updates.at(-1)?.dueDate }) }))
      .sort((a, b) => b.score - a.score || a.window.dateKey.localeCompare(b.window.dateKey) || a.window.start - b.window.start);
    const best = candidates[0]?.window;
    if (!best) break;
    const dateKey = best.dateKey;
    const time = toClock(best.start);
    const reused = displaced.shift();
    const session = reused ? withTaskExecution({ ...reused, dueDate: dateKey, dueTime: time, updatedAt: now.toISOString() }, dateKey, time) : {
      ...makeTask({ title: `${assessment.className || 'Study'} Study`, dueDate: dateKey, dueTime: time, duration: target.duration, subject: assessment.className }, { relatedAssessmentId: assessment.id, source: 'scheduler', type: 'study_session', userScheduled: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }),
      type: 'study_session',
      autoScheduled: true,
      scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED
    };
    session.schedulingIdentity = `${assessment.idempotencyKey || assessment.id}:${dateKey}:${time}`;
    session.schedulingReason = `Preparation for ${assessment.title || 'assessment'}`;
    if (reused) {
      session.scheduleChangeReason = SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY;
      session.scheduleChangeMessage = `${session.title} was incomplete from its previous planned date, so I moved it to ${formatDate(dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(time)}.`;
    }
    session.priority = Math.max(1, assessment.priority || 1);
    if (reused) updates.push(session); else created.push(session);
    workingTasks.push(session);
    needed -= 1;
  }
  return { updates, created, duplicates, sessions: [...sessions.filter(session => !updates.some(update => update.id === session.id)), ...updates, ...created] };
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
  const planningState = buildPlanningState({ tasks, currentTime: now });
  return tasks.filter(task => task.status !== 'completed' && (!task.dueDate || (task.duration || 30) <= availableMinutes)).map(task => ({
    task,
    score: urgencyScore(task, planningState) + (task.duration && Number.isFinite(availableMinutes) ? Math.max(0, 18 - Math.abs(availableMinutes - task.duration) / 3) : 0)
  })).sort((a, b) => b.score - a.score || taskSort(a.task, b.task)).map(item => item.task);
}

/*
 * Planning is deliberately kept separate from the capture/parser code. The
 * parser can describe work, but this state and the functions below decide
 * whether, when, and why that work can fit.
 */
const DEFAULT_PLANNING_HORIZON_DAYS = 14;
const DEFAULT_DAILY_CAPACITY_MINUTES = 180;
const PRIORITY_WEIGHT = { 1: 0, 2: 12, 3: 26, 4: 42 };

function plannerProfile(profile = {}) {
  const school = profile.schoolSchedule || {};
  return {
    ...profile,
    schoolStart: profile.schoolStart || school.start || '08:00',
    schoolEnd: profile.schoolEnd || school.end || '16:00',
    schoolDays: Array.isArray(profile.schoolDays) ? profile.schoolDays : Array.isArray(school.days) ? school.days : [1, 2, 3, 4, 5],
    preferredStart: profile.preferredStart || profile.preferredStudyStart || '16:00',
    latestStudyTime: profile.latestStudyTime || profile.latestAllowedStudyTime || '21:00',
    sleepStart: profile.sleepStart || profile.sleepWindow?.start || null,
    sleepEnd: profile.sleepEnd || profile.sleepWindow?.end || null,
    preferredBreakMinutes: Number(profile.preferredBreakMinutes || profile.preferredBreakLength) || 10,
    maxConsecutiveSessions: Number(profile.maxConsecutiveSessions) || 2,
    sessionLength: Number(profile.sessionLength || profile.sessionLengthMinutes) || 45,
    dailyCapacityMinutes: Number(profile.dailyCapacityMinutes || profile.maxDailyWorkMinutes) || DEFAULT_DAILY_CAPACITY_MINUTES,
    classPreferences: profile.classPreferences && typeof profile.classPreferences === 'object' ? profile.classPreferences : {},
    blockedPeriods: Array.isArray(profile.blockedPeriods) ? profile.blockedPeriods : []
  };
}

function isPlanningState(value) {
  return Boolean(value && value.currentTime instanceof Date && Array.isArray(value.tasks) && value.studentPreferences && Array.isArray(value.assessments));
}

function planningDate(value, fallback) {
  const candidate = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(candidate.getTime()) ? new Date(fallback) : candidate;
}

export function buildPlanningState(input = {}) {
  const currentTime = planningDate(input.currentTime || input.now, new Date());
  const profile = plannerProfile(input.studentPreferences || input.profile || {});
  const tasks = [...(Array.isArray(input.tasks) ? input.tasks : [])].filter(Boolean);
  const assessments = [
    ...(Array.isArray(input.assessments) ? input.assessments : []),
    ...tasks.filter(task => task.type === 'assessment')
  ].filter((assessment, index, all) => all.findIndex(item => item.id === assessment.id) === index);
  const studySessions = [
    ...(Array.isArray(input.studySessions) ? input.studySessions : []),
    ...tasks.filter(task => task.type === 'study_session')
  ].filter((session, index, all) => all.findIndex(item => item.id === session.id) === index);
  const schoolSchedule = {
    start: profile.schoolStart,
    end: profile.schoolEnd,
    days: profile.schoolDays
  };
  return {
    currentTime,
    timezone: input.timezone || profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    tasks,
    assessments,
    studySessions,
    recurringCommitments: Array.isArray(input.recurringCommitments) ? input.recurringCommitments : [],
    calendarEvents: Array.isArray(input.calendarEvents) ? input.calendarEvents : tasks.filter(task => task.source === 'calendar' || task.type === 'fixed_event'),
    existingSchedule: Array.isArray(input.existingSchedule) ? input.existingSchedule : tasks.filter(task => task.scheduledDate || task.scheduledTime),
    schoolSchedule,
    blockedWindows: [...(Array.isArray(input.blockedWindows) ? input.blockedWindows : []), ...profile.blockedPeriods],
    studentPreferences: profile,
    studyAllocations: input.studyAllocations || profile.classPreferences || {},
    historicalBehavior: input.historicalBehavior || profile.historicalBehavior || {},
    completedWork: Array.isArray(input.completedWork) ? input.completedWork : tasks.filter(task => task.status === 'completed')
  };
}

function itemDeadline(item, state) {
  if (!item?.dueDate) return state.currentTime.getTime() + DAY_MS * DEFAULT_PLANNING_HORIZON_DAYS;
  return dateAt(item.dueDate, item.dueTime || '23:59').getTime();
}

function relatedAssessment(item, state) {
  if (item?.type === 'assessment') return item;
  return state.assessments.find(assessment => assessment.id === item?.relatedAssessmentId || (assessment.className && assessment.className === item?.className));
}

export function urgencyScore(item, stateOrTasks = {}) {
  const state = isPlanningState(stateOrTasks) ? stateOrTasks : buildPlanningState({ tasks: stateOrTasks });
  const now = state.currentTime.getTime();
  const deadline = itemDeadline(item, state);
  const hours = (deadline - now) / 3_600_000;
  const duration = Math.max(15, Number(item?.duration) || 30);
  const priority = PRIORITY_WEIGHT[Math.max(1, Math.min(4, Number(item?.priority) || 1))] || 0;
  const overdue = hours < 0 && item?.status !== 'completed';
  const deadlinePressure = overdue ? 88 : Math.max(0, 72 - Math.max(0, hours) * 2.4);
  const assessment = relatedAssessment(item, state);
  const assessmentHours = assessment && assessment !== item ? (itemDeadline(assessment, state) - now) / 3_600_000 : Infinity;
  const assessmentPressure = Number.isFinite(assessmentHours) ? Math.max(0, 38 - Math.max(0, assessmentHours) * 1.6) : item?.type === 'assessment' ? 30 : 0;
  const durationPressure = Math.min(24, duration / 15);
  const postponements = Number(state.historicalBehavior?.postponements?.[item?.id] || state.historicalBehavior?.postponedCount?.[item?.id] || 0);
  return Math.round(Math.max(0, deadlinePressure + priority + assessmentPressure + durationPressure + Math.min(18, postponements * 6) + (overdue ? 24 : 0)) * 100) / 100;
}

export function deadlineRisk(item, stateOrTasks = {}) {
  const state = isPlanningState(stateOrTasks) ? stateOrTasks : buildPlanningState({ tasks: stateOrTasks });
  if (!item?.dueDate || item.status === 'completed') return 'LOW';
  const hours = (itemDeadline(item, state) - state.currentTime.getTime()) / 3_600_000;
  if (hours < 0) return 'CRITICAL';
  if (hours <= 48 || urgencyScore(item, state) >= 150) return 'HIGH';
  if (hours <= 96 || urgencyScore(item, state) >= 105) return 'MEDIUM';
  return 'LOW';
}

function hardCommitment(task) {
  // A deadline is not a reservation for ordinary work. Assessments, tests,
  // quizzes, and study sessions are different: their dates represent the
  // actual academic event/session and must not drift when homework moves.
  const assignmentType = String(task?.assignmentType || '').toLowerCase();
  const dateLockedAcademicWork = task?.type === 'study_session' || task?.type === 'assessment' || ['test', 'quiz'].includes(assignmentType);
  const dateLockedReminder = assignmentType === 'reminder' && Boolean(task?.dueDate || task?.scheduledDate);
  return task?.type === 'fixed_event'
    || dateLockedAcademicWork && Boolean(task?.dueDate || task?.scheduledDate)
    || dateLockedReminder
    || task?.source === 'calendar'
    || isRigidExecution(task);
}

function taskBreakMinutes(task, state) {
  const explicit = Number(task?.breakAfterMinutes);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(30, explicit));
  if (task?.type === 'fixed_event' || task?.source === 'calendar' || task?.type === 'assessment') return 0;
  return Math.max(0, Math.min(30, Number(state?.studentPreferences?.preferredBreakMinutes) || 10));
}

function blockForTask(task, state) {
  const execution = taskExecution(task);
  const date = execution.date || task.dueDate;
  const time = execution.time || task.dueTime;
  if (!date || !time || (!hardCommitment(task) && task.autoScheduled !== true)) return null;
  return { dateKey: date, start: toMinutes(time), end: toMinutes(time) + (Number(task.duration) || 30) + taskBreakMinutes(task, state) };
}

function normalizedBlock(block, dateKey, weekday) {
  const applies = block?.date === dateKey || block?.dateKey === dateKey || (block?.weekday !== undefined && Number(block.weekday) === weekday);
  if (!applies) return null;
  const start = toMinutes(block.start || block.startTime || block.start_time);
  const end = toMinutes(block.end || block.endTime || block.end_time);
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? { start, end } : null;
}

function hardBlocksForDate(state, dateKey) {
  const date = parseDateKey(dateKey);
  const blocks = [];
  if (state.schoolSchedule.days.includes(date.getDay())) blocks.push({ start: toMinutes(state.schoolSchedule.start), end: toMinutes(state.schoolSchedule.end), kind: 'school' });
  const sleepStart = toMinutes(state.studentPreferences.sleepStart);
  const sleepEnd = toMinutes(state.studentPreferences.sleepEnd);
  if (Number.isFinite(sleepStart) && Number.isFinite(sleepEnd)) {
    if (sleepStart > sleepEnd) blocks.push({ start: sleepStart, end: 24 * 60, kind: 'sleep' }, { start: 0, end: sleepEnd, kind: 'sleep' });
    else if (sleepStart < sleepEnd) blocks.push({ start: sleepStart, end: sleepEnd, kind: 'sleep' });
  }
  state.blockedWindows.forEach(block => { const normalized = normalizedBlock(block, dateKey, date.getDay()); if (normalized) blocks.push({ ...normalized, kind: 'blocked' }); });
  state.tasks.forEach(task => { const block = blockForTask(task, state); if (block?.dateKey === dateKey && task.status !== 'completed') blocks.push({ ...block, kind: task.type || 'task' }); });
  state.recurringCommitments.forEach(commitment => { const block = blockForTask({ ...commitment, dueDate: commitment.dueDate || dateKey }, state); if (block?.dateKey === dateKey) blocks.push({ ...block, kind: 'commitment' }); });
  return blocks.filter(block => block.end > block.start).sort((a, b) => a.start - b.start || a.end - b.end);
}

export function generateCandidateWindows(stateOrInput = {}, item = {}, options = {}) {
  const state = isPlanningState(stateOrInput) ? stateOrInput : buildPlanningState(stateOrInput);
  const duration = Math.max(15, Number(item.duration) || state.studentPreferences.sessionLength || 30);
  const horizonDays = Math.max(0, Number(options.horizonDays ?? DEFAULT_PLANNING_HORIZON_DAYS));
  const startDate = parseDateKey(toDateKey(state.currentTime));
  const deadline = item.dueDate || addDays(toDateKey(state.currentTime), horizonDays);
  const collect = (respectPreferences) => {
    const windows = [];
    for (let offset = 0; offset <= horizonDays; offset += 1) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + offset);
      const dateKey = toDateKey(date);
      if (dateKey > deadline || (item.type === 'assessment' && dateKey >= item.dueDate)) break;
      if (options.anchorToDate && item.dueDate && dateKey !== item.dueDate) continue;
      if (options.anchorToScheduleDate && item.scheduledDate && dateKey !== item.scheduledDate) continue;
      const afterNow = offset === 0
        ? state.currentTime.getHours() * 60 + state.currentTime.getMinutes() + Math.max(0, Number(options.minimumDelayMinutes) || 15)
        : 0;
      const start = Math.max(afterNow, respectPreferences ? toMinutes(state.studentPreferences.preferredStart) : 0);
      // The user's latest study time is a hard stop. Relaxing the preferred
      // start is allowed when a deadline is tight, but planning must never
      // spill past the configured stop time.
      const preferredEnd = toMinutes(state.studentPreferences.latestStudyTime);
      const deadlineEnd = item.dueDate === dateKey && item.dueTime && !hardCommitment(item) ? toMinutes(item.dueTime) : preferredEnd;
      const end = Math.min(preferredEnd, Number.isFinite(deadlineEnd) ? deadlineEnd : preferredEnd);
      if (start >= end) continue;
      const blocks = hardBlocksForDate(state, dateKey);
      const incrementMinutes = Number(options.incrementMinutes);
      let cursor = Number.isFinite(incrementMinutes)
        ? roundUpToIncrement(start, Math.max(1, incrementMinutes))
        : roundToQuarter(start);
      for (const block of [...blocks, { start: end, end }]) {
        const gapEnd = Math.min(end, block.start);
        if (gapEnd - cursor >= duration) windows.push({ dateKey, start: cursor, end: gapEnd, duration: gapEnd - cursor, relaxed: !respectPreferences });
        cursor = Math.max(cursor, block.end);
        if (Number.isFinite(incrementMinutes)) cursor = roundUpToIncrement(cursor, Math.max(1, incrementMinutes));
        if (cursor >= end) break;
      }
    }
    return windows;
  };
  const preferredWindows = collect(true);
  // Relaxed windows are useful for callers that are explicitly asking for a
  // best-effort recommendation, but automatic scheduling must not silently
  // turn a future after-school plan into morning work.  Keep the legacy
  // fallback available to direct callers while letting planner/recovery code
  // opt into the conservative cutoff policy.
  if (preferredWindows.length || options.allowFlexibleFallback === false || options.allowBeforePreferredStart === false) return preferredWindows;
  return collect(false);
}

export function scoreTimeWindow(window, item, stateOrInput = {}, options = {}) {
  const state = isPlanningState(stateOrInput) ? stateOrInput : buildPlanningState(stateOrInput);
  const preferred = toMinutes(state.studentPreferences.preferredStart);
  const startDistance = Math.abs(window.start - preferred);
  const duration = Math.max(15, Number(item.duration) || 30);
  const fit = Math.max(0, 24 - Math.abs(window.duration - duration) / 4);
  const preferenceMatch = Math.max(0, 28 - startDistance / 12);
  const urgency = urgencyScore(item, state);
  const daysUntilWindow = Math.max(0, calendarDayDiff(parseDateKey(toDateKey(state.currentTime)), parseDateKey(window.dateKey)));
  const earlyStartBenefit = Math.max(0, 18 - daysUntilWindow * 6);
  const daysUntilDeadline = item.dueDate ? Math.max(0, calendarDayDiff(parseDateKey(toDateKey(state.currentTime)), parseDateKey(item.dueDate))) : Infinity;
  const deadlineProximity = daysUntilDeadline <= 2 ? Math.max(0, 16 - daysUntilWindow * 16) : 0;
  const latePenalty = window.start >= 20 * 60 ? 18 : window.start >= 19 * 60 ? 7 : 0;
  const relaxedPenalty = window.relaxed ? 12 : 0;
  const fragmentationPenalty = window.duration > duration + 90 ? 4 : 0;
  const balancePenalty = Number(options.dailyLoadMinutes || 0) / 18;
  const spacingBenefit = item.className && options.lastClassDate && options.lastClassDate !== window.dateKey ? 9 : 0;
  const classPreference = item.className ? state.studentPreferences.classPreferences?.[item.className] || {} : {};
  const preferredLength = Number(classPreference.sessionLength || state.studentPreferences.sessionLength) || duration;
  const classFit = Math.max(0, 10 - Math.abs(preferredLength - duration) / 6);
  const historicalWindow = state.historicalBehavior?.preferredWindows?.[item.className || 'general'];
  const historicalFit = Array.isArray(historicalWindow) && historicalWindow.includes(Math.floor(window.start / 60)) ? 8 : 0;
  const eveningWorkloadPenalty = window.start >= 19 * 60 ? Math.max(0, Number(options.dailyLoadMinutes || 0) - 60) / 12 : 0;
  const transitionPenalty = item.className && options.lastClassDate === window.dateKey ? 3 : 0;
  return urgency + preferenceMatch + fit + earlyStartBenefit + deadlineProximity + spacingBenefit + classFit + historicalFit - latePenalty - relaxedPenalty - fragmentationPenalty - balancePenalty - eveningWorkloadPenalty - transitionPenalty;
}

function taskOrderPosition(task, state) {
  const dateKey = task?.scheduledDate || task?.dueDate;
  const savedOrder = dateKey ? state.studentPreferences.taskOrder?.[dateKey] : null;
  if (!Array.isArray(savedOrder)) return Number.MAX_SAFE_INTEGER;
  const position = savedOrder.indexOf(task.id);
  return position < 0 ? Number.MAX_SAFE_INTEGER : position;
}

function samePlanningDate(left, right) {
  return (left?.scheduledDate || left?.dueDate || '') === (right?.scheduledDate || right?.dueDate || '');
}

function workDuration(task) {
  // Preserve short reminders and quick assignments accurately. The planner
  // may still require a minimum-sized open window when creating new work, but
  // collision and duration math must use the task's actual remaining minutes.
  return Math.max(1, Number(task?.remainingDuration ?? task?.duration) || 30);
}

function isAutomaticRecoveryCandidate(task) {
  return task?.status !== 'completed'
    && (!task?.type || task?.type === 'task')
    && task?.source !== 'calendar'
    && task?.type !== 'fixed_event'
    && task?.userPinned !== true
    && scheduleOriginOf(task) === SCHEDULE_ORIGINS.SILICO_SCHEDULED
    && task?.userScheduled !== true;
}

function recoveryWindow(state, task, horizonDays, reason, options = {}) {
  const recoveryState = buildPlanningState({
    ...state,
    tasks: state.tasks.filter(candidate => candidate.id !== task.id)
  });
  const recoveryItem = {
    ...task,
    dueDate: null,
    dueTime: null,
    scheduledDate: null,
    scheduledTime: null,
    userScheduled: false,
    userPinned: false,
    autoScheduled: false,
    scheduleOrigin: SCHEDULE_ORIGINS.UNSCHEDULED
  };
  return generateCandidateWindows(recoveryState, recoveryItem, {
    horizonDays,
    allowFlexibleFallback: true,
    allowBeforePreferredStart: false,
    minimumDelayMinutes: options.minimumDelayMinutes,
    incrementMinutes: options.incrementMinutes
  }).filter(window => reason !== SCHEDULE_CHANGE_REASONS.HARD_STOP_CONFLICT || window.dateKey > toDateKey(state.currentTime))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey) || left.start - right.start)[0] || null;
}

function automaticScheduleRepairs(state, horizonDays) {
  const todayKey = toDateKey(state.currentTime);
  const repairs = [];
  const workingTasks = state.tasks.map(task => ({ ...task }));

  const nowMinutes = state.currentTime.getHours() * 60 + state.currentTime.getMinutes();
  // Only genuinely stale execution allocations qualify for automatic overdue
  // recovery. A future allocation is never pulled into today merely because
  // a window happens to be empty. Same-day work is stale once its planned
  // start has passed, so it gets the same conservative recovery treatment.
  const overdue = workingTasks.filter(task => isAutomaticRecoveryCandidate(task)
    && task.scheduledDate
    && (task.scheduledDate < todayKey
      || (task.scheduledDate === todayKey && task.scheduledTime && toMinutes(task.scheduledTime) < nowMinutes)));
  for (const task of overdue.sort((left, right) => taskSort(left, right))) {
    const sameDayRecovery = task.scheduledDate === todayKey;
    const window = recoveryWindow(
      { ...state, tasks: workingTasks },
      task,
      horizonDays,
      SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY,
      sameDayRecovery ? { minimumDelayMinutes: 5, incrementMinutes: 5 } : {}
    );
    if (!window) continue;
    const message = sameDayRecovery
      ? `${task.title} missed its planned start, so I moved it to ${formatDate(window.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(toClock(window.start))}.`
      : `${task.title} was incomplete from ${formatDate(task.scheduledDate, { month: 'short', day: 'numeric' })}, so I moved it to ${formatDate(window.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(toClock(window.start))}.`;
    repairs.push({
      item: withTaskExecution(task, window.dateKey, toClock(window.start)),
      dateKey: window.dateKey,
      time: toClock(window.start),
      duration: workDuration(task),
      reason: SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY,
      message,
      rescheduled: true
    });
    const index = workingTasks.findIndex(candidate => candidate.id === task.id);
    if (index >= 0) workingTasks[index] = { ...withTaskExecution(workingTasks[index], window.dateKey, toClock(window.start)), autoScheduled: true, scheduleOrigin: scheduleOriginOf(task) };
  }

  // Protect the hard stop with the smallest possible intervention. The latest
  // movable task is the first candidate; hard commitments and user-pinned
  // work remain untouched.
  const hardStop = toMinutes(state.studentPreferences.latestStudyTime);
  if (Number.isFinite(hardStop)) {
    const movableToday = () => workingTasks
      .filter(task => isAutomaticRecoveryCandidate(task) && task.scheduledDate === todayKey && task.scheduledTime)
      .sort((left, right) => toMinutes(right.scheduledTime) - toMinutes(left.scheduledTime) || String(right.id).localeCompare(String(left.id)));
    const dayHasOverflow = () => workingTasks.some(task => task.status !== 'completed' && task.scheduledDate === todayKey && task.scheduledTime && toMinutes(task.scheduledTime) + workDuration(task) > hardStop);
    while (dayHasOverflow()) {
      const task = movableToday().find(candidate => toMinutes(candidate.scheduledTime) + workDuration(candidate) > hardStop);
      if (!task) break;
      const window = recoveryWindow({ ...state, tasks: workingTasks }, task, horizonDays, SCHEDULE_CHANGE_REASONS.HARD_STOP_CONFLICT);
      if (!window) break;
      const message = `Today's workload exceeded your ${formatTime(state.studentPreferences.latestStudyTime)} hard stop, so I moved ${task.title} to ${formatDate(window.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(toClock(window.start))}.`;
      repairs.push({
        item: withTaskExecution(task, window.dateKey, toClock(window.start)),
        dateKey: window.dateKey,
        time: toClock(window.start),
        duration: workDuration(task),
        reason: SCHEDULE_CHANGE_REASONS.HARD_STOP_CONFLICT,
        message,
        rescheduled: true
      });
      const index = workingTasks.findIndex(candidate => candidate.id === task.id);
      if (index >= 0) workingTasks.splice(index, 1);
    }
  }
  return repairs;
}

function isHardCollisionAnchor(task) {
  return isRigidExecution(task);
}

function isImportedCommitment(task) {
  return task?.status !== 'completed' && task?.source === 'calendar';
}

function collisionExecution(task) {
  if (task?.scheduledDate && task?.scheduledTime) return { dateKey: task.scheduledDate, time: task.scheduledTime };
  // Older imported/planner-created study work stored its execution time in
  // due_date/due_time only. It is still rendered as a timed task, so leaving
  // that legacy shape out of collision detection is how multiple items end
  // up visibly stacked at the same time.
  if ((task?.type === 'study_session' || task?.assignmentType === 'study' || task?.source === 'scheduler' || task?.source === 'calendar' || task?.autoScheduled === true)
    && task?.dueDate && task?.dueTime) return { dateKey: task.dueDate, time: task.dueTime };
  return null;
}

function collisionRecoveryWindow(state, task, dateKey, startAt, horizonDays) {
  const recoveryState = buildPlanningState({
    ...state,
    tasks: state.tasks.filter(candidate => candidate.id !== task.id)
  });
  const recoveryItem = {
    ...task,
    dueDate: dateKey,
    dueTime: null,
    scheduledDate: null,
    scheduledTime: null,
    userScheduled: false,
    userPinned: false,
    autoScheduled: false,
    scheduleOrigin: SCHEDULE_ORIGINS.UNSCHEDULED
  };
  const duration = workDuration(recoveryItem);
  return generateCandidateWindows(recoveryState, recoveryItem, {
    horizonDays,
    allowFlexibleFallback: true,
    allowBeforePreferredStart: false
  }).map(window => {
    if (window.dateKey !== dateKey) return null;
    const start = Math.max(window.start, startAt);
    return start + duration <= window.end ? { ...window, start, duration: window.end - start } : null;
  }).filter(Boolean).sort((left, right) => left.start - right.start)[0] || null;
}

function importedCommitmentRepairs(state, horizonDays) {
  const imported = state.tasks.filter(task => isImportedCommitment(task) && collisionExecution(task));
  if (!imported.length) return [];
  const workingTasks = state.tasks.map(task => ({ ...task }));
  const repairs = [];
  const movable = task => task.status !== 'completed'
    && !isImportedCommitment(task)
    && task.type !== 'fixed_event'
    && collisionExecution(task);

  for (const importedTask of imported) {
    const importedExecution = collisionExecution(importedTask);
    const importedStart = toMinutes(importedExecution.time);
    const importedEnd = importedStart + workDuration(importedTask);
    const conflicts = workingTasks
      .filter(task => movable(task))
      .map(task => ({ task, execution: collisionExecution(task) }))
      .filter(entry => entry.execution?.dateKey === importedExecution.dateKey
        && toMinutes(entry.execution.time) < importedEnd
        && toMinutes(entry.execution.time) + workDuration(entry.task) > importedStart)
      .sort((left, right) => toMinutes(left.execution.time) - toMinutes(right.execution.time) || String(left.task.id).localeCompare(String(right.task.id)));

    for (const conflict of conflicts) {
      const originalDate = conflict.execution.dateKey;
      const originalStart = toMinutes(conflict.execution.time);
      const recoveryState = buildPlanningState({ ...state, tasks: workingTasks.filter(task => task.id !== conflict.task.id) });
      const recoveryItem = {
        ...conflict.task,
        dueDate: null,
        dueTime: null,
        scheduledDate: null,
        scheduledTime: null,
        userScheduled: false,
        userPinned: false,
        autoScheduled: false,
        scheduleOrigin: SCHEDULE_ORIGINS.UNSCHEDULED
      };
      const candidates = generateCandidateWindows(recoveryState, recoveryItem, { horizonDays, allowFlexibleFallback: true, allowBeforePreferredStart: false })
        .filter(window => window.dateKey >= originalDate)
        .sort((left, right) => left.dateKey.localeCompare(right.dateKey)
          || Math.abs(left.start - originalStart) - Math.abs(right.start - originalStart)
          || left.start - right.start);
      const replacement = candidates[0];
      if (!replacement) continue;
      const time = toClock(replacement.start);
      const message = `${conflict.task.title} conflicted with imported calendar time ${formatDate(importedExecution.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(importedExecution.time)}, so I moved it to ${formatDate(replacement.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(time)}.`;
      repairs.push({
        item: withTaskExecution(conflict.task, replacement.dateKey, time),
        dateKey: replacement.dateKey,
        time,
        duration: workDuration(conflict.task),
        reason: SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT,
        message,
        rescheduled: true
      });
      const index = workingTasks.findIndex(task => task.id === conflict.task.id);
      if (index >= 0) workingTasks[index] = { ...withTaskExecution(workingTasks[index], replacement.dateKey, time), autoScheduled: true, scheduleOrigin: scheduleOriginOf(conflict.task) };
    }
  }
  return repairs;
}

function scheduleCollisionRepairs(state, horizonDays) {
  const groups = new Map();
  state.tasks.filter(task => task.status !== 'completed').forEach(task => {
    const execution = collisionExecution(task);
    if (!execution) return;
    const key = `${execution.dateKey}T${execution.time}`;
    const group = groups.get(key) || [];
    group.push({ task, execution });
    groups.set(key, group);
  });
  const actions = [];
  const workingTasks = state.tasks.map(task => ({ ...task }));

  // Fixed events are interval anchors, not just timestamp anchors. A task at
  // 4:30 still conflicts with an event that starts at 4:00 and lasts 45
  // minutes. Move the non-anchor task to the next opening on the same date;
  // this also keeps date-locked study sessions on their requested date.
  const anchors = workingTasks.filter(task => task.status !== 'completed' && isHardCollisionAnchor(task) && collisionExecution(task));
  const movedIds = new Set();
  for (const anchor of anchors) {
    const anchorExecution = collisionExecution(anchor);
    const anchorStart = toMinutes(anchorExecution.time);
    const anchorEnd = anchorStart + workDuration(anchor);
    const conflicts = workingTasks
      .filter(task => task.status !== 'completed' && task.id !== anchor.id && !isHardCollisionAnchor(task) && !movedIds.has(task.id) && collisionExecution(task))
      .map(task => ({ task, execution: collisionExecution(task) }))
      .filter(entry => entry.execution.dateKey === anchorExecution.dateKey
        && toMinutes(entry.execution.time) < anchorEnd
        && toMinutes(entry.execution.time) + workDuration(entry.task) > anchorStart)
      .sort((left, right) => toMinutes(left.execution.time) - toMinutes(right.execution.time) || String(left.task.id).localeCompare(String(right.task.id)));
    for (const conflict of conflicts) {
      const recoveryState = { ...state, tasks: workingTasks.filter(task => task.id !== conflict.task.id) };
      const replacement = collisionRecoveryWindow(recoveryState, conflict.task, anchorExecution.dateKey, anchorEnd, horizonDays);
      if (!replacement) continue;
      const time = toClock(replacement.start);
      if (conflict.execution.dateKey === replacement.dateKey && conflict.execution.time === time) continue;
      const message = `${conflict.task.title} conflicted with ${anchor.title}, which runs until ${formatTime(toClock(anchorEnd))}, so I moved it to ${formatDate(anchorExecution.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(time)}.`;
      actions.push({ item: withTaskExecution(conflict.task, replacement.dateKey, time), dateKey: replacement.dateKey, time, duration: workDuration(conflict.task), reason: SCHEDULE_CHANGE_REASONS.TIME_CONFLICT, message, rescheduled: true });
      const index = workingTasks.findIndex(task => task.id === conflict.task.id);
      if (index >= 0) workingTasks[index] = { ...withTaskExecution(workingTasks[index], replacement.dateKey, time), userScheduled: false, userPinned: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED };
      movedIds.add(conflict.task.id);
    }
  }

  // A duration edit can create an overlap without changing either task's
  // starting timestamp (for example, 4:57 for 60 minutes followed by 5:37).
  // Repair the whole chronological chain, not only equal-start groups. Hard
  // anchors stay where the user/import placed them; flexible work moves to
  // the next valid opening after the preceding task really ends.
  const entriesByDate = new Map();
  workingTasks.filter(task => task.status !== 'completed' && collisionExecution(task)).forEach(task => {
    const execution = collisionExecution(task);
    const entries = entriesByDate.get(execution.dateKey) || [];
    entries.push({ task, execution });
    entriesByDate.set(execution.dateKey, entries);
  });
  for (const entries of entriesByDate.values()) {
    entries.sort((left, right) => toMinutes(left.execution.time) - toMinutes(right.execution.time) || String(left.task.id).localeCompare(String(right.task.id)));
    let previous = null;
    for (const entry of entries) {
      let task = workingTasks.find(candidate => candidate.id === entry.task.id) || entry.task;
      let execution = collisionExecution(task) || entry.execution;
      const start = toMinutes(execution.time);
      const requiredStart = previous ? previous.end + taskBreakMinutes(previous.task, state) : start;
      if (previous && execution.dateKey === previous.execution.dateKey && start < requiredStart && task.autoScheduled === true && task.flexibility !== 'flexible' && task.userScheduled !== true && !isHardCollisionAnchor(task) && !movedIds.has(task.id)) {
        const startAt = requiredStart;
        const recoveryState = { ...state, tasks: workingTasks.filter(candidate => candidate.id !== task.id) };
        const replacement = collisionRecoveryWindow(recoveryState, task, execution.dateKey, startAt, horizonDays);
        if (replacement) {
          const time = toClock(replacement.start);
          const message = `${task.title} overlapped ${previous.task.title}, so I moved it to ${formatDate(execution.dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(time)}.`;
          actions.push({ item: withTaskExecution(task, replacement.dateKey, time), dateKey: replacement.dateKey, time, duration: workDuration(task), reason: SCHEDULE_CHANGE_REASONS.TIME_CONFLICT, message, rescheduled: true });
          task = { ...withTaskExecution(task, replacement.dateKey, time), userScheduled: false, userPinned: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED };
          const index = workingTasks.findIndex(candidate => candidate.id === task.id);
          if (index >= 0) workingTasks[index] = task;
          movedIds.add(task.id);
          execution = collisionExecution(task) || { dateKey: replacement.dateKey, time };
        }
      }
      const end = toMinutes(execution.time) + workDuration(task);
      if (!previous || execution.dateKey !== previous.execution.dateKey || end > previous.end) previous = { task, execution, end };
    }
  }

  for (const group of new Map([...groups.entries()].map(([key, group]) => [key, group.map(entry => ({ ...entry, task: workingTasks.find(task => task.id === entry.task.id) || entry.task })).filter(entry => !movedIds.has(entry.task.id))])).values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((leftEntry, rightEntry) => {
      const left = leftEntry.task;
      const right = rightEntry.task;
      const anchorDifference = Number(isHardCollisionAnchor(right)) - Number(isHardCollisionAnchor(left));
      if (anchorDifference) return anchorDifference;
      const durationDifference = workDuration(right) - workDuration(left);
      if (durationDifference && scheduleOriginOf(left) === SCHEDULE_ORIGINS.SILICO_SCHEDULED && scheduleOriginOf(right) === SCHEDULE_ORIGINS.SILICO_SCHEDULED) return durationDifference;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
    const keeper = ordered[0].task;
    const keeperExecution = ordered[0].execution;
    actions.push({
      item: keeper,
      dateKey: keeperExecution.dateKey,
      time: keeperExecution.time,
      duration: workDuration(keeper),
      reason: null,
      message: null,
      rescheduled: false
    });
    for (const entry of ordered.slice(1)) {
      const task = entry.task;
      if (isHardCollisionAnchor(task)) continue;
      const dateKey = entry.execution.dateKey;
      const startAt = toMinutes(entry.execution.time) + workDuration(keeper) + taskBreakMinutes(keeper, state);
      const window = collisionRecoveryWindow({ ...state, tasks: workingTasks }, task, dateKey, startAt, horizonDays);
      if (!window) continue;
      const time = toClock(window.start);
      const message = `${task.title} conflicted with ${keeper.title} at ${formatTime(entry.execution.time)}, so I moved it to ${formatDate(dateKey, { month: 'short', day: 'numeric' })} at ${formatTime(time)}.`;
      actions.push({
        item: withTaskExecution(task, dateKey, time),
        dateKey,
        time,
        duration: workDuration(task),
        reason: SCHEDULE_CHANGE_REASONS.TIME_CONFLICT,
        message,
        rescheduled: true
      });
      const index = workingTasks.findIndex(candidate => candidate.id === task.id);
      if (index >= 0) workingTasks[index] = { ...withTaskExecution(workingTasks[index], dateKey, time), userScheduled: false, userPinned: false, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED };
    }
  }
  return actions;
}

function flexibleDayOrder(tasks, state) {
  const savedOrder = state.studentPreferences.taskOrder?.[tasks[0]?.scheduledDate];
  if (Array.isArray(savedOrder)) {
    const positions = new Map(savedOrder.map((id, index) => [id, index]));
    return [...tasks].sort((left, right) => {
      const leftPosition = positions.get(left.id);
      const rightPosition = positions.get(right.id);
      if (leftPosition !== undefined || rightPosition !== undefined) {
        if (leftPosition === undefined) return 1;
        if (rightPosition === undefined) return -1;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      }
      return 0;
    });
  }
  return [...tasks].sort((left, right) => {
    const urgencyDifference = urgencyScore(right, state) - urgencyScore(left, state);
    if (Math.abs(urgencyDifference) > 15) return urgencyDifference;
    return workDuration(right) - workDuration(left) || taskSort(left, right);
  });
}

function reorderFlexibleDay(tasks, state) {
  if (tasks.length < 2) return null;
  const dateKey = tasks[0].scheduledDate;
  const groupIds = new Set(tasks.map(task => task.id));
  const dayState = buildPlanningState({ ...state, tasks: state.tasks.filter(task => !groupIds.has(task.id)) });
  const hardBlocks = hardBlocksForDate(dayState, dateKey);
  const date = parseDateKey(dateKey);
  const afterNow = dateKey === toDateKey(state.currentTime) ? state.currentTime.getHours() * 60 + state.currentTime.getMinutes() + 15 : 0;
  // Flexible work is an after-school plan by default. Preserve the first
  // existing allocation during ordinary duration optimization; manual drag
  // repacking has its own explicit reset-to-boundary behavior in the UI.
  const preferredStart = toMinutes(state.studentPreferences.preferredStart);
  const earliestAfterCutoff = Math.min(...tasks
    .map(task => toMinutes(task.scheduledTime))
    .filter(time => Number.isFinite(time) && time >= preferredStart));
  const firstStart = Number.isFinite(earliestAfterCutoff) ? earliestAfterCutoff : preferredStart;
  let cursor = roundToQuarter(Math.max(afterNow, preferredStart, firstStart));
  const assignments = [];
  for (const task of flexibleDayOrder(tasks, state)) {
    while (true) {
      const blocking = hardBlocks.find(block => cursor < block.end && cursor + workDuration(task) > block.start);
      if (!blocking) break;
      cursor = roundToQuarter(blocking.end);
    }
    const end = cursor + workDuration(task);
    if (end > toMinutes(state.studentPreferences.latestStudyTime)) return null;
    assignments.push({ task, dateKey, time: toClock(cursor), duration: workDuration(task) });
    cursor = end;
  }
  return assignments;
}

export function planWorkload(stateOrInput = {}, options = {}) {
  const state = isPlanningState(stateOrInput) ? stateOrInput : buildPlanningState(stateOrInput);
  const allTasks = state.tasks.filter(task => task.status !== 'completed');
  const targetIds = Array.isArray(options.taskIds) ? new Set(options.taskIds) : null;
  const includeUndated = options.includeUndated === true;
  const work = allTasks.filter(task => {
    const hasPlanningIntent = Boolean(task.dueDate || task.userScheduled || task.userPinned || includeUndated && targetIds?.has(task.id));
    return task.type !== 'assessment' && !hardCommitment(task) && hasPlanningIntent && (!targetIds || targetIds.has(task.id));
  });
  const scheduled = [];
  const unscheduled = [];
  const dailyLoad = new Map();
  const lastClassDate = new Map();
  const horizonDays = Math.max(1, Number(options.horizonDays || DEFAULT_PLANNING_HORIZON_DAYS));
  const planningTasks = state.tasks.map(task => ({ ...task }));
  const planningState = buildPlanningState({ ...state, tasks: planningTasks });
  const importedActions = importedCommitmentRepairs(state, horizonDays);
  const importedRepairedIds = new Set(importedActions.map(action => action.item.id));
  const repairableState = { ...state, tasks: state.tasks.filter(task => !importedRepairedIds.has(task.id)) };
  const collisionActions = scheduleCollisionRepairs(repairableState, horizonDays);
  const repairActions = [...importedActions, ...collisionActions, ...automaticScheduleRepairs(repairableState, horizonDays)];
  const repairedIds = new Set(repairActions.map(action => action.item.id));
  repairActions.forEach(action => {
    scheduled.push(action);
    dailyLoad.set(action.dateKey, (dailyLoad.get(action.dateKey) || 0) + action.duration);
    planningState.tasks = planningState.tasks.map(task => task.id === action.item.id ? { ...withTaskExecution(task, action.dateKey, action.time), autoScheduled: true, scheduleOrigin: scheduleOriginOf(task) } : task);
  });

  // Repack only scheduler-controlled work that is already on the same date.
  // This is a time optimization within an existing date, never a license to
  // pull a future user plan into today.
  const flexibleGroups = new Map();
  work.filter(task => isFlexibleSchedule(task) && (task.flexibility !== 'planned' || options.allowRebalance === true) && !repairedIds.has(task.id)).forEach(task => {
    const group = flexibleGroups.get(task.scheduledDate) || [];
    group.push(task);
    flexibleGroups.set(task.scheduledDate, group);
  });
  const reorderedIds = new Set();
  for (const group of flexibleGroups.values()) {
    const assignments = reorderFlexibleDay(group, planningState);
    if (!assignments) continue;
    assignments.forEach(assignment => {
      const action = {
        item: withTaskExecution(assignment.task, assignment.dateKey, assignment.time),
        dateKey: assignment.dateKey,
        time: assignment.time,
        duration: assignment.duration,
        reason: SCHEDULE_CHANGE_REASONS.DURATION_REORDERING,
        message: `${assignment.task.title} was placed earlier because its longer duration needs the better contiguous window.`,
        rescheduled: assignment.time !== assignment.task.scheduledTime
      };
      scheduled.push(action);
      reorderedIds.add(assignment.task.id);
      dailyLoad.set(action.dateKey, (dailyLoad.get(action.dateKey) || 0) + action.duration);
      planningState.tasks = planningState.tasks.map(task => task.id === assignment.task.id ? { ...withTaskExecution(task, action.dateKey, action.time), autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED } : task);
    });
  }
  const ordered = [...work].sort((a, b) => {
    if (samePlanningDate(a, b)) {
      const orderDifference = taskOrderPosition(a, state) - taskOrderPosition(b, state);
      if (orderDifference) return orderDifference;
      const durationDifference = (Number(b.remainingDuration ?? b.duration) || 30) - (Number(a.remainingDuration ?? a.duration) || 30);
      if (durationDifference) return durationDifference;
    }
    return urgencyScore(b, state) - urgencyScore(a, state) || taskSort(a, b);
  });
  for (const item of ordered) {
    if (repairedIds.has(item.id) || reorderedIds.has(item.id)) continue;
    const itemState = buildPlanningState({ ...planningState, tasks: planningState.tasks.filter(task => task.id !== item.id) });
    const preferredStart = toMinutes(state.studentPreferences.preferredStart);
    const stalePreCutoffAllocation = item.autoScheduled === true
      && item.flexibility === 'planned'
      && scheduleOriginOf(item) === SCHEDULE_ORIGINS.SILICO_SCHEDULED
      && item.userScheduled !== true
      && item.userPinned !== true
      && item.scheduledDate
      && item.scheduledDate > toDateKey(state.currentTime)
      && Number.isFinite(toMinutes(item.scheduledTime))
      && toMinutes(item.scheduledTime) < preferredStart;
    const plannedStart = toMinutes(item.scheduledTime);
    const hardStop = toMinutes(state.studentPreferences.latestStudyTime);
    const plannedFitsHardStop = Number.isFinite(plannedStart) && (!Number.isFinite(hardStop) || plannedStart + workDuration(item) <= hardStop);
    const plannedDate = item.autoScheduled === true
      && item.scheduledDate
      && item.scheduledTime
      && item.flexibility === 'planned'
      && !stalePreCutoffAllocation
      && plannedFitsHardStop
      && (!options.allowRebalance || !reorderedIds.has(item.id));
    if (plannedDate) {
      // Existing Silico allocations are stable records. If a newly added
      // blocker makes one infeasible, leave it visible for explicit recovery;
      // only the two repair passes above may move it automatically.
      const action = { item, dateKey: item.scheduledDate, time: item.scheduledTime, duration: workDuration(item), score: 0, urgency: urgencyScore(item, state), risk: deadlineRisk(item, state), relaxed: false };
      scheduled.push(action);
      dailyLoad.set(action.dateKey, (dailyLoad.get(action.dateKey) || 0) + action.duration);
      if (item.className) lastClassDate.set(item.className, action.dateKey);
      planningState.tasks = planningState.tasks.filter(task => task.id !== item.id);
      planningState.tasks.push({ ...withTaskExecution(item, action.dateKey, action.time), id: `planned-${item.id}`, autoScheduled: true, type: 'planned_task', source: 'planner' });
      continue;
    }
    const candidates = generateCandidateWindows(itemState, item, { horizonDays, allowBeforePreferredStart: options.allowBeforePreferredStart === true, anchorToDate: Boolean(options.anchorToDate || item.datePinned === true || (item.userScheduled === true && !isRigidExecution(item) && item.scheduledDate && !item.autoScheduled)), anchorToScheduleDate: Boolean(item.autoScheduled && item.scheduledDate && item.flexibility === 'planned' && plannedFitsHardStop) }).filter(window => {
      const load = dailyLoad.get(window.dateKey) || 0;
      return load + (Number(item.remainingDuration ?? item.duration) || 30) <= state.studentPreferences.dailyCapacityMinutes;
    });
    const ranked = candidates.map(window => ({ window, score: scoreTimeWindow(window, item, itemState, { dailyLoadMinutes: dailyLoad.get(window.dateKey) || 0, lastClassDate: lastClassDate.get(item.className) }) })).sort((a, b) => b.score - a.score || a.window.dateKey.localeCompare(b.window.dateKey) || a.window.start - b.window.start);
    const best = ranked[0];
    if (!best) { unscheduled.push({ item, reason: deadlineRisk(item, state) === 'CRITICAL' ? 'No feasible window before the deadline.' : 'No reasonable window in the planning horizon.' }); continue; }
    const action = { item, dateKey: best.window.dateKey, time: toClock(best.window.start), duration: Number(item.remainingDuration ?? item.duration) || 30, score: Math.round(best.score * 100) / 100, urgency: urgencyScore(item, state), risk: deadlineRisk(item, state), relaxed: Boolean(best.window.relaxed) };
    scheduled.push(action);
    dailyLoad.set(action.dateKey, (dailyLoad.get(action.dateKey) || 0) + action.duration);
    if (item.className) lastClassDate.set(item.className, action.dateKey);
    planningState.tasks = planningState.tasks.filter(task => task.id !== item.id);
    planningState.tasks.push({ ...withTaskExecution(item, action.dateKey, action.time), id: `planned-${item.id}`, autoScheduled: true, type: 'planned_task', source: 'planner' });
  }
  const horizonEnd = addDays(toDateKey(state.currentTime), horizonDays);
  const availableByDay = new Map();
  generateCandidateWindows(state, { duration: 15 }, { horizonDays, allowBeforePreferredStart: options.allowBeforePreferredStart === true }).forEach(window => availableByDay.set(window.dateKey, (availableByDay.get(window.dateKey) || 0) + window.duration));
  const availableMinutes = [...availableByDay.values()].reduce((total, minutes) => total + Math.min(minutes, state.studentPreferences.dailyCapacityMinutes), 0);
  const totalRequiredMinutes = work.reduce((total, item) => total + (Number(item.remainingDuration ?? item.duration) || 30), 0);
  const bottleneck = unscheduled[0]?.item || (totalRequiredMinutes > availableMinutes ? [...work].sort((a, b) => urgencyScore(b, state) - urgencyScore(a, state))[0] : null);
  scheduled.sort((left, right) => taskSort({ ...left.item, scheduledDate: left.dateKey, scheduledTime: left.time }, { ...right.item, scheduledDate: right.dateKey, scheduledTime: right.time }));
  return { state, scheduled, unscheduled, availableMinutes, totalRequiredMinutes, horizonEnd, bottleneck, canFinish: unscheduled.length === 0 && totalRequiredMinutes <= availableMinutes, deadlineRisk: unscheduled.length ? 'HIGH' : totalRequiredMinutes > availableMinutes ? 'MEDIUM' : 'LOW' };
}

export function recommendNextAction(stateOrTasks = {}, options = {}) {
  const state = isPlanningState(stateOrTasks) ? stateOrTasks : buildPlanningState({ tasks: stateOrTasks, currentTime: options.now });
  const now = state.currentTime;
  const availableMinutes = Number.isFinite(Number(options.availableMinutes)) ? Number(options.availableMinutes) : Infinity;
  const horizonDays = Number.isFinite(Number(options.horizonDays)) ? Math.max(0, Number(options.horizonDays)) : 7;
  const todayKey = toDateKey(now);
  const targetDate = isDateKey(options.dateKey) ? options.dateKey : null;
  const horizonEnd = targetDate || addDays(todayKey, horizonDays);
  const targetTaskIds = Array.isArray(options.taskIds) ? new Set(options.taskIds) : null;
  const preferImmediate = options.preferImmediate === true;
  const available = state.tasks.filter(task => {
    if (task.status === 'completed' || !(task.dueDate || task.scheduledDate) || targetTaskIds && !targetTaskIds.has(task.id) || task.type === 'assessment' || task.type === 'fixed_event' || task.source === 'calendar' || (Number(task.remainingDuration ?? task.duration) || 30) > availableMinutes) return false;
    if (!preferImmediate || targetDate) return true;
    const taskDate = task.scheduledDate || (task.type === 'study_session' ? task.dueDate : null);
    const dueSoon = task.dueDate && task.dueDate <= addDays(todayKey, 1);
    const flexible = task.flexibility === 'flexible' && !task.userScheduled;
    return !taskDate || taskDate === todayKey || dueSoon || flexible;
  });
  const ranked = available.map(task => {
    const related = relatedAssessment(task, state);
    const recoveryItem = task.type === 'study_session' && related?.dueDate && (!task.scheduledDate || task.scheduledDate < todayKey || (task.scheduledDate === todayKey && Number.isFinite(toMinutes(task.scheduledTime)) && toMinutes(task.scheduledTime) < now.getHours() * 60 + now.getMinutes()))
      ? { ...task, dueDate: related.dueDate, dueTime: null, scheduledDate: null, scheduledTime: null, userScheduled: false }
      : task;
    const taskScheduleDate = task.scheduledDate || (task.type === 'study_session' ? task.dueDate : null);
    const taskScheduleTime = task.scheduledTime || (task.type === 'study_session' ? task.dueTime : null);
    const scheduledStart = taskScheduleDate && taskScheduleTime ? toMinutes(taskScheduleTime) : NaN;
    const scheduledWindow = isDateKey(taskScheduleDate) && Number.isFinite(scheduledStart) && (taskScheduleDate > todayKey || scheduledStart >= now.getHours() * 60 + now.getMinutes()) && taskScheduleDate >= todayKey && taskScheduleDate <= horizonEnd && (!targetDate || taskScheduleDate === targetDate)
      ? { dateKey: taskScheduleDate, start: scheduledStart, end: scheduledStart + (Number(task.remainingDuration ?? task.duration) || 30), duration: Number(task.remainingDuration ?? task.duration) || 30, scheduled: true }
      : null;
    const windows = scheduledWindow ? [scheduledWindow] : generateCandidateWindows(state, recoveryItem, { horizonDays: targetDate ? Math.max(0, calendarDayDiff(parseDateKey(todayKey), parseDateKey(targetDate))) : horizonDays, allowBeforePreferredStart: false }).filter(window => !targetDate || window.dateKey === targetDate);
    const window = windows.map(candidate => ({ candidate, score: scoreTimeWindow(candidate, recoveryItem, state) })).sort((a, b) => b.score - a.score || a.candidate.dateKey.localeCompare(b.candidate.dateKey) || a.candidate.start - b.candidate.start)[0]?.candidate;
    const fit = window ? scoreTimeWindow(window, recoveryItem, state) : 0;
    return { task, score: urgencyScore(task, state) + fit, window };
  }).sort((a, b) => {
    if (preferImmediate) {
      // “Next” is an execution question, not a deadline/priority question.
      // Once the caller asks for an immediate recommendation, the earliest
      // runnable window must win over a task that merely scores higher because
      // its deadline is farther away or more urgent.
      const executionDate = item => item.window?.dateKey || item.task.scheduledDate || (item.task.type === 'study_session' ? item.task.dueDate : item.task.dueDate) || '9999-12-31';
      const executionStart = item => Number.isFinite(Number(item.window?.start))
        ? Number(item.window.start)
        : toMinutes(item.task.scheduledTime || (item.task.type === 'study_session' ? item.task.dueTime : item.task.dueTime));
      const dateDifference = executionDate(a).localeCompare(executionDate(b));
      if (dateDifference) return dateDifference;
      const aStart = executionStart(a);
      const bStart = executionStart(b);
      if (Number.isFinite(aStart) || Number.isFinite(bStart)) {
        if (!Number.isFinite(aStart)) return 1;
        if (!Number.isFinite(bStart)) return -1;
        if (aStart !== bStart) return aStart - bStart;
      }
    }
    if (samePlanningDate(a.task, b.task)) {
      const orderDifference = taskOrderPosition(a.task, state) - taskOrderPosition(b.task, state);
      if (orderDifference) return orderDifference;
    }
    return b.score - a.score || taskSort(a.task, b.task);
  });
  const best = ranked[0];
  if (!best) {
    const nextPlanned = preferImmediate && !targetDate
      ? state.tasks.filter(task => task.status !== 'completed' && (task.scheduledDate || task.type === 'study_session' && task.dueDate) && (task.scheduledDate || task.dueDate) > todayKey).sort((a, b) => `${a.scheduledDate || a.dueDate}T${a.scheduledTime || a.dueTime || '23:59'}`.localeCompare(`${b.scheduledDate || b.dueDate}T${b.scheduledTime || b.dueTime || '23:59'}`))[0]
      : null;
    return { task: null, availableMinutes, reason: nextPlanned ? `You're caught up for today. Your next planned work is ${nextPlanned.title}.` : 'You\'re caught up for today. Nothing needs to move forward right now.', now };
  }
  const assessment = relatedAssessment(best.task, state);
  const reason = best.window?.relaxed
    ? `${best.task.title} is due ${best.task.dueDate ? formatDate(best.task.dueDate, { month: 'short', day: 'numeric' }) : 'soon'}; the preferred window is full, so this is the next available opening.`
    : assessment?.dueDate
      ? `${assessment.className || 'This subject'} is due ${formatDate(assessment.dueDate, { month: 'short', day: 'numeric' })} and this task fits the time you have.`
    : best.task.dueDate
      ? `${best.task.title} is due ${formatDate(best.task.dueDate, { month: 'short', day: 'numeric' })} and is the strongest use of this window.`
      : `${best.task.title} is the highest-priority work that fits right now.`;
  return { task: best.task, score: best.score, availableMinutes, window: best.window, reason, now };
}

// Public name used by the UI and future notifications. Keeping this as a
// single engine entry point prevents each surface from inventing its own
// notion of the next thing to do.
export function getNextBestAction(stateOrTasks = {}, options = {}) {
  const result = recommendNextAction(stateOrTasks, options);
  if (result.task) return { type: 'work', workItemId: result.task.id, task: result.task, startAt: result.window?.dateKey && result.window?.start !== undefined ? `${result.window.dateKey}T${toClock(result.window.start)}` : null, duration: result.task.remainingDuration ?? result.task.duration ?? 30, reason: result.reason, window: result.window };
  return { type: 'nothing', workItemId: null, startAt: null, duration: 0, reason: result.reason, window: null };
}

export function planningSummary(stateOrInput = {}, options = {}) {
  const plan = planWorkload(stateOrInput, options);
  const hours = minutes => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const summary = plan.canFinish
    ? `You have approximately ${hours(plan.totalRequiredMinutes)} of work remaining and ${hours(plan.availableMinutes)} of usable time before ${formatDate(plan.horizonEnd, { month: 'short', day: 'numeric' })}.`
    : `You need about ${hours(plan.totalRequiredMinutes)} of work, but only ${hours(plan.availableMinutes)} is realistically available before ${formatDate(plan.horizonEnd, { month: 'short', day: 'numeric' })}.`;
  return { ...plan, summary, bottleneck: plan.bottleneck ? { id: plan.bottleneck.id, title: plan.bottleneck.title, duration: plan.bottleneck.remainingDuration ?? plan.bottleneck.duration } : null };
}

export function recordCompletion(gamification = {}, task, completedAt = new Date()) {
  const awarded = { ...(gamification.awardedTaskIds || {}) };
  const identity = task.occurrenceKey || task.id;
  if (!identity || awarded[identity]) return { ...gamification, level: gamificationLevel(gamification.xp), awardedTaskIds: awarded };
  awarded[identity] = true;
  const amount = task.type === 'study_session' ? 12 : task.type === 'assessment' ? 15 : 10;
  const xp = Math.max(0, Number(gamification.xp) || 0) + amount;
  const next = { ...gamification, xp, level: gamificationLevel(xp), awardedTaskIds: awarded };
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
  const streakMilestonesAwarded = { ...(gamification.streakMilestonesAwarded || {}) };
  let xp = Math.max(0, Number(gamification.xp) || 0);
  for (let milestone = 7; milestone <= currentStreak; milestone += 7) {
    if (streakMilestonesAwarded[milestone]) continue;
    streakMilestonesAwarded[milestone] = true;
    xp += 200;
  }
  return { ...gamification, xp, level: gamificationLevel(xp), currentStreak, longestStreak, completedDays: [...completedDays].sort(), lastCompletionDate: dateKey, streakMilestonesAwarded };
}

export function gamificationLevel(xp = 0) {
  return Math.max(1, Math.floor(Math.max(0, Number(xp) || 0) / 100) + 1);
}

function toMinutes(time) { const match = String(time || '').match(/^(\d{1,2}):(\d{2})/); if (!match) return NaN; const value = Number(match[1]) * 60 + Number(match[2]); return Number.isFinite(value) && Number(match[1]) <= 23 && Number(match[2]) <= 59 ? value : NaN; }
function toClock(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
function roundToQuarter(minutes) { return Math.ceil(minutes / 15) * 15; }
function roundUpToIncrement(minutes, increment) { return Math.ceil(minutes / increment) * increment; }

export const seedState = () => {
  return {
    tasks: [],
    profile: { onboardingComplete: false, displayName: '', notifications: [], schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:00', latestStudyTime: '21:00', sessionLength: 45, sessionsPerAssessment: 3, sessionsPerWeek: 2, methods: ['Review notes'], classPreferences: { Biology: { sessionsPerWeek: 3, sessionLength: 45 }, Mathematics: { sessionsPerWeek: 2, sessionLength: 45 }, English: { sessionsPerWeek: 2, sessionLength: 30 }, Chemistry: { sessionsPerWeek: 2, sessionLength: 45 } }, classColors: {}, gamification: { xp: 0, level: 1, currentStreak: 0, longestStreak: 0, completedDays: [], awardedTaskIds: {}, streakMilestonesAwarded: {} } },
    classes: [],
    projects: [],
    deletedTaskIds: [],
    deletedTaskIdentities: []
  };
};
