import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyPriorityCompatibilityPayload, legacySchemaPriorityPayload } from '../api/tasks.js';

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
