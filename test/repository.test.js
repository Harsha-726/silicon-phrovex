import assert from 'node:assert/strict';
import test from 'node:test';
import { fromRow, toRow } from '../src/repository.js';

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
