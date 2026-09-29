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
