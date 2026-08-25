import { requireClerkUser, supabaseRequest, json } from './_auth.js';

function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function validUuid(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value); }

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const input = request.body || {};
  if (!validUuid(input.task_id) || !validDate(input.occurrence_date)) return json(response, 400, { error: 'Invalid occurrence identity' });
  const filter = `user_id=eq.${encodeURIComponent(auth.userId)}&task_id=eq.${encodeURIComponent(input.task_id)}&occurrence_date=eq.${encodeURIComponent(input.occurrence_date)}`;
  try {
    const ownedTasks = await supabaseRequest(`tasks?id=eq.${encodeURIComponent(input.task_id)}&user_id=eq.${encodeURIComponent(auth.userId)}&select=id`);
    if (!ownedTasks?.length) return json(response, 404, { error: 'Task not found' });
    if (request.method === 'POST' && input.completed === true) {
      const rows = await supabaseRequest('recurrence_occurrence_completions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ user_id: auth.userId, task_id: input.task_id, occurrence_date: input.occurrence_date }]) });
      return json(response, 200, { occurrence: rows?.[0] || null });
    }
    if (request.method === 'DELETE' || (request.method === 'POST' && input.completed === false)) {
      await supabaseRequest(`recurrence_occurrence_completions?${filter}`, { method: 'DELETE' });
      return response.status(204).end();
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) { return json(response, error.status || 422, { error: error.message || 'Occurrence operation failed' }); }
}
