import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeGamificationSettings, mergeOnboardingComplete, normalizeProfileSettingsForClient } from '../api/profile.js';

test('profile gamification merges append-only account history across devices', () => {
  const merged = mergeGamificationSettings(
    {
      xp: 240,
      completedDays: ['2026-09-28', '2026-09-29'],
      currentStreak: 2,
      longestStreak: 4,
      awardedTaskIds: { taskA: true },
      streakMilestonesAwarded: { 7: true }
    },
    {
      xp: 100,
      completedDays: ['2026-09-27'],
      currentStreak: 1,
      longestStreak: 3,
      awardedTaskIds: { taskA: false, taskB: true },
      streakMilestonesAwarded: { 14: true }
    }
  );

  assert.equal(merged.xp, 240);
  assert.deepEqual(merged.completedDays, ['2026-09-27', '2026-09-28', '2026-09-29']);
  assert.equal(merged.longestStreak, 4);
  assert.deepEqual(merged.awardedTaskIds, { taskA: true, taskB: true });
  assert.deepEqual(merged.streakMilestonesAwarded, { 7: true, 14: true });
});

test('onboarding completion cannot be reset by a stale device', () => {
  assert.equal(mergeOnboardingComplete(true, false), true);
  assert.equal(mergeOnboardingComplete(false, true), true);
  assert.equal(mergeOnboardingComplete(false, false), false);
});

test('profile gamification merge preserves existing history when a device has no gamification payload', () => {
  const existing = { xp: 500, completedDays: ['2026-09-29'], awardedTaskIds: { taskA: true } };
  assert.deepEqual(mergeGamificationSettings(existing, {}), existing);
});

test('profile settings normalize legacy feeds and class allocations into the current shape', () => {
  const settings = normalizeProfileSettingsForClient({
    integrations: {
      schoologyFeed: { icalUrl: 'webcal://schoology.example/feed' },
      todoistCalendar: { url: 'https://todoist.example/feed' }
    },
    studyAllocations: { Chemistry: { sessions_per_week: 4, session_length_minutes: 60 } }
  });

  assert.deepEqual(settings.calendarFeeds.map(feed => ({ id: feed.id, url: feed.url })), [
    { id: 'schoology', url: 'webcal://schoology.example/feed' },
    { id: 'todoist', url: 'https://todoist.example/feed' }
  ]);
  assert.deepEqual(settings.classes, ['Chemistry']);
  assert.deepEqual(settings.classPreferences.Chemistry, { sessions_per_week: 4, session_length_minutes: 60, sessionsPerWeek: 4, sessionLength: 60 });
  assert.equal('integrations' in settings, false);
});
