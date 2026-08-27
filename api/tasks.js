import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const allowedFields = ['title', 'description', 'status', 'priority', 'due_date', 'due_time', 'duration_minutes', 'project_id', 'project_name', 'class_id', 'class_name', 'recurrence', 'related_assessment_id', 'task_type', 'source', 'idempotency_key', 'scheduling_identity', 'completed_at'];

function normalizeTask(input = {}) {
  if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 500) throw new Error('Task title is invalid');
  const task = {};
  for (const field of allowedFields) if (input[field] !== undefined) task[field] = input[field];
  task.title = task.title.trim();
  if (task.status && !['open', 'completed'].includes(task.status)) throw new Error('Task status is invalid');
  if (task.priority !== undefined && ![1, 2, 3, 4].includes(Number(task.priority))) throw new Error('Task priority is invalid');
  if (task.duration_minutes !== undefined && (Number(task.duration_minutes) < 1 || Number(task.duration_minutes) > 1440)) throw new Error('Task duration is invalid');
  if (task.related_assessment_id !== undefined && task.related_assessment_id !== null && !/^[0-9a-f-]{36}$/i.test(task.related_assessment_id)) throw new Error('Related assessment id is invalid');
  return task;
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

async function findExistingTask(userFilter, task) {
  for (const field of ['idempotency_key', 'scheduling_identity']) {
    if (!task[field]) continue;
    const rows = await supabaseRequest(`tasks?${userFilter}&${field}=eq.${encodeURIComponent(task[field])}&select=*&limit=1`);
    if (rows?.[0]) return rows[0];
  }
  return null;
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const userFilter = `user_id=eq.${encodeURIComponent(auth.userId)}`;
  try {
    const body = requestBody(request);
    if (request.method === 'GET') {
      const tasks = await supabaseRequest(`tasks?${userFilter}&select=*&order=due_date.asc,due_time.asc,created_at.asc`);
      return json(response, 200, { tasks });
    }
    if (request.method === 'POST') {
      const task = normalizeTask(body.task);
      await ensureProfile(auth.userId);
      const existing = await findExistingTask(userFilter, task);
      if (existing) return json(response, 200, { task: existing });
      try {
        const rows = await supabaseRequest('tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ ...task, user_id: auth.userId }]) });
        return json(response, 201, { task: rows?.[0] });
      } catch (error) {
        // A concurrent request can win the unique index between the lookup and
        // insert. Return that canonical row instead of surfacing a duplicate.
        if (error.status === 409 || error.body?.code === '23505') {
          const raced = await findExistingTask(userFilter, task);
          if (raced) return json(response, 200, { task: raced });
        }
        throw error;
      }
    }
    if (request.method === 'DELETE' && request.query?.all === 'true') {
      await supabaseRequest(`tasks?${userFilter}`, { method: 'DELETE' });
      return response.status(204).end();
    }
    const id = request.query?.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(response, 400, { error: 'A valid task id is required' });
    if (request.method === 'PATCH') {
      const input = body.task || {};
      const patch = input.title === undefined ? normalizeTask({ title: 'placeholder', ...input }) : normalizeTask(input);
      if (input.title === undefined) delete patch.title;
      const rows = await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&${userFilter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
      return json(response, 200, { task: rows?.[0] || null });
    }
    if (request.method === 'DELETE') {
      await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&${userFilter}`, { method: 'DELETE' });
      return response.status(204).end();
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Task API operation failed', { status: error.status || 422, message: error.message, code: error.body?.code });
    return json(response, error.status || 422, { error: error.message || 'Task operation failed', details: error.body || undefined });
  }
}
