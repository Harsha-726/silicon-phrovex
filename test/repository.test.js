import assert from 'node:assert/strict';
import test from 'node:test';
import { fromRow, toRow } from '../src/repository.js';
import { createTaskRepository } from '../src/repository.js';

test('manual imported class assignments survive legacy task payloads', () => {
  const row = toRow({
    title: 'Imported event',
    source: 'calendar',
    type: 'fixed_event',
    assignmentType: 'event',
    className: 'Physics I AP',
    calendarClassManuallySet: true,
    schedulingReason: null
  }, false);

  assert.match(row.scheduling_reason, /silico:calendar-class-manual/);
  const restored = fromRow({ ...row, calendar_class_manually_set: false });
  assert.equal(restored.className, 'Physics I AP');
  assert.equal(restored.calendarClassManuallySet, true);
  assert.equal(restored.schedulingReason, null);
});

test('numeric priority is carried in a canonical marker for legacy imported rows', () => {
  const row = toRow({
    title: 'Imported event',
    priority: 4,
    source: 'calendar',
    type: 'fixed_event',
    assignmentType: 'event',
    schedulingReason: 'Calendar event',
    calendarClassManuallySet: true
  }, false);

  assert.match(row.scheduling_reason, /^silico:priority:4\|/);
  const restored = fromRow({
    ...row,
    priority: 'medium',
    scheduling_reason: 'Calendar event|silico:calendar-class-manual|silico:assignment:event|silico:priority:4'
  });
  assert.equal(restored.priority, 4);
  assert.equal(restored.schedulingReason, 'Calendar event');
});

test('ambiguous task POSTs reconcile with the server by identity', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const remote = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Physics homework',
    status: 'open',
    priority: 1,
    idempotency_key: 'capture:task|physics|2026-09-30',
    due_date: '2026-09-30',
    task_type: 'task',
    source: 'capture'
  };
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    assert.match(String(url), /\/api\/tasks\?idempotency_key=/);
    return new Response(JSON.stringify({ tasks: [remote] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const task = await createTaskRepository().create({ title: remote.title, idempotencyKey: remote.idempotency_key, dueDate: remote.due_date, type: 'task', source: 'capture' });
    assert.equal(task.id, remote.id);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test('local imported recovery patches the canonical remote row instead of returning the stale idempotent row', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {};
  const remote = {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Original event',
    status: 'open',
    priority: 1,
    idempotency_key: 'ical:schoology:provider-event-1',
    due_date: '2026-10-02',
    task_type: 'fixed_event',
    source: 'calendar',
    class_name: 'AP US History'
  };
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return new Response(JSON.stringify({ tasks: [remote] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ task: { ...remote, ...body.task, updated_at: '2026-10-01T20:00:00.000Z' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const saved = await createTaskRepository().recover({
      id: 'task_local_import',
      title: 'Edited event',
      source: 'calendar',
      type: 'fixed_event',
      assignmentType: 'event',
      className: 'Physics I AP',
      calendarClassManuallySet: true,
      idempotencyKey: 'ical:provider-event-1'
    });
    assert.equal(saved.id, remote.id);
    assert.equal(saved.className, 'Physics I AP');
    assert.match(requests[0].url, /idempotency_key=ical%3Aprovider-event-1/);
    assert.match(requests[1].url, new RegExp(`/api/tasks\\?id=${remote.id}`));
    assert.equal(JSON.parse(requests[1].options.body).task.class_name, 'Physics I AP');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});
