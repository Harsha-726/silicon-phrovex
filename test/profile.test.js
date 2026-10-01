import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCalendarFeedSettings, mergeGamificationSettings, mergeLearningProfilesIntoSettings, mergeOnboardingComplete, mergeProjectSettings, normalizeProfileSettingsForClient } from '../api/profile.js';

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

test('profile settings recover feeds nested under historical calendar containers', () => {
  const settings = normalizeProfileSettingsForClient({
    integrations: { calendar: { sources: { schoologyUrl: 'webcal://schoology.example/legacy', todoist: { feedUrl: 'https://todoist.example/legacy' } } } }
  });
  assert.equal(settings.calendarFeeds.find(feed => feed.id === 'schoology').url, 'webcal://schoology.example/legacy');
  assert.equal(settings.calendarFeeds.find(feed => feed.id === 'todoist').url, 'https://todoist.example/legacy');
});

test('profile settings recover feeds stored in provider arrays', () => {
  const settings = normalizeProfileSettingsForClient({
    integrations: { providers: [
      { provider: 'schoology', settings: { webcal_url: 'webcal://schoology.example/array' } },
      { provider: 'todoist', settings: { feed_url: 'https://todoist.example/array' } }
    ] }
  });
  assert.equal(settings.calendarFeeds.find(feed => feed.id === 'schoology').url, 'webcal://schoology.example/array');
  assert.equal(settings.calendarFeeds.find(feed => feed.id === 'todoist').url, 'https://todoist.example/array');
});

test('legacy learning profiles hydrate allocations without overriding migrated profile settings', () => {
  const settings = mergeLearningProfilesIntoSettings(
    { classPreferences: { Chemistry: { sessionsPerWeek: 3, sessionLength: 45 } } },
    [{ id: 'chemistry-id', name: 'Chemistry' }, { id: 'biology-id', name: 'Biology' }],
    [
      { class_id: 'chemistry-id', sessions_per_week: 7, session_length_minutes: 60 },
      { class_id: 'biology-id', sessions_per_week: 4, session_length_minutes: 30 }
    ]
  );
  assert.deepEqual(settings.classPreferences.Chemistry, { sessionsPerWeek: 3, sessionLength: 45 });
  assert.equal(settings.classPreferences.Biology.sessionsPerWeek, 4);
  assert.equal(settings.classPreferences.Biology.sessionLength, 30);
});

test('profile writes preserve populated feeds from stale blank clients but honor explicit removals', () => {
  const existing = { calendarFeeds: [{ id: 'schoology', url: 'webcal://schoology.example/feed', className: 'Chemistry', lastSyncedAt: '2026-09-30T12:00:00.000Z' }, { id: 'todoist', url: 'https://todoist.example/feed', className: '', lastSyncedAt: null }] };
  const stale = mergeCalendarFeedSettings(existing, { calendarFeeds: [{ id: 'schoology', url: '' }, { id: 'todoist', url: '' }] });
  assert.deepEqual(stale.calendarFeeds.map(feed => feed.url), ['webcal://schoology.example/feed', 'https://todoist.example/feed']);
  const removed = mergeCalendarFeedSettings(existing, { calendarFeeds: [{ id: 'schoology', url: '' }, { id: 'todoist', url: '' }], calendarFeedRemovals: ['todoist'] });
  assert.deepEqual(removed.calendarFeeds.map(feed => feed.url), ['webcal://schoology.example/feed', '']);
});

test('profile writes cannot erase projects from a stale device snapshot', () => {
  const merged = mergeProjectSettings(
    { projects: ['College applications', 'Robotics'], projectRemovals: [] },
    { projects: [], projectRemovals: [] }
  );
  assert.deepEqual(merged.projects, ['College applications', 'Robotics']);
});

test('project deletion remains durable when another device sends an old project list', () => {
  const merged = mergeProjectSettings(
    { projects: ['College applications', 'Robotics'], projectRemovals: ['Robotics'] },
    { projects: ['Robotics'], projectRemovals: [] }
  );
  assert.deepEqual(merged.projects, ['College applications']);
  assert.deepEqual(merged.projectRemovals, ['Robotics']);
});

test('project settings are normalized for the client without duplicate labels', () => {
  const settings = normalizeProfileSettingsForClient({ projects: [' Robotics ', 'robotics', ''], projectRemovals: [' College applications '] });
  assert.deepEqual(settings.projects, ['Robotics']);
  assert.deepEqual(settings.projectRemovals, ['College applications']);
});

test('normalized project settings hide durable deletions', () => {
  const settings = normalizeProfileSettingsForClient({ projects: ['Robotics', 'College applications'], projectRemovals: ['robotics'] });
  assert.deepEqual(settings.projects, ['College applications']);
});
