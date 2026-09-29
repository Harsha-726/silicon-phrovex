import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPersistenceCoordinator } from '../src/task-persistence.js';

test('coalesces a background recovery with the original task create', async () => {
  let resolveCreate;
  let calls = 0;
  const create = () => {
    calls += 1;
    return new Promise(resolve => { resolveCreate = resolve; });
  };
  const coordinator = createTaskPersistenceCoordinator(create);
  const task = { id: 'task_local_1', title: 'Physics' };

  const first = coordinator.persist(task);
  const second = coordinator.persist(task);
  assert.equal(coordinator.hasPending(task.id), true);
  assert.equal(coordinator.size(), 1);
  assert.equal(calls, 0, 'creation is deferred to the promise turn');

  await Promise.resolve();
  assert.equal(calls, 1);
  resolveCreate({ id: 'remote-1', title: 'Physics' });
  assert.deepEqual(await first, { id: 'remote-1', title: 'Physics' });
  assert.deepEqual(await second, { id: 'remote-1', title: 'Physics' });
  assert.equal(coordinator.hasPending(task.id), false);
  assert.equal(coordinator.size(), 0);
});

test('clears the pending guard after a failed create so recovery can retry', async () => {
  let calls = 0;
  const coordinator = createTaskPersistenceCoordinator(async () => {
    calls += 1;
    throw new Error('offline');
  });
  const task = { id: 'task_local_2', title: 'Chemistry' };

  await assert.rejects(coordinator.persist(task), /offline/);
  assert.equal(coordinator.hasPending(task.id), false);
  await assert.rejects(coordinator.persist(task), /offline/);
  assert.equal(calls, 2);
});
