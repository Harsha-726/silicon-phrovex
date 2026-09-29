import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyPriorityCompatibilityPayload, legacySchemaPriorityPayload, taskStatusMatches } from '../api/tasks.js';

const importedTask = {
  title: 'Imported event',
  priority: 1,
  assignment_type: 'event',
  class_name: 'Physics I AP',
  scheduling_reason: 'silico:calendar-class-manual|silico:assignment:event'
};

test('legacy task update fallbacks preserve manual imported class marker', () => {
  assert.match(legacyPriorityCompatibilityPayload(importedTask).scheduling_reason, /silico:calendar-class-manual/);
  assert.match(legacySchemaPriorityPayload(importedTask).scheduling_reason, /silico:calendar-class-manual/);
});

test('legacy todo rows count as open for idempotent task retries', () => {
  assert.equal(taskStatusMatches({ status: 'todo' }, 'open'), true);
  assert.equal(taskStatusMatches({ status: 'open' }, 'open'), true);
  assert.equal(taskStatusMatches({ status: 'completed' }, 'open'), false);
  assert.equal(taskStatusMatches({ status: 'completed' }, 'completed'), true);
});
