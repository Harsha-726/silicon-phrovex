import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedback } from '../api/feedback.js';

test('feedback accepts bug reports and product feedback with bounded text', () => {
  assert.deepEqual(normalizeFeedback({ category: 'BUG', message: 'The team view is slow.', page: 'teams' }), { category: 'bug', message: 'The team view is slow.', page: 'teams' });
  assert.equal(normalizeFeedback({ message: 'Please add filters.' }).category, 'feedback');
  assert.throws(() => normalizeFeedback({ category: 'request', message: 'Nope' }), /type is invalid/);
  assert.throws(() => normalizeFeedback({ category: 'bug', message: '' }), /between 1 and 5000/);
  assert.throws(() => normalizeFeedback({ category: 'bug', message: 'x'.repeat(5001) }), /between 1 and 5000/);
});
