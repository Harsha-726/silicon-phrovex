import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const fields = ['display_name', 'timezone', 'onboarding_complete', 'settings'];
const learningFields = ['class_id', 'session_length_minutes', 'sessions_per_week', 'preferred_methods', 'preferred_start', 'latest_study_time'];

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
      if (profile.settings !== undefined) {
        const current = await supabaseRequest(`profiles?${filter}&select=settings`);
        const existingSettings = current?.[0]?.settings && typeof current[0].settings === 'object' ? current[0].settings : {};
        profile.settings = { ...existingSettings, ...profile.settings };
        // A delete-all undo needs to remove the durable tombstone rather than
        // merely omit it from a merge patch.
        if (input.settings.tasksClearedAt === null) delete profile.settings.tasksClearedAt;
      }
      const rows = await supabaseRequest('profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([profile]) });
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
