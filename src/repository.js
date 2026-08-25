import { getAuthHeaders } from './platform.js';

function toRow(task) {
  return {
    ...(task.id && /^[0-9a-f-]{36}$/i.test(task.id) ? { id: task.id } : {}),
    title: task.title,
    description: task.description || '',
    status: task.status || 'open',
    priority: task.priority || 1,
    due_date: task.dueDate || null,
    due_time: task.dueTime || null,
    duration_minutes: task.duration || null,
    class_name: task.className || null,
    project_name: task.project || null,
    recurrence: task.recurrence || null,
    related_assessment_id: task.relatedAssessmentId || null,
    task_type: task.type || 'task',
    source: task.source || 'capture',
    idempotency_key: task.idempotencyKey || null,
    scheduling_identity: task.schedulingIdentity || null,
    completed_at: task.completedAt || null
  };
}

function fromRow(row) {
  return { ...row, duration: row.duration_minutes, dueDate: row.due_date, dueTime: row.due_time, relatedAssessmentId: row.related_assessment_id, type: row.task_type, idempotencyKey: row.idempotency_key, schedulingIdentity: row.scheduling_identity, completedAt: row.completed_at, className: row.class_name || null, project: row.project_name || null };
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()), ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Remote repository unavailable (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export function createTaskRepository() {
  return {
    async load() { const payload = await request('/api/tasks'); return (payload.tasks || []).map(fromRow); },
    async loadProfile() { return request('/api/profile'); },
    async saveProfile(profile, classes = []) { return request('/api/profile', { method: 'PATCH', body: JSON.stringify({ profile: { onboarding_complete: Boolean(profile.onboardingComplete), settings: { ...profile, classes } } }) }); },
    async create(task) { const payload = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ task: toRow(task) }) }); return payload.task ? fromRow(payload.task) : task; },
    async update(task) { const payload = await request(`/api/tasks?id=${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ task: toRow(task) }) }); return payload.task ? fromRow(payload.task) : task; },
    async remove(taskId) { await request(`/api/tasks?id=${encodeURIComponent(taskId)}`, { method: 'DELETE' }); },
    async removeAll() { await request('/api/tasks?all=true', { method: 'DELETE' }); },
    async setOccurrence(taskId, occurrenceDate, completed) { await request('/api/occurrences', { method: completed ? 'POST' : 'DELETE', body: JSON.stringify({ task_id: taskId, occurrence_date: occurrenceDate, completed }) }); }
  };
}
