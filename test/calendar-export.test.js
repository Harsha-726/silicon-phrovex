import test from 'node:test';
import assert from 'node:assert/strict';
import { activeUserForToken, buildCalendar, escapeIcsText, exportableTask, recurrenceRule } from '../api/calendar-export.js';
import { filterCalendarEvents, isPastImportedOneTimeTask, preserveImportedCalendarTask, repairImportedCalendarClass } from '../src/ical.js';

const baseTask = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Review, then submit',
  description: 'Line one; line two\\final',
  status: 'open',
  due_date: '2026-08-29',
  due_time: '17:30:00',
  duration_minutes: 90,
  class_name: 'APUSH',
  recurrence: null,
  ...overrides
});

test('past one-time calendar imports are skipped and marked for deletion', () => {
  const events = filterCalendarEvents([
    { uid: 'past', dueDate: '2026-08-28', recurrence: null },
    { uid: 'recurring', dueDate: '2026-08-01', recurrence: { frequency: 'weekly' } },
    { uid: 'today', dueDate: '2026-08-29', recurrence: null },
    { uid: 'today', dueDate: '2026-08-29', recurrence: null }
  ], '2026-08-29');
  assert.deepEqual(events.map(event => event.uid), ['recurring', 'today']);
  assert.equal(isPastImportedOneTimeTask({ source: 'calendar', dueDate: '2026-08-28' }, '2026-08-29'), true);
  assert.equal(isPastImportedOneTimeTask({ source: 'calendar', dueDate: '2026-08-28', recurrence: { frequency: 'weekly' } }, '2026-08-29'), false);
});

test('a manually moved imported event is evaluated by its execution date', () => {
  assert.equal(isPastImportedOneTimeTask({ source: 'calendar', dueDate: '2026-08-28', scheduledDate: '2026-09-03' }, '2026-09-04'), true);
  assert.equal(isPastImportedOneTimeTask({ source: 'calendar', dueDate: '2026-08-28', scheduledDate: '2026-09-05' }, '2026-09-04'), false);
});

test('ICS text escaping protects commas, semicolons, backslashes, and newlines', () => {
  assert.equal(escapeIcsText('a,b;c\\d\nnext'), 'a\\,b\\;c\\\\d\\nnext');
});

test('all-day tasks use a date value and a one-day exclusive end', () => {
  const ics = buildCalendar([baseTask({ due_time: null, duration_minutes: 180 })], '2026-08-29');
  assert.match(ics, /DTSTART;VALUE=DATE:20260829\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20260830\r\n/);
  assert.doesNotMatch(ics, /DTSTART;TZID|DTSTART:20260829T/);
});

test('timed tasks use duration-aware end times, including the next day', () => {
  const ics = buildCalendar([baseTask({ due_date: '2026-08-29', due_time: '23:30', duration_minutes: 90 })], '2026-08-29');
  assert.match(ics, /DTSTART:20260829T233000\r\n/);
  assert.match(ics, /DTEND:20260830T010000\r\n/);
});

test('recurrence is emitted when the stored recurrence can be represented', () => {
  assert.equal(recurrenceRule({ frequency: 'weekly', interval: 2, days: [1, 5] }, '2026-08-29'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR');
  const ics = buildCalendar([baseTask({ due_date: '2026-08-01', due_time: null, recurrence: { frequency: 'weekly', interval: 1, days: [6] } })], '2026-08-29');
  assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA\r\n/);
});

test('completed, undated, and past one-time tasks are excluded while recurring past tasks remain', () => {
  const ics = buildCalendar([
    baseTask({ id: 'completed', status: 'completed' }),
    baseTask({ id: 'undated', due_date: null }),
    baseTask({ id: 'past', due_date: '2026-08-28' }),
    baseTask({ id: 'recurring-past', due_date: '2026-08-01', recurrence: { frequency: 'monthly' } })
  ], '2026-08-29');
  assert.doesNotMatch(ics, /UID:silico-task-(?:completed|undated|past)@silico/);
  assert.match(ics, /UID:silico-task-recurring-past@silico/);
});

test('stable task IDs produce stable UIDs and prevent duplicate event series', () => {
  const first = buildCalendar([baseTask()], '2026-08-29');
  const second = buildCalendar([baseTask()], '2026-08-29');
  assert.equal(first, second);
  assert.equal((first.match(/UID:silico-task-/g) || []).length, 1);
});

test('resync preserves manual edits to imported tasks while repairing only legacy identity', () => {
  const edited = { id: 'imported', title: 'My edited title', description: 'My notes', dueDate: '2026-09-03', dueTime: '19:00', duration: 120, className: null, project: 'Important', recurrence: null, idempotencyKey: 'ical:old:uid', source: 'calendar' };
  const incoming = { title: 'Original feed title', description: 'Original feed notes', dueDate: '2026-08-29', dueTime: '16:00', duration: 60, className: 'Chemistry', idempotencyKey: 'ical:todoist:uid' };
  const result = preserveImportedCalendarTask(edited, incoming);
  assert.equal(result.changed, true);
  assert.deepEqual(result.task, { ...edited, idempotencyKey: 'ical:todoist:uid' });
});

test('calendar resync repairs an empty or stale auto-matched class', () => {
  const incoming = { className: 'Calculus AB AP', calendarClassName: 'Calculus AB AP', calendarClassHint: 'Calculus AB AP' };
  const missing = repairImportedCalendarClass({ id: 'missing', source: 'calendar', className: null }, incoming);
  assert.equal(missing.changed, true);
  assert.equal(missing.task.className, 'Calculus AB AP');
  const stale = repairImportedCalendarClass({ id: 'stale', source: 'calendar', className: 'Todoist' }, incoming);
  assert.equal(stale.changed, true);
  assert.equal(stale.task.className, 'Calculus AB AP');
  const manual = repairImportedCalendarClass({ id: 'manual', source: 'calendar', className: 'Physics I AP', calendarClassManuallySet: true }, incoming);
  assert.equal(manual.changed, false);
  assert.equal(manual.task.className, 'Physics I AP');
});

test('calendar resync clears a default class from a known non-academic Schoology event', () => {
  const incoming = { className: null, calendarClassName: null, calendarClassResolution: 'non_academic', calendarClassHint: null, calendarDefaultClass: 'Calculus AB AP' };
  const result = repairImportedCalendarClass({ id: 'club', source: 'calendar', className: 'Calculus AB AP', calendarClassName: 'Calculus AB AP', calendarClassManuallySet: true }, incoming);
  assert.equal(result.changed, true);
  assert.equal(result.task.className, null);
  assert.equal(result.task.calendarClassName, null);
  const legacy = repairImportedCalendarClass({ id: 'legacy-club', source: 'calendar', className: 'Calculus AB AP', calendarClassManuallySet: true }, incoming);
  assert.equal(legacy.changed, true);
  assert.equal(legacy.task.className, null);
});

test('calendar resync clears a configured Schoology default when metadata is unmatched', () => {
  const incoming = { className: null, calendarClassName: null, calendarClassResolution: 'unmatched', calendarClassHint: null, calendarDefaultClass: 'Calculus AB AP' };
  const result = repairImportedCalendarClass({ id: 'unmatched', source: 'calendar', className: 'Calculus AB AP', calendarClassName: 'Calculus AB AP', calendarClassManuallySet: false }, incoming);
  assert.equal(result.changed, true);
  assert.equal(result.task.className, null);
  assert.equal(result.task.calendarClassName, null);
});

test('invalid and revoked feed tokens are rejected', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://supabase.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    assert.equal(await activeUserForToken('too-short'), null);
    assert.equal(await activeUserForToken('revoked-token-that-is-long-enough'), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
