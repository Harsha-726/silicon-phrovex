import { getAuthHeaders } from './platform.js';

function toRow(task, includeNulls = true) {
  const row = {
    ...(task.id && /^[0-9a-f-]{36}$/i.test(task.id) ? { id: task.id } : {}),
    title: task.title,
    description: task.description || '',
    status: task.status || 'open',
    priority: task.priority || 1,
    due_date: task.dueDate || null,
    due_time: task.dueTime || null,
    duration_minutes: task.duration || null,
    task_type: task.type || 'task',
    source: task.source || 'capture'
  };
  const optional = {
    class_name: task.className || null,
    project_name: task.project || null,
    recurrence: task.recurrence || null,
    related_assessment_id: isRemoteId(task.relatedAssessmentId) ? task.relatedAssessmentId : null,
    idempotency_key: task.idempotencyKey || null,
    scheduling_identity: task.schedulingIdentity || null,
    completed_at: task.completedAt || null
  };
  for (const [field, value] of Object.entries(optional)) if (includeNulls || value !== null) row[field] = value;
  return row;
}

function fromRow(row) {
  return { ...row, duration: row.duration_minutes, dueDate: row.due_date, dueTime: row.due_time, relatedAssessmentId: row.related_assessment_id, type: row.task_type, idempotencyKey: row.idempotency_key, schedulingIdentity: row.scheduling_identity, completedAt: row.completed_at, className: row.class_name || null, project: row.project_name || null };
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()), ...(options.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Remote repository unavailable (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function isRemoteId(id) { return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id); }

export function createTaskRepository() {
  return {
    async load() { const payload = await request('/api/tasks'); return (payload.tasks || []).map(fromRow); },
    async loadProfile() { return request('/api/profile'); },
    async saveProfile(profile, classes = []) { return request('/api/profile', { method: 'PATCH', body: JSON.stringify({ profile: { onboarding_complete: Boolean(profile.onboardingComplete), settings: { ...profile, classes } } }) }); },
    async create(task) { const payload = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ task: toRow(task, false) }) }); return payload.task ? fromRow(payload.task) : task; },
    async update(task) { if (!isRemoteId(task.id)) return task; const payload = await request(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ task: toRow(task) }) }); return payload.task ? fromRow(payload.task) : task; },
    async remove(taskId) { if (!isRemoteId(taskId)) return; await request(`/api/tasks?id=${encodeURIComponent(taskId)}`, { method: 'DELETE' }); },
    async removeAll() { await request('/api/tasks?all=true', { method: 'DELETE' }); },
    async setOccurrence(taskId, occurrenceDate, completed) { await request('/api/occurrences', { method: completed ? 'POST' : 'DELETE', body: JSON.stringify({ task_id: taskId, occurrence_date: occurrenceDate, completed }) }); }
  };
}
