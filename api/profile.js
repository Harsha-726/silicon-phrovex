import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const fields = ['display_name', 'timezone', 'onboarding_complete', 'settings'];
const learningFields = ['class_id', 'session_length_minutes', 'sessions_per_week', 'preferred_methods', 'preferred_start', 'latest_study_time'];

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const filter = `user_id=eq.${encodeURIComponent(auth.userId)}`;
  try {
    if (request.method === 'GET') {
      await ensureProfile(auth.userId);
      const rows = await supabaseRequest(`profiles?${filter}&select=*`);
      const learning = await supabaseRequest(`learning_profiles?${filter}&select=*`);
      return json(response, 200, { profile: rows?.[0] || null, learningProfiles: learning || [] });
    }
    if (request.method === 'PATCH' || request.method === 'POST') {
      await ensureProfile(auth.userId);
      const input = request.body?.profile || {};
      const profile = { user_id: auth.userId };
      for (const field of fields) if (input[field] !== undefined) profile[field] = input[field];
      if (profile.settings !== undefined && (typeof profile.settings !== 'object' || profile.settings === null || Array.isArray(profile.settings))) throw new Error('Profile settings are invalid');
      const rows = await supabaseRequest('profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([profile]) });
      let learningProfiles = [];
      for (const inputLearning of request.body?.learningProfiles || []) {
        const learning = { user_id: auth.userId };
        for (const field of learningFields) if (inputLearning[field] !== undefined) learning[field] = inputLearning[field];
        if (learning.class_id) { const saved = await supabaseRequest('learning_profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([learning]) }); learningProfiles.push(saved?.[0]); }
      }
      return json(response, 200, { profile: rows?.[0] || null, learningProfiles });
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) { return json(response, error.status || 422, { error: error.message || 'Profile operation failed' }); }
}
