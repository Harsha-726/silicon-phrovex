import test from 'node:test';
import assert from 'node:assert/strict';
import { hashCode, memberDisplayName, normalizeSlots, normalizeSubprojectName, normalizeTask, teamTaskCompletionState } from '../api/team-projects.js';

test('team join codes are normalized before hashing and raw codes are not stored', () => {
  assert.equal(hashCode(' ab12-CD34 '), hashCode('AB12-cd34'));
  assert.notEqual(hashCode('AB12CD34'), 'AB12CD34');
  assert.match(hashCode('AB12CD34'), /^[0-9a-f]{64}$/);
});

test('team availability accepts bounded weekly windows and rejects invalid windows', () => {
  assert.deepEqual(normalizeSlots([{ weekday: 1, start: '9:05', end: '10:30' }]), [{ weekday: 1, start: '09:05', end: '10:30' }]);
  assert.throws(() => normalizeSlots([{ weekday: 7, start: '09:00', end: '10:00' }]), /day is invalid/);
  assert.throws(() => normalizeSlots([{ weekday: 1, start: '10:00', end: '09:00' }]), /window is invalid/);
});

test('team tasks require a current or future due date', () => {
  assert.throws(() => normalizeTask({ title: 'No deadline' }), /due date/);
  assert.throws(() => normalizeTask({ title: 'Old deadline', due_date: '2000-01-01' }), /past/);
  assert.equal(normalizeTask({ title: 'Future task', due_date: '2099-01-01' }).due_date, '2099-01-01');
});

test('team tasks preserve valid subproject and assignee targets', () => {
  assert.deepEqual(normalizeTask({ title: 'Build chassis', due_date: '2099-01-01', subproject_id: '123e4567-e89b-42d3-a456-426614174000', assignee_id: 'user_member_1' }), {
    title: 'Build chassis', description: '', due_date: '2099-01-01', due_time: null, duration_minutes: null, priority: 1,
    subproject_id: '123e4567-e89b-42d3-a456-426614174000', assignee_id: 'user_member_1'
  });
  assert.throws(() => normalizeTask({ title: 'Bad subproject', due_date: '2099-01-01', subproject_id: 'not-a-uuid' }), /subproject is invalid/);
  assert.equal(normalizeSubprojectName('  Build   team  '), 'Build team');
});

test('team members prefer an email identity and fall back safely', () => {
  assert.equal(memberDisplayName({ userId: 'user_123', claims: { email: 'person@example.com', name: 'Person' } }), 'person@example.com');
  assert.equal(memberDisplayName({ userId: 'user_123', claims: { name: 'Person' } }), 'Person');
  assert.equal(memberDisplayName({ userId: 'user_123', claims: {} }), 'user_123');
});

test('assigned team tasks complete when the assignee completes them', () => {
  const task = { id: 'task-1', assignee_id: 'member-2' };
  assert.deepEqual(teamTaskCompletionState(task, [{ team_task_id: 'task-1', user_id: 'member-2' }], 3), { completedByAssignee: true, completed: true, completionCount: 1 });
  assert.equal(teamTaskCompletionState(task, [{ team_task_id: 'task-1', user_id: 'member-1' }], 3).completed, false);
  assert.equal(teamTaskCompletionState({ id: 'task-2', assignee_id: null }, [{ team_task_id: 'task-2', user_id: 'member-1' }, { team_task_id: 'task-2', user_id: 'member-2' }], 2).completed, true);
});
