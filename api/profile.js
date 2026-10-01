import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const fields = ['display_name', 'timezone', 'onboarding_complete', 'settings'];
const learningFields = ['class_id', 'session_length_minutes', 'sessions_per_week', 'preferred_methods', 'preferred_start', 'latest_study_time'];

function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function maxNumber(...values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : 0;
}
function latestDate(...values) {
  return values.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().at(-1) || null;
}
function mergeBooleanMap(existing, incoming) {
  const current = objectValue(existing);
  const next = objectValue(incoming);
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(next)])].filter(key => Boolean(current[key]) || Boolean(next[key])).map(key => [key, true]));
}

function firstString(object, keys) {
  for (const key of keys) if (typeof object?.[key] === 'string' && object[key].trim()) return object[key].trim();
  return '';
}
function normalizeFeedRecord(id, value) {
  if (typeof value === 'string') return { id, url: /^(?:webcal|https?):\/\//i.test(value.trim()) ? value.trim() : '', className: '', lastSyncedAt: null };
  const source = objectValue(value);
  return {
    id,
    url: firstString(source, ['url', 'feedUrl', 'icalUrl', 'calendarUrl', 'ical_feed_url']),
    className: firstString(source, ['className', 'class', 'defaultClass', 'calendarClassName']),
    lastSyncedAt: firstString(source, ['lastSyncedAt', 'last_synced_at']) || null
  };
}
function findNestedFeed(value, id, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  return findNestedFeedMarked(value, id, depth, false);
}
function findNestedFeedMarked(value, id, depth, relevant) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') return relevant && /^(?:webcal|https?):\/\//i.test(value.trim()) ? normalizeFeedRecord(id, value) : null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const nested = findNestedFeedMarked(child, id, depth + 1, relevant);
      if (nested?.url) return nested;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const entries = Object.entries(value);
  const objectMarker = entries.some(([key, child]) => ['provider', 'source', 'name', 'type', 'id'].includes(key.toLowerCase()) && String(child || '').trim().toLowerCase() === id);
  const objectRelevant = relevant || objectMarker;
  for (const [key, child] of entries) {
    const lowerKey = key.toLowerCase();
    const keyRelevant = objectRelevant || lowerKey.includes(id);
    if (keyRelevant) {
      const direct = normalizeFeedRecord(id, child);
      if (direct.url) return direct;
      const nested = findNestedFeedMarked(child, id, depth + 1, keyRelevant);
      if (nested?.url) return nested;
    }
  }
  for (const [key, child] of entries) {
    const nested = findNestedFeedMarked(child, id, depth + 1, objectRelevant || key.toLowerCase().includes(id));
    if (nested?.url) return nested;
  }
  return null;
}
function legacyFeedRecord(settings, integrations, id) {
  const direct = normalizeFeedRecord(id, objectValue(settings.calendarFeeds)[id] || objectValue(integrations)[id]);
  if (direct.url) return direct;
  const suffix = id === 'schoology' ? 'Schoology' : 'Todoist';
  const legacy = normalizeFeedRecord(id, {
    url: settings[`${id}CalendarFeedUrl`] || settings[`${id}FeedUrl`] || settings[`calendarFeed${suffix}Url`] || settings[`${id}_calendar_feed_url`],
    className: settings[`${id}CalendarFeedClassName`] || settings[`calendarFeed${suffix}ClassName`],
    lastSyncedAt: settings[`${id}CalendarFeedLastSyncedAt`] || settings[`calendarFeed${suffix}LastSyncedAt`]
  });
  if (legacy.url) return legacy;
  const integration = objectValue(integrations);
  const candidates = [integration[`${id}Feed`], integration[`${id}Calendar`], integration[`${id}_ical`], integration[`${id}_calendar`]];
  for (const candidate of candidates) {
    const result = normalizeFeedRecord(id, candidate);
    if (result.url) return result;
  }
  const nested = findNestedFeed(integrations, id);
  if (nested?.url) return nested;
  const topLevel = findNestedFeed(settings, id);
  if (topLevel?.url) return topLevel;
  return { id, url: '', className: '', lastSyncedAt: null };
}
function normalizeClassPreference(value) {
  const source = objectValue(value);
  return {
    ...source,
    sessionsPerWeek: source.sessionsPerWeek ?? source.sessions_per_week ?? source.sessions ?? 2,
    sessionLength: source.sessionLength ?? source.session_length ?? source.sessionLengthMinutes ?? source.session_length_minutes ?? 45
  };
}

function normalizeClassName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
}

export function mergeLearningProfilesIntoSettings(rawSettings, classRows = [], learningRows = []) {
  const settings = normalizeProfileSettingsForClient(rawSettings);
  const classNames = new Map((Array.isArray(classRows) ? classRows : []).map(row => [row?.id, normalizeClassName(row?.name)]).filter(([, name]) => name));
  const rawPreferences = objectValue(rawSettings?.classPreferences || rawSettings?.classAllocations || rawSettings?.studyAllocations || rawSettings?.class_preferences);
  const preferences = { ...settings.classPreferences };
  for (const learning of Array.isArray(learningRows) ? learningRows : []) {
    const name = classNames.get(learning?.class_id);
    if (!name) continue;
    const existingKey = Object.keys(rawPreferences).find(key => normalizeClassName(key).toLowerCase() === name.toLowerCase());
    // Profile JSON is the canonical store after a user edits an allocation.
    // Legacy learning_profiles rows only hydrate classes that have not been
    // migrated into that store yet.
    if (existingKey) continue;
    preferences[name] = normalizeClassPreference({
      session_length_minutes: learning.session_length_minutes,
      sessions_per_week: learning.sessions_per_week,
      preferred_methods: learning.preferred_methods,
      preferred_start: learning.preferred_start,
      latest_study_time: learning.latest_study_time
    });
  }
  settings.classPreferences = preferences;
  settings.classes = [...new Set([...settings.classes, ...Object.keys(preferences)])];
  return settings;
}

function normalizedFeedMap(settings) {
  const normalized = normalizeProfileSettingsForClient(settings);
  return new Map(normalized.calendarFeeds.map(feed => [feed.id, feed]));
}

export function mergeCalendarFeedSettings(existingSettings, incomingSettings) {
  const existing = objectValue(existingSettings);
  const incoming = objectValue(incomingSettings);
  const existingFeeds = normalizedFeedMap(existing);
  const incomingFeeds = normalizedFeedMap(incoming);
  const removed = new Set(Array.isArray(incoming.calendarFeedRemovals) ? incoming.calendarFeedRemovals : []);
  const calendarFeeds = ['schoology', 'todoist'].map(id => {
    if (removed.has(id)) return { id, url: '', className: '', lastSyncedAt: null };
    const before = existingFeeds.get(id) || { id, url: '', className: '', lastSyncedAt: null };
    const after = incomingFeeds.get(id) || { id, url: '', className: '', lastSyncedAt: null };
    return {
      id,
      url: after.url || before.url || '',
      className: after.className || before.className || '',
      lastSyncedAt: after.lastSyncedAt || before.lastSyncedAt || null
    };
  });
  return { ...incoming, calendarFeeds, calendarFeedRemovals: [] };
}

// Older profile rows used nested integration names and snake_case allocation
// fields. Normalize them at the authenticated API boundary so the browser has
// one stable shape and never has to guess which historical schema is live.
export function normalizeProfileSettingsForClient(rawSettings = {}) {
  const settings = objectValue(rawSettings);
  const integrations = objectValue(settings.integrations);
  const storedFeeds = Array.isArray(settings.calendarFeeds) ? settings.calendarFeeds : objectValue(settings.calendarFeeds);
  const normalizedFeeds = ['schoology', 'todoist'].map(id => {
    const direct = Array.isArray(storedFeeds) ? storedFeeds.find(feed => feed?.id === id) : storedFeeds[id];
    const feed = normalizeFeedRecord(id, direct);
    return feed.url ? feed : legacyFeedRecord(settings, integrations, id);
  });
  const rawPreferences = settings.classPreferences || settings.classAllocations || settings.studyAllocations || settings.class_preferences || {};
  const classPreferences = Object.fromEntries(Object.entries(objectValue(rawPreferences)).map(([name, preference]) => [name, normalizeClassPreference(preference)]));
  const classes = [...new Set([
    ...(Array.isArray(settings.classes) ? settings.classes : []),
    ...(Array.isArray(settings.classNames) ? settings.classNames : []),
    ...Object.keys(classPreferences)
  ].filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
  const sanitized = { ...settings, classes, classPreferences, calendarFeeds: normalizedFeeds };
  delete sanitized.integrations;
  delete sanitized.classAllocations;
  delete sanitized.studyAllocations;
  delete sanitized.class_preferences;
  return sanitized;
}

// Profile settings are sent by every signed-in device. A device can be offline
// or holding an old cache, so a shallow JSON merge is unsafe for append-only
// gamification data: the stale device would erase days, XP awards, or streak
// milestones recorded by another device.
export function mergeGamificationSettings(existing = {}, incoming = {}) {
  const current = objectValue(existing);
  const next = objectValue(incoming);
  if (!Object.keys(next).length) return current;
  const completedDays = [...new Set([
    ...(Array.isArray(current.completedDays) ? current.completedDays : []),
    ...(Array.isArray(next.completedDays) ? next.completedDays : [])
  ])].filter(day => typeof day === 'string').sort();
  const xp = maxNumber(current.xp, next.xp);
  return {
    ...current,
    ...next,
    xp,
    completedDays,
    currentStreak: maxNumber(current.currentStreak, next.currentStreak),
    longestStreak: maxNumber(current.longestStreak, next.longestStreak),
    lastCompletionDate: latestDate(current.lastCompletionDate, next.lastCompletionDate),
    awardedTaskIds: mergeBooleanMap(current.awardedTaskIds, next.awardedTaskIds),
    streakMilestonesAwarded: mergeBooleanMap(current.streakMilestonesAwarded, next.streakMilestonesAwarded)
  };
}

export function mergeOnboardingComplete(existing, incoming) {
  return Boolean(existing) || Boolean(incoming);
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

function publicProfile(row, classRows = [], learningRows = []) {
  if (!row) return row;
  const settings = mergeLearningProfilesIntoSettings(row.settings, classRows, learningRows);
  return settings === row.settings ? row : { ...row, settings };
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const filter = `user_id=eq.${encodeURIComponent(auth.userId)}`;
  try {
    if (request.method === 'GET') {
      await ensureProfile(auth.userId);
      const rows = await supabaseRequest(`profiles?${filter}&select=*`);
      const learning = await supabaseRequest(`learning_profiles?${filter}&select=*`);
      const classes = await supabaseRequest(`classes?${filter}&select=id,name`);
      return json(response, 200, { profile: publicProfile(rows?.[0] || null, classes || [], learning || []), learningProfiles: learning || [] });
    }
    if (request.method === 'PATCH' || request.method === 'POST') {
      await ensureProfile(auth.userId);
      const body = requestBody(request);
      const input = body.profile || {};
      const profile = { user_id: auth.userId };
      for (const field of fields) if (input[field] !== undefined) profile[field] = input[field];
      if (profile.settings !== undefined && (typeof profile.settings !== 'object' || profile.settings === null || Array.isArray(profile.settings))) throw new Error('Profile settings are invalid');
      // The RPC receives the caller's patch, not a stale read-modify-write
      // snapshot. Its row lock performs the merge against the latest row.
      const atomicPatch = { ...profile };
      const current = await supabaseRequest(`profiles?${filter}&select=onboarding_complete,settings`);
      const currentProfile = current?.[0] || {};
      if (profile.onboarding_complete !== undefined) profile.onboarding_complete = mergeOnboardingComplete(currentProfile.onboarding_complete, profile.onboarding_complete);
      if (profile.settings !== undefined) {
        const existingSettings = objectValue(currentProfile.settings);
        const mergedSettings = mergeCalendarFeedSettings(existingSettings, profile.settings);
        profile.settings = { ...existingSettings, ...mergedSettings };
        atomicPatch.settings = mergedSettings;
        profile.settings.gamification = mergeGamificationSettings(existingSettings.gamification, profile.settings.gamification);
        // A delete-all undo needs to remove the durable tombstone rather than
        // merely omit it from a merge patch.
        if (input.settings.tasksClearedAt === null) delete profile.settings.tasksClearedAt;
      }
      let rows;
      try {
        const saved = await supabaseRequest('rpc/merge_profile_state', { method: 'POST', body: JSON.stringify({ p_user_id: auth.userId, p_patch: atomicPatch }) });
        rows = Array.isArray(saved) ? saved : saved ? [saved] : [];
      } catch (error) {
        // Keep older environments usable until migration 026 is applied. The
        // fallback still merges the current row, while the RPC provides the
        // atomic row lock in migrated production databases.
        if (error.status !== 404) throw error;
        rows = await supabaseRequest('profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([profile]) });
      }
      let learningProfiles = [];
      for (const inputLearning of Array.isArray(body.learningProfiles) ? body.learningProfiles : []) {
        const learning = { user_id: auth.userId };
        for (const field of learningFields) if (inputLearning[field] !== undefined) learning[field] = inputLearning[field];
        if (learning.class_id) { const saved = await supabaseRequest('learning_profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([learning]) }); learningProfiles.push(saved?.[0]); }
      }
      return json(response, 200, { profile: publicProfile(rows?.[0] || null), learningProfiles });
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) { return json(response, error.status || 422, { error: error.message || 'Profile operation failed' }); }
}
