import { randomUUID } from 'node:crypto';
import { ensureLegacyUser, ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';
import { handleOccurrences } from './_occurrences.js';

const allowedFields = ['title', 'description', 'status', 'priority', 'due_date', 'due_time', 'scheduled_date', 'scheduled_time', 'scheduling_reason', 'schedule_origin', 'schedule_change_reason', 'schedule_change_message', 'duration_minutes', 'project_id', 'project_name', 'class_id', 'class_name', 'recurrence', 'related_assessment_id', 'task_type', 'assignment_type', 'source', 'idempotency_key', 'scheduling_identity', 'completed_at', 'google_event_id', 'event_reminder_enabled', 'event_reminder_recipient', 'reminder_for_task_id', 'calendar_class_manually_set', 'calendar_class_name', 'calendar_class_hint', 'calendar_default_class', 'calendar_class_resolution'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const manualCalendarClassMarker = 'silico:calendar-class-manual';

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Task due date is invalid');
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
  if (!match) throw new Error('Task due date is invalid');
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) throw new Error('Task due date is invalid');
  return match[1];
}

function normalizeTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Task time is invalid');
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) {
    const meridiem = value.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (!meridiem) throw new Error('Task time is invalid');
    let hour = Number(meridiem[1]);
    if (hour < 1 || hour > 12 || Number(meridiem[2]) > 59) throw new Error('Task time is invalid');
    if (meridiem[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (meridiem[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${meridiem[2]}:00`;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error('Task time is invalid');
  return `${String(hour).padStart(2, '0')}:${match[2]}:${String(second).padStart(2, '0')}`;
}

function normalizeTask(input = {}) {
  if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 500) throw new Error('Task title is invalid');
  const task = {};
  for (const field of allowedFields) if (input[field] !== undefined) task[field] = input[field];
  task.title = task.title.trim();
  if ('due_date' in task) task.due_date = normalizeDate(task.due_date);
  if ('due_time' in task) task.due_time = normalizeTime(task.due_time);
  if ('scheduled_date' in task) task.scheduled_date = normalizeDate(task.scheduled_date);
  if ('scheduled_time' in task) task.scheduled_time = normalizeTime(task.scheduled_time);
  if (task.status !== undefined && !['open', 'completed'].includes(task.status)) throw new Error('Task status is invalid');
  if (task.priority !== undefined) {
    const priority = Number(task.priority);
    if (![1, 2, 3, 4].includes(priority)) throw new Error('Task priority is invalid');
    task.priority = priority;
  }
  if (task.duration_minutes !== undefined && task.duration_minutes !== null && (!Number.isFinite(Number(task.duration_minutes)) || Number(task.duration_minutes) < 1 || Number(task.duration_minutes) > 1440)) throw new Error('Task duration is invalid');
  for (const field of ['description', 'project_name', 'class_name', 'source', 'task_type', 'assignment_type', 'idempotency_key', 'scheduling_identity', 'scheduling_reason', 'google_event_id', 'event_reminder_recipient', 'calendar_class_name', 'calendar_class_hint', 'calendar_default_class', 'calendar_class_resolution']) {
    if (task[field] !== undefined && task[field] !== null && typeof task[field] !== 'string') throw new Error(`Task ${field} is invalid`);
  }
  for (const field of ['project_id', 'class_id', 'related_assessment_id', 'reminder_for_task_id']) if (task[field] !== undefined && task[field] !== null && !uuidPattern.test(task[field])) throw new Error(`Task ${field} is invalid`);
  if (task.recurrence !== undefined && task.recurrence !== null && (typeof task.recurrence !== 'object' || Array.isArray(task.recurrence))) throw new Error('Task recurrence is invalid');
  if (task.description?.length > 10_000 || task.project_name?.length > 120 || task.class_name?.length > 120 || task.assignment_type?.length > 40 || task.idempotency_key?.length > 255 || task.scheduling_identity?.length > 255 || task.scheduling_reason?.length > 500 || task.google_event_id?.length > 255 || task.event_reminder_recipient?.length > 80 || ['calendar_class_name', 'calendar_class_hint', 'calendar_default_class', 'calendar_class_resolution'].some(field => task[field]?.length > 160)) throw new Error('Task metadata is too long');
  if (task.completed_at !== undefined && task.completed_at !== null && (typeof task.completed_at !== 'string' || Number.isNaN(Date.parse(task.completed_at)))) throw new Error('Task completion timestamp is invalid');
  if (task.task_type !== undefined && !['task', 'assessment', 'study_session', 'fixed_event'].includes(task.task_type)) throw new Error('Task type is invalid');
  if (task.assignment_type !== undefined && !['study', 'test', 'quiz', 'homework', 'club_meeting', 'meeting', 'project', 'essay', 'presentation', 'event', 'reminder', 'other'].includes(task.assignment_type)) throw new Error('Assignment type is invalid');
  if (task.schedule_origin !== undefined && !['USER_SCHEDULED', 'SILICO_SCHEDULED', 'UNSCHEDULED'].includes(task.schedule_origin)) throw new Error('Task schedule origin is invalid');
  for (const field of ['schedule_change_reason', 'schedule_change_message']) {
    if (task[field] !== undefined && task[field] !== null && typeof task[field] !== 'string') throw new Error(`Task ${field} is invalid`);
  }
  if (task.schedule_change_reason !== undefined && task.schedule_change_reason !== null && !['OVERDUE_RECOVERY', 'HARD_STOP_CONFLICT', 'HARD_COMMITMENT_CONFLICT', 'TIME_CONFLICT', 'DURATION_REORDERING'].includes(task.schedule_change_reason)) throw new Error('Task schedule change reason is invalid');
  if (task.schedule_change_message?.length > 500) throw new Error('Task schedule change message is too long');
  if (task.event_reminder_enabled !== undefined && typeof task.event_reminder_enabled !== 'boolean') throw new Error('Event reminder setting is invalid');
  if (task.calendar_class_manually_set !== undefined && typeof task.calendar_class_manually_set !== 'boolean') throw new Error('Task calendar class setting is invalid');
  if (task.source !== undefined && !['capture', 'calendar', 'scheduler', 'todoist'].includes(task.source)) throw new Error('Task source is invalid');
  return task;
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') {
    try { return JSON.parse(request.body); } catch { return {}; }
  }
  return {};
}

function legacyPriority(value) {
  return ({ 1: 'medium', 2: 'high', 3: 'urgent', 4: 'critical' })[Number(value)] || 'medium';
}

function legacyTaskPayload(task) {
  const payload = { ...task };
  if (payload.priority !== undefined) payload.priority = legacyPriority(payload.priority);
  if (payload.status !== undefined) payload.status = payload.status === 'completed' ? 'completed' : 'todo';
  return payload;
}

function legacySchemaTaskPayload(task, options = {}) {
  const payload = legacyTaskPayload(task);
  if (task.duration_minutes !== undefined) payload.estimated_minutes = task.duration_minutes == null ? 0 : Number(task.duration_minutes);
  if (options.numericPriority && task.priority !== undefined) payload.priority = Math.min(3, Math.max(1, Number(task.priority) || 1));
  if (options.openStatus && payload.status !== undefined) payload.status = payload.status === 'completed' ? 'completed' : 'open';
  const fields = ['user_id', 'title', 'description', 'status', 'priority', 'due_date', 'scheduled_date', 'scheduled_time', 'duration_minutes', 'estimated_minutes'];
  if (options.schedule !== false) fields.push('due_time');
  if (options.labels !== false) fields.push('project_name', 'class_name');
  if (options.recurrence !== false) fields.push('recurrence');
  if (options.completion !== false) fields.push('completed_at');
  if (options.updated) fields.push('updated_at');
  if (options.scheduling !== false && task.scheduling_reason !== undefined) fields.push('scheduling_reason');
  return Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
}

function legacyNumericTaskPayload(task) {
  return legacySchemaTaskPayload(task, { numericPriority: true, openStatus: true });
}

function legacyNumericTodoPayload(task) {
  return legacySchemaTaskPayload(task, { numericPriority: true });
}

function legacySafeTextPayload(task) {
  const payload = legacyTaskPayload(task);
  if (task.duration_minutes !== undefined) payload.estimated_minutes = task.duration_minutes == null ? 0 : Number(task.duration_minutes);
  const fields = ['title', 'description', 'status', 'priority', 'due_date', 'due_time', 'scheduled_date', 'scheduled_time', 'duration_minutes', 'estimated_minutes', 'project_name', 'class_name', 'recurrence', 'completed_at', 'updated_at'];
  return Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
}

function legacyMinimalTextPayload(task) {
  const payload = legacyTaskPayload(task);
  if (task.duration_minutes !== undefined) payload.estimated_minutes = task.duration_minutes == null ? 0 : Number(task.duration_minutes);
  const fields = ['title', 'description', 'status', 'priority', 'due_date', 'due_time', 'scheduled_date', 'scheduled_time', 'estimated_minutes', 'project_name', 'class_name', 'recurrence', 'completed_at', 'updated_at'];
  return Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
}

function legacyStrictTaskPayload(task) {
  const payload = legacyTaskPayload(task);
  if (task.duration_minutes !== undefined) payload.estimated_minutes = task.duration_minutes == null ? 0 : Number(task.duration_minutes);
  if (payload.due_date) payload.due_date = `${String(payload.due_date).slice(0, 10)}T00:00:00.000Z`;
  const fields = ['user_id', 'title', 'description', 'status', 'priority', 'due_date', 'due_time', 'scheduled_date', 'scheduled_time', 'duration_minutes', 'estimated_minutes', 'task_type', 'source', 'project_name', 'class_name', 'recurrence', 'idempotency_key', 'scheduling_identity', 'scheduling_reason', 'completed_at', 'updated_at'];
  return Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
}

// Some deployed legacy databases still accept only the original `medium`
// priority. Preserve the user's numeric priority in an existing legacy
// metadata column until migration 009 repairs that constraint. This path is
// intentionally after the normal payloads and disappears once they succeed.
function manualCalendarClassMarkerFor(task) {
  return String(task.scheduling_reason || '').split('|').includes(manualCalendarClassMarker) ? manualCalendarClassMarker : null;
}

export function legacyPriorityCompatibilityPayload(task) {
  const payload = legacyStrictTaskPayload(task);
  const priority = Number(task.priority);
  const assignmentMarker = task.assignment_type ? `silico:assignment:${task.assignment_type}` : null;
  const manualClassMarker = manualCalendarClassMarkerFor(task);
  if (priority > 1) {
    payload.priority = 'medium';
    payload.scheduling_reason = [`silico:priority:${priority}`, assignmentMarker, manualClassMarker].filter(Boolean).join('|');
  } else {
    payload.priority = 'medium';
    // Clear a marker if a previously high-priority task is changed back to
    // Normal while the legacy schema is still active.
    payload.scheduling_reason = [assignmentMarker, manualClassMarker].filter(Boolean).join('|') || null;
  }
  // Keep the newer task metadata in this compatibility attempt. Databases
  // that still require the legacy priority value can nevertheless have the
  // assignment/reminder migration applied. If an older database lacks these
  // columns, PostgREST rejects this attempt and the reduced fallbacks below
  // continue as before.
  for (const field of ['assignment_type', 'event_reminder_enabled', 'event_reminder_recipient', 'reminder_for_task_id']) {
    if (task[field] !== undefined) payload[field] = task[field];
  }
  const fields = ['user_id', 'title', 'description', 'status', 'priority', 'due_date', 'due_time', 'scheduled_date', 'scheduled_time', 'duration_minutes', 'estimated_minutes', 'task_type', 'assignment_type', 'source', 'project_name', 'class_name', 'recurrence', 'idempotency_key', 'scheduling_identity', 'completed_at', 'updated_at', 'scheduling_reason', 'event_reminder_enabled', 'event_reminder_recipient', 'reminder_for_task_id'];
  return Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
}

export function legacySchemaPriorityPayload(task, options = {}) {
  const payload = legacySchemaTaskPayload(task, options);
  if (task.priority !== undefined) {
    const priority = Number(task.priority);
    payload.priority = 'medium';
    payload.scheduling_reason = [priority > 1 ? `silico:priority:${priority}` : null, task.assignment_type ? `silico:assignment:${task.assignment_type}` : null, manualCalendarClassMarkerFor(task)].filter(Boolean).join('|') || null;
  }
  return payload;
}

function canRetryLegacyTask(error) {
  return ['23514', '22P02', '42804'].includes(error.body?.code) || [400, 422].includes(error.status);
}

function legacyTaskPayloads(task) {
  return [
    // Try the marker-preserving form first so a legacy schema cannot silently
    // collapse Silico's strongest priority into the old `urgent` value.
    legacyPriorityCompatibilityPayload(task),
    // Some legacy tables do not have every newer task column (for example
    // task_type or source), so the strict compatibility payload above can
    // fail before it reaches the database. Keep the numeric priority in the
    // scheduling marker for that schema too, before reduced payloads run.
    legacySchemaPriorityPayload(task),
    legacySchemaPriorityPayload(task, { openStatus: true }),
    legacyTaskPayload(task),
    legacyStrictTaskPayload(task),
    legacySchemaTaskPayload(task),
    legacySchemaTaskPayload(task, { openStatus: true }),
    legacyNumericTaskPayload(task),
    legacyNumericTodoPayload(task),
    legacySchemaTaskPayload(task, { schedule: false, updated: true }),
    legacySchemaTaskPayload(task, { openStatus: true, schedule: false, updated: true }),
    legacySchemaTaskPayload(task, { labels: false, updated: true }),
    legacySchemaTaskPayload(task, { openStatus: true, labels: false, updated: true }),
    legacySchemaTaskPayload(task, { schedule: false, labels: false, recurrence: false, updated: true }),
    legacySchemaTaskPayload(task, { openStatus: true, schedule: false, labels: false, recurrence: false, updated: true }),
    legacySchemaTaskPayload(task, { schedule: false, labels: false, recurrence: false, completion: false, updated: false })
  ];
}

export function taskStatusMatches(row, status) {
  if (!status) return true;
  return status === 'completed' ? row?.status === 'completed' : row?.status !== 'completed';
}

async function findExistingTask(userFilter, task, options = {}) {
  for (const field of ['idempotency_key', 'scheduling_identity']) {
    if (!task[field]) continue;
    // Do not push the status predicate into PostgREST. Older task schemas use
    // values such as `todo`; filtering for `open` misses the existing row and
    // turns an idempotent retry into a unique-constraint failure.
    const rows = await supabaseRequest(`tasks?${userFilter}&${field}=eq.${encodeURIComponent(task[field])}&select=*&limit=20`);
    const matching = rows?.find(row => taskStatusMatches(row, options.status));
    if (matching) return matching;
  }
  return null;
}

function reissueIdentity(value) {
  if (!value) return value;
  return `${String(value).slice(0, 220)}:reissued:${randomUUID()}`.slice(0, 255);
}

export default async function handler(request, response) {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  if (request.query?.occurrence_route === '1' || requestUrl.searchParams.get('occurrence_route') === '1') return handleOccurrences(request, response);
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const userFilter = `user_id=eq.${encodeURIComponent(auth.userId)}`;
  try {
    const body = requestBody(request);
    if (request.method === 'GET') {
      // The client sorts task rows itself. Avoid ordering by legacy columns
      // that may not exist until all schema repairs have been applied.
      const identityField = ['idempotency_key', 'scheduling_identity'].find(field => typeof request.query?.[field] === 'string' || typeof requestUrl.searchParams.get(field) === 'string');
      const identityValue = identityField ? request.query?.[identityField] || requestUrl.searchParams.get(identityField) : null;
      if (identityField && (!identityValue || identityValue.length > 255)) return json(response, 400, { error: 'Task identity is invalid' });
      const identityFilter = identityField ? `&${identityField}=eq.${encodeURIComponent(identityValue)}` : '';
      const tasks = await supabaseRequest(`tasks?${userFilter}${identityFilter}&select=*`);
      return json(response, 200, { tasks });
    }
    if (request.method === 'POST') {
      const task = normalizeTask(body.task);
      await ensureProfile(auth.userId);
      // Open work remains idempotent, but a completed task must never absorb
      // a new capture. The database uniqueness index covers all statuses, so
      // give a re-created task a fresh identity before inserting it.
      const existingOpen = await findExistingTask(userFilter, task, { status: 'open' });
      if (existingOpen) return json(response, 200, { task: existingOpen });
      const existingCompleted = await findExistingTask(userFilter, task, { status: 'completed' });
      if (existingCompleted) {
        task.idempotency_key = reissueIdentity(task.idempotency_key);
        task.scheduling_identity = reissueIdentity(task.scheduling_identity);
      }
      try {
        // Older task tables require estimated_minutes. The current contract
        // calls this value duration_minutes, so populate the legacy field
        // during inserts while the database migration rolls forward.
        const insert = { ...task, user_id: auth.userId, estimated_minutes: task.duration_minutes == null ? 0 : Number(task.duration_minutes) };
        let rows;
        let lastError;
        const insertPayloads = [insert, ...legacyTaskPayloads(insert)];
        for (const payload of insertPayloads) {
          try {
            rows = await supabaseRequest('tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([payload]) });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            // A legacy database may still point tasks.user_id at users.id.
            // Provision that compatibility row once, then continue the same
            // contract fallback sequence.
            if (error.body?.code === '23503' && payload === insert) {
              await ensureLegacyUser(auth.userId);
              continue;
            }
            if (!canRetryLegacyTask(error)) throw error;
          }
        }
        if (lastError) throw lastError;
        if (!rows?.[0]) throw new Error('Task was not persisted by the database');
        return json(response, 201, { task: rows[0] });
      } catch (error) {
        // A concurrent request can win the unique index between the lookup and
        // insert. Return that canonical row instead of surfacing a duplicate.
        if (error.status === 409 || error.body?.code === '23505') {
          const racedOpen = await findExistingTask(userFilter, task, { status: 'open' });
          if (racedOpen) return json(response, 200, { task: racedOpen });
        }
        throw error;
      }
    }
    if (request.method === 'DELETE' && request.query?.all === 'true') {
      const requestedAt = typeof request.query?.before === 'string' && Number.isFinite(Date.parse(request.query.before)) ? new Date(request.query.before).toISOString() : null;
      const deleteFilter = requestedAt ? `${userFilter}&updated_at=lte.${encodeURIComponent(requestedAt)}` : userFilter;
      await supabaseRequest(`tasks?${deleteFilter}`, { method: 'DELETE' });
      // The tombstone is durable in the user's profile so another device
      // cannot merge its stale local task cache back into the workspace.
      const clearedAt = requestedAt || new Date().toISOString();
      await ensureProfile(auth.userId);
      const profiles = await supabaseRequest(`profiles?${userFilter}&select=settings&limit=1`);
      const settings = profiles?.[0]?.settings && typeof profiles[0].settings === 'object' ? profiles[0].settings : {};
      settings.tasksClearedAt = clearedAt;
      await supabaseRequest('profiles', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ user_id: auth.userId, settings }]) });
      return json(response, 200, { cleared_at: clearedAt });
    }
    const id = request.query?.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json(response, 400, { error: 'A valid task id is required' });
    if (request.method === 'PATCH') {
      const input = body.task || {};
      const patch = input.title === undefined ? normalizeTask({ title: 'placeholder', ...input }) : normalizeTask(input);
      if (input.title === undefined) delete patch.title;
      const update = { ...patch, updated_at: new Date().toISOString() };
      // Keep timing persistence working while older deployments finish the
      // schedule-authority migration. New schemas keep the precise reason;
      // old schemas can still accept the existing generic conflict value.
      const compatibilityUpdate = update.schedule_change_reason === 'HARD_COMMITMENT_CONFLICT'
        ? { ...update, schedule_change_reason: 'TIME_CONFLICT' }
        : update;
      // Preserve assignment/reminder metadata before falling back to reduced
      // legacy payloads. Otherwise a legacy priority constraint can accept an
      // update while silently dropping the reminder fields.
      const patchPayloads = [update, compatibilityUpdate, legacyPriorityCompatibilityPayload(update), legacySchemaPriorityPayload(update), legacySchemaPriorityPayload(update, { openStatus: true }), ...legacyTaskPayloads(update), legacySafeTextPayload(update), legacyMinimalTextPayload(update)];
      let rows;
      let lastError;
      for (const payload of patchPayloads) {
        try {
          rows = await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&${userFilter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(payload) });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!canRetryLegacyTask(error)) throw error;
        }
      }
      if (lastError) throw lastError;
      if (!rows?.[0]) {
        console.warn('Task update matched no row', { taskId: id });
        return json(response, 404, { error: 'Task was not found or could not be updated' });
      }
      return json(response, 200, { task: rows[0] });
    }
    if (request.method === 'DELETE') {
      await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&${userFilter}`, { method: 'DELETE' });
      return response.status(204).end();
    }
    return json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Task API operation failed', {
      status: error.status || 422,
      message: error.message,
      code: error.body?.code,
      constraint: error.body?.constraint,
      details: error.body?.details,
      hint: error.body?.hint
    });
    return json(response, error.status || 422, { error: error.message || 'Task operation failed', details: error.body || undefined });
  }
}
