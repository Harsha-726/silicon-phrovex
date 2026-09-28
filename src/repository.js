import { getAuthHeaders } from './platform.js';

const assignmentTypePattern = /(?:^|\|)silico:assignment:(study|test|quiz|homework|club_meeting|meeting|project|essay|presentation|event|reminder|other)(?:$|\|)/;
const autoScheduledMarker = 'silico:auto-scheduled';
const studyDateLockedMarker = 'silico:study-date-locked';
const explicitExecutionMarker = 'silico:explicit-execution';
function schedulingReasonWithAssignment(task) {
  const marker = `silico:assignment:${task.assignmentType || 'homework'}`;
  const parts = String(task.schedulingReason || '').split('|').filter(part => part && !part.startsWith('silico:assignment:') && part !== autoScheduledMarker && part !== studyDateLockedMarker && part !== explicitExecutionMarker);
  if (task.autoScheduled === true) parts.push(autoScheduledMarker);
  if (task.studyDateLocked === true) parts.push(studyDateLockedMarker);
  if (task.explicitExecution === true) parts.push(explicitExecutionMarker);
  return [...parts, marker].join('|');
}

function toRow(task, includeNulls = true) {
  const row = {
    ...(task.id && /^[0-9a-f-]{36}$/i.test(task.id) ? { id: task.id } : {}),
    title: task.title,
    description: task.description || '',
    status: task.status || 'open',
    priority: task.priority || 1,
    due_date: task.dueDate || null,
    due_time: task.dueTime || null,
    scheduled_date: task.scheduledDate || null,
    scheduled_time: task.scheduledTime || null,
    scheduling_reason: schedulingReasonWithAssignment(task),
    schedule_origin: task.scheduleOrigin || null,
    schedule_change_reason: task.scheduleChangeReason || null,
    schedule_change_message: task.scheduleChangeMessage || null,
    duration_minutes: task.duration || null,
    task_type: task.type || 'task',
    assignment_type: task.assignmentType || 'other',
    source: task.source || 'capture',
    event_reminder_enabled: task.eventReminderEnabled === true,
    event_reminder_recipient: task.eventReminderRecipient || null,
    reminder_for_task_id: isRemoteId(task.reminderForTaskId) ? task.reminderForTaskId : null,
    calendar_class_manually_set: task.calendarClassManuallySet === true
  };
  const optional = {
    class_name: task.className || null,
    project_name: task.project || null,
    recurrence: task.recurrence || null,
    related_assessment_id: isRemoteId(task.relatedAssessmentId) ? task.relatedAssessmentId : null,
    idempotency_key: task.idempotencyKey || null,
    scheduling_identity: task.schedulingIdentity || null,
    completed_at: task.completedAt || null,
    google_event_id: task.googleEventId || null,
    calendar_class_name: task.calendarClassName || null,
    calendar_class_hint: task.calendarClassHint || null,
    calendar_default_class: task.calendarDefaultClass || null,
    calendar_class_resolution: task.calendarClassResolution || null
  };
  for (const [field, value] of Object.entries(optional)) if (includeNulls || value !== null) row[field] = value;
  return row;
}

function fromRow(row) {
  const rawSchedulingReason = typeof row.scheduling_reason === 'string' ? row.scheduling_reason : '';
  const assignmentMarker = rawSchedulingReason.match(assignmentTypePattern)?.[1] || null;
  const autoScheduled = rawSchedulingReason.split('|').includes(autoScheduledMarker);
  const studyDateLocked = rawSchedulingReason.split('|').includes(studyDateLockedMarker);
  const explicitExecution = rawSchedulingReason.split('|').includes(explicitExecutionMarker);
  const priorityMarker = rawSchedulingReason.match(/^silico:priority:([1-4])(?:\|silico:assignment:[a-z_]+)?$/)?.[1] || null;
  const schedulingReason = rawSchedulingReason.split('|').filter(part => !part.startsWith('silico:assignment:') && part !== autoScheduledMarker && part !== studyDateLockedMarker && part !== explicitExecutionMarker).join('|') || null;
  const priority = priorityMarker ? Number(priorityMarker) : typeof row.priority === 'number' ? row.priority : ({ low: 1, medium: 1, high: 2, urgent: 3, critical: 4 })[String(row.priority).toLowerCase()] || Number(row.priority) || 1;
  const status = row.status === 'completed' ? 'completed' : 'open';
  const dueDate = typeof row.due_date === 'string' ? row.due_date.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || row.due_date : row.due_date;
  const dueTime = typeof row.due_time === 'string' ? row.due_time.match(/^\d{2}:\d{2}(?::\d{2})?/)?.[0] || row.due_time : row.due_time;
  // Older task tables use estimated_minutes instead of duration_minutes.
  // Prefer the current column, but preserve the saved duration on refresh
  // when reading rows from that legacy schema.
  const duration = row.duration_minutes ?? row.estimated_minutes;
  const scheduledDate = typeof row.scheduled_date === 'string' ? row.scheduled_date.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || row.scheduled_date : row.scheduled_date;
  const scheduledTime = typeof row.scheduled_time === 'string' ? row.scheduled_time.match(/^\d{2}:\d{2}(?::\d{2})?/)?.[0] || row.scheduled_time : row.scheduled_time;
  const scheduleOrigin = ['USER_SCHEDULED', 'SILICO_SCHEDULED', 'UNSCHEDULED'].includes(row.schedule_origin)
    ? row.schedule_origin
    : autoScheduled ? 'SILICO_SCHEDULED' : scheduledDate || scheduledTime ? 'USER_SCHEDULED' : 'UNSCHEDULED';
  return { ...row, priority, status, duration, dueDate, dueTime, scheduledDate, scheduledTime, schedulingReason, scheduleOrigin, scheduleChangeReason: row.schedule_change_reason || null, scheduleChangeMessage: row.schedule_change_message || null, autoScheduled, studyDateLocked, explicitExecution, relatedAssessmentId: row.related_assessment_id, type: row.task_type, assignmentType: assignmentMarker || row.assignment_type || null, assignmentTypeExplicit: Boolean(assignmentMarker || (row.assignment_type && row.assignment_type !== 'other')), idempotencyKey: row.idempotency_key, schedulingIdentity: row.scheduling_identity, completedAt: row.completed_at, className: row.class_name || null, project: row.project_name || null, googleEventId: row.google_event_id || null, eventReminderEnabled: row.event_reminder_enabled === true, eventReminderRecipient: row.event_reminder_recipient || '', reminderForTaskId: row.reminder_for_task_id || null, calendarClassManuallySet: row.calendar_class_manually_set === true, calendarClassName: row.calendar_class_name || null, calendarClassHint: row.calendar_class_hint || null, calendarDefaultClass: row.calendar_default_class || null, calendarClassResolution: row.calendar_class_resolution || null };
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function shouldRetryRequest(method, status, attempt) {
  if (attempt >= 2) return false;
  // GET/PATCH/DELETE are safe to repeat here. PATCH is especially important:
  // a brief device/network handoff must not turn a successful edit into a
  // misleading "saved locally" error. POST mutations remain single-shot
  // unless their caller has its own idempotency contract.
  if (!['GET', 'PATCH', 'DELETE'].includes(method)) return false;
  return status === 401 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function request(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : 12000;
  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  let lastError;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...fetchOptions, signal: options.signal || AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', ...(await getAuthHeaders()), ...(options.headers || {}) } });
      if (response.ok) return response.status === 204 ? null : response.json();
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || `Remote repository unavailable (${response.status})`);
      error.status = response.status;
      error.body = body;
      // A task can disappear between the last remote merge and a user action
      // (for example, after it was deleted on another device). Notify the
      // application so it can reconcile the local copy immediately instead
      // of leaving an editable ghost task behind.
      if (response.status === 404 && method === 'PATCH' && typeof window !== 'undefined') {
        const requestUrl = new URL(url, window.location.origin);
        if (requestUrl.pathname === '/api/tasks') {
          const missingTaskId = requestUrl.searchParams.get('id');
          if (missingTaskId) window.dispatchEvent(new CustomEvent('silico-task-not-found', { detail: { id: missingTaskId } }));
        }
      }
      lastError = error;
      if (!shouldRetryRequest(method, response.status, attempt)) throw error;
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError') throw error;
      const networkFailure = !error.status && (error.name === 'TypeError' || error.name === 'TimeoutError');
      if (!networkFailure && !shouldRetryRequest(method, error.status, attempt)) throw error;
      if (networkFailure && (!['GET', 'PATCH', 'DELETE'].includes(method) || attempt >= 2)) throw error;
    }
    await wait(150 * (attempt + 1));
  }
  throw lastError || new Error('Remote repository unavailable');
}

function isRemoteId(id) { return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id); }

export function createTaskRepository() {
  const taskUpdateQueues = new Map();
  let profileSaveQueue = Promise.resolve();
  const snapshot = value => JSON.parse(JSON.stringify(value));
  const updateTaskInOrder = task => {
    const taskId = task.id;
    const previous = taskUpdateQueues.get(taskId) || Promise.resolve();
    const savedTask = snapshot(task);
    const operation = previous.catch(() => {}).then(async () => {
      const payload = await request(`/api/tasks?id=${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify({ task: toRow(savedTask) }) });
      if (!payload?.task || payload.task.id !== taskId) throw new Error('Task update was not confirmed by the database');
      return fromRow(payload.task);
    });
    const queued = operation.finally(() => { if (taskUpdateQueues.get(taskId) === queued) taskUpdateQueues.delete(taskId); });
    taskUpdateQueues.set(taskId, queued);
    return operation;
  };
  const saveProfileInOrder = (profile, classes, projects) => {
    const savedProfile = snapshot(profile);
    const savedClasses = snapshot(classes);
    const savedProjects = snapshot(projects);
    const operation = profileSaveQueue.catch(() => {}).then(() => request('/api/profile', { method: 'PATCH', body: JSON.stringify({ profile: { display_name: String(savedProfile.displayName || '').trim().slice(0, 80) || null, onboarding_complete: Boolean(savedProfile.onboardingComplete), settings: { ...savedProfile, classes: savedClasses, projects: savedProjects } } }) }));
    profileSaveQueue = operation.catch(() => {});
    return operation;
  };
  return {
    async load() { const payload = await request('/api/tasks'); return (payload.tasks || []).map(fromRow); },
    async loadProfile() { return request('/api/profile'); },
    async loadStudy() { return request('/api/study'); },
    async loadStudyMaterial(id) { return request(`/api/study?material_id=${encodeURIComponent(id)}`); },
    async generateStudy(material) { return request('/api/study', { method: 'POST', body: JSON.stringify(material), timeoutMs: 55000 }); },
    async loadBilling() { return request('/api/billing'); },
    async createCheckout(interval = 'monthly', plan = 'student') { return request('/api/billing', { method: 'POST', body: JSON.stringify({ action: 'checkout', interval, plan }) }); },
    async openBillingPortal() { return request('/api/billing', { method: 'POST', body: JSON.stringify({ action: 'portal' }) }); },
    async saveProfile(profile, classes = [], projects = []) { return saveProfileInOrder(profile, classes, projects); },
    async submitFeedback(feedback) { return request('/api/feedback', { method: 'POST', body: JSON.stringify({ feedback }) }); },
    async loadFeedback(adminKey) { return request('/api/feedback', { headers: { 'X-Feedback-Admin-Key': adminKey } }); },
    async updateFeedbackStatus(adminKey, id, resolved) { return request('/api/feedback', { method: 'PATCH', headers: { 'X-Feedback-Admin-Key': adminKey }, body: JSON.stringify({ id, resolved }) }); },
    async revokeFeedbackAdminAccess(adminKey) { return request('/api/feedback', { method: 'DELETE', headers: { 'X-Feedback-Admin-Key': adminKey } }); },
    async fetchCalendarFeed(url) { return request('/api/calendar-feed', { method: 'POST', body: JSON.stringify({ url }) }); },
    async calendarExportStatus() { return request('/api/calendar-export'); },
    async generateCalendarExport(regenerate = false) { return request('/api/calendar-export', { method: 'POST', body: JSON.stringify({ action: regenerate ? 'regenerate' : 'generate' }) }); },
    async revokeCalendarExport() { return request('/api/calendar-export', { method: 'POST', body: JSON.stringify({ action: 'revoke' }) }); },
    async loadTeamProjects() { const payload = await request('/api/team-projects'); return payload.projects || []; },
    async loadTeamTaskFeed(email = '') { const query = email ? `&member_email=${encodeURIComponent(email)}` : ''; const payload = await request(`/api/team-projects?feed=true${query}`); return { tasks: payload.tasks || [], tasksClearedAt: payload.tasks_cleared_at || {} }; },
    async loadTeamProject(id, weekStart, email = '') { const query = email ? `&member_email=${encodeURIComponent(email)}` : ''; return request(`/api/team-projects?id=${encodeURIComponent(id)}&week_start=${encodeURIComponent(weekStart)}${query}`); },
    async loadTeamFiles(id) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'list_files', team_project_id: id }) }); return payload.files || []; },
    async uploadTeamFile(id, file) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'upload_file', team_project_id: id, file }) }); return payload.file; },
    async deleteTeamFile(id, fileId) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'delete_file', team_project_id: id, file_id: fileId }) }); },
    async createTeamProject(name, email = '') { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'create', name, email }) }); },
    async joinTeamProject(joinCode, email = '') { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'join', join_code: joinCode, email }) }); },
    async createTeamSubproject(teamProjectId, name) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'create_subproject', team_project_id: teamProjectId, name }) }); return payload.subproject; },
    async renameTeamSubproject(teamProjectId, subprojectId, name) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'rename_subproject', team_project_id: teamProjectId, subproject_id: subprojectId, name }) }); return payload.subproject; },
    async deleteTeamSubproject(teamProjectId, subprojectId) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'delete_subproject', team_project_id: teamProjectId, subproject_id: subprojectId }) }); },
    async regenerateTeamCode(teamProjectId) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'regenerate_code', team_project_id: teamProjectId }) }); },
    async renameTeamProject(teamProjectId, name) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'rename_project', team_project_id: teamProjectId, name }) }); return payload.project; },
    async deleteAllTeamTasks(teamProjectId) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'delete_all_tasks', team_project_id: teamProjectId }) }); },
    async deleteTeamProject(teamProjectId) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'delete_project', team_project_id: teamProjectId }) }); },
    async createTeamTask(teamProjectId, task) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'create_task', team_project_id: teamProjectId, task }) }); return payload.task; },
    async updateTeamTask(teamProjectId, teamTaskId, task) { const payload = await request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'update_task', team_project_id: teamProjectId, team_task_id: teamTaskId, task }) }); return payload.task; },
    async toggleTeamTask(teamProjectId, teamTaskId, completed) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'toggle_task', team_project_id: teamProjectId, team_task_id: teamTaskId, completed }) }); },
    async saveTeamAvailability(teamProjectId, weekStart, slots) { return request('/api/team-projects', { method: 'POST', body: JSON.stringify({ action: 'save_availability', team_project_id: teamProjectId, week_start: weekStart, slots }) }); },
    async create(task) { const payload = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ task: toRow(task, false) }) }); if (!payload?.task || !isRemoteId(payload.task.id)) throw new Error('Task was not confirmed by the database'); return fromRow(payload.task); },
    async update(task) { if (!isRemoteId(task.id)) return task; return updateTaskInOrder(task); },
    async remove(taskId) { if (!isRemoteId(taskId)) return; await request(`/api/tasks?id=${encodeURIComponent(taskId)}`, { method: 'DELETE' }); },
    async removeAll(before = null) { return request(`/api/tasks?all=true${before ? `&before=${encodeURIComponent(before)}` : ''}`, { method: 'DELETE' }); },
    async setOccurrence(taskId, occurrenceDate, completed) { await request('/api/occurrences', { method: completed ? 'POST' : 'DELETE', body: JSON.stringify({ task_id: taskId, occurrence_date: occurrenceDate, completed }) }); }
  };
}
