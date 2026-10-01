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

function publicProfile(row) {
  if (!row) return row;
  const settings = row.settings && typeof row.settings === 'object' ? { ...row.settings } : row.settings;
  if (settings && typeof settings === 'object') delete settings.integrations;
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
      return json(response, 200, { profile: publicProfile(rows?.[0] || null), learningProfiles: learning || [] });
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
        profile.settings = { ...existingSettings, ...profile.settings };
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
