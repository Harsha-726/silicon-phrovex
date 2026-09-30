import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, assignUniqueClassHues, assessmentIdempotencyKey, assessmentSessionIdentity, assessmentTitle, assignmentTypeLabel, buildPlanningState, cleanCaptureInput, cleanTaskTitle, deadlineRisk, expandRecurringTask, findOpenSlot, gamificationLevel, generateCandidateWindows, inferAssignmentType, isClearedByTaskTombstone, isOverdue, isPastSchedule, isRigidExecution, makeTask, matchExistingClass, parseCapture, planStudySessions, planStudySessionsOnDates, planWorkload, planningSummary, rankRecommendations, recommendNextAction, recordCompletion, removeClassFromTitle, resolveDatePhrase, resolveDuration, resolvePriority, resolveStudyDates, resolveTimePhrase, scheduleOriginOf, SCHEDULE_ORIGINS, SCHEDULE_CHANGE_REASONS, setTaskExecution, splitCaptureInput, stableColorHue, taskExecution, taskSort, taskSyncTimestamp, teamTaskFeedRecord, titleCaseTaskTitle, toDateKey, updateStreak, urgencyScore, INTENTS } from '../src/core.js';
import { inferSchoologyClassHint, isNonAcademicSchoologyEvent, parseICal } from '../src/ical.js';
import { getNextBestAction, replanAssessmentSessions } from '../src/core.js';

const fixedNow = new Date(2026, 7, 25, 17, 30);

test('relative dates resolve in the local calendar', () => {
  assert.equal(resolveDatePhrase('tomorrow', fixedNow), '2026-08-26');
  assert.equal(resolveDatePhrase('tmrw', fixedNow), '2026-08-26');
  assert.equal(resolveDatePhrase('2moro', fixedNow), '2026-08-26');
  assert.equal(resolveDatePhrase('next Wednesday', fixedNow), '2026-09-02');
  assert.equal(resolveDatePhrase('next Friday', fixedNow), '2026-09-04');
  assert.equal(resolveDatePhrase('this Friday', fixedNow), '2026-08-28');
  assert.equal(resolveDatePhrase('Wednesday', fixedNow), '2026-08-26');
  assert.equal(resolveDatePhrase('in three days', fixedNow), '2026-08-28');
  const thursday = new Date(2026, 7, 27, 17, 30);
  assert.equal(resolveDatePhrase('next Friday', thursday), '2026-09-04');
  assert.equal(parseCapture('submit project next Friday', thursday).dueDate, '2026-09-04');
});

test('explicit shorthand dates stay on the requested execution date', () => {
  const command = parseCapture('ela ws tmrw', fixedNow);
  assert.equal(command.dueDate, '2026-08-26');
  assert.equal(command.dueDateExplicit, true);
  const task = makeTask(command, { userScheduled: command.dueDateExplicit === true });
  assert.equal(task.scheduledDate, '2026-08-26');
});

test('execution timing has one canonical setter and remains separate from deadlines', () => {
  const task = { id: 'task', dueDate: '2026-09-20', dueTime: '23:59' };
  setTaskExecution(task, '2026-09-18', '16:30');
  assert.deepEqual(taskExecution(task), { date: '2026-09-18', time: '16:30' });
  assert.equal(task.dueDate, '2026-09-20');
  assert.equal(task.dueTime, '23:59');
  assert.deepEqual(task.schedule.execution, { date: '2026-09-18', time: '16:30' });
});

test('date-only homework stays on its requested date and starts after the study boundary', () => {
  const now = new Date(2026, 8, 15, 12, 0);
  const task = makeTask(parseCapture('math homework tomorrow', now), { datePinned: true, userScheduled: true, executionPinned: false });
  const plan = planWorkload(buildPlanningState({ currentTime: now, tasks: [task], profile: { preferredStart: '16:00', latestStudyTime: '21:00', schoolDays: [] } }), { horizonDays: 3 });
  const action = plan.scheduled.find(item => item.item.id === task.id);
  assert.deepEqual([action.dateKey, action.time], ['2026-09-16', '16:00']);
});

test('a completion requirement with an explicit day creates work on that day', () => {
  const command = parseCapture('I need to complete AP history on Friday', fixedNow);
  assert.equal(command.intent, INTENTS.CREATE_TASK);
  assert.equal(command.title, 'AP history');
  assert.equal(command.dueDate, '2026-08-28');
  const task = makeTask(command, { datePinned: true, userScheduled: true, executionPinned: false });
  const plan = planWorkload(buildPlanningState({ currentTime: fixedNow, tasks: [task], profile: { preferredStart: '16:00', latestStudyTime: '21:00', schoolDays: [] } }), { horizonDays: 5 });
  const action = plan.scheduled.find(item => item.item.id === task.id);
  assert.deepEqual([action.dateKey, action.time], ['2026-08-28', '16:00']);
});

test('recurrence expansion is safe and keeps scheduled occurrences on their own dates', () => {
  const task = makeTask({ title: 'Work on Silico', dueDate: '2026-08-25', recurrence: { frequency: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] } }, { datePinned: false, userScheduled: false });
  setTaskExecution(task, '2026-08-25', '16:00');
  const occurrences = expandRecurringTask(task, '2026-08-25', '2026-08-31');
  assert.deepEqual(occurrences.map(item => [item.dueDate, item.scheduledDate, item.scheduledTime]), [
    ['2026-08-25', '2026-08-25', '16:00'],
    ['2026-08-26', '2026-08-26', '16:00'],
    ['2026-08-27', '2026-08-27', '16:00'],
    ['2026-08-28', '2026-08-28', '16:00'],
    ['2026-08-31', '2026-08-31', '16:00']
  ]);
  assert.equal(expandRecurringTask({ ...task, recurrence: { frequency: 'weekly', interval: 0, days: 'weekday' } }, '2026-08-25', '2026-08-31').length, 7);
});

test('explicit assessment times remain rigid while flexible work moves around them', () => {
  const assessment = makeTask({ title: 'Chemistry Test', dueDate: '2026-09-16', dueTime: '08:00', dueDateExplicit: true }, { type: 'assessment', datePinned: true, executionPinned: true, userScheduled: true });
  const homework = makeTask({ title: 'Chemistry homework', dueDate: '2026-09-16', dueDateExplicit: true }, { datePinned: true, userScheduled: true, executionPinned: false });
  const state = buildPlanningState({ currentTime: new Date(2026, 8, 15, 12, 0), tasks: [assessment, homework], profile: { preferredStart: '16:00', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 2 });
  assert.equal(plan.scheduled.find(item => item.item.id === homework.id).time, '16:00');
  assert.equal(plan.scheduled.some(item => item.item.id === assessment.id), false);
});

test('legacy planner timestamps on ordinary work are flexible until explicitly pinned', () => {
  assert.equal(isRigidExecution({ assignmentType: 'homework', scheduledDate: '2026-08-25', scheduledTime: '16:30', autoScheduled: false }), false);
  assert.equal(isRigidExecution({ assignmentType: 'homework', scheduledDate: '2026-08-25', scheduledTime: '16:30', executionPinned: true }), false);
  assert.equal(isRigidExecution({ assignmentType: 'homework', scheduledDate: '2026-08-25', scheduledTime: '16:30', executionPinned: true, explicitExecution: true }), true);
  assert.equal(isRigidExecution({ assignmentType: 'study', source: 'scheduler', scheduledDate: '2026-08-25', scheduledTime: '16:30' }), false);
  assert.equal(isRigidExecution({ assignmentType: 'reminder', type: 'assessment', scheduledDate: '2026-08-25', scheduledTime: '16:30', executionPinned: true }), false);
});

test('past schedule validation blocks only past user intent', () => {
  const now = new Date(2026, 8, 15, 16, 0);
  assert.equal(isPastSchedule('2026-09-14', null, now), true);
  assert.equal(isPastSchedule('2026-09-15', '15:59', now), true);
  assert.equal(isPastSchedule('2026-09-15', null, now), false);
  assert.equal(isPastSchedule('2026-09-16', '08:00', now), false);
});

test('task tombstones clear stale tasks but preserve tasks created afterward', () => {
  const clearedAt = '2026-08-29T12:00:00.000Z';
  const oldTask = { createdAt: '2026-08-29T11:59:00.000Z', updatedAt: '2026-08-29T11:59:00.000Z' };
  const newTask = { createdAt: '2026-08-29T12:01:00.000Z', updatedAt: '2026-08-29T12:01:00.000Z' };
  assert.equal(taskSyncTimestamp(oldTask), Date.parse(oldTask.updatedAt));
  assert.equal(isClearedByTaskTombstone(oldTask, clearedAt), true);
  assert.equal(isClearedByTaskTombstone(newTask, clearedAt), false);
});

test('capture understands shorthand and assessment intent', () => {
  const command = parseCapture('i have a biolgy test next wed', fixedNow);
  assert.equal(command.intent, INTENTS.CREATE_ASSESSMENT);
  assert.equal(command.subject, 'Biology');
  assert.equal(command.title, 'Biology Test');
  assert.equal(command.dueDate, '2026-09-02');
});

test('study-for-test requests plan study without creating an assessment', () => {
  const command = parseCapture('study for chem test Friday', fixedNow);
  assert.equal(command.intent, INTENTS.STUDY_PLANNING);
  assert.equal(command.subject, 'Chemistry');
  assert.equal(command.title, 'Test');
  assert.equal(command.dueDate, '2026-08-28');
  assert.equal(parseCapture('study for chemestry exam Sep 4', fixedNow).subject, 'Chemistry');
  assert.equal(parseCapture('study for chemestry exam Sep 4', fixedNow).dueDate, '2026-09-04');
});

test('assessment study sessions use the class count in the final days before the exam', () => {
  const assessment = { id: 'chem-final', idempotencyKey: 'chem-final-key', className: 'Chemistry', title: 'Chemistry Test', dueDate: '2026-09-08', priority: 1 };
  const sessions = planStudySessions(assessment, [], {
    now: fixedNow,
    sessionsPerAssessment: 5,
    preferredStart: '16:30',
    latestStudyTime: '21:00',
    schoolDays: [],
    classPreferences: { Chemistry: { sessionsPerWeek: 3, sessionLength: 45 } }
  });
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map(session => session.dueDate), ['2026-09-05', '2026-09-06', '2026-09-07']);
  assert.equal(sessions.some(session => session.dueDate === '2026-08-25'), false);
});

test('an assessment two weeks away still receives its configured preparation sessions', () => {
  const assessment = { id: 'history-sept-25', idempotencyKey: 'history-sept-25-key', className: 'AP US History', title: 'AP US History Test', dueDate: '2026-09-25', priority: 1 };
  const sessions = planStudySessions(assessment, [assessment], {
    now: new Date(2026, 8, 14, 12, 0),
    sessionsPerWeek: 4,
    preferredStart: '16:30',
    latestStudyTime: '21:00',
    schoolDays: [],
    sessionLength: 45
  });
  assert.equal(sessions.length, 4);
  assert.deepEqual(sessions.map(session => session.dueDate), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
});

test('ordinary assessment maintenance repairs an auto-generated session into the preparation window', () => {
  const assessment = { id: 'history-final', className: 'History', title: 'History Test', dueDate: '2026-09-08', status: 'open' };
  const earlySession = { id: 'early-history-session', type: 'study_session', status: 'open', title: 'History Study', relatedAssessmentId: assessment.id, dueDate: '2026-08-25', dueTime: '18:00', duration: 45, autoScheduled: true, userScheduled: false, userPinned: false, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED };
  const result = replanAssessmentSessions(assessment, [assessment, earlySession], { now: fixedNow, sessionsPerAssessment: 3, preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }, { createMissing: false });
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].dueDate, '2026-09-05');
  assert.equal(result.created.length, 0);
});

test('study requests can name several explicit days without being split', () => {
  const input = 'study for chem on Thursday Wednesday and Friday';
  const command = parseCapture(input, fixedNow);
  assert.equal(command.intent, INTENTS.STUDY_PLANNING);
  assert.equal(command.subject, 'Chemistry');
  assert.deepEqual(command.studyDates, ['2026-08-26', '2026-08-27', '2026-08-28']);
  assert.deepEqual(splitCaptureInput(input), [input]);
  const sessions = planStudySessionsOnDates({ id: 'study-plan:chemistry', className: 'Chemistry', priority: 1 }, command.studyDates, [], { now: fixedNow, preferredStart: '16:30', latestStudyTime: '21:00', sessionLength: 45 });
  assert.deepEqual(sessions.map(session => session.dueDate), command.studyDates);
  assert.equal(new Set(sessions.map(session => session.dueTime)).size, 1);
});

test('assignment types are inferred but remain editable', () => {
  assert.equal(inferAssignmentType('Biology test next Wednesday'), 'test');
  assert.equal(inferAssignmentType('Inform parents about club meeting'), 'club_meeting');
  assert.equal(inferAssignmentType('Imported calendar item', 'fixed_event', 'calendar'), 'event');
  assert.equal(makeTask({ title: 'Read chapter 4' }).assignmentType, 'study');
  assert.equal(makeTask({ title: 'Finish this thing' }).assignmentType, 'homework');
  assert.equal(assignmentTypeLabel('club_meeting'), 'Club Meeting');
});

test('class colors are deterministic and case-insensitive', () => {
  assert.equal(stableColorHue('Chemistry'), stableColorHue(' chemistry '));
  assert.notEqual(stableColorHue('Chemistry'), stableColorHue('Biology'));
});

test('class colors stay unique while remaining stable for each class', () => {
  const first = assignUniqueClassHues(['Spanish', 'POE']);
  const second = assignUniqueClassHues(['Spanish', 'POE'], first);
  assert.notEqual(first.spanish, first.poe);
  assert.deepEqual(second, first);
  assert.equal(assignUniqueClassHues(['Spanish', 'Spanish']).spanish, first.spanish);
});

test('capture cleans filler and common typos before creating visible tasks', () => {
  const command = parseCapture("I'm really stressed, please add biolgy homework", fixedNow);
  assert.equal(command.intent, INTENTS.CREATE_TASK);
  assert.equal(command.title, 'Biology homework');
  assert.equal(command.dueDate, '2026-08-25');
  assert.equal(cleanCaptureInput('can you add tommorow math hw'), 'tomorrow math homework');
  assert.equal(cleanCaptureInput('pls add math hw tmrw'), 'math homework tomorrow');
  assert.equal(cleanCaptureInput('ela ws tmrw'), 'ela worksheet tomorrow');
  assert.equal(parseCapture('pls add math hw tmrw', fixedNow).title, 'math homework');
  assert.equal(parseCapture('pls add math hw tmrw', fixedNow).dueDate, '2026-08-26');
});

test('autocorrect expands task shorthand and day abbreviations', () => {
  assert.equal(cleanCaptureInput('study for chem tst fri'), 'study for chem test friday');
  assert.equal(cleanCaptureInput('qui tues'), 'quiz tuesday');
  assert.equal(cleanCaptureInput('wednsday proj due thurs'), 'wednesday project due thursday');
  assert.equal(parseCapture('chem tst fri', fixedNow).intent, INTENTS.CREATE_ASSESSMENT);
  assert.equal(parseCapture('chem tst fri', fixedNow).dueDate, '2026-08-28');
  assert.equal(parseCapture('history qui tues', fixedNow).dueDate, '2026-08-25');
  assert.equal(cleanTaskTitle('history qui tues'), 'history quiz');
});

test('class removal does not cut the suffix from a longer class name', () => {
  assert.equal(removeClassFromTitle('Chemistry homework', 'Chemistry'), 'homework');
  assert.equal(removeClassFromTitle('Chemistry homework', 'Chem'), 'homework');
  assert.equal(removeClassFromTitle('Chem homework', 'Chem'), 'homework');
});

test('capture splits independent tasks joined in one prompt', () => {
  assert.deepEqual(splitCaptureInput('APUSH test tomorrow and Vex Meet tomorrow'), ['APUSH test tomorrow', 'Vex Meet tomorrow']);
  assert.deepEqual(splitCaptureInput('APUSH test tmrw and Vex Meet tmrw'), ['APUSH test tomorrow', 'Vex Meet tomorrow']);
  assert.deepEqual(splitCaptureInput('I have a Biology test Wednesday, math homework due tomorrow, and an English essay due Monday'), ['I have a Biology test Wednesday', 'math homework due tomorrow', 'an English essay due Monday']);
  assert.deepEqual(splitCaptureInput('what do I have today and tomorrow?'), ['what do I have today and tomorrow?']);
});

test('capture shares a trailing date across multiple tasks', () => {
  assert.deepEqual(splitCaptureInput('chem hw and apush hw on fri'), ['chem homework on friday', 'apush homework on friday']);
  assert.deepEqual(splitCaptureInput('chem hw on thurs and apush hw on fri'), ['chem homework on thursday', 'apush homework on friday']);
  assert.deepEqual(splitCaptureInput('x tast sat and sun'), ['x task saturday and sunday']);
  const command = parseCapture('x tast sat and sun', fixedNow);
  assert.equal(command.title, 'x task');
  assert.deepEqual(command.dueDates, ['2026-08-29', '2026-08-30']);
});

test('date shorthand is removed from visible task titles', () => {
  assert.equal(cleanTaskTitle('math test tmrw'), 'math Test');
  assert.equal(cleanTaskTitle('history quiz tues'), 'history quiz');
  assert.equal(cleanTaskTitle('chem lab thurs'), 'Chemistry lab');
  assert.equal(cleanTaskTitle('APUSH - Work on HW p1'), 'APUSH - Work on homework');
  assert.equal(removeClassFromTitle(cleanTaskTitle('APUSH - Work on HW p1'), 'APUSH'), 'Work on homework');
  assert.equal(parseCapture('history quiz tues', fixedNow).title, 'history quiz');
});

test('new task titles use title case and preserve common acronyms', () => {
  assert.equal(titleCaseTaskTitle('math homework on chapter 3'), 'Math Homework On Chapter 3');
  assert.equal(titleCaseTaskTitle('calculus ab ap test'), 'Calculus AB AP Test');
  assert.equal(makeTask({ title: 'biology homework', dueDate: '2026-08-25' }).title, 'Biology Homework');
});

test('existing classes receive assignments using the saved class label', () => {
  assert.equal(matchExistingClass({ subject: 'Biology', title: 'Unit exam', raw: 'biology exam Friday' }, ['AP Biology', 'Biology', 'English']), 'Biology');
  assert.equal(matchExistingClass({ subject: 'Chemistry', title: 'Lab quiz', raw: 'chem quiz' }, ['Chemistry 101', 'History']), 'Chemistry 101');
  assert.equal(matchExistingClass({ subject: null, title: 'Read physics chapter', raw: 'read physics chapter' }, ['Physics', 'English']), 'Physics');
  assert.equal(matchExistingClass({ subject: 'Spanish', title: 'Essay', raw: 'essay Friday' }, ['French', 'English']), null);
  assert.equal(matchExistingClass({ subject: 'Mathematics', title: 'Math test', raw: 'math test Friday' }, ['Calculus', 'English']), 'Calculus');
  assert.equal(matchExistingClass({ subject: 'History', title: 'History test', raw: 'history test Friday' }, ['APUSH', 'English']), 'APUSH');
  assert.equal(matchExistingClass({ subject: 'Math', title: 'Math test', raw: 'math test Friday' }, ['Calculus', 'Geometry']), null);
  assert.equal(matchExistingClass(parseCapture('APUSH - Work on HW p1', fixedNow), ['APUSH', 'Biology', 'Mathematics']), 'APUSH');
});

test('team task feed records use the shared task shape and preserve member completion state', () => {
  const task = teamTaskFeedRecord({ id: 'task-1', team_project_id: 'project-1', project_name: 'Robotics', title: 'Order parts', due_date: '2026-09-10', due_time: '09:30:00', duration_minutes: 45, priority: 3, completed_by_me: true, completed_at: '2026-08-29T12:00:00.000Z', completion_count: 1, member_count: 2, created_at: '2026-08-28T12:00:00.000Z', updated_at: '2026-08-29T12:00:00.000Z' });
  assert.deepEqual({ source: task.source, type: task.type, dueDate: task.dueDate, dueTime: task.dueTime, duration: task.duration, status: task.status, teamProjectName: task.teamProjectName, teamCompletionCount: task.teamCompletionCount, teamMemberCount: task.teamMemberCount }, { source: 'team', type: 'team_task', dueDate: '2026-09-10', dueTime: '09:30:00', duration: 45, status: 'completed', teamProjectName: 'Robotics', teamCompletionCount: 1, teamMemberCount: 2 });
});

test('matched class prefixes are removed from visible task titles', () => {
  assert.equal(removeClassFromTitle('APUSH - Work on homework', 'AP US History'), 'Work on homework');
  assert.equal(removeClassFromTitle('Finish AP US History reading', 'APUSH'), 'Finish reading');
  assert.equal(removeClassFromTitle('Catcher In The Rye Sheet ELA', 'English Language Arts'), 'Catcher In The Rye Sheet');
  assert.equal(removeClassFromTitle('Chemistry homework', 'Chem'), 'homework');
  assert.equal(removeClassFromTitle('Chem homework', 'Chem'), 'homework');
});

test('assessment titles use the matched class while retaining useful detail', () => {
  assert.equal(assessmentTitle({ subject: 'Mathematics', title: 'math test', raw: 'math test on 9/2' }, 'Calculus AB AP'), 'Calculus AB AP Test');
  assert.equal(assessmentTitle({ subject: 'Mathematics', title: 'math unit 2 test', raw: 'math unit 2 test on 9/2' }, 'Calculus AB AP'), 'Calculus AB AP Unit 2 Test');
});

test('iCalendar imports timed, all-day, folded, and recurring events', () => {
  const events = parseICal('BEGIN:VCALENDAR\r\nX-WR-CALNAME:Calculus AB AP\r\nBEGIN:VEVENT\r\nUID:exam-1\r\nSUMMARY:Calculus\\, Unit Test\r\nCATEGORIES:Exam\r\nX-COURSE:Calculus AB AP\r\nDESCRIPTION:Review limits and derivatives\\nBring notes\r\nDTSTART;TZID=America/New_York:20260904T153000\r\nDTEND;TZID=America/New_York:20260904T170000\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:holiday-1\r\nSUMMARY:No School\r\nDTSTART;VALUE=DATE:20260907\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { uid: 'exam-1', title: 'Calculus, Unit Test', description: 'Review limits and derivatives\nBring notes', location: '', categories: 'Exam', classHint: 'Calculus AB AP', calendarName: 'Calculus AB AP', dueDate: '2026-09-04', dueTime: '15:30', duration: 90, recurrence: { frequency: 'weekly', interval: 2, days: [5] } });
  assert.equal(events[1].dueDate, '2026-09-07');
  assert.equal(events[1].dueTime, null);
  assert.equal(events[1].duration, 60);
});

test('iCalendar keeps recurring series whose original start is in the past', () => {
  const [event] = parseICal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:old-series\nSUMMARY:Weekly study group\nDTSTART;VALUE=DATE:20260801\nRRULE:FREQ=WEEKLY;BYDAY=SA\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(event.dueDate, '2026-08-01');
  assert.deepEqual(event.recurrence, { frequency: 'weekly', interval: 1, days: [6] });
});

test('calendar metadata provides an unambiguous class hint', () => {
  const [event] = parseICal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nSUMMARY:Math Test\nCATEGORIES:Calculus AB AP\nDTSTART;VALUE=DATE:20260910\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(matchExistingClass({ subject: event.classHint, title: event.title, raw: `${event.categories} ${event.calendarName}` }, ['Calculus AB AP', 'Geometry']), 'Calculus AB AP');
});

test('iCalendar course metadata wins over generic event categories', () => {
  const [event] = parseICal('BEGIN:VCALENDAR\nX-WR-CALNAME:Schoology\nBEGIN:VEVENT\nUID:schoology-1\nSUMMARY:Read chapter 3\nCATEGORIES:English II HRS, Assignment\nX-SCHOOLOGY-COURSE:English II HRS\nDTSTART;VALUE=DATE:20260910\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(event.classHint, 'English II HRS');
  assert.equal(matchExistingClass({ subject: event.classHint, classHint: event.classHint, hints: [event.categories, event.calendarName], title: event.title, raw: `${event.categories} ${event.calendarName}` }, ['APUSH', 'English II HRS']), 'English II HRS');
});

test('iCalendar ignores generic CLASS visibility and keeps the course metadata', () => {
  const [event] = parseICal('BEGIN:VCALENDAR\nX-WR-CALNAME:Schoology\nBEGIN:VEVENT\nUID:schoology-3\nCLASS:PUBLIC\nSUMMARY:Read chapter 4\nCATEGORIES:Chemistry HRS, Assignment\nDTSTART;VALUE=DATE:20260910\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(event.classHint, '');
  assert.equal(matchExistingClass({ subject: event.classHint, classHint: event.classHint, hints: [event.categories, event.calendarName], title: event.title, raw: `${event.categories} ${event.calendarName}` }, ['Chemistry HRS', 'English II HRS']), 'Chemistry HRS');
});

test('iCalendar category course names match when the feed has no custom course field', () => {
  const [event] = parseICal('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:schoology-2\nSUMMARY:APUSH - Populism and the Populist Movement\nCATEGORIES:APUSH, Assignment\nDTSTART;VALUE=DATE:20260910\nEND:VEVENT\nEND:VCALENDAR');
  assert.equal(matchExistingClass({ subject: event.classHint, classHint: event.classHint, hints: [event.categories], title: event.title, raw: event.title }, ['APUSH', 'English II HRS']), 'APUSH');
});

test('Schoology all-course imports use title signals instead of the default class', () => {
  assert.equal(inferSchoologyClassHint({ title: 'AP Classroom Quiz #1' }), 'Calculus');
  assert.equal(inferSchoologyClassHint({ title: '9.15 Prueba: Verbos con Cambio' }), 'Spanish');
  assert.equal(inferSchoologyClassHint({ title: 'Chemical or Physical Change Check' }), 'Chemistry');
  assert.equal(inferSchoologyClassHint({ title: 'Simple Machines (Pulleys & Incline Plane)' }), 'Principles of Engineering');
  assert.equal(isNonAcademicSchoologyEvent({ title: 'FBLA Meeting in D215' }), true);
  assert.equal(isNonAcademicSchoologyEvent({ title: 'AP Classroom Quiz #1' }), false);
});

test('parser covers task commands and natural durations', () => {
  assert.equal(parseCapture('math hw tomorrow', fixedNow).title, 'math homework');
  assert.equal(parseCapture('I need to finish my history essay tomorrow', fixedNow).intent, INTENTS.CREATE_TASK);
  assert.equal(parseCapture('delete my essay', fixedNow).intent, INTENTS.DELETE_TASK);
  assert.equal(parseCapture('complete biology study', fixedNow).intent, INTENTS.COMPLETE_TASK);
  assert.equal(parseCapture('what should i do right now', fixedNow).intent, INTENTS.QUERY_RECOMMENDATION);
  assert.equal(parseCapture('what do i have today', fixedNow).intent, INTENTS.QUERY_TODAY);
  assert.equal(parseCapture('what is upcoming this week', fixedNow).intent, INTENTS.QUERY_UPCOMING);
  assert.equal(resolveTimePhrase('meet me at 7:30 pm'), '19:30');
  assert.equal(resolveTimePhrase('meet me at 25:90'), null);
  assert.equal(resolveDuration('for 1.5 hours'), 90);
  assert.equal(resolveDuration('I have an hour free'), 60);
  assert.equal(parseCapture('Study every 2 weeks', fixedNow).dueDate, '2026-08-25');
  assert.equal(parseCapture('when should i study for bio?', fixedNow).intent, INTENTS.QUERY_RECOMMENDATION);
  assert.equal(parseCapture('clear my schedule tonight', fixedNow).intent, INTENTS.CLEAR_SCHEDULE);
});

test('priority shorthand maps to app priorities and stays out of titles', () => {
  assert.equal(resolvePriority('study p1 tomorrow'), 4);
  assert.equal(resolvePriority('study !!1 tomorrow'), 4);
  assert.equal(resolvePriority('study p2 tomorrow'), 3);
  assert.equal(resolvePriority('study !!3 tomorrow'), 2);
  assert.equal(resolvePriority('study p4 tomorrow'), 1);
  assert.equal(cleanTaskTitle('math homework !!1 tmrw'), 'math homework');
  assert.equal(parseCapture('math homework p1 tmrw', fixedNow).priority, 4);
  assert.equal(makeTask(parseCapture('math homework !!1 tmrw', fixedNow)).priority, 4);
});

test('Todoist P1 stays stronger than P2 after app priority mapping', () => {
  assert.ok(resolvePriority('finish project p1 today') > resolvePriority('finish project p2 today'));
  assert.equal(resolvePriority('finish project p1 today'), 4);
  assert.equal(resolvePriority('finish project p2 today'), 3);
});

test('overdue is only unfinished work before the current timestamp', () => {
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-25', dueTime: '17:00' }, fixedNow), true);
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-26', dueTime: '09:00' }, fixedNow), false);
  assert.equal(isOverdue({ status: 'completed', dueDate: '2026-08-24', dueTime: '09:00' }, fixedNow), false);
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '11:55' }, fixedNow), true);
  assert.equal(isOverdue({ status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '17:35' }, fixedNow), false);
});

test('same-day overdue planned work moves into the next five-minute recovery slot', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 17, 0),
    tasks: [{
      id: 'same-day-overdue',
      title: 'Same-day overdue work',
      type: 'task',
      status: 'open',
      dueDate: '2026-08-25',
      scheduledDate: '2026-08-25',
      scheduledTime: '16:30',
      duration: 30,
      autoScheduled: true,
      scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED,
      flexibility: 'planned'
    }],
    profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }
  });
  const plan = planWorkload(state, { horizonDays: 0 });
  const repair = plan.scheduled.find(action => action.item.id === 'same-day-overdue');
  assert.equal(repair?.reason, SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY);
  assert.equal(repair?.dateKey, '2026-08-25');
  assert.equal(repair?.time, '17:05');
  assert.match(repair?.message || '', /missed its planned start/i);
});

test('overdue fixed and user-pinned timings stay anchored and remain overdue', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 17, 0),
    tasks: [{
      id: 'fixed-overdue',
      title: 'Fixed overdue commitment',
      type: 'task',
      status: 'open',
      dueDate: '2026-08-25',
      scheduledDate: '2026-08-25',
      scheduledTime: '16:30',
      duration: 30,
      userPinned: true,
      userScheduled: true,
      scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED,
      flexibility: 'fixed'
    }],
    profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }
  });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.equal(plan.scheduled.some(action => action.item.id === 'fixed-overdue'), false);
  assert.equal(isOverdue(state.tasks[0], state.currentTime), true);
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

test('edited and legacy session identities collapse to one assessment slot', () => {
  const assessment = { id: 'assessment-remote-id', idempotencyKey: 'capture:assessment:chemistry:2026-09-10', title: 'Chemistry Quiz', className: 'Chemistry', dueDate: '2026-09-10', status: 'open' };
  const legacy = { id: 'session-legacy', type: 'study_session', status: 'open', relatedAssessmentId: assessment.id, schedulingIdentity: `${assessment.idempotencyKey}:2026-09-08:17:00`, dueDate: '2026-09-08', dueTime: '17:00', duration: 45, updatedAt: '2026-09-01T12:00:00.000Z' };
  const edited = { id: 'session-edited', type: 'study_session', status: 'open', relatedAssessmentId: assessment.id, schedulingIdentity: `${assessment.id}:2026-09-08:17:00`, dueDate: '2026-09-08', dueTime: '17:00', duration: 45, updatedAt: '2026-09-02T12:00:00.000Z' };
  assert.equal(assessmentSessionIdentity(assessment, legacy), assessmentSessionIdentity(assessment, edited));
  const result = replanAssessmentSessions(assessment, [assessment, legacy, edited], { now: new Date('2026-09-05T12:00:00'), sessionsPerAssessment: 1, sessionLength: 45, preferredStart: '16:00', latestStudyTime: '21:00', schoolDays: [] }, { createMissing: true });
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.created.length, 0);
  assert.equal(result.sessions[0].id, 'session-edited');
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

test('assessment sessions stay in the configured final preparation days', () => {
  const assessment = { id: 'a3', title: 'Chemistry Exam', className: 'Chemistry', dueDate: '2026-09-10', priority: 2 };
  const sessions = planStudySessions(assessment, [], { preferredStart: '16:30', latestStudyTime: '21:00', sessionLength: 45, sessionsPerAssessment: 3, now: new Date(2026, 7, 25, 12, 0) });
  assert.deepEqual(sessions.map(session => session.dueDate), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.equal(new Set(sessions.map(session => session.dueDate)).size, 3);
});

test('custom school days and recurring blocked periods are hard constraints', () => {
  const now = new Date(2026, 7, 25, 10, 0);
  assert.equal(findOpenSlot([], '2026-08-29', 45, { now, preferredStart: '09:00', latestStudyTime: '12:00', schoolStart: '08:00', schoolEnd: '10:00', schoolDays: [1, 2, 3, 4, 5], blockedPeriods: [{ weekday: 6, start: '09:00', end: '11:00' }] }), '11:00');
});

test('completion XP is idempotent and streaks are transparent', () => {
  const task = { id: 'task-1', type: 'study_session' };
  const first = recordCompletion({}, task, new Date(2026, 7, 25, 18, 0));
  const second = recordCompletion(first, task, new Date(2026, 7, 25, 19, 0));
  const nextDay = recordCompletion(second, { id: 'task-2' }, new Date(2026, 7, 26, 18, 0));
  assert.equal(first.xp, 12);
  assert.equal(first.level, 1);
  assert.equal(second.xp, 12);
  assert.equal(nextDay.xp, 22);
  assert.equal(nextDay.currentStreak, 2);
  assert.equal(gamificationLevel(99), 1);
  assert.equal(gamificationLevel(100), 2);
  assert.equal(gamificationLevel(199), 2);
  assert.equal(gamificationLevel(200), 3);
  assert.equal(recordCompletion({ xp: 90 }, { id: 'boundary-task' }).level, 2);
  assert.equal(recordCompletion({ xp: 190 }, { id: 'boundary-task-2' }).level, 3);
});

test('streaks advance at the next calendar date without waiting 24 hours', () => {
  const beforeMidnight = updateStreak({}, new Date(2026, 7, 25, 23, 59));
  const justAfterMidnight = updateStreak(beforeMidnight, new Date(2026, 7, 26, 0, 1));
  assert.equal(justAfterMidnight.currentStreak, 2);
  assert.deepEqual(justAfterMidnight.completedDays, ['2026-08-25', '2026-08-26']);
});

test('every seven-day streak milestone awards 200 XP exactly once', () => {
  let gamification = {};
  for (let day = 1; day <= 7; day += 1) gamification = updateStreak(gamification, new Date(2026, 7, day, 12, 0));
  assert.equal(gamification.currentStreak, 7);
  assert.equal(gamification.xp, 200);
  assert.equal(gamification.streakMilestonesAwarded[7], true);
  gamification = updateStreak(gamification, new Date(2026, 7, 7, 18, 0));
  assert.equal(gamification.xp, 200);
  for (let day = 8; day <= 14; day += 1) gamification = updateStreak(gamification, new Date(2026, 7, day, 12, 0));
  assert.equal(gamification.currentStreak, 14);
  assert.equal(gamification.xp, 400);
  assert.equal(gamification.streakMilestonesAwarded[14], true);
});

test('planning state ranks deadline pressure and reports deterministic risk', () => {
  const now = new Date(2026, 7, 25, 17, 30);
  const tomorrow = { id: 'tomorrow', title: 'Math homework', status: 'open', priority: 1, dueDate: '2026-08-26', duration: 60 };
  const nextWeek = { id: 'next-week', title: 'Reading', status: 'open', priority: 1, dueDate: '2026-09-01', duration: 30 };
  const state = buildPlanningState({ currentTime: now, tasks: [tomorrow, nextWeek], profile: { preferredStart: '16:30', latestStudyTime: '21:00' } });
  assert.ok(urgencyScore(tomorrow, state) > urgencyScore(nextWeek, state));
  assert.equal(deadlineRisk(tomorrow, state), 'HIGH');
  assert.equal(deadlineRisk(nextWeek, state), 'LOW');
});

test('candidate windows eliminate school, calendar, and late-night conflicts', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 17, 30), tasks: [{ id: 'vex', type: 'fixed_event', status: 'open', dueDate: '2026-08-27', dueTime: '18:00', duration: 120 }], profile: { schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '21:00' } });
  const windows = generateCandidateWindows(state, { duration: 45, dueDate: '2026-08-28' }, { horizonDays: 3 });
  assert.ok(windows.length > 0);
  assert.ok(windows.every(window => window.start >= 16 * 60 && window.end <= 21 * 60));
  assert.equal(windows.some(window => window.dateKey === '2026-08-27' && window.start < 20 * 60 && window.end > 18 * 60), false);
});

test('workload planning distributes work within a daily capacity and stays stable', () => {
  const input = { currentTime: new Date(2026, 7, 25, 17, 30), tasks: [
    { id: 'math', title: 'Math homework', status: 'open', priority: 2, dueDate: '2026-08-26', duration: 60 },
    { id: 'essay', title: 'English essay', status: 'open', priority: 1, dueDate: '2026-08-31', duration: 90 },
    { id: 'vex', title: 'VEX', type: 'fixed_event', status: 'open', dueDate: '2026-08-27', dueTime: '18:00', duration: 120 }
  ], profile: { schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '21:00', dailyCapacityMinutes: 180 } };
  const first = planWorkload(input);
  const second = planWorkload(input);
  assert.deepEqual(first.scheduled.map(item => [item.item.id, item.dateKey, item.time]), second.scheduled.map(item => [item.item.id, item.dateKey, item.time]));
  assert.equal(first.scheduled.find(item => item.item.id === 'math').dateKey, '2026-08-25');
  assert.ok(first.scheduled.every(item => item.time >= '16:30' && item.time < '21:00'));
});

test('workload planning reserves each assigned slot and uses flexible time when needed', () => {
  const now = new Date(2026, 7, 25, 17, 30);
  const input = { currentTime: now, tasks: [
    { id: 'first', title: 'First task', status: 'open', dueDate: '2026-08-25', duration: 60 },
    { id: 'second', title: 'Second task', status: 'open', dueDate: '2026-08-25', duration: 60 }
  ], profile: { schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '21:00', dailyCapacityMinutes: 180 } };
  const plan = planWorkload(input, { horizonDays: 1 });
  assert.equal(plan.scheduled.length, 2);
  assert.notEqual(plan.scheduled[0].time, plan.scheduled[1].time);
  assert.equal(plan.scheduled[0].dateKey, '2026-08-25');
  assert.equal(plan.scheduled[1].dateKey, '2026-08-25');

  const flexible = buildPlanningState({ currentTime: now, tasks: [{ id: 'late', title: 'Late task', status: 'open', dueDate: '2026-08-27', duration: 60 }], profile: { schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '17:00', dailyCapacityMinutes: 180 } });
  const recommendation = recommendNextAction(flexible, { horizonDays: 0 });
  assert.equal(recommendation.task.id, 'late');
  assert.equal(recommendation.window, undefined);
});

test('future flexible work never rebuilds from stale morning timestamps', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 8, 14, 12, 0),
    tasks: [
      { id: 'test', title: 'Chemistry Work', type: 'task', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '08:00', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' },
      { id: 'study', title: 'Review Work', type: 'task', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '09:50', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' },
      { id: 'short', title: 'Short Work', type: 'task', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '11:50', duration: 10, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' }
    ],
    profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }
  });
  const plan = planWorkload(state, { horizonDays: 3 });
  const day = plan.scheduled.filter(action => action.dateKey === '2026-09-16').sort((left, right) => left.time.localeCompare(right.time));
  assert.equal(day.length, 3);
  assert.ok(day.every(action => action.time >= '16:30'));
  assert.deepEqual(day.map(action => action.time), ['16:30', '17:15', '18:00']);
});

test('an explicit before-cutoff commitment stays anchored while flexible work starts after cutoff', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 8, 14, 12, 0),
    tasks: [
      { id: 'fixed', title: 'Morning appointment', type: 'task', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '09:00', duration: 30, userScheduled: true, userPinned: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
      { id: 'planned', title: 'Planned homework', type: 'task', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '09:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' }
    ],
    profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }
  });
  const plan = planWorkload(state, { horizonDays: 3 });
  assert.equal(plan.scheduled.find(action => action.item.id === 'planned')?.time, '16:30');
  assert.equal(plan.scheduled.some(action => action.item.id === 'fixed'), false);
});

test('planning answers recommendation, capacity, and natural-language query intents', () => {
  const now = new Date(2026, 7, 25, 17, 30);
  const tasks = [{ id: 'math', title: 'Math homework', status: 'open', priority: 2, dueDate: '2026-08-26', duration: 45 }];
  const state = buildPlanningState({ currentTime: now, tasks, profile: { preferredStart: '16:30', latestStudyTime: '21:00' } });
  assert.equal(recommendNextAction(state, { availableMinutes: 45 }).task.id, 'math');
  assert.match(planningSummary(state, { horizonDays: 1 }).summary, /work remaining/);
  assert.equal(parseCapture('when should i do my math homework', now).intent, INTENTS.QUERY_WHEN_TO_DO);
  assert.equal(parseCapture('can i finish everything before friday', now).intent, INTENTS.QUERY_CAPACITY);
  assert.equal(parseCapture('do i have time to do my math hw tdy', now).dueDate, '2026-08-25');
  assert.equal(parseCapture("what's my day look like", now).intent, INTENTS.QUERY_DAY_SUMMARY);
});

test('subject recommendations retain unrelated blockers and honor a requested date', () => {
  const now = new Date(2026, 7, 25, 17, 30);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'long', title: 'Long task', status: 'open', scheduledDate: '2026-08-25', scheduledTime: '18:00', duration: 180 },
    { id: 'math', title: 'Math homework', status: 'open', dueDate: '2026-08-25', duration: 45 }
  ], profile: { schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5], preferredStart: '16:30', latestStudyTime: '22:00' } });
  const result = recommendNextAction(state, { taskIds: ['math'], dateKey: '2026-08-25', horizonDays: 0, now });
  assert.equal(result.task.id, 'math');
  assert.equal(result.window.dateKey, '2026-08-25');
  assert.ok(result.window.start >= 21 * 60 + 10);
});

test('work planning assigns every flexible task a time with breaks and saved order', () => {
  const now = new Date(2026, 7, 25, 12, 0);
  const tasks = [
    { id: 'first', title: 'First task', status: 'open', dueDate: '2026-08-25', duration: 45, priority: 1 },
    { id: 'urgent', title: 'Urgent task', status: 'open', dueDate: '2026-08-25', duration: 45, priority: 4 }
  ];
  const plan = planWorkload({ currentTime: now, tasks, profile: { preferredStart: '16:30', latestStudyTime: '18:30', preferredBreakMinutes: 10, schoolDays: [], taskOrder: { '2026-08-25': ['first', 'urgent'] } } }, { horizonDays: 0 });
  assert.deepEqual(plan.scheduled.map(item => item.item.id), ['first', 'urgent']);
  assert.equal(plan.scheduled.length, 2);
  const firstStart = Number(plan.scheduled[0].time.slice(0, 2)) * 60 + Number(plan.scheduled[0].time.slice(3));
  const urgentStart = Number(plan.scheduled[1].time.slice(0, 2)) * 60 + Number(plan.scheduled[1].time.slice(3));
  assert.ok(urgentStart >= firstStart + 55);
  assert.ok(plan.scheduled.every(item => Number(item.time.slice(0, 2)) * 60 + Number(item.time.slice(3)) + item.duration <= 18 * 60 + 30));
});

test('latest study time stays hard even when the preferred window is full', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 17, 30), tasks: [], profile: { preferredStart: '16:30', latestStudyTime: '18:00', schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [1, 2, 3, 4, 5] } });
  const windows = generateCandidateWindows(state, { duration: 90, dueDate: '2026-08-25' }, { horizonDays: 0 });
  assert.equal(windows.length, 0);
});

test('moments remain unscheduled unless explicitly included for planning', () => {
  const now = new Date(2026, 7, 25, 12, 0);
  const moment = { id: 'moment', title: 'Think about a project', status: 'open', duration: 30 };
  const state = buildPlanningState({ currentTime: now, tasks: [moment], profile: { preferredStart: '16:30', latestStudyTime: '21:00' } });
  assert.equal(planWorkload(state, { horizonDays: 7 }).scheduled.length, 0);
  assert.equal(recommendNextAction(state).task, null);
  assert.equal(planWorkload(state, { horizonDays: 7, taskIds: ['moment'], includeUndated: true }).scheduled.length, 1);
});

test('flexible work moves to earlier days and longer work gets first access', () => {
  const now = new Date(2026, 7, 25, 12, 0);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'long', title: 'Long project', status: 'open', dueDate: '2026-08-27', duration: 120, priority: 1 },
    { id: 'short', title: 'Short homework', status: 'open', dueDate: '2026-08-27', duration: 30, priority: 1 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [], dailyCapacityMinutes: 180 } });
  const plan = planWorkload(state, { horizonDays: 3 });
  assert.equal(plan.scheduled[0].item.id, 'long');
  assert.equal(plan.scheduled[0].dateKey, '2026-08-25');
  assert.equal(plan.scheduled[1].item.id, 'short');
  assert.ok(plan.scheduled[1].dateKey >= plan.scheduled[0].dateKey);
});

test('existing planned work stays on its intended future date', () => {
  const now = new Date(2026, 7, 29, 12, 0);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'biology', title: 'Biology Study', status: 'open', dueDate: '2026-09-01', scheduledDate: '2026-08-31', scheduledTime: '17:00', autoScheduled: true, flexibility: 'planned', duration: 45 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [], dailyCapacityMinutes: 180 } });
  const plan = planWorkload(state, { horizonDays: 7 });
  assert.equal(plan.scheduled.length, 1);
  assert.equal(plan.scheduled[0].dateKey, '2026-08-31');
  assert.equal(plan.scheduled[0].time, '17:00');
});

test('date-bound event reminders never get pulled into today by spare capacity', () => {
  const now = new Date(2026, 8, 14, 12, 0);
  const reminder = { id: 'parent-reminder', title: 'Inform parents about field trip', status: 'open', assignmentType: 'reminder', source: 'scheduler', dueDate: '2026-09-21', duration: 10 };
  const state = buildPlanningState({ currentTime: now, tasks: [reminder], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [], dailyCapacityMinutes: 180 } });
  const plan = planWorkload(state, { horizonDays: 14 });
  assert.equal(plan.scheduled.length, 0);
  assert.equal(plan.unscheduled.length, 0);
});

test('existing planned work keeps its exact time on an ordinary planning pass', () => {
  const now = new Date(2026, 7, 25, 12, 0);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'planned', title: 'Planned work', status: 'open', dueDate: '2026-08-27', scheduledDate: '2026-08-27', scheduledTime: '18:00', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 7 });
  assert.equal(plan.scheduled[0].dateKey, '2026-08-27');
  assert.equal(plan.scheduled[0].time, '18:00');
});

test('legacy automatic planned times before the cutoff are repaired on their own date', () => {
  const now = new Date(2026, 8, 14, 12, 0);
  const state = buildPlanningState({
    currentTime: now,
    tasks: [
      { id: 'legacy-a', title: 'Legacy A', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '08:00', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
      { id: 'legacy-b', title: 'Legacy B', status: 'open', dueDate: '2026-09-16', scheduledDate: '2026-09-16', scheduledTime: '09:00', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
    ],
    profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] }
  });
  const plan = planWorkload(state, { horizonDays: 3 });
  assert.deepEqual(plan.scheduled.filter(action => action.dateKey === '2026-09-16').map(action => [action.item.id, action.time]), [['legacy-a', '16:30'], ['legacy-b', '17:25']]);
});

test('right now recommendations do not pull stable future work forward', () => {
  const now = new Date(2026, 7, 29, 12, 0);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'biology', title: 'Biology Study', status: 'open', dueDate: '2026-09-01', scheduledDate: '2026-08-31', scheduledTime: '17:00', autoScheduled: true, flexibility: 'planned', duration: 45 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [], dailyCapacityMinutes: 180 } });
  const result = recommendNextAction(state, { preferImmediate: true });
  assert.equal(result.task, null);
  assert.match(result.reason, /caught up/i);
});

test('immediate recommendations choose the earliest runnable execution', () => {
  const now = new Date(2026, 7, 25, 17, 30);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'today-late', title: 'Today late', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '19:00', duration: 30 },
    { id: 'future-urgent', title: 'Future urgent', status: 'open', dueDate: '2026-08-30', scheduledDate: '2026-08-30', scheduledTime: '16:30', priority: 4, duration: 30 }
  ] });
  const result = recommendNextAction(state, { preferImmediate: true, horizonDays: 0 });
  assert.equal(result.task.id, 'today-late');
  assert.equal(result.window.dateKey, '2026-08-25');
});

test('study sessions and tests stay date-locked while homework can move earlier', () => {
  const now = new Date(2026, 7, 25, 12, 0);
  const state = buildPlanningState({ currentTime: now, tasks: [
    { id: 'study', title: 'Biology Study', type: 'study_session', status: 'open', dueDate: '2026-08-27', dueTime: '17:00', duration: 45, autoScheduled: true },
    { id: 'quiz', title: 'Chemistry Quiz', type: 'task', assignmentType: 'quiz', status: 'open', dueDate: '2026-08-27', scheduledDate: '2026-08-27', scheduledTime: '18:00', autoScheduled: true, duration: 30 },
    { id: 'homework', title: 'Math Homework', type: 'task', assignmentType: 'homework', status: 'open', dueDate: '2026-08-27', duration: 60 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [], dailyCapacityMinutes: 180 } });
  const plan = planWorkload(state, { horizonDays: 3 });
  assert.deepEqual(plan.scheduled.map(action => action.item.id), ['homework']);
  assert.equal(plan.scheduled[0].dateKey, '2026-08-25');
});

test('recommendations include already-planned personal tasks', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 17, 30), tasks: [{ id: 'planned', title: 'Planned task', status: 'open', dueDate: '2026-08-27', scheduledDate: '2026-08-25', scheduledTime: '18:00', duration: 45 }] });
  const result = recommendNextAction(state);
  assert.equal(result.task.id, 'planned');
  assert.equal(result.window.dateKey, '2026-08-25');
  assert.equal(result.window.start, 18 * 60);
});

test('already-planned work stays fixed around a new hard event', () => {
  const input = { currentTime: new Date(2026, 7, 25, 17, 0), tasks: [
    { id: 'homework', title: 'Homework', status: 'open', dueDate: '2026-08-27', scheduledDate: '2026-08-25', scheduledTime: '18:00', schedulingReason: 'Placed around your availability', duration: 60 },
    { id: 'event', title: 'Practice', status: 'open', type: 'fixed_event', dueDate: '2026-08-25', dueTime: '17:30', duration: 90 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', dailyCapacityMinutes: 180 } };
  const plan = planWorkload(input, { horizonDays: 0 });
  assert.equal(plan.scheduled.length, 0);
  assert.equal(plan.unscheduled.length, 0);
});

test('questions, mixed turns, and casual commitments stay out of task creation', () => {
  assert.equal(parseCapture('I have 45 minutes', fixedNow).intent, INTENTS.QUERY_FREE_TIME);
  assert.equal(parseCapture("what's going on", fixedNow).intent, INTENTS.QUERY_DAY_SUMMARY);
  assert.equal(parseCapture('my Bio test got moved to Friday', fixedNow).intent, INTENTS.RESCHEDULE_TASK);
  assert.deepEqual(splitCaptureInput("I'm overwhelmed. I have a Bio test Wednesday and math homework tomorrow. What should I work on first?"), [
    'I have a Bio test Wednesday', 'math homework tomorrow', 'What should I work on first?'
  ]);
  assert.equal(parseCapture('vex thurs 6', fixedNow).dueTime, '18:00');
  assert.equal(cleanTaskTitle('vex thurs 6'), 'vex');
});

test('deadline times constrain work without turning the deadline into a commitment', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 17, 0), tasks: [{ id: 'deadline', title: 'Math', status: 'open', dueDate: '2026-08-25', dueTime: '18:00', duration: 45 }], profile: { preferredStart: '16:00', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.equal(plan.scheduled.length, 1);
  assert.equal(plan.scheduled[0].dateKey, '2026-08-25');
  assert.ok(plan.scheduled[0].time < '18:00');
});

test('next-best-action includes study sessions and missed preparation is recovered in place', () => {
  const now = new Date(2026, 7, 25, 17, 0);
  const assessment = { id: 'bio-test', title: 'Biology Test', type: 'assessment', status: 'open', className: 'Biology', dueDate: '2026-08-27', priority: 3 };
  const missed = { id: 'bio-session-1', title: 'Biology Study', type: 'study_session', status: 'open', className: 'Biology', relatedAssessmentId: 'bio-test', dueDate: '2026-08-24', dueTime: '17:00', duration: 45 };
  const state = buildPlanningState({ currentTime: now, tasks: [assessment, missed], profile: { preferredStart: '16:00', latestStudyTime: '21:00', sessionsPerAssessment: 2, sessionLength: 45, schoolDays: [] } });
  assert.equal(getNextBestAction(state, { availableMinutes: 45 }).type, 'work');
  assert.equal(getNextBestAction(state, { availableMinutes: 45 }).workItemId, missed.id);
  const recovery = replanAssessmentSessions(assessment, [assessment, missed], { ...state.studentPreferences, now, sessionsPerAssessment: 2 });
  assert.equal(recovery.updates.length, 1);
  assert.equal(recovery.created.length, 1);
  assert.equal(recovery.updates[0].id, missed.id);
  assert.equal(new Set(recovery.sessions.map(session => session.id)).size, recovery.sessions.length);
});

test('assessment replanning is idempotent across repeated renders', () => {
  const now = new Date(2026, 8, 12, 12, 0);
  const assessment = { id: 'apush-test', idempotencyKey: 'capture:assessment:apush', title: 'US History AP Test', type: 'assessment', status: 'open', className: 'US History AP', dueDate: '2026-10-03', priority: 2 };
  const profile = { now, preferredStart: '16:30', latestStudyTime: '21:00', sessionsPerAssessment: 3, sessionLength: 45, schoolDays: [] };
  const first = replanAssessmentSessions(assessment, [assessment], profile);
  const second = replanAssessmentSessions(assessment, [assessment, ...first.created], profile);
  assert.equal(first.created.length, 3);
  assert.equal(second.created.length, 0);
  assert.equal(second.updates.length, 0);
});

test('observational assessment replanning does not manufacture study sessions', () => {
  const assessment = { id: 'chem-test', title: 'Chemistry Test', type: 'assessment', status: 'open', className: 'Chemistry', dueDate: '2026-10-03', priority: 2 };
  const result = replanAssessmentSessions(assessment, [assessment], { now: new Date(2026, 8, 12, 12, 0), preferredStart: '16:30', latestStudyTime: '21:00', sessionsPerAssessment: 3, sessionLength: 45, schoolDays: [] }, { createMissing: false });
  assert.equal(result.created.length, 0);
  assert.equal(result.updates.length, 0);
});

test('assessment replanning matches sessions by idempotency identity after sync', () => {
  const now = new Date(2026, 8, 12, 12, 0);
  const assessment = { id: 'remote-assessment-id', idempotencyKey: 'capture:assessment:apush', title: 'US History AP Test', type: 'assessment', status: 'open', className: 'US History AP', dueDate: '2026-10-03', priority: 2 };
  const profile = { now, preferredStart: '16:30', latestStudyTime: '21:00', sessionsPerAssessment: 3, sessionLength: 45, schoolDays: [] };
  const planned = replanAssessmentSessions(assessment, [assessment], profile).created;
  const synced = planned.map(session => ({ ...session, relatedAssessmentId: null }));
  const repeated = replanAssessmentSessions(assessment, [assessment, ...synced], profile);
  assert.equal(repeated.created.length, 0);
  assert.equal(repeated.updates.length, 0);
});

test('execution sorting is chronological and deterministic for equal starts', () => {
  const tasks = [
    { id: 'biology', title: 'Biology', scheduledDate: '2026-08-25', scheduledTime: '17:30' },
    { id: 'math', title: 'Math', scheduledDate: '2026-08-25', scheduledTime: '16:30' },
    { id: 'history', title: 'History', scheduledDate: '2026-08-25', scheduledTime: '17:30' }
  ];
  assert.deepEqual([...tasks].sort(taskSort).map(task => task.id), ['math', 'biology', 'history']);
  assert.deepEqual([...tasks].sort(taskSort).map(task => task.id), [...tasks].sort(taskSort).map(task => task.id));
});

test('duration is a contiguous-window requirement', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 12, 0),
    tasks: [],
    profile: { preferredStart: '16:30', latestStudyTime: '18:00', schoolDays: [] }
  });
  assert.ok(generateCandidateWindows(state, { duration: 90, dueDate: '2026-08-25' }, { horizonDays: 0 }).length > 0);
  assert.equal(generateCandidateWindows(state, { duration: 90, dueDate: '2026-08-25' }, { horizonDays: 0 }).some(window => window.duration >= 90), true);
  assert.equal(generateCandidateWindows(state, { duration: 90, dueDate: '2026-08-25' }, { horizonDays: 0, allowFlexibleFallback: false }).length > 0, true);
  const shortWindow = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [], profile: { preferredStart: '16:30', latestStudyTime: '17:00', schoolStart: '08:00', schoolEnd: '16:00', schoolDays: [2] } });
  assert.equal(generateCandidateWindows(shortWindow, { duration: 90, dueDate: '2026-08-25' }, { horizonDays: 0 }).length, 0);
});

test('comparable flexible work can reorder actual stored times by duration', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'short', title: 'Math', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' },
    { id: 'long', title: 'Biology', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '17:00', duration: 120, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.deepEqual(plan.scheduled.map(action => action.item.id), ['long', 'short']);
  assert.deepEqual(plan.scheduled.map(action => action.time), ['16:30', '18:30']);
  assert.ok(plan.scheduled.every(action => action.reason === SCHEDULE_CHANGE_REASONS.DURATION_REORDERING));
  const rerun = planWorkload(buildPlanningState({ ...state, tasks: plan.scheduled.map(action => action.item) }), { horizonDays: 0 });
  assert.deepEqual(rerun.scheduled.map(action => [action.item.id, action.time]), [['long', '16:30'], ['short', '18:30']]);
});

test('schedule math uses the edited remaining duration for downstream work', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'math', title: 'Math', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:30', duration: 60, remainingDuration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' },
    { id: 'reading', title: 'Reading', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '17:00', duration: 30, remainingDuration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' }
  ] });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.deepEqual(plan.scheduled.map(action => [action.item.id, action.time, action.duration]), [['math', '16:30', 60], ['reading', '17:30', 30]]);
});

test('urgent small work still outranks a large non-urgent task', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'urgent', title: 'Due today', status: 'open', dueDate: '2026-08-25', duration: 20, priority: 4 },
    { id: 'large', title: 'Project', status: 'open', dueDate: '2026-08-30', duration: 120, priority: 1 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  assert.equal(planWorkload(state, { horizonDays: 5 }).scheduled[0].item.id, 'urgent');
});

test('future user and Silico study plans are date-stable', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'user', title: 'User plan', status: 'open', dueDate: '2026-08-27', scheduledDate: '2026-08-27', scheduledTime: '17:00', duration: 30, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED },
    { id: 'study-2', title: 'Biology Study 2', type: 'study_session', status: 'open', dueDate: '2026-08-27', dueTime: '18:00', scheduledDate: '2026-08-27', scheduledTime: '18:00', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
    { id: 'study-3', title: 'Biology Study 3', type: 'study_session', status: 'open', dueDate: '2026-08-29', dueTime: '18:00', scheduledDate: '2026-08-29', scheduledTime: '18:00', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const first = planWorkload(state, { horizonDays: 7 });
  const second = planWorkload(state, { horizonDays: 7 });
  assert.deepEqual(first.scheduled.map(action => [action.item.id, action.dateKey, action.time]), second.scheduled.map(action => [action.item.id, action.dateKey, action.time]));
  assert.equal(state.studySessions.find(session => session.id === 'study-2').scheduledDate, '2026-08-27');
  assert.equal(state.studySessions.find(session => session.id === 'study-3').scheduledDate, '2026-08-29');
});

test('pinned and explicit user times cannot be duration-swapped', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'pinned-short', title: 'Pinned short', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:30', duration: 20, userPinned: true, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
    { id: 'flex-long', title: 'Flexible long', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '17:00', duration: 120, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'flexible' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.equal(plan.scheduled.find(action => action.item.id === 'flex-long').time, '17:00');
  assert.equal(plan.scheduled.some(action => action.item.id === 'pinned-short'), false);
});

test('fixed assignment timings stay anchored while planned work moves around them', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'fixed-assignment', title: 'Fixed assignment', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:30', duration: 60, userPinned: true, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
    { id: 'planned-work', title: 'Planned work', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:45', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.equal(plan.scheduled.some(action => action.item.id === 'fixed-assignment'), false);
  assert.equal(plan.scheduled.find(action => action.item.id === 'planned-work')?.time, '17:40');
});

test('multiple manually fixed tasks on one day remain independent anchors', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'fixed-a', title: 'Fixed A', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '16:30', duration: 45, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
    { id: 'fixed-b', title: 'Fixed B', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '17:30', duration: 45, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
    { id: 'planned', title: 'Planned work', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '18:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 1 });
  assert.equal(plan.scheduled.some(action => action.item.id === 'fixed-a'), false);
  assert.equal(plan.scheduled.some(action => action.item.id === 'fixed-b'), false);
  assert.equal(plan.scheduled.find(action => action.item.id === 'planned')?.time, '18:30');
});

test('synced user-fixed homework does not lose its anchor on a later edit', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'first-edit', title: 'First edit', type: 'task', assignmentType: 'homework', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '18:00', duration: 45, userScheduled: true, executionPinned: true, explicitExecution: false, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' },
    { id: 'second-edit', title: 'Second edit', type: 'task', assignmentType: 'homework', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '19:00', duration: 30, userScheduled: true, executionPinned: true, explicitExecution: false, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 1 });
  assert.equal(isRigidExecution(state.tasks[0]), true);
  assert.equal(isRigidExecution(state.tasks[1]), true);
  assert.equal(plan.scheduled.some(action => action.item.id === 'first-edit'), false);
  assert.equal(plan.scheduled.some(action => action.item.id === 'second-edit'), false);
});

test('future planned work is never preserved past the hard stop', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'late-a', title: 'Late A', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '20:30', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
    { id: 'late-b', title: 'Late B', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '21:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 1 });
  assert.equal(plan.unscheduled.length, 0);
  assert.ok(plan.scheduled.every(action => Number(action.time.slice(0, 2)) * 60 + Number(action.time.slice(3)) + action.duration <= 21 * 60));
});

test('automatic study sessions past the hard stop are repaired in place', () => {
  const assessment = { id: 'hard-stop-assessment', idempotencyKey: 'hard-stop-assessment', title: 'History Test', type: 'assessment', status: 'open', className: 'History', dueDate: '2026-08-28', priority: 2 };
  const session = { id: 'late-study-session', title: 'History Study', type: 'study_session', assignmentType: 'study', status: 'open', relatedAssessmentId: assessment.id, dueDate: '2026-08-27', dueTime: '21:30', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' };
  const result = replanAssessmentSessions(assessment, [assessment, session], { now: new Date(2026, 7, 25, 12, 0), sessionsPerAssessment: 1, sessionLength: 45, latestStudyTime: '21:00', preferredStart: '16:30', schoolDays: [] });
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].dueDate, '2026-08-27');
  assert.ok(Number(result.updates[0].dueTime.slice(0, 2)) * 60 + Number(result.updates[0].dueTime.slice(3)) + 45 <= 21 * 60);
});

test('same-day duplicate timestamps are repaired into sequential timings', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'first', title: 'First task', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '17:00', duration: 45, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED },
    { id: 'second', title: 'Second task', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '17:00', duration: 30, userScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 2 });
  const times = plan.scheduled.sort((left, right) => left.time.localeCompare(right.time)).map(action => action.time);
  assert.deepEqual(times, ['17:00', '17:55']);
  assert.equal(plan.scheduled.find(action => action.item.id === 'second').reason, SCHEDULE_CHANGE_REASONS.TIME_CONFLICT);
  assert.match(plan.scheduled.find(action => action.item.id === 'second').message, /conflicted/i);
});

test('imported calendar timings take precedence over overlapping planned work', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'imported', title: 'School event', type: 'fixed_event', source: 'calendar', status: 'open', dueDate: '2026-08-26', dueTime: '17:00', scheduledDate: '2026-08-26', scheduledTime: '17:00', duration: 60 },
    { id: 'planned', title: 'Math homework', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '17:30', duration: 45, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 2 });
  const moved = plan.scheduled.find(action => action.item.id === 'planned');
  assert.equal(moved.reason, SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT);
  assert.equal(moved.time, '18:00');
  assert.ok(moved.message.includes('imported calendar time'));
});

test('fixed event intervals push a later task past the event end', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 12, 0),
    profile: { schoolDays: [], preferredStart: '16:00', latestStudyTime: '22:00' },
    tasks: [
      { id: 'event-interval', title: 'Event', type: 'fixed_event', source: 'calendar', status: 'open', dueDate: '2026-08-25', dueTime: '16:00', scheduledDate: '2026-08-25', scheduledTime: '16:00', duration: 45 },
      { id: 'task-interval', title: 'Task after event', type: 'task', source: 'capture', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED }
    ]
  });
  const plan = planWorkload(state, { horizonDays: 2 });
  const repair = plan.scheduled.find(action => action.item.id === 'task-interval');
  assert.ok([SCHEDULE_CHANGE_REASONS.TIME_CONFLICT, SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT].includes(repair?.reason));
  assert.equal(repair?.dateKey, '2026-08-25');
  assert.equal(repair?.time, '16:45');
});

test('a longer scheduled task pushes an overlapping later task by its real duration', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 12, 0),
    profile: { schoolDays: [], preferredStart: '16:00', latestStudyTime: '22:00', preferredBreakMinutes: 10 },
    tasks: [
      { id: 'longer-task', title: 'Longer task', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:57', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
      { id: 'later-task', title: 'Later task', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '17:37', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
    ]
  });
  const plan = planWorkload(state, { horizonDays: 2 });
  const repair = plan.scheduled.find(action => action.item.id === 'later-task');
  assert.equal(repair?.reason, SCHEDULE_CHANGE_REASONS.TIME_CONFLICT);
  assert.equal(repair?.time, '18:07');
});

test('planned flexible tasks keep a break after a short task even without overlap', () => {
  const state = buildPlanningState({
    currentTime: new Date(2026, 7, 25, 12, 0),
    profile: { schoolDays: [], preferredStart: '16:00', latestStudyTime: '22:00', preferredBreakMinutes: 10 },
    tasks: [
      { id: 'short-study', title: 'Short study', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:10', duration: 10, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
      { id: 'reminder', title: 'Reminder', type: 'task', assignmentType: 'reminder', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '16:20', duration: 5, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
    ]
  });
  const plan = planWorkload(state, { horizonDays: 0 });
  assert.equal(plan.scheduled.find(action => action.item.id === 'reminder')?.time, '16:30');
});

test('explicit study sessions retain their requested dates during assessment replanning', () => {
  const assessment = { id: 'assessment-locked', type: 'assessment', status: 'open', title: 'Chemistry test', dueDate: '2026-08-28', dueTime: null, duration: 60 };
  const session = { id: 'session-locked', type: 'study_session', status: 'open', title: 'Chemistry Study', relatedAssessmentId: assessment.id, dueDate: '2026-09-01', dueTime: '17:00', duration: 45, studyDateLocked: true, autoScheduled: true };
  const result = replanAssessmentSessions(assessment, [assessment, session], { now: new Date(2026, 7, 25, 12), sessionsPerAssessment: 1, sessionLength: 45, schoolDays: [] });
  assert.equal(result.updates.length, 0);
  assert.equal(result.sessions.find(item => item.id === session.id)?.dueDate, '2026-09-01');
});

test('legacy imported calendar due times remain hard scheduling anchors', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'legacy-import', title: 'Legacy calendar event', source: 'calendar', status: 'open', dueDate: '2026-08-26', dueTime: '17:00', duration: 60 },
    { id: 'planned', title: 'Reading', type: 'task', status: 'open', dueDate: '2026-08-26', scheduledDate: '2026-08-26', scheduledTime: '17:30', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 2 });
  const moved = plan.scheduled.find(action => action.item.id === 'planned');
  assert.equal(moved.reason, SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT);
  assert.equal(moved.time, '18:00');
});

test('legacy timed study tasks using due time are also repaired', () => {
  const state = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'study-a', title: 'Calculus Study', type: 'task', assignmentType: 'study', status: 'open', dueDate: '2026-08-26', dueTime: '16:30', duration: 45 },
    { id: 'study-b', title: 'Chemistry Study', type: 'task', assignmentType: 'study', status: 'open', dueDate: '2026-08-26', dueTime: '16:30', duration: 30 },
    { id: 'study-c', title: 'Spanish Study', type: 'task', assignmentType: 'study', status: 'open', dueDate: '2026-08-26', dueTime: '16:30', duration: 45 }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const plan = planWorkload(state, { horizonDays: 2 });
  const repaired = plan.scheduled.filter(action => action.reason === SCHEDULE_CHANGE_REASONS.TIME_CONFLICT);
  assert.equal(repaired.length, 2);
  assert.deepEqual(repaired.map(action => action.time).sort(), ['17:25', '18:05']);
});

test('automatic changes expose overdue and hard-stop reasons', () => {
  const overdue = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'old', title: 'Old homework', type: 'task', status: 'open', dueDate: '2026-08-24', scheduledDate: '2026-08-24', scheduledTime: '18:00', duration: 30, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '21:00', schoolDays: [] } });
  const overduePlan = planWorkload(overdue, { horizonDays: 2 });
  assert.equal(overduePlan.scheduled[0].reason, SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY);
  assert.match(overduePlan.scheduled[0].message, /incomplete/i);

  const hardStop = buildPlanningState({ currentTime: new Date(2026, 7, 25, 12, 0), tasks: [
    { id: 'first', title: 'First', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '19:00', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' },
    { id: 'overflow', title: 'Overflow', type: 'task', status: 'open', dueDate: '2026-08-25', scheduledDate: '2026-08-25', scheduledTime: '20:00', duration: 60, autoScheduled: true, scheduleOrigin: SCHEDULE_ORIGINS.SILICO_SCHEDULED, flexibility: 'planned' }
  ], profile: { preferredStart: '16:30', latestStudyTime: '20:30', schoolDays: [] } });
  const hardStopPlan = planWorkload(hardStop, { horizonDays: 2 });
  assert.equal(hardStopPlan.scheduled.find(action => action.item.id === 'overflow').reason, SCHEDULE_CHANGE_REASONS.HARD_STOP_CONFLICT);
  assert.match(hardStopPlan.scheduled.find(action => action.item.id === 'overflow').message, /hard stop/i);
});

test('schedule origin distinguishes user, Silico, and unscheduled work', () => {
  assert.equal(scheduleOriginOf({ userScheduled: true, scheduledDate: '2026-08-25' }), SCHEDULE_ORIGINS.USER_SCHEDULED);
  assert.equal(scheduleOriginOf({ autoScheduled: true, scheduledDate: '2026-08-25' }), SCHEDULE_ORIGINS.SILICO_SCHEDULED);
  assert.equal(scheduleOriginOf({ title: 'Inbox item' }), SCHEDULE_ORIGINS.UNSCHEDULED);
});
