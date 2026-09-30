import test from 'node:test';
import assert from 'node:assert/strict';
import { taskNotificationTiming } from '../src/notifications.js';

const now = new Date(2026, 8, 30, 12, 0, 0);

test('timed tasks enter the five-minute reminder window', () => {
  const task = { id: 'task-1', title: 'Chemistry', status: 'open', dueDate: '2026-09-30', dueTime: '12:05' };
  const timing = taskNotificationTiming(task, now);
  assert.equal(timing.kind, 'task-due-soon');
  assert.equal(timing.minutesUntil, 5);
});

test('tasks outside the reminder window do not notify early', () => {
  const task = { id: 'task-2', title: 'History', status: 'open', dueDate: '2026-09-30', dueTime: '12:06' };
  assert.equal(taskNotificationTiming(task, now), null);
});

test('completed tasks never create due notifications', () => {
  const task = { id: 'task-3', title: 'Finished', status: 'completed', dueDate: '2026-09-30', dueTime: '12:03' };
  assert.equal(taskNotificationTiming(task, now), null);
});

test('planned execution time is used when it differs from the deadline', () => {
  const task = { id: 'task-4', title: 'Study', status: 'open', dueDate: '2026-10-02', dueTime: '23:59', scheduledDate: '2026-09-30', scheduledTime: '12:05' };
  const timing = taskNotificationTiming(task, now);
  assert.equal(timing.kind, 'task-due-soon');
  assert.equal(timing.date, '2026-09-30');
});

