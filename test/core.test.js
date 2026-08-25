import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, assessmentIdempotencyKey, expandRecurringTask, findOpenSlot, isOverdue, parseCapture, planStudySessions, rankRecommendations, resolveDatePhrase, resolveDuration, resolveTimePhrase, toDateKey, INTENTS } from '../src/core.js';

const fixedNow = new Date(2026, 7, 25, 17, 30);

test('relative dates resolve in the local calendar', () => {
  assert.equal(resolveDatePhrase('tomorrow', fixedNow), '2026-08-26');
  assert.equal(resolveDatePhrase('next Wednesday', fixedNow), '2026-09-02');
  assert.equal(resolveDatePhrase('next Friday', fixedNow), '2026-09-04');
  assert.equal(resolveDatePhrase('in three days', fixedNow), '2026-08-28');
});

test('capture understands shorthand and assessment intent', () => {
  const command = parseCapture('i have a biolgy test next wed', fixedNow);
  assert.equal(command.intent, INTENTS.CREATE_ASSESSMENT);
  assert.equal(command.subject, 'Biology');
  assert.equal(command.title, 'Biology Test');
  assert.equal(command.dueDate, '2026-09-02');
});

test('parser covers task commands and natural durations', () => {
  assert.equal(parseCapture('math hw tomorrow', fixedNow).title, 'math homework');
  assert.equal(parseCapture('delete my essay', fixedNow).intent, INTENTS.DELETE_TASK);
  assert.equal(parseCapture('complete biology study', fixedNow).intent, INTENTS.COMPLETE_TASK);
  assert.equal(parseCapture('what should i do right now', fixedNow).intent, INTENTS.QUERY_RECOMMENDATION);
  assert.equal(parseCapture('what do i have today', fixedNow).intent, INTENTS.QUERY_TODAY);
  assert.equal(parseCapture('what is upcoming this week', fixedNow).intent, INTENTS.QUERY_UPCOMING);
  assert.equal(resolveTimePhrase('meet me at 7:30 pm'), '19:30');
  assert.equal(resolveTimePhrase('meet me at 25:90'), null);
  assert.equal(resolveDuration('for 1.5 hours'), 90);
});

test('overdue is only unfinished work before the current timestamp', () => {
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-25', dueTime: '17:00' }, fixedNow), true);
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-26', dueTime: '09:00' }, fixedNow), false);
  assert.equal(isOverdue({ status: 'completed', dueDate: '2026-08-24', dueTime: '09:00' }, fixedNow), false);
});

test('assessment planning creates a bounded, conflict-free number of sessions', () => {
  const assessment = { id: 'a1', title: 'Biology Test', className: 'Biology', dueDate: '2026-08-28', priority: 3 };
  const sessions = planStudySessions(assessment, [{ id: 'busy', status: 'open', dueDate: '2026-08-27', dueTime: '17:00', duration: 90 }], { preferredStart: '16:30', latestStudyTime: '21:00', sessionLength: 45, sessionsPerAssessment: 3 });
  assert.ok(sessions.length <= 3);
  assert.ok(sessions.every(task => task.dueDate < assessment.dueDate));
  assert.ok(sessions.every(task => task.dueTime >= '16:30' && task.dueTime < '21:00'));
  assert.equal(new Set(sessions.map(task => task.schedulingIdentity)).size, sessions.length);
});

test('date helpers remain date-only and deterministic', () => {
  const key = toDateKey(new Date(2026, 7, 25));
  assert.equal(addDays(key, 7), '2026-09-01');
});

test('recurrence keeps a canonical definition and independent occurrences', () => {
  const command = parseCapture('Read every Monday', fixedNow);
  assert.equal(command.intent, 'CREATE_RECURRING_TASK');
  const definition = { id: 'r1', title: command.title, dueDate: command.dueDate, recurrence: command.recurrence, status: 'open', duration: 30 };
  const occurrences = expandRecurringTask(definition, '2026-08-24', '2026-09-14', {});
  assert.deepEqual(occurrences.map(task => task.dueDate), ['2026-08-31', '2026-09-07', '2026-09-14']);
  const completed = expandRecurringTask(definition, '2026-08-24', '2026-09-14', { 'r1::2026-08-31': 'done' });
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[1].status, 'open');
});

test('date and scheduler boundaries never place work in the past or school hours', () => {
  const now = new Date(2026, 7, 25, 17, 50);
  assert.equal(resolveDatePhrase('today', now), '2026-08-25');
  assert.equal(resolveDatePhrase('tomorrow', new Date(2026, 7, 25, 23, 59)), '2026-08-26');
  assert.equal(resolveDatePhrase('2/31', now), null);
  assert.equal(findOpenSlot([], '2026-08-25', 45, { now, preferredStart: '15:00', latestStudyTime: '21:00' }), '18:15');
});

test('planning is idempotent for an assessment already fully scheduled', () => {
  const assessment = { id: 'a2', title: 'Math Test', className: 'Mathematics', dueDate: '2026-08-28', priority: 2 };
  const existing = [
    { id: 's1', type: 'study_session', relatedAssessmentId: 'a2', schedulingIdentity: 'a2:2026-08-27:1700' },
    { id: 's2', type: 'study_session', relatedAssessmentId: 'a2', schedulingIdentity: 'a2:2026-08-26:1700' },
    { id: 's3', type: 'study_session', relatedAssessmentId: 'a2', schedulingIdentity: 'a2:2026-08-25:1700' }
  ];
  assert.deepEqual(planStudySessions(assessment, existing, { sessionsPerAssessment: 3, now: fixedNow }), []);
});

test('repeated assessment input produces one stable idempotency key', () => {
  const first = parseCapture('Bio test Friday', fixedNow);
  const second = parseCapture('biology test fri', fixedNow);
  assert.equal(assessmentIdempotencyKey(first), assessmentIdempotencyKey(second));
});

test('free-time recommendations favor urgency, priority, and fit', () => {
  const tasks = [
    { id: 'later', title: 'Read', status: 'open', dueDate: '2026-09-10', priority: 1, duration: 30 },
    { id: 'urgent', title: 'Study', status: 'open', dueDate: '2026-08-26', priority: 3, duration: 45 },
    { id: 'too-long', title: 'Project', status: 'open', dueDate: '2026-08-25', priority: 4, duration: 120 }
  ];
  assert.equal(rankRecommendations(tasks, fixedNow, 45)[0].id, 'urgent');
});
