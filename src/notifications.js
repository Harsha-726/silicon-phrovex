import { dateAt, taskExecution, toDateKey } from './core.js';

export const TASK_REMINDER_LEAD_MINUTES = 5;

export function taskNotificationTiming(task, now = new Date(), leadMinutes = TASK_REMINDER_LEAD_MINUTES) {
  if (!task || task.status === 'completed') return null;
  const execution = taskExecution(task);
  const date = execution.date || task.dueDate || null;
  const time = execution.time || task.dueTime || null;
  if (!date || !time) return null;
  const dueAt = dateAt(date, time);
  const minutesUntil = (dueAt.getTime() - now.getTime()) / 60000;
  const roundedMinutes = Math.round(minutesUntil);
  const today = toDateKey(now);
  if (minutesUntil >= 0 && minutesUntil <= leadMinutes) {
    // Keep the due-now alert distinct from the five-minute alert so the
    // browser can deliver both instead of deduplicating them under one tag.
    return { kind: minutesUntil <= 0.5 ? 'task-due-now' : 'task-due-soon', date, time: time.slice(0, 5), dueAt, minutesUntil: roundedMinutes };
  }
  if (date === today && minutesUntil < 0 && minutesUntil >= -leadMinutes) {
    return { kind: 'task-overdue', date, time: time.slice(0, 5), dueAt, minutesUntil: roundedMinutes };
  }
  return null;
}
