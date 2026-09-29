import { taskSyncTimestamp } from './core.js';

const remoteIdPattern = /^[0-9a-f-]{36}$/i;

function isRemoteTaskId(id) {
  return typeof id === 'string' && remoteIdPattern.test(id);
}

export function taskIdentity(task) {
  const identity = task?.idempotencyKey || task?.schedulingIdentity || null;
  if (!identity) return null;
  const raw = String(identity);
  // Early Schoology imports used ical:<uid>; current feed-scoped imports use
  // ical:schoology:<uid>. Give those forms one canonical identity while
  // keeping Todoist/file feed identities isolated.
  if (raw.startsWith('ical:')) {
    const parts = raw.split(':');
    if (parts.length === 2 || parts[1] === 'schoology') return `calendar:schoology:${parts.at(-1)}`;
    return `calendar:${parts[1]}:${parts.slice(2).join(':')}`;
  }
  return raw;
}

function isImportedTask(task) {
  return task?.source === 'calendar' || String(task?.idempotencyKey || '').startsWith('ical:');
}

// A completed imported event is a durable user action. If a legacy/current
// feed identity creates two rows for the same provider event, keep the
// completed row instead of reopening it from the newer duplicate. A deliberate
// reopen edits that canonical row and therefore remains the newer record.
export function preferTaskRecord(left, right) {
  if (isImportedTask(left) && isImportedTask(right) && left.status !== right.status) {
    return left.status === 'completed' ? left : right;
  }
  const leftTime = taskSyncTimestamp(left);
  const rightTime = taskSyncTimestamp(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (Boolean(left.status === 'completed') !== Boolean(right.status === 'completed')) return left.status === 'completed' ? left : right;
  if (isRemoteTaskId(left.id) !== isRemoteTaskId(right.id)) return isRemoteTaskId(left.id) ? left : right;
  return String(left.id || '').localeCompare(String(right.id || '')) <= 0 ? left : right;
}

export function deduplicateTaskRecords(tasks) {
  const owners = new Map();
  const duplicates = [];
  for (const task of tasks) {
    const identity = taskIdentity(task);
    if (!identity) continue;
    const previous = owners.get(identity);
    if (!previous) { owners.set(identity, task); continue; }
    const winner = preferTaskRecord(previous, task);
    const loser = winner === previous ? task : previous;
    owners.set(identity, winner);
    duplicates.push(loser);
  }
  const duplicateIds = new Set(duplicates.map(task => task.id));
  return { tasks: tasks.filter(task => !duplicateIds.has(task.id)), duplicates };
}
