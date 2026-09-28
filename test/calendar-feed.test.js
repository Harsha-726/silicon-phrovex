import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarFeedUrl } from '../api/calendar-feed.js';

test('calendar feed URLs accept webcal and normalize to HTTPS', () => {
  assert.equal(normalizeCalendarFeedUrl('webcal://school.example/calendar.ics'), 'https://school.example/calendar.ics');
  assert.equal(normalizeCalendarFeedUrl('https://school.example/calendar.ics'), 'https://school.example/calendar.ics');
});

test('calendar feed URLs reject local and unsupported destinations', () => {
  assert.throws(() => normalizeCalendarFeedUrl('ftp://school.example/calendar.ics'), /public webcal|https/);
  assert.throws(() => normalizeCalendarFeedUrl('http://localhost/calendar.ics'), /public webcal|https/);
});
