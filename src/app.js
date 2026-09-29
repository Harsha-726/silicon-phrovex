import { ASSIGNMENT_TYPES, SCHEDULE_ORIGINS, SCHEDULE_CHANGE_REASONS, addDays, assignUniqueClassHues, assignmentTypeLabel, assessmentTitle, buildPlanningState, cleanTaskTitle, clearTaskExecution, dateAt, deadlineRisk, expandRecurringTask, extractSubject, formatDate, formatLongDate, formatTime, gamificationLevel, generateCandidateWindows, inferAssignmentType, isClearedByTaskTombstone, isDateKey, isOverdue, isPastSchedule, isRigidExecution, makeTask, matchExistingClass, normalizeClassColorKey, normalizeRecurrence, parseCapture, planStudySessions, planStudySessionsOnDates, planWorkload, planningSummary, rankRecommendations, recommendNextAction, replanAssessmentSessions, recordCompletion, recurrenceFromText, removeClassFromTitle, resolvePriority, scheduleOriginOf, seedState, setTaskExecution, stableColorHue, taskExecution, taskSort, taskSyncTimestamp, teamTaskFeedRecord, titleCaseTaskTitle, toDateKey, uid, updateStreak, INTENTS } from './core.js';
import { parseCaptureCommands } from './capture.js';
import { filterCalendarEvents, inferSchoologyClassHint, isNonAcademicSchoologyEvent, isPastImportedOneTimeTask, parseICal, preserveImportedCalendarTask, repairImportedCalendarClass } from './ical.js';
import { clerk, clerkLoadOptions, platformStatus } from './platform.js';
import { createTaskRepository } from './repository.js';
import { createTaskPersistenceCoordinator } from './task-persistence.js';
import './styles.css';

const STORAGE_KEY = 'silico.state.v1';
const PROFILE_PICTURE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const PROFILE_PICTURE_MAX_DIMENSION = 1024;
const teamsEnabled = true;
let currentUser = null;
let state = seedState();
let repository = null;
const taskPersistence = createTaskPersistenceCoordinator(task => repository?.create(task) || Promise.resolve(task));
const views = new Set(['today', 'upcoming', 'calendar', 'inbox', 'brain-dump', 'study', 'completed', 'classes', 'projects', 'teams', 'settings', 'feedback-admin']);
let view = views.has(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
let selectedTaskId = null;
let nextUpTaskId = null;
let onboardingStep = 0;
let selectedCollection = null;
let captureValue = '';
let captureDraft = { priority: '', className: '', project: '', dueDate: '' };
let capturePriorityAutoDetected = false;
let captureClassAutoDetected = false;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = null;
let isSyncing = false;
let isProcessingCapture = false;
let isSidebarOpen = false;
let taskCreationBusy = false;
let profilePictureBusy = false;
let pointerDragState = null;
let pointerDragFallbackBound = false;
let profileMutationVersion = 0;
let calendarFeedSyncPromise = null;
let calendarFeedBusy = false;
let calendarExportBusy = false;
let calendarExportUrl = '';
let calendarExportActive = false;
let feedbackBusy = false;
let feedbackAdminBusy = false;
let feedbackAdminLoaded = false;
let feedbackAdminError = '';
let feedbackItems = [];
let feedbackDraft = { category: 'feedback', message: '' };
let feedbackAdminKey = localStorage.getItem(`${STORAGE_KEY}.feedback-admin-key`) || '';
let teamProjects = [];
let teamTaskFeed = [];
let teamTaskClearTimestamps = {};
let activeTeamProjectId = null;
let activeTeamDetail = null;
let activeTeamFiles = [];
let activeTeamSubprojectId = null;
let editingTeamTaskId = null;
let teamBusy = false;
let teamInviteCodes = {};
let undoEntry = null;
let undoTimer = null;
let undoBusy = false;
let activeToast = null;
let notificationsOpen = false;
let lastPlannerToastKey = '';
let remoteSyncPromise = null;
let localScheduleMutationVersion = 0;
const localScheduleMutations = new Map();
let backgroundRenderPending = false;
let authRenderMode = null;
let timeSensitiveViewSignature = '';
let assistantResult = null;
let voiceRecognition = null;
let studyMaterials = [];
let studyArtifacts = [];
let studyUsage = null;
let studyArtifact = null;
let studyBilling = null;
let studyLoading = false;
let studyBusy = false;
let billingBusy = false;
let studyError = '';
const STUDY_DRAFT_STORAGE_KEY = `${STORAGE_KEY}.study-draft`;
function readStudyDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_DRAFT_STORAGE_KEY) || '{}');
    return { format: ['flashcards', 'quiz', 'study_guide', 'summary'].includes(saved.format) ? saved.format : 'flashcards', difficulty: ['easy', 'medium', 'hard'].includes(saved.difficulty) ? saved.difficulty : 'medium', count: Math.min(50, Math.max(5, Math.round(Number(saved.count) || 20))) };
  } catch {
    return { format: 'flashcards', difficulty: 'medium', count: 20 };
  }
}
let studyDraft = readStudyDraft();
function saveStudyDraft() {
  try { localStorage.setItem(STUDY_DRAFT_STORAGE_KEY, JSON.stringify(studyDraft)); } catch { /* storage may be unavailable */ }
}
let voiceState = 'idle';
const SYNC_INTERVAL_MS = 3_000;
const CLOCK_REFRESH_INTERVAL_MS = 5_000;
const STUDY_MOTION_DURATION_MS = 5_800;
// Recurring work has an infinite mathematical horizon. The UI must never
// materialize that horizon into millions of occurrence objects just because
// the user chose “All open tasks”. Keep the view useful for a full school year
// while making the upper bound explicit and safe.
const MAX_UPCOMING_RANGE_DAYS = 366;
const STUDY_MOTION_EPOCH = performance.now();
const CURRENT_BUNDLE_PATH = new URL(import.meta.url, location.href).pathname;
let staleBundleReloaded = false;
const localRecoveryAttempts = new Set();
const localDeletedTaskIds = new Set();
const localDeletedTaskIdentities = new Set();

// A tab can keep an old Vite bundle alive indefinitely after a deployment.
// That matters here because the old bundle could still contain the removed
// guest-workspace fallback. Compare the loaded entry asset with the current
// no-store document and replace stale tabs before they can render old UI.
async function refreshIfBundleIsStale() {
  if (staleBundleReloaded || !CURRENT_BUNDLE_PATH.includes('/assets/')) return;
  try {
    const response = await fetch(`/?__silico_build_check=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const html = await response.text();
    const currentAsset = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    if (!currentAsset || currentAsset === CURRENT_BUNDLE_PATH) return;
    staleBundleReloaded = true;
    location.reload();
  } catch {
    // A transient network failure must not interrupt a usable signed-in tab.
  }
}
setTimeout(() => { void refreshIfBundleIsStale(); }, 2_000);
setInterval(() => { void refreshIfBundleIsStale(); }, 30_000);

function authenticatedUser(user) {
  if (!user?.id) return null;
  const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress;
  return email ? user : null;
}

function currentUserEmail(user = currentUser) {
  return user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || '';
}

function renderUnauthenticatedRoute() {
  const page = new URLSearchParams(location.search).get('page');
  if (['about', 'privacy', 'it-admin', 'setup'].includes(page)) renderPublicInfoPage(page);
  else renderAuth();
}

function purgeLegacyGuestWorkspace() {
  ['guest', 'team-invites.guest', 'team-cleared.guest', 'calendar-export.guest', 'streak-seen.guest', 'team-invites.unauthenticated', 'team-cleared.unauthenticated', 'calendar-export.unauthenticated', 'streak-seen.unauthenticated'].forEach(suffix => {
    try { localStorage.removeItem(`${STORAGE_KEY}.${suffix}`); } catch { /* storage may be unavailable */ }
  });
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage may be unavailable */ }
}
purgeLegacyGuestWorkspace();

const iconPaths = {
  today: '<circle cx="10" cy="10" r="6.5"/><path d="M10 7v3l2 1"/>',
  calendar: '<rect x="2.5" y="3.5" width="15" height="14" rx="2"/><path d="M6 2.5v3M14 2.5v3M2.5 8h15"/>',
  grid: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
  brain: '<path d="M8.5 3.5a2.5 2.5 0 0 0-4.7 1.2A2.7 2.7 0 0 0 3 10a2.7 2.7 0 0 0 1.8 4.9A2.5 2.5 0 0 0 9 14.2V5.8a2.5 2.5 0 0 0-.5-2.3Z"/><path d="M11.5 3.5a2.5 2.5 0 0 1 4.7 1.2A2.7 2.7 0 0 1 17 10a2.7 2.7 0 0 1-1.8 4.9A2.5 2.5 0 0 1 11 14.2V5.8a2.5 2.5 0 0 1 .5-2.3ZM6 7h2M6 11h2M12 7h2M12 11h2M10 5v10"/>',
  feedback: '<path d="M3 4.5A2.5 2.5 0 0 1 5.5 2h9A2.5 2.5 0 0 1 17 4.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3.5A2.5 2.5 0 0 1 3 10.5v-6Z"/><path d="M7 7h6M7 10h3"/>',
  inbox: '<path d="M3 5.5h14l1 9.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2l1-9.5Z"/><path d="M3 12h3l1.5 2h5L14 12h3M6 5.5l1-3h6l1 3"/>',
  book: '<path d="M3 4.5A2.5 2.5 0 0 1 5.5 2H17v14H5.5A2.5 2.5 0 0 0 3 18.5v-14Z"/><path d="M3 18.5A2.5 2.5 0 0 1 5.5 16H17M7 6h6M7 9h6"/>',
  folder: '<path d="M2.5 5.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z"/>',
  settings: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7"/>',
  bell: '<path d="M4 14.5h12l-1.4-2V9a4.6 4.6 0 0 0-9.2 0v3.5L4 14.5Z"/><path d="M8 17h4"/>',
  microphone: '<rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 10.5a5.5 5.5 0 0 0 11 0M10 16v2.5M7 18.5h6"/>',
  sparkle: '<path d="m10 2 1.6 5.4L17 10l-5.4 1.6L10 17l-1.6-5.4L3 10l5.4-2.6L10 2Z"/><path d="m16.5 14 .6 2 1.9.6-1.9.6-.6 2-.6-2-1.9-.6 1.9-.6.6-2Z"/>',
  completed: '<path d="m4 10 4 4 8-8"/>',
  streak: '<path d="M10 18c-3.2 0-5.5-2.1-5.5-5.2 0-2.6 1.6-4.4 3.2-6.2C8.8 5.3 9.7 4 9.6 2c2.2 1.3 4.2 3.9 4.2 6.6 0 .4 0 .8-.1 1.2.6-.5 1-1.1 1.3-1.8.9 1.1 1.5 2.6 1.5 4.1 0 3.5-2.8 5.9-6.5 5.9Z"/><path class="flame-inner" d="M10.2 16.2c-1.3-.2-2.3-1.2-2.3-2.6 0-1 .5-1.8 1.1-2.6.4-.5.7-1 .8-1.6.9.8 1.7 1.9 1.7 3.1 0 .3 0 .5-.1.8.4-.3.7-.6.9-1 .3.5.5 1 .5 1.6 0 1.2-1.1 2.2-2.6 2.3Z"/>'
};

function svgIcon(name, className = '') { return `<svg class="${className}" viewBox="0 0 20 20" aria-hidden="true">${iconPaths[name] || ''}</svg>`; }
const brandMarkup = '<span class="brand-mark"><img src="/favicon.svg?v=3" alt="" aria-hidden="true" /></span><span>Silico</span>';
const calendarFeedDefinitions = [
  { id: 'schoology', label: 'Schoology' },
  { id: 'todoist', label: 'Todoist' }
];

function calendarFeeds() {
  const stored = Array.isArray(state.profile.calendarFeeds) ? state.profile.calendarFeeds : [];
  return calendarFeedDefinitions.map(definition => {
    const saved = stored.find(feed => feed?.id === definition.id) || {};
    const legacySchoology = definition.id === 'schoology' && !saved.url ? {
      url: state.profile.calendarFeedUrl || '',
      className: state.profile.calendarFeedClassName || '',
      lastSyncedAt: state.profile.calendarFeedLastSyncedAt || null
    } : {};
    return { ...definition, ...legacySchoology, ...saved, url: typeof (saved.url ?? legacySchoology.url) === 'string' ? (saved.url ?? legacySchoology.url) : '', className: typeof (saved.className ?? legacySchoology.className) === 'string' ? (saved.className ?? legacySchoology.className) : '', lastSyncedAt: saved.lastSyncedAt ?? legacySchoology.lastSyncedAt ?? null };
  });
}

function saveCalendarFeeds(feeds) {
  state.profile.calendarFeeds = feeds.map(feed => ({ id: feed.id, url: feed.url || '', className: feed.className || '', lastSyncedAt: feed.lastSyncedAt || null }));
}

function calendarFeed(feedId) { return calendarFeeds().find(feed => feed.id === feedId) || calendarFeeds()[0]; }

function calendarTaskKey(uid, feedId = 'file') { return `ical:${feedId}:${uid}`; }

function calendarImportSection() {
  const forms = calendarFeeds().map(feed => {
    const classOptions = [`<option value="">Auto-match class</option>`, ...state.classes.map(name => `<option value="${escapeHtml(name)}" ${feed.className === name ? 'selected' : ''}>${escapeHtml(name)}</option>`)].join('');
    const classField = feed.id === 'schoology'
      ? '<p class="muted calendar-feed-class-note">Schoology events use their course metadata or a confident title match. Unmatched events stay unassigned.</p>'
      : `<label for="calendar-feed-class-${feed.id}">Default class for unmatched events<select id="calendar-feed-class-${feed.id}" data-calendar-feed-class>${classOptions}</select></label>`;
    const lastSynced = feed.lastSyncedAt ? `Last synced ${new Date(feed.lastSyncedAt).toLocaleString()}.` : 'Not synced yet.';
    return `<form class="calendar-feed-form calendar-feed-source" data-calendar-feed-form data-feed-id="${feed.id}"><div class="settings-title"><h3>${feed.label}</h3><p>${feed.id === 'todoist' ? 'Import your Todoist tasks without replacing your Schoology calendar.' : 'Keep your Schoology events in their own calendar feed.'}</p></div><label for="ical-feed-url-${feed.id}">${feed.label} calendar feed URL<input id="ical-feed-url-${feed.id}" data-calendar-feed-url type="url" value="${escapeHtml(feed.url)}" placeholder="webcal://…" autocomplete="off"/></label>${classField}<div class="calendar-feed-actions"><button class="primary-button" type="submit" ${calendarFeedBusy ? 'disabled' : ''}>${calendarFeedBusy ? '<span class="capture-spinner"></span>Syncing…' : feed.url ? 'Save & sync' : 'Save feed'}</button>${feed.url ? `<button class="secondary-button" type="button" data-action="remove-calendar-feed" data-feed-id="${feed.id}">Remove feed</button>` : ''}<span class="calendar-feed-status">${escapeHtml(lastSynced)}</span></div></form>`;
  }).join('');
  return `<section class="settings-section calendar-import-section"><div class="settings-title"><h2>Import school calendars</h2><p>Add separate iCal feeds for Schoology and Todoist. Each feed is synced independently, so saving one never replaces the other.</p></div>${forms}<input id="ical-import" type="file" accept=".ics,text/calendar" hidden/><label for="ical-import" class="secondary-button file-button">Import an .ics file instead</label></section>`;
}

function calendarExportStorageKey() { return currentUser?.id ? `${STORAGE_KEY}.calendar-export.${currentUser.id}` : null; }

function loadCalendarExportState() {
  const key = calendarExportStorageKey();
  calendarExportUrl = key ? localStorage.getItem(key) || '' : '';
  calendarExportActive = Boolean(calendarExportUrl);
}

function calendarExportSection() {
  const active = calendarExportActive || Boolean(calendarExportUrl);
  const urlField = calendarExportUrl
    ? `<label for="calendar-export-url">Private Silico feed URL<input id="calendar-export-url" type="url" value="${escapeHtml(calendarExportUrl)}" readonly /></label>`
    : `<p class="muted">${active ? 'This feed is active, but its secret URL is not available on this device. Regenerate it to reveal a new URL.' : 'Generate a private URL for Google Calendar to subscribe to.'}</p>`;
  return `<section id="calendar-export-section" class="settings-section calendar-export-section"><div class="settings-title"><h2>Publish to Google Calendar</h2><p>This is one-way syncing: Google Calendar reads Silico’s private calendar feed. Changes made in Google Calendar will not update Silico.</p></div>${urlField}<div class="calendar-feed-actions"><button class="primary-button" type="button" data-action="generate-calendar-feed" ${calendarExportBusy ? 'disabled' : ''}>${calendarExportBusy ? 'Generating…' : active ? 'Regenerate feed URL' : 'Generate feed URL'}</button>${calendarExportUrl ? '<button class="secondary-button" type="button" data-action="copy-calendar-feed">Copy feed URL</button>' : ''}${active ? '<button class="danger-button" type="button" data-action="revoke-calendar-feed" ' + (calendarExportBusy ? 'disabled' : '') + '>Revoke feed</button>' : ''}</div><div class="settings-title calendar-instructions"><p><strong>Connect it in Google Calendar</strong></p><p>1. Copy the Silico calendar feed URL.<br/>2. Open Google Calendar on desktop.<br/>3. Select Other calendars → From URL.<br/>4. Paste the Silico feed URL.<br/>5. Add the calendar.</p><p class="muted">Google Calendar subscriptions are read-only and refresh periodically.</p></div></section>`;
}

function teamInviteStorageKey() { return currentUser?.id ? `${STORAGE_KEY}.team-invites.${currentUser.id}` : null; }
function loadTeamInviteCodes() {
  const key = teamInviteStorageKey();
  try { teamInviteCodes = key ? JSON.parse(localStorage.getItem(key) || '{}') || {} : {}; } catch { teamInviteCodes = {}; }
}
function saveTeamInviteCodes() { const key = teamInviteStorageKey(); if (key) localStorage.setItem(key, JSON.stringify(teamInviteCodes)); }
function teamTaskClearStorageKey() { return currentUser?.id ? `${STORAGE_KEY}.team-cleared.${currentUser.id}` : null; }
function loadTeamTaskClearTimestamps() {
  const key = teamTaskClearStorageKey();
  try { teamTaskClearTimestamps = key ? JSON.parse(localStorage.getItem(key) || '{}') || {} : {}; } catch { teamTaskClearTimestamps = {}; }
}
function saveTeamTaskClearTimestamps() { const key = teamTaskClearStorageKey(); if (key) localStorage.setItem(key, JSON.stringify(teamTaskClearTimestamps)); }
function teamWeekStart() { const date = new Date(); date.setDate(date.getDate() - date.getDay()); return toDateKey(date); }

function storageKey() { return currentUser?.id ? `${STORAGE_KEY}.${currentUser.id}` : null; }
function loadState() {
  const key = storageKey();
  if (!key) return seedState();
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (!saved || typeof saved !== 'object') return seedState();
    const savedTasks = Array.isArray(saved.tasks) ? saved.tasks : [];
    if (savedTasks.some(task => String(task?.id || '').startsWith('seed_'))) {
      localStorage.removeItem(key);
      return seedState();
    }
    return { ...saved, tasks: savedTasks };
  } catch { return seedState(); }
}
function saveState() { state.deletedTaskIds = [...localDeletedTaskIds]; state.deletedTaskIdentities = [...localDeletedTaskIdentities]; const key = storageKey(); if (key) localStorage.setItem(key, JSON.stringify(state)); }
function cloneState(value) { return JSON.parse(JSON.stringify(value)); }
function stateSnapshot() { return cloneState(state); }
function isRemoteTaskId(id) { return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id); }
function taskIdentity(task) {
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

// A provider/capture identity is the logical task key. Database IDs are only
// row identities, so merging solely by row ID lets an old and a newly-imported
// copy of the same event coexist. Keep the newest meaningful record and make
// the losing rows part of the normal deletion/tombstone path.
function preferTaskRecord(left, right) {
  const leftTime = taskSyncTimestamp(left);
  const rightTime = taskSyncTimestamp(right);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  if (Boolean(left.status === 'completed') !== Boolean(right.status === 'completed')) return left.status === 'completed' ? left : right;
  if (isRemoteTaskId(left.id) !== isRemoteTaskId(right.id)) return isRemoteTaskId(left.id) ? left : right;
  return String(left.id || '').localeCompare(String(right.id || '')) <= 0 ? left : right;
}

function deduplicateTaskRecords(tasks) {
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

function offerUndo(message, previousState = null) {
  if (!previousState) { showToast(message); return; }
  const token = uid('undo');
  undoEntry = { token, message, previousState: cloneState(previousState) };
  clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => {
    if (undoEntry?.token === token) undoEntry = null;
  }, 6000);
  showToast(message, { label: 'Undo', onClick: () => { void undoMutation(token); } });
}

function profileDisplayName() {
  return String(state.profile?.displayName || '').trim()
    || currentUser?.firstName
    || currentUser?.username
    || currentUserEmail().split('@')[0]
    || 'Your profile';
}

function notificationStorageId(type, task, suffix = '') {
  return `notification:${type}:${task?.id || 'workspace'}:${suffix || task?.updatedAt || toDateKey()}`;
}

function addAppNotification({ type = 'info', title, body = '', task = null, id = '' } = {}) {
  if (!title) return;
  state.profile.notifications ||= [];
  const notificationId = id || notificationStorageId(type, task);
  if (state.profile.notifications.some(item => item.id === notificationId)) return;
  state.profile.notifications.unshift({ id: notificationId, type, title: String(title).slice(0, 180), body: String(body).slice(0, 500), taskId: task?.id || null, createdAt: new Date().toISOString(), read: false });
  state.profile.notifications = state.profile.notifications.slice(0, 100);
  saveState();
  void persistProfile();
  if (typeof window !== 'undefined' && 'Notification' in window) {
    const notify = () => { if (Notification.permission === 'granted') new Notification(title, { body, icon: '/favicon.svg' }); };
    if (Notification.permission === 'granted') notify();
    else if (Notification.permission === 'default' && type === 'task-created') void Notification.requestPermission().then(permission => { if (permission === 'granted') notify(); }).catch(() => {});
  }
  if (notificationsOpen) render();
}

function checkDueNotifications(now = new Date()) {
  const todayKey = toDateKey(now);
  state.tasks.filter(task => task.status !== 'completed').forEach(task => {
    const date = taskDisplayDate(task);
    const time = taskDisplayTime(task);
    if (!date || !time) return;
    const dueAt = dateAt(date, time);
    const minutesUntil = Math.round((dueAt.getTime() - now.getTime()) / 60000);
    if (minutesUntil >= 0 && minutesUntil <= 5) {
      addAppNotification({
        type: 'task-due-soon',
        task,
        id: notificationStorageId('task-due-soon', task, `${date}T${time.slice(0, 5)}`),
        title: `${task.title} is due soon`,
        body: minutesUntil === 0 ? 'Due now.' : `Due in ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}.`
      });
    }
    if (date === todayKey && dueAt.getTime() < now.getTime() && minutesUntil >= -5) {
      addAppNotification({ type: 'task-overdue', task, id: notificationStorageId('task-overdue', task, `${date}T${time.slice(0, 5)}`), title: `${task.title} is overdue`, body: 'Open the task to reschedule it.' });
    }
  });
}

function renderNotificationPanel() {
  if (!notificationsOpen) return '';
  const notifications = Array.isArray(state.profile.notifications) ? state.profile.notifications : [];
  const unread = notifications.filter(item => !item.read).length;
  return `<div class="notification-backdrop" data-action="close-notifications"></div><aside class="notification-panel" aria-label="Notifications"><div class="notification-panel-header"><div><div class="eyebrow">Workspace</div><h2>Notifications</h2></div><button class="icon-button" type="button" data-action="close-notifications" aria-label="Close notifications">×</button></div><div class="notification-panel-actions">${unread ? `<button class="secondary-button" type="button" data-action="mark-notifications-read">Mark all read</button>` : '<span class="muted">You’re all caught up.</span>'}</div><div class="notification-list">${notifications.length ? notifications.map(item => `<button class="notification-item ${item.read ? '' : 'is-unread'}" type="button" data-action="open-notification" data-id="${escapeHtml(item.id)}"><span class="notification-dot"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.body)}</small><time>${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : '')}</time></span></button>`).join('') : '<p class="muted notification-empty">No notifications yet.</p>'}</div></aside>`;
}

async function reconcileUndoState(afterState, desiredState) {
  if (!repository) return;
  if (afterState.profile?.tasksClearedAt && !desiredState.profile?.tasksClearedAt) desiredState.profile.tasksClearedAt = null;
  const remoteTasks = await repository.load();
  const desiredTasks = desiredState.tasks || [];
  const afterIds = new Set((afterState.tasks || []).map(task => task.id));
  const desiredById = new Map(desiredTasks.map(task => [task.id, task]));
  const desiredByIdentity = new Map(desiredTasks.map(task => [taskIdentity(task), task]).filter(([identity]) => identity));
  const remoteById = new Map(remoteTasks.map(task => [task.id, task]));
  const remoteByIdentity = new Map(remoteTasks.map(task => [taskIdentity(task), task]).filter(([identity]) => identity));

  await Promise.all(remoteTasks.filter(task => !desiredById.has(task.id) && !desiredByIdentity.has(taskIdentity(task))).filter(task => isRemoteTaskId(task.id)).map(task => repository.remove(task.id)));

  const idMap = new Map();
  const restoreCandidates = desiredTasks.filter(task => !afterIds.has(task.id)).sort((a, b) => (a.type === 'assessment' ? -1 : 0) - (b.type === 'assessment' ? -1 : 0));
  for (const task of restoreCandidates) {
    const existing = remoteById.get(task.id) || remoteByIdentity.get(taskIdentity(task));
    if (existing) {
      const oldId = task.id;
      Object.assign(task, existing);
      idMap.set(oldId, task.id);
      continue;
    }
    const payload = { ...task, relatedAssessmentId: idMap.get(task.relatedAssessmentId) || task.relatedAssessmentId };
    const restored = await persistCreatedTask(payload);
    const oldId = task.id;
    Object.assign(task, restored);
    idMap.set(oldId, task.id);
  }

  const afterById = new Map((afterState.tasks || []).map(task => [task.id, task]));
  await Promise.all(desiredTasks.filter(task => afterById.has(task.id) && isRemoteTaskId(task.id) && JSON.stringify(task) !== JSON.stringify(afterById.get(task.id))).map(task => repository.update(task)));

  const occurrenceKeys = new Set([...Object.keys(afterState.occurrenceCompletions || {}), ...Object.keys(desiredState.occurrenceCompletions || {})]);
  await Promise.all([...occurrenceKeys].filter(key => Boolean(afterState.occurrenceCompletions?.[key]) !== Boolean(desiredState.occurrenceCompletions?.[key])).map(key => {
    const separator = key.lastIndexOf('::');
    if (separator < 1) return null;
    const sourceId = idMap.get(key.slice(0, separator)) || key.slice(0, separator);
    if (!isRemoteTaskId(sourceId)) return null;
    return repository.setOccurrence(sourceId, key.slice(separator + 2), Boolean(desiredState.occurrenceCompletions?.[key]));
  }).filter(Boolean));
  await repository.saveProfile(desiredState.profile, desiredState.classes, desiredState.projects);
}

async function undoMutation(token) {
  if (undoBusy || undoEntry?.token !== token) return;
  const entry = undoEntry;
  undoEntry = null;
  clearTimeout(undoTimer);
  undoBusy = true;
  const afterState = stateSnapshot();
  state = cloneState(entry.previousState);
  localDeletedTaskIds.clear();
  localDeletedTaskIdentities.clear();
  (state.deletedTaskIds || []).forEach(id => localDeletedTaskIds.add(id));
  (state.deletedTaskIdentities || []).forEach(identity => localDeletedTaskIdentities.add(identity));
  selectedTaskId = null;
  document.querySelector('.level-up-celebration')?.remove();
  saveState();
  render();
  showToast('Undoing…');
  try {
    await reconcileUndoState(afterState, state);
    saveState();
    render();
    showToast(`${entry.message} undone.`);
  } catch {
    saveState();
    render();
    showToast('Restored locally, but the database sync needs another try.');
  } finally {
    undoBusy = false;
  }
}
function persistProfile() {
  profileMutationVersion += 1;
  return repository?.saveProfile(state.profile, state.classes, state.projects).catch(() => showToast('Could not sync preferences. They are saved locally.'));
}
function defaultClassPreference() { return { sessionsPerWeek: 2, sessionLength: 45 }; }
function classAllocationValue(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(30, Math.round(number))) : 0; }
function updateClassAllocation(input) {
  const name = input?.dataset.class;
  if (!name) return;
  state.profile.classPreferences ||= {};
  state.profile.classPreferences[name] = { ...(state.profile.classPreferences[name] || defaultClassPreference()), sessionsPerWeek: classAllocationValue(input.value) };
}
function normalizeState() {
  const defaults = seedState();
  state = { ...defaults, ...state, profile: { ...defaults.profile, ...(state.profile || {}), gamification: { ...defaults.profile.gamification, ...(state.profile?.gamification || {}) } } };
  state.profile.displayName = typeof state.profile.displayName === 'string' ? state.profile.displayName.trim().slice(0, 80) : '';
  state.profile.notifications = (Array.isArray(state.profile.notifications) ? state.profile.notifications : []).filter(item => item && typeof item.id === 'string').slice(0, 100);
  state.profile.inboxWindowDays = [0, 7, 30, 90].includes(Number(state.profile.inboxWindowDays)) ? Number(state.profile.inboxWindowDays) : 30;
  state.profile.taskOrder = state.profile.taskOrder && typeof state.profile.taskOrder === 'object' && !Array.isArray(state.profile.taskOrder) ? state.profile.taskOrder : {};
  state.profile.gamification.level = gamificationLevel(state.profile.gamification.xp);
  // Keep the two source feeds as a durable, independently editable setting.
  // Older profiles only have the original Schoology feed fields; migrate that
  // value in memory without losing it on the next profile save.
  state.profile.calendarFeeds = calendarFeeds().map(feed => ({ id: feed.id, url: feed.url, className: feed.className, lastSyncedAt: feed.lastSyncedAt }));
  state.tasks = (Array.isArray(state.tasks) ? state.tasks : []).map((task, index) => normalizeTaskRecord(task, index)).filter(Boolean);
  repairEventReminderSchedules();
  state.classes = uniqueLabels(state.classes);
  state.projects = uniqueLabels(state.projects);
  ensureClassColors();
  localDeletedTaskIds.clear();
  (Array.isArray(state.deletedTaskIds) ? state.deletedTaskIds : []).filter(id => typeof id === 'string' && id.length <= 120).forEach(id => localDeletedTaskIds.add(id));
  localDeletedTaskIdentities.clear();
  (Array.isArray(state.deletedTaskIdentities) ? state.deletedTaskIdentities : []).filter(id => typeof id === 'string' && id.length <= 255).forEach(id => localDeletedTaskIdentities.add(id));
  state.deletedTaskIds = [...localDeletedTaskIds];
  state.deletedTaskIdentities = [...localDeletedTaskIdentities];
}
function uniqueLabels(values) {
  const labels = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const label = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const key = label.toLowerCase();
    if (label && !seen.has(key)) { seen.add(key); labels.push(label); }
  }
  return labels;
}
function normalizeTaskRecord(task, index = 0) {
  if (!task || typeof task !== 'object') return null;
  const dueDate = isDateKey(task.dueDate) ? task.dueDate : null;
  const dueTime = typeof task.dueTime === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(task.dueTime) ? task.dueTime.slice(0, 8) : null;
  const priority = Number(task.priority);
  const duration = Number(task.duration);
  const scheduledDate = isDateKey(task.scheduledDate) ? task.scheduledDate : null;
  const scheduledTime = typeof task.scheduledTime === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(task.scheduledTime) ? task.scheduledTime.slice(0, 8) : null;
  const type = typeof task.type === 'string' ? task.type : 'task';
  const source = typeof task.source === 'string' ? task.source : 'capture';
  const title = String(task.title || 'Untitled task').trim().slice(0, 500) || 'Untitled task';
  const hasExplicitAssignmentType = task.assignmentTypeExplicit === true || (task.assignmentType && task.assignmentType !== 'other');
  const assignmentType = hasExplicitAssignmentType && ASSIGNMENT_TYPES.some(option => option.value === task.assignmentType) ? task.assignmentType : inferAssignmentType(title, type, source);
  const normalizedDuration = Number.isFinite(duration) && duration > 0 ? Math.min(1440, duration) : 30;
  const autoScheduled = task.autoScheduled === true;
  const explicitUserSchedule = task.userScheduled === true
    || task.userPinned === true
    || type === 'fixed_event'
    || source === 'calendar'
    || task.scheduleOrigin === SCHEDULE_ORIGINS.USER_SCHEDULED;
  const executionPinned = task.explicitExecution === true
    || task.userPinned === true
    || type === 'fixed_event'
    || source === 'calendar'
    || (!autoScheduled && Boolean(scheduledTime) && explicitUserSchedule);
  const datePinned = task.datePinned === true
    || type === 'fixed_event'
    || source === 'calendar'
    || (!autoScheduled && explicitUserSchedule && Boolean(scheduledDate));
  const explicitUserTiming = !autoScheduled && executionPinned && dueTime;
  // Older records used dueTime for the user's requested start and later
  // acquired a conflicting scheduledTime from the planner. For a
  // user-controlled task, the explicit clock time is the authoritative
  // execution time; normalize the stale planner value away at the boundary.
  const canonicalScheduledTime = explicitUserTiming && dueTime ? dueTime : scheduledTime;
  const userScheduled = !autoScheduled && explicitUserSchedule;
  const scheduleOrigin = Object.values(SCHEDULE_ORIGINS).includes(task.scheduleOrigin)
    ? task.scheduleOrigin
    : userScheduled ? SCHEDULE_ORIGINS.USER_SCHEDULED
    : autoScheduled && (scheduledDate || canonicalScheduledTime || dueTime) ? SCHEDULE_ORIGINS.SILICO_SCHEDULED
        : SCHEDULE_ORIGINS.UNSCHEDULED;
  const normalized = { ...task, id: typeof task.id === 'string' && task.id.trim() ? task.id : uid(`recovered${index}`), title, description: typeof task.description === 'string' ? task.description : '', status: task.status === 'completed' ? 'completed' : 'open', priority: [1, 2, 3, 4].includes(priority) ? priority : 1, dueDate, dueTime, scheduledDate, scheduledTime: canonicalScheduledTime, duration: normalizedDuration, remainingDuration: Number.isFinite(Number(task.remainingDuration)) ? Math.max(0, Math.min(normalizedDuration, Number(task.remainingDuration))) : normalizedDuration, className: typeof task.className === 'string' && task.className.trim() ? task.className.trim() : null, project: typeof task.project === 'string' && task.project.trim() ? task.project.trim() : null, assignmentType, autoScheduled, scheduleOrigin, datePinned, executionPinned, explicitExecution: task.explicitExecution === true, studyDateLocked: task.studyDateLocked === true, userPinned: task.userPinned === true, userScheduled, flexibility: task.flexibility || (autoScheduled && (scheduledDate || canonicalScheduledTime) ? 'planned' : executionPinned ? 'fixed' : 'flexible'), eventReminderEnabled: task.eventReminderEnabled === true, eventReminderRecipient: typeof task.eventReminderRecipient === 'string' ? task.eventReminderRecipient.trim().slice(0, 80) : '', reminderForTaskId: typeof task.reminderForTaskId === 'string' ? task.reminderForTaskId : null, recurrence: normalizeRecurrence(task.recurrence) };
  // Normalize legacy rows once at the boundary. All later writes use the
  // canonical execution setter, while the old columns remain mirrored for
  // database compatibility.
  setTaskExecution(normalized, scheduledDate, canonicalScheduledTime);
  return normalized;
}
function markTaskDeleted(id, task = null) {
  if (typeof id === 'string' && id.trim()) localDeletedTaskIds.add(id);
  const identity = taskIdentity(task || state.tasks.find(item => item.id === id));
  if (identity) localDeletedTaskIdentities.add(identity);
  state.deletedTaskIds = [...localDeletedTaskIds];
  state.deletedTaskIdentities = [...localDeletedTaskIdentities];
}
function markTaskSyncRetry(task) { if (task) { task.syncRetryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString(); saveState(); } }
function persistCreatedTask(task) { return taskPersistence.persist(task); }
function normalizeClassName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function collectOnboardingClassPreferences() {
  state.profile.classPreferences ||= {};
  document.querySelectorAll('.onboarding-class-sessions').forEach(input => {
    const name = input.dataset.class;
    const length = document.querySelector(`.onboarding-class-length[data-class="${CSS.escape(name)}"]`);
    state.profile.classPreferences[name] = { ...(state.profile.classPreferences[name] || defaultClassPreference()), sessionsPerWeek: Math.max(1, Math.min(14, Number(input.value) || 1)), sessionLength: Number(length?.value || 45) };
  });
}
function today() { return toDateKey(); }
function teamTaskIsCleared(task) {
  const clearedAt = Date.parse(teamTaskClearTimestamps[task?.team_project_id] || '');
  if (!Number.isFinite(clearedAt)) return false;
  const updatedAt = Date.parse(task?.updated_at || task?.updatedAt || task?.created_at || task?.createdAt || '') || 0;
  return updatedAt <= clearedAt;
}
function teamFeedTasks() { return teamTaskFeed.filter(task => !teamTaskIsCleared(task)).map(task => teamTaskFeedRecord(task)).filter(Boolean); }
function allTaskRecords() { return [...state.tasks, ...teamFeedTasks()]; }
function orderTasksForDate(tasks, dateKey) {
  const savedOrder = Array.isArray(state.profile.taskOrder?.[dateKey]) ? state.profile.taskOrder[dateKey] : [];
  const positions = new Map(savedOrder.map((id, index) => [id, index]));
  return [...tasks].sort((left, right) => {
    // A saved drag order is useful for unscheduled ties, but it can never put
    // a later execution time above an earlier one.
    const leftTimeValue = taskDisplayTime(left);
    const rightTimeValue = taskDisplayTime(right);
    const leftTime = leftTimeValue ? dateAt(taskDisplayDate(left) || dateKey, leftTimeValue).getTime() : Number.MAX_SAFE_INTEGER;
    const rightTime = rightTimeValue ? dateAt(taskDisplayDate(right) || dateKey, rightTimeValue).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftPosition = positions.get(left.id);
    const rightPosition = positions.get(right.id);
    if (leftPosition !== undefined || rightPosition !== undefined) {
      if (leftPosition === undefined) return 1;
      if (rightPosition === undefined) return -1;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    }
    return taskSort(left, right);
  });
}
function orderTasksByDate(tasks) {
  const groups = new Map();
  [...tasks].sort(taskSort).forEach(task => {
    // The schedule is grouped by the date the task will happen, not merely
    // by its deadline. A Sunday planned session with a later deadline must
    // never be inserted ahead of today's group.
    const dateKey = taskDisplayDate(task) || '';
    let group = groups.get(dateKey);
    if (!group) { group = []; groups.set(dateKey, group); }
    group.push(task);
  });
  return [...groups.entries()].flatMap(([dateKey, group]) => orderTasksForDate(group, dateKey));
}
function taskDisplayDate(task) { return taskExecution(task).date || task.dueDate; }
function taskDisplayTime(task) { return taskExecution(task).time || task.dueTime; }
function tasksForDate(dateKey) { return orderTasksForDate(allTaskRecords().flatMap(task => task.recurrence ? expandRecurringTask(task, dateKey, dateKey, state.occurrenceCompletions || {}) : [task]).filter(task => taskDisplayDate(task) === dateKey), dateKey); }
function calendarTasksForDate(dateKey) { return tasksForDate(dateKey).filter(task => task.status !== 'completed' && !(task.source === 'calendar' && task.dueDate && task.dueDate < today())); }
function boundedTaskRangeEnd(fromKey, toKey) {
  const start = isDateKey(fromKey) ? fromKey : today();
  const maximum = addDays(start, MAX_UPCOMING_RANGE_DAYS);
  return isDateKey(toKey) && toKey < maximum ? toKey : maximum;
}
function rangeTasks(fromKey, toKey) {
  const start = isDateKey(fromKey) ? fromKey : today();
  const end = boundedTaskRangeEnd(start, toKey);
  return orderTasksByDate(allTaskRecords().flatMap(task => task.recurrence ? expandRecurringTask(task, start, end, state.occurrenceCompletions || {}) : [task]).filter(task => { const date = taskDisplayDate(task); return date && date >= start && date <= end; }));
}
function nextUpcomingTask(tasks = rangeTasks(today(), addDays(today(), Number(state.profile.inboxWindowDays ?? 30) || 30))) {
  const todayKey = today();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return tasks
    .filter(task => task.status !== 'completed' && taskDisplayDate(task))
    .map(task => {
      const date = taskDisplayDate(task);
      const time = taskDisplayTime(task);
      const clock = time ? dateAt(date, time) : null;
      return { task, date, time, minutes: clock ? clock.getHours() * 60 + clock.getMinutes() : Number.MAX_SAFE_INTEGER };
    })
    .filter(item => item.date > todayKey || item.date < todayKey || !item.time || item.minutes >= nowMinutes)
    .sort((left, right) => left.date.localeCompare(right.date) || left.minutes - right.minutes || taskSort(left.task, right.task))[0]?.task || null;
}
function visibleTasks() { return rangeTasks(today(), addDays(today(), 30)); }
function getTaskById(id) { return allTaskRecords().find(task => task.id === id) || visibleTasks().find(task => task.id === id); }
function collectionTasks(type, name) { const field = type === 'class' ? 'className' : 'project'; return state.tasks.filter(task => task[field] === name).sort(taskSort); }
function avatarInitial() { const first = currentUser?.firstName?.trim()?.[0] || ''; const last = currentUser?.lastName?.trim()?.[0] || ''; const email = currentUser?.emailAddresses?.[0]?.emailAddress?.trim()?.[0] || ''; return `${first}${last || (!first ? email : '')}`.toUpperCase() || 'S'; }
function accountEmail() { return currentUser?.emailAddresses?.find(item => item?.emailAddress)?.emailAddress?.trim() || ''; }
function avatarContent() { return currentUser?.imageUrl ? `<img src="${escapeHtml(currentUser.imageUrl)}" alt=""/>` : escapeHtml(avatarInitial()); }
function profilePictureErrorMessage(error) {
  return error?.errors?.find(item => item?.longMessage || item?.message)?.longMessage
    || error?.errors?.find(item => item?.longMessage || item?.message)?.message
    || error?.message
    || 'Could not update your profile picture.';
}
function isImageFile(file) {
  return Boolean(file && (/^image\//i.test(file.type) || /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name || '')));
}
async function normalizeProfilePicture(file) {
  if (!isImageFile(file)) throw new Error('Choose an image file from your phone or computer.');
  if (file.size > PROFILE_PICTURE_SOURCE_MAX_BYTES) throw new Error('That image is larger than 25 MB. Choose a smaller photo.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('That photo could not be read by this browser. Try choosing it again or use JPG/PNG.'));
      element.src = objectUrl;
    });
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, PROFILE_PICTURE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare that photo. Try JPG or PNG.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) throw new Error('This browser could not prepare that photo. Try JPG or PNG.');
    return new File([blob], 'profile-picture.jpg', { type: 'image/jpeg', lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
async function updateProfilePicture(file) {
  if (!file || profilePictureBusy) return;
  if (!clerk?.user?.setProfileImage) {
    showToast('Profile picture updates are unavailable right now.');
    return;
  }
  profilePictureBusy = true;
  render();
  try {
    const uploadFile = await normalizeProfilePicture(file);
    await clerk.user.setProfileImage({ file: uploadFile });
    currentUser = authenticatedUser(clerk.user);
    showToast('Profile picture saved to your account.');
  } catch (error) {
    showToast(profilePictureErrorMessage(error));
  } finally {
    profilePictureBusy = false;
    render();
  }
}
function renderCompletedSection(tasks, { open = false } = {}) { if (!tasks.length) return ''; return `<details class="completed-section"${open ? ' open' : ''}><summary>Completed <span class="muted">${tasks.length}</span></summary><div class="completed-task-list">${tasks.map(renderTaskRow).join('')}</div></details>`; }

function renderCapture(scope = null) {
  const classValue = scope?.type === 'class' ? scope.name : captureDraft.className;
  const projectValue = scope?.type === 'project' ? scope.name : captureDraft.project;
  const dateValue = captureDraft.dueDate || '';
  const classOptions = [`<option value="">No class</option>`, ...state.classes.map(name => `<option value="${escapeHtml(name)}" ${classValue === name ? 'selected' : ''}>${escapeHtml(name)}</option>`)].join('');
  const projectOptions = [`<option value="">No project</option>`, ...state.projects.map(name => `<option value="${escapeHtml(name)}" ${projectValue === name ? 'selected' : ''}>${escapeHtml(name)}</option>`)].join('');
  const voiceLabel = voiceState === 'listening' ? 'Stop listening' : 'Speak to Silico';
  return `<form class="capture ${isProcessingCapture ? 'is-busy' : ''}" id="capture-form" aria-busy="${isProcessingCapture}" data-scope-type="${scope?.type || ''}" data-scope-name="${escapeHtml(scope?.name || '')}"><div class="capture-main"><span class="capture-plus">＋</span><input id="capture-input" value="${escapeHtml(captureValue)}" placeholder="${isProcessingCapture ? 'Working on it…' : 'Add a task or ask Silico anything…'}" autocomplete="off" ${isProcessingCapture ? 'disabled' : ''}/><button class="voice-button ${voiceState === 'listening' ? 'is-listening' : ''}" type="button" data-action="voice-capture" aria-label="${voiceLabel}" title="${voiceLabel}">${voiceState === 'listening' ? '■' : svgIcon('microphone', 'voice-icon')}</button><span class="capture-hint" aria-live="polite">${isProcessingCapture ? '<span class="capture-spinner"></span>Working' : voiceState === 'listening' ? 'Listening…' : 'Press <kbd>↵</kbd>'}</span></div><div class="capture-options"><label>Date<input class="capture-field" data-capture-field="dueDate" type="date" value="${escapeHtml(dateValue)}" aria-label="Task date"/></label><label>Priority<select class="capture-field" data-capture-field="priority" aria-label="Task priority"><option value="">Normal</option><option value="2" ${captureDraft.priority === '2' ? 'selected' : ''}>High</option><option value="3" ${captureDraft.priority === '3' ? 'selected' : ''}>Urgent</option><option value="4" ${captureDraft.priority === '4' ? 'selected' : ''}>Critical</option></select></label><label>Class<select class="capture-field" data-capture-field="className" ${scope?.type === 'class' ? 'disabled' : ''}>${classOptions}</select></label><label>Project<select class="capture-field" data-capture-field="project" ${scope?.type === 'project' ? 'disabled' : ''}>${projectOptions}</select></label></div></form>`;
}

function taskCreationOptions(type, selectedValue) {
  const emptyLabel = type === 'class' ? 'No class' : 'No project';
  const values = type === 'class' ? state.classes : state.projects;
  return [`<option value="">${emptyLabel}</option>`, ...values.map(value => `<option value="${escapeHtml(value)}" ${selectedValue === value ? 'selected' : ''}>${escapeHtml(value)}</option>`)].join('');
}

function closeTaskCreationOverlay() {
  document.querySelector('.task-create-backdrop')?.remove();
  taskCreationBusy = false;
}

async function createTaskFromOverlay(form, close) {
  if (taskCreationBusy) return;
  const data = new FormData(form);
  const title = String(data.get('title') || '').trim();
  if (!title) { form.elements.title?.focus(); return; }
  const dueDate = String(data.get('dueDate') || '').trim();
  const dueTime = String(data.get('dueTime') || '').trim();
  // A task created from the Q/add-task form is ordinary planned work, not a
  // Moment. If the user leaves the date blank, place it on today so it enters
  // the same planning pipeline as the main capture field.
  const executionDate = dueDate || today();
  const duration = Math.max(1, Math.min(1440, Number(data.get('duration')) || 30));
  const priority = Math.max(1, Math.min(4, Number(data.get('priority')) || 1));
  const className = String(data.get('className') || '').trim();
  const project = String(data.get('project') || '').trim();
  const assignmentType = String(data.get('assignmentType') || '').trim();
  const description = String(data.get('description') || '').trim();
  const command = {
    intent: INTENTS.CREATE_TASK,
    title,
    subject: className || null,
    dueDate: executionDate,
    dueDateExplicit: Boolean(dueDate),
    dueDates: [],
    dueTime: dueTime || null,
    duration,
    priority,
    recurrence: null,
    assignmentType: assignmentType || null,
    raw: title
  };
  taskCreationBusy = true;
  const submit = form.querySelector('[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Adding…'; }
  try {
    const previousState = stateSnapshot();
    const result = await createTaskFromCommand(command, { dueDate: executionDate, priority, className, project, description, duration, assignmentType });
    if (result.blocked) { showToast(result.message || 'That task could not be scheduled.'); return; }
    if (result.duplicate) { close(); render(); showToast('That task already exists.'); return; }
    if (result.task) {
      result.task.description = description;
      result.task.duration = duration;
      result.task.remainingDuration = result.task.status === 'completed' ? 0 : duration;
      result.task.updatedAt = new Date().toISOString();
      const planned = applyWorkloadPlan([result.task.id]);
      const reflowDate = taskDisplayDate(result.task);
      const preferredStart = timeToMinutes(state.profile.preferredStart || '16:00');
      const explicitReflow = reflowDate && timeToMinutes(taskDisplayTime(result.task)) >= preferredStart
        ? reflowDurationChain(reflowDate, { anchorFromPreferredStart: true })
        : [];
      const recoveredSessions = replanAssessmentWork({ persist: false });
      const planningChanges = [...new Map([...planned, ...explicitReflow, ...recoveredSessions].map(item => [item.id, item])).values()];
      if (repository && planningChanges.length) await Promise.all(planningChanges.filter(item => isRemoteTaskId(item.id)).map(item => repository.update(item).catch(() => { markTaskSyncRetry(item); })));
      // createTaskFromCommand already persisted all form fields in its POST.
      // Only planner/reflow mutations belong in the update batch above; an
      // unconditional PATCH here made every Q/add-task submission wait for a
      // redundant second network round trip.
    }
    saveState();
    close();
    render();
    offerUndo(result.persistenceWarning ? 'Task saved locally; syncing will retry.' : 'Task added.', previousState);
  } catch (error) {
    showToast(error.message || 'Could not add that task.');
  } finally {
    taskCreationBusy = false;
    if (form.isConnected && submit) { submit.disabled = false; submit.textContent = 'Add task'; }
  }
}

function openTaskCreationOverlay() {
  closeTaskCreationOverlay();
  const selectedClass = selectedCollection?.type === 'class' ? selectedCollection.name : '';
  const selectedProject = selectedCollection?.type === 'project' ? selectedCollection.name : '';
  const backdrop = document.createElement('div');
  backdrop.className = 'task-create-backdrop';
  const card = document.createElement('section');
  card.className = 'task-create-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'task-create-title');
  card.innerHTML = `<div class="task-create-header"><div><div class="eyebrow">New task</div><h2 id="task-create-title">What needs your attention?</h2></div><button class="icon-button" type="button" data-task-create-close aria-label="Close">×</button></div><p class="muted task-create-intro">Add the task now; Silico will place flexible work around your schedule.</p><form id="task-create-form" class="task-create-form"><label>Title<input name="title" maxlength="500" autocomplete="off" placeholder="e.g. Finish biology lab report" required/></label><label>Description<span class="task-create-optional">Optional</span><textarea name="description" rows="3" maxlength="10000" placeholder="Add notes or the next step…"></textarea></label><div class="task-create-grid"><label>Date<span class="task-create-optional">Optional</span><input name="dueDate" type="date"/></label><label>Time<span class="task-create-optional">Optional</span><input name="dueTime" type="time"/></label><label>Duration<input name="duration" type="number" min="1" max="1440" step="1" value="30"/></label><label>Priority<select name="priority"><option value="1">Normal</option><option value="2">High</option><option value="3">Urgent</option><option value="4">Critical</option></select></label><label>Class<select name="className" ${selectedClass ? 'disabled' : ''}>${taskCreationOptions('class', selectedClass)}</select>${selectedClass ? `<input type="hidden" name="className" value="${escapeHtml(selectedClass)}"/>` : ''}</label><label>Project<select name="project" ${selectedProject ? 'disabled' : ''}>${taskCreationOptions('project', selectedProject)}</select>${selectedProject ? `<input type="hidden" name="project" value="${escapeHtml(selectedProject)}"/>` : ''}</label></div><div class="task-create-footer"><button class="secondary-button" type="button" data-task-create-close>Cancel</button><button class="primary-button" type="submit">Add task</button></div></form>`;
  const assignmentOptions = [`<option value="">Auto-detect</option>`, ...ASSIGNMENT_TYPES.map(option => `<option value="${option.value}">${option.label}</option>`)].join('');
  card.querySelector('.task-create-grid')?.insertAdjacentHTML('beforeend', `<label>Assignment type<select name="assignmentType">${assignmentOptions}</select></label>`);
  const close = () => closeTaskCreationOverlay();
  const form = card.querySelector('#task-create-form');
  card.querySelectorAll('[data-task-create-close]').forEach(button => button.addEventListener('click', close));
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  form.addEventListener('submit', event => { event.preventDefault(); void createTaskFromOverlay(form, close); });
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  form.elements.title.focus();
}

function currentPlanningState() {
  return buildPlanningState({ tasks: allTaskRecords(), profile: { ...state.profile, now: new Date() }, currentTime: new Date(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
}

function replanAssessmentWork({ persist = false } = {}) {
  const changed = [];
  const created = [];
  const updated = [];
  const now = new Date();
  const assessments = state.tasks.filter(task => task.type === 'assessment' && task.status !== 'completed');
  for (const assessment of assessments) {
    const result = replanAssessmentSessions(assessment, state.tasks, { ...state.profile, now }, { createMissing: false });
    for (const update of result.updates) {
      const existing = state.tasks.find(task => task.id === update.id);
      if (existing) { Object.assign(existing, update); updated.push(existing); changed.push(existing); }
    }
    if (result.created.length) { state.tasks.push(...result.created); created.push(...result.created); changed.push(...result.created); }
  }
  if (changed.length) {
    saveState();
    if (repository && created.length) {
      Promise.all(created.map(async task => {
        try {
          const saved = await persistCreatedTask(task);
          if (saved) Object.assign(task, saved);
          delete task.syncRetryAfter;
          saveState();
        } catch {
          markTaskSyncRetry(task);
        }
      })).catch(() => {});
    }
    if (persist && repository && updated.length) Promise.all(updated.map(task => repository.update(task).catch(() => { markTaskSyncRetry(task); }))).catch(() => {});
  }
  return changed;
}

function queryTaskMatches(task, subject) {
  if (!subject) return true;
  const subjectKey = String(subject).toLowerCase().trim();
  const aliases = {
    mathematics: ['mathematics', 'math', 'algebra', 'geometry', 'calculus', 'trigonometry', 'statistics', 'stats', 'precalc'],
    biology: ['biology', 'bio'],
    chemistry: ['chemistry', 'chem'],
    english: ['english', 'ela', 'literature'],
    history: ['history', 'apush']
  };
  const haystack = `${task.title || ''} ${task.className || ''}`.toLowerCase();
  return (aliases[subjectKey] || [subjectKey]).some(alias => haystack.includes(alias));
}

function toClock(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }

function renderAssistantPanel() {
  if (!assistantResult) return '';
  if (assistantResult.type === 'recommendation') {
    const result = assistantResult.result;
    if (!result?.task) return `<section class="assistant-card assistant-empty"><div><div class="eyebrow">Best next step</div><strong>Nothing fits this window yet.</strong><p class="muted">${escapeHtml(result?.reason || 'Try a longer window or add a task with a smaller first step.')}</p></div></section>`;
    const task = result.task;
    const plannedTime = result.window ? `${formatDate(result.window.dateKey, { weekday: 'short', month: 'short', day: 'numeric' })} at ${formatTime(toClock(result.window.start))}` : 'now';
    return `<section class="assistant-card"><div class="assistant-card-copy"><div class="eyebrow">Best next task</div><strong>${escapeHtml(task.title)}</strong><div class="assistant-meta">${task.duration || 30} min${task.className ? ` · ${escapeHtml(task.className)}` : ''}${deadlineRisk(task, currentPlanningState()) !== 'LOW' ? ` · ${deadlineRisk(task, currentPlanningState())} risk` : ''}</div><p><strong>Why:</strong> ${escapeHtml(result.reason)}</p><small class="muted">Suggested ${escapeHtml(plannedTime)}</small></div><div class="assistant-actions"><button class="primary-button" type="button" data-action="start-recommendation" data-id="${escapeHtml(task.id)}">Start</button><button class="secondary-button" type="button" data-action="schedule-recommendation" data-id="${escapeHtml(task.id)}">Schedule</button></div></section>`;
  }
  if (assistantResult.type === 'capacity') {
    const summary = assistantResult.summary;
    return `<section class="assistant-card"><div class="assistant-card-copy"><div class="eyebrow">Capacity check</div><strong>${summary.canFinish ? 'This looks achievable.' : 'Something needs to move.'}</strong><p>${escapeHtml(summary.summary)}</p>${summary.unscheduled.length ? `<p class="assistant-warning">${summary.unscheduled.length} item${summary.unscheduled.length === 1 ? '' : 's'} could not fit before the deadlines.</p>` : ''}</div></section>`;
  }
  const tasks = assistantResult.tasks || [];
  return `<section class="assistant-card assistant-day-summary"><div class="assistant-card-copy"><div class="eyebrow">Today at a glance</div><strong>${tasks.length ? `${tasks.length} open item${tasks.length === 1 ? '' : 's'}` : 'A clear day'}</strong><p>${tasks.length ? tasks.slice(0, 4).map(task => `${escapeHtml(task.dueTime ? formatTime(task.dueTime) : 'No time')} · ${escapeHtml(task.title)}`).join('<br/>') : 'Nothing is scheduled today.'}</p></div></section>`;
}

function speechRecognitionClass() {
  return typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
}

function stopVoiceCapture() {
  if (voiceRecognition) voiceRecognition.stop();
  voiceRecognition = null;
  if (voiceState === 'listening') voiceState = 'idle';
  render();
}

function startVoiceCapture() {
  if (voiceState === 'listening') { stopVoiceCapture(); return; }
  const Recognition = speechRecognitionClass();
  if (!Recognition) { showToast('Voice input is not supported in this browser. You can still type normally.'); return; }
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  voiceRecognition = recognition;
  voiceState = 'listening';
  captureValue = '';
  render();
  document.querySelector('#capture-input')?.focus();
  recognition.onresult = event => {
    const transcript = [...event.results].map(result => result[0]?.transcript || '').join(' ').trim();
    if (!transcript) return;
    captureValue = transcript;
    const input = document.querySelector('#capture-input');
    if (input) { input.value = transcript; input.focus(); }
  };
  recognition.onerror = event => {
    voiceRecognition = null;
    voiceState = 'idle';
    const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Microphone access was denied. Allow it in your browser settings or type instead.'
      : event.error === 'no-speech' ? 'I didn’t hear anything. Try again or type instead.' : 'Voice input failed. You can still type normally.';
    render();
    showToast(message);
  };
  recognition.onend = () => {
    if (voiceRecognition !== recognition) return;
    voiceRecognition = null;
    voiceState = 'idle';
    render();
  };
  try { recognition.start(); } catch {
    voiceRecognition = null;
    voiceState = 'idle';
    render();
    showToast('Voice input could not start. You can still type normally.');
  }
}

function renderCollectionDetail(type, name) {
  const tasks = collectionTasks(type, name);
  const open = tasks.filter(task => task.status !== 'completed');
  const label = type === 'class' ? 'Class' : 'Project';
  return `<div class="collection-detail"><button class="back-link" type="button" data-action="close-collection">← Back to ${label.toLowerCase()}s</button><div class="collection-heading"><div><div class="eyebrow">${label}</div><h2>${escapeHtml(name)}</h2><p class="muted">${open.length} open task${open.length === 1 ? '' : 's'}</p></div><button class="secondary-button" type="button" data-action="focus-capture">＋ Task</button></div>${renderCapture({ type, name })}<section class="task-section"><div class="section-heading"><span>Tasks</span><span class="muted">${open.length}</span></div>${open.length ? open.map(renderTaskRow).join('') : emptyState('Nothing here yet', `Add a task to this ${type}.`)}</section></div>`;
}

function renderLoadingShell() {
  // Never show a workspace-shaped shell before Clerk has confirmed the user.
  // The old skeleton looked like a demo workspace during slow auth loads.
  document.querySelector('#app').innerHTML = `<main class="auth-loading" aria-busy="true" aria-label="Checking your sign-in"><div class="auth-loading-card"><div class="brand">${brandMarkup}</div><span class="skeleton auth-loading-line auth-loading-line-wide"></span><span class="skeleton auth-loading-line"></span></div></main>`;
}

function isEditingControl() {
  const active = document.activeElement;
  return Boolean(active?.matches?.('input, textarea, select, [contenteditable="true"]')) || Boolean(active?.closest?.('.task-drawer')) || Boolean(active?.closest?.('form'));
}

function isTaskDrawerOpen() {
  return Boolean(document.querySelector('.task-drawer'));
}

function renderBackgroundState() {
  // A sync must never replace the task drawer while a user is editing it.
  // Date/time pickers can temporarily move focus away from the input, so the
  // drawer itself is the reliable boundary rather than activeElement alone.
  if (isTaskDrawerOpen() || isEditingControl()) {
    backgroundRenderPending = true;
    return;
  }
  backgroundRenderPending = false;
  if (authenticatedUser(currentUser) && state.profile.onboardingComplete === false) renderOnboarding();
  else if (authenticatedUser(currentUser)) render();
  else renderUnauthenticatedRoute();
}

function flushBackgroundRender() {
  if (backgroundRenderPending && !isEditingControl()) renderBackgroundState();
}

function render() {
  if (!authenticatedUser(currentUser)) {
    authRenderMode = null;
    renderUnauthenticatedRoute();
    return;
  }
  repairEventReminderSchedules({ persist: true });
  if (['today', 'upcoming', 'inbox', 'calendar'].includes(view)) {
    replanAssessmentWork({ persist: true });
    planFlexibleWork({ persist: true });
  }
  backgroundRenderPending = false;
  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar ${isSidebarOpen ? 'open' : ''}">
        <div class="brand">${brandMarkup}</div>
        <button class="add-task-button" data-action="focus-capture"><span>＋</span> Add task <kbd>Q</kbd></button>
        <nav class="nav primary">
          ${navItem('today', 'Today', 'today', countToday())}
          ${navItem('upcoming', 'Upcoming', 'calendar', countUpcoming())}
          ${navItem('calendar', 'Calendar', 'grid', '')}
          ${navItem('inbox', 'Inbox', 'inbox', countInbox())}
          ${navItem('study', 'Study', 'book', '')}
          ${navItem('brain-dump', 'Moment', 'brain', countBrainDump())}
          ${navItem('completed', 'Completed', 'completed', countCompleted())}
        </nav>
        <div class="sidebar-section"><div class="section-label">Workspace</div>
          ${navItem('classes', 'Classes', 'book', '')}
          ${navItem('projects', 'Projects', 'folder', '')}
          ${teamsEnabled ? navItem('teams', 'Teams', 'grid', '') : ''}
          ${navItem('settings', 'Settings', 'settings', '')}
          ${navItem('feedback-admin', 'Feedback', 'feedback', feedbackItems.length || '')}
        </div>
        <div class="sidebar-bottom"><div class="profile-chip" data-action="open-settings" role="button" tabindex="0"><span class="avatar">${avatarContent()}</span><span><strong>${escapeHtml(currentUser?.firstName || currentUser?.username || currentUserEmail().split('@')[0])}</strong><small>${escapeHtml(currentUserEmail())}</small></span><button class="dots" data-action="sign-out" title="Sign out">↗</button></div></div>
      </aside>
      ${isSidebarOpen ? '<div class="sidebar-backdrop" data-action="close-sidebar" aria-label="Close sidebar"></div>' : ''}
      <main class="main"><header class="topbar"><button class="mobile-menu" data-action="toggle-sidebar" aria-label="${isSidebarOpen ? 'Close' : 'Open'} sidebar" aria-expanded="${isSidebarOpen}">${isSidebarOpen ? '×' : '☰'}</button><div class="breadcrumbs">${viewLabel()}</div><div class="top-actions">${isSyncing ? '<span class="sync-status" aria-live="polite"><span class="sync-dot"></span>Syncing</span>' : ''}<button class="icon-button notification-trigger" aria-label="Notifications${(state.profile.notifications || []).some(item => !item.read) ? ', unread' : ''}" data-action="notifications">${svgIcon('bell')}${(state.profile.notifications || []).some(item => !item.read) ? '<span class="notification-badge"></span>' : ''}</button><button class="avatar small" aria-label="Open settings" data-action="open-settings">${avatarContent()}</button></div></header>
        <div class="content"><div class="content-header"><div><div class="eyebrow">${view === 'today' ? formatDate(today(), { weekday: 'long' }) : 'Your workspace'}</div><h1>${viewTitle()}</h1>${view === 'today' ? `<p class="subtitle">${formatLongDate(today())}</p>` : ''}</div><div class="header-actions">${view === 'calendar' ? '<button class="secondary-button" data-action="calendar-today">Today</button>' : ''}<button class="secondary-button" data-action="focus-capture">＋ Task</button></div></div>
        ${view === 'today' ? renderProgressSummary() : ''}
        ${view === 'settings' ? renderSettings() : view === 'feedback-admin' ? renderFeedbackAdminView() : view === 'classes' ? renderClasses() : view === 'projects' ? renderProjects() : teamsEnabled && view === 'teams' ? renderTeams() : view === 'brain-dump' ? renderBrainDump() : view === 'study' ? renderStudy() : renderTaskView()}
        </div>
      </main>
      ${selectedTaskId ? renderTaskDrawer() : ''}
      ${renderNotificationPanel()}
    </div>`;
  document.querySelector('.profile-chip strong')?.replaceChildren(document.createTextNode(profileDisplayName()));
  document.querySelector('.profile-picture-copy strong')?.replaceChildren(document.createTextNode(profileDisplayName()));
  if (view === 'settings' && !document.querySelector('#display-name')) {
    document.querySelector('.profile-settings')?.insertAdjacentHTML('beforeend', '<label>Display name<input id="display-name" maxlength="80" placeholder="Your name in Silico" autocomplete="name"/></label><button class="primary-button" type="button" data-action="save-display-name">Save name</button>');
    const input = document.querySelector('#display-name');
    if (input) input.value = state.profile.displayName || '';
  }
  bindEvents();
}

function navItem(key, label, icon, count) { const motionStyle = key === 'study' ? ` style="--study-sweep-delay:-${Math.round((performance.now() - STUDY_MOTION_EPOCH) % STUDY_MOTION_DURATION_MS)}ms"` : ''; return `<button class="nav-item ${view === key ? 'active' : ''} ${key === 'study' ? 'study-nav-item' : ''}" data-view="${key}"${motionStyle}><span class="nav-icon ${key === 'study' ? 'study-nav-icon' : ''}">${svgIcon(icon)}</span><span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`; }
function viewLabel() { return view === 'today' ? 'My tasks' : view === 'brain-dump' ? 'Moment' : view === 'feedback-admin' ? 'Admin feedback' : view[0].toUpperCase() + view.slice(1); }
function viewTitle() { return ({ today: 'Today', upcoming: 'Upcoming', calendar: 'Calendar', inbox: 'Inbox', 'brain-dump': 'Moment', study: 'Study', completed: 'Completed', classes: 'Classes', projects: 'Projects', teams: 'Teams', settings: 'Settings', 'feedback-admin': 'Feedback' })[view] || 'Today'; }
function countToday() { return tasksForDate(today()).filter(t => t.status !== 'completed').length; }
function countUpcoming() { const windowDays = Number(state.profile.inboxWindowDays ?? 30); const endDate = windowDays > 0 ? addDays(today(), windowDays) : addDays(today(), MAX_UPCOMING_RANGE_DAYS); return rangeTasks(today(), endDate).filter(t => (taskDisplayDate(t) || '') > today() && t.status !== 'completed').length; }
function inboxTasks() {
  const windowDays = Number(state.profile.inboxWindowDays ?? 30);
  const tasks = windowDays > 0 ? rangeTasks(today(), addDays(today(), windowDays)) : orderTasksByDate(state.tasks.filter(task => task.status !== 'completed'));
  return tasks.filter(task => !task.project && !task.className && task.status !== 'completed' && !(task.source === 'calendar' && task.dueDate && task.dueDate < today()));
}
function countInbox() { return inboxTasks().length; }
function brainDumpTasks() { return state.tasks.filter(task => task.source !== 'team' && !task.dueDate && task.status !== 'completed').sort(taskSort); }
function countBrainDump() { return brainDumpTasks().length; }
function countCompleted() { return state.tasks.filter(task => task.status === 'completed').length; }
function renderProgressSummary() { const gamification = state.profile.gamification || {}; const todayTasks = tasksForDate(today()); const openToday = todayTasks.filter(task => task.status !== 'completed'); const completed = todayTasks.filter(task => task.status === 'completed').length; const minutes = openToday.reduce((total, task) => total + (Number(task.remainingDuration ?? task.duration) || 0), 0); return `<div class="progress-summary"><div><strong>${Math.floor(minutes / 60)}h ${minutes % 60}m</strong><span>planned today</span></div><div><strong>${completed}/${todayTasks.length || 0}</strong><span>completed today</span></div><div class="streak-summary-stat"><strong><span class="streak-summary-icon">${svgIcon('streak')}</span>${gamification.currentStreak || 0}</strong><span>day streak</span></div><div><strong>Level ${gamificationLevel(gamification.xp)}</strong><span>${gamification.xp || 0} XP</span></div></div>`; }

function nextPlanningAction() {
  const planning = currentPlanningState();
  const todayKey = toDateKey(planning.currentTime);
  // Recompute focus from the tasks that are actually on today, so completing
  // one item cannot promote an unscheduled Wednesday deadline into the active
  // slot while a nearer task still exists.
  const todayTasks = tasksForDate(todayKey).filter(task => task.status !== 'completed');
  const todayPlanning = buildPlanningState({ ...planning, tasks: todayTasks, currentTime: planning.currentTime });
  const immediate = recommendNextAction(todayPlanning, { availableMinutes: Infinity, now: planning.currentTime, preferImmediate: true, horizonDays: 0 });
  if (immediate.task) return immediate;

  // If today is clear, “Next up” should still be useful—but it must point to
  // the first actual future execution, never to whichever task won the
  // seven-day planning score.
  // Use the same date-expanded task view that Upcoming renders. Raw records
  // can represent recurring work with an earlier anchor date, which makes a
  // later Wednesday occurrence look like the next execution after today.
  const nextPlanned = rangeTasks(addDays(todayKey, 1), addDays(todayKey, 30))
    .filter(task => task.status !== 'completed' && task.type !== 'fixed_event')
    .map(task => ({ task, dateKey: task.scheduledDate || task.dueDate, time: task.scheduledTime || task.dueTime }))
    .filter(item => isDateKey(item.dateKey) && item.dateKey > todayKey)
    .sort((left, right) => `${left.dateKey}T${left.time || '23:59'}`.localeCompare(`${right.dateKey}T${right.time || '23:59'}`) || taskSort(left.task, right.task))[0];
  if (!nextPlanned) return immediate;
  const duration = Number(nextPlanned.task.remainingDuration ?? nextPlanned.task.duration) || 30;
  const start = nextPlanned.time ? dateAt(nextPlanned.dateKey, nextPlanned.time) : null;
  return {
    ...immediate,
    task: nextPlanned.task,
    window: start ? { dateKey: nextPlanned.dateKey, start: start.getHours() * 60 + start.getMinutes(), end: start.getHours() * 60 + start.getMinutes() + duration, duration, scheduled: true } : null,
    reason: `You're caught up today. Your next planned work is ${nextPlanned.task.title}.`
  };
}
function renderPlanningPulse() {
  const planning = currentPlanningState();
  const next = nextPlanningAction();
  nextUpTaskId = next.task?.id || null;
  timeSensitiveViewSignature = JSON.stringify([
    today(),
    next.task?.id || null,
    next.window?.dateKey || null,
    next.window?.start ?? null,
    next.window?.end ?? null
  ]);
  const upcomingDeadlines = planning.tasks.filter(task => task.status !== 'completed' && task.dueDate && task.dueDate >= today() && task.dueDate <= addDays(today(), 7) && task.type !== 'fixed_event').length;
  return `<section class="planning-pulse"><div><div class="eyebrow">Next up</div>${next.task ? `<button class="planning-pulse-task" type="button" data-action="open-task" data-id="${escapeHtml(next.task.id)}"><strong>${escapeHtml(next.task.title)}</strong><p>${next.window ? `${formatTime(toClock(next.window.start))} · ${next.task.duration || 30} min` : 'Ready when you are'}</p></button>` : '<strong>Your schedule has breathing room.</strong><p>Add a deadline and Silico will find the work window.</p>'}</div><div class="planning-pulse-stat"><strong>${upcomingDeadlines}</strong><span>deadlines this week</span></div></section>`;
}

function renderTaskView() {
  const capture = renderCapture();
  if (view === 'calendar') return `<div class="calendar-page">${renderCalendar()}</div>`;
  if (view === 'upcoming') return `${capture}${renderAssistantPanel()}${renderUpcoming()}`;
  if (view === 'completed') return renderCompletedView();
  const date = view === 'today' ? today() : null;
  const next = view === 'today' ? nextPlanningAction() : null;
  nextUpTaskId = next?.task?.id || null;
  const baseTasks = view === 'today' ? tasksForDate(date) : view === 'inbox' ? inboxTasks() : visibleTasks();
  const tasks = baseTasks.filter(task => task.status !== 'completed').sort((left, right) => {
    if (view === 'today' && nextUpTaskId) {
      if (left.id === nextUpTaskId) return -1;
      if (right.id === nextUpTaskId) return 1;
    }
    return 0;
  });
  const open = tasks.filter(t => t.status !== 'completed');
  const pendingRows = isProcessingCapture ? renderTaskSkeletons(2) : '';
  const windowControl = view === 'inbox' ? taskWindowControl() : '';
  return `${capture}${view === 'today' ? renderPlanningPulse() : ''}${renderAssistantPanel()}${windowControl}<section class="task-section"><div class="section-heading"><span>${view === 'today' ? 'Up next' : 'Tasks'}</span><span class="muted">${open.length} ${open.length === 1 ? 'task' : 'tasks'}</span></div>${pendingRows}${open.length ? open.map(renderTaskRow).join('') : isProcessingCapture ? '' : emptyState()}</section>`;
}

function renderBrainDump() {
  const tasks = brainDumpTasks();
  return `<div class="brain-dump-view"><div class="brain-dump-intro"><div><div class="eyebrow">Unscheduled ideas and commitments</div><h2>Capture the moment.</h2><p class="muted">Capture anything you want to remember without deciding when yet. Add a date later from Task details and it will move into your schedule.</p></div></div><form id="brain-dump-form" class="brain-dump-form"><input name="title" maxlength="500" placeholder="e.g. Study for the SATs or learn CSP" required/><textarea name="description" maxlength="10000" rows="3" placeholder="Optional notes"></textarea><div class="brain-dump-form-footer"><label>Priority<select name="priority"><option value="1">Normal</option><option value="2">High</option><option value="3">Urgent</option><option value="4">Critical</option></select></label><label>Plan this moment?<select name="planning"><option value="no">No, keep it here</option><option value="yes">Yes, schedule it</option></select></label><button class="primary-button" type="submit">＋ Save moment</button></div></form><section class="task-section"><div class="section-heading"><span>Waiting for a time</span><span class="muted">${tasks.length}</span></div>${tasks.length ? tasks.map(renderTaskRow).join('') : emptyState('No moments yet', 'Save something you want to remember and decide when to do it later.')}</section></div>`;
}

function studyUsageLabel(value, limit) { return `${Number(value || 0).toLocaleString()} / ${Number(limit || 0).toLocaleString()}`; }
function studyUsageRemaining(value, limit) { return Math.max(0, Number(limit || 0) - Number(value || 0)).toLocaleString(); }
function syncStudyCountControl() {
  const format = document.querySelector('#study-form select[name="format"]')?.value || studyDraft.format;
  const countControl = document.querySelector('[data-study-count-control]');
  if (countControl) countControl.hidden = !['flashcards', 'quiz'].includes(format);
}
function studySourceLabel(artifact, id) {
  return artifact?.sourceMap?.find(source => source.id === id)?.label || id;
}
function renderStudyRefs(artifact, refs) {
  if (!Array.isArray(refs) || !refs.length) return '';
  return `<small class="study-citations">Sources: ${refs.map(ref => `<span title="${escapeHtml(studySourceLabel(artifact, ref))}">${escapeHtml(ref)}</span>`).join(', ')}</small>`;
}
function renderStudyEvidence(artifact) {
  if (!Array.isArray(artifact?.evidence) || !artifact.evidence.length) return '';
  return `<details class="study-evidence"><summary>Source evidence</summary>${artifact.evidence.map(item => `<p>${renderStudyRefs(artifact, item.sourceRefs)} ${escapeHtml(item.quote)}</p>`).join('')}</details>`;
}
function renderStudyHistory() {
  if (!studyArtifacts.length) return '';
  return `<section class="study-materials study-history"><div class="section-heading"><span>Past generations</span><span class="muted">${studyArtifacts.length}</span></div>${studyArtifacts.map(artifact => `<div class="study-material-row"><div><strong>${escapeHtml(artifact.material_title || 'Study material')}</strong><small>${escapeHtml(artifact.format === 'study_guide' ? 'outline' : artifact.format)} · ${escapeHtml(artifact.created_at ? new Date(artifact.created_at).toLocaleString() : 'Saved across devices')}</small></div><div class="study-history-actions"><button class="secondary-button" type="button" data-action="view-study-artifact" data-id="${escapeHtml(artifact.id)}">View</button>${artifact.material_id ? `<button class="secondary-button" type="button" data-action="edit-study-material" data-id="${escapeHtml(artifact.material_id)}">Edit source</button>` : ''}</div></div>`).join('')}</section>`;
}
function renderStudyArtifact() {
  const artifact = studyArtifact?.content_json;
  if (!artifact) return '';
  if (artifact.type === 'flashcards') return `<section class="study-output"><div class="settings-title"><h2>Flashcards</h2><p>Review the front, then reveal the answer.</p></div><div class="study-card-list">${artifact.cards.map((card, index) => `<details class="study-flashcard"><summary><span>${index + 1}</span>${escapeHtml(card.front)}</summary><p>${escapeHtml(card.back)}</p>${renderStudyRefs(artifact, card.sourceRefs)}</details>`).join('')}</div>${renderStudyEvidence(artifact)}</section>`;
  if (artifact.type === 'quiz') return `<section class="study-output"><div class="settings-title"><h2>Practice quiz</h2><p>Answers stay hidden until you reveal each explanation.</p></div><div class="study-quiz-list">${artifact.questions.map((question, index) => `<details class="study-question"><summary>${index + 1}. ${escapeHtml(question.question)}</summary><div class="study-choices">${question.choices.map((choice, choiceIndex) => `<span class="study-choice ${choiceIndex === question.correctChoice ? 'is-correct' : ''}">${String.fromCharCode(65 + choiceIndex)}. ${escapeHtml(choice)}</span>`).join('')}</div><p><strong>Answer:</strong> ${escapeHtml(question.choices[question.correctChoice] || 'See explanation')}</p>${question.explanation ? `<p class="muted">${escapeHtml(question.explanation)}</p>` : ''}${renderStudyRefs(artifact, question.sourceRefs)}</details>`).join('')}</div>${renderStudyEvidence(artifact)}</section>`;
  if (artifact.type === 'summary') return `<section class="study-output"><div class="settings-title"><h2>${escapeHtml(artifact.title || 'Summary')}</h2></div><p class="study-summary-copy">${escapeHtml(artifact.summary)}</p><div class="study-points"><strong>Key points</strong><ul>${artifact.keyPoints.map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul></div>${artifact.terms?.length ? `<div class="study-terms"><strong>Terms</strong>${artifact.terms.map(term => `<p><b>${escapeHtml(term.term)}:</b> ${escapeHtml(term.definition)}</p>`).join('')}</div>` : ''}${renderStudyEvidence(artifact)}</section>`;
  return `<section class="study-output"><div class="settings-title"><h2>${escapeHtml(artifact.title || 'Study guide')}</h2><p>Organized outline only—no cards or questions.</p></div><div class="study-guide-sections">${(artifact.sections || []).map(section => `<div><h3>${escapeHtml(section.heading)}</h3><ul>${(section.points || []).map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ul>${renderStudyRefs(artifact, section.sourceRefs)}</div>`).join('')}</div>${renderStudyEvidence(artifact)}</section>`;
}
function renderStudy() {
  const limits = studyUsage?.limits || { plan: 'free', basicGenerations: 10, advancedGenerations: 0, monthlyInputTokens: 100_000, dailyRequests: 3, monthlyCostCents: 200 };
  const usage = studyUsage?.usage || {};
  const disabled = studyUsage?.enabled === false;
  const studyReady = Boolean(studyUsage && studyBilling);
  const generationLocked = !studyReady || disabled;
  const lockedAttr = generationLocked ? 'disabled' : '';
  const studyCountControl = ['flashcards', 'quiz'].includes(studyDraft.format) ? `<label data-study-count-control>Cards/questions<input name="count" type="number" min="5" max="50" value="${studyDraft.count}" ${lockedAttr}/></label>` : '';
  const status = studyError ? `<p class="study-error">${escapeHtml(studyError)}</p>` : disabled ? '<p class="study-warning">Study generation is safely disabled until the server Gemini key and feature flag are configured.</p>' : '<p class="study-note">Free access uses Gemini Flash: 10 generations per month, with saved results for repeat review.</p>';
  const privacyNotice = `<aside class="study-privacy-warning"><strong>Privacy before you generate</strong><p>Your extracted study text will be sent to Google’s Gemini API on its free tier. Image-only PDF pages are OCR-scanned locally in your browser; the original PDF is not uploaded. Google marks free-tier content as potentially used to improve its products. Do not paste grades, private messages, health or family details, or anything you would not want to share with Google.</p><a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer">Review Google’s billing and data terms ↗</a></aside>`;
  return `<div class="study-view"><div class="study-intro"><div><div class="eyebrow">Turn material into practice</div><h2>Study with Silico.</h2><p class="muted">Paste notes or import a text/PDF file. Gemini Flash will build a focused study set from the material you provide, and Silico saves it so repeated reviews do not create another AI request.</p></div><div class="study-usage"><strong>Free access</strong><span>Gemini Flash: ${studyUsageLabel(usage.basicGenerations, limits.basicGenerations)} used · ${studyUsageRemaining(usage.basicGenerations, limits.basicGenerations)} remaining</span><span>Input: ${studyUsageLabel(usage.inputTokens, limits.monthlyInputTokens)} tokens used · ${studyUsageRemaining(usage.inputTokens, limits.monthlyInputTokens)} remaining</span><span>Today: ${studyUsageLabel(usage.requestsToday, limits.dailyRequests)} requests used</span></div></div><section class="study-generator"><form id="study-form"><label>Material title<input name="title" maxlength="160" placeholder="e.g. Biology — cell respiration" ${lockedAttr} required/></label><label>Notes, transcript, or lecture text<textarea name="content" id="study-content" maxlength="250000" rows="12" placeholder="Paste one lecture, chapter, or review packet here…" ${lockedAttr} required></textarea></label><div class="study-file-row"><input id="study-file" type="file" accept=".txt,.md,.markdown,.pdf,text/plain,application/pdf" ${lockedAttr} hidden/><label for="study-file" class="secondary-button file-button">Import notes or PDF</label><span class="muted">Selectable text is extracted in your browser. Image-only pages are scanned with local OCR before any study text is sent to Gemini. The PDF file itself is never uploaded.</span></div>${privacyNotice}<div class="study-options"><label>Study mode<select name="format" ${lockedAttr}><option value="flashcards" ${studyDraft.format === 'flashcards' ? 'selected' : ''}>Flashcards · active recall</option><option value="quiz" ${studyDraft.format === 'quiz' ? 'selected' : ''}>Quiz · self-test</option><option value="study_guide" ${studyDraft.format === 'study_guide' ? 'selected' : ''}>Outline · organize ideas only</option><option value="summary" ${studyDraft.format === 'summary' ? 'selected' : ''}>Summary · quick review</option></select></label><label>Difficulty<select name="difficulty" ${lockedAttr}><option value="easy" ${studyDraft.difficulty === 'easy' ? 'selected' : ''}>Easy</option><option value="medium" ${studyDraft.difficulty === 'medium' ? 'selected' : ''}>Medium</option><option value="hard" ${studyDraft.difficulty === 'hard' ? 'selected' : ''}>Hard</option></select></label>${studyCountControl}</div>${status}<button class="primary-button" type="submit" ${studyBusy || generationLocked ? 'disabled' : ''}>${studyBusy ? '<span class="capture-spinner"></span>Generating…' : 'Generate study set'}</button></form></section>${studyLoading ? '<section class="study-output"><p class="muted">Loading your saved study materials…</p></section>' : renderStudyArtifact()}${renderStudyHistory()}${studyMaterials.length ? `<section class="study-materials"><div class="section-heading"><span>Saved materials</span><span class="muted">${studyMaterials.length}</span></div>${studyMaterials.map(material => `<div class="study-material-row"><div><strong>${escapeHtml(material.title)}</strong><small>${escapeHtml(material.source_type)} · ${Number(material.token_count || 0).toLocaleString()} tokens</small></div><div class="study-history-actions"><button class="secondary-button" type="button" data-action="edit-study-material" data-id="${escapeHtml(material.id)}">Edit source</button><time>${escapeHtml(material.created_at ? new Date(material.created_at).toLocaleDateString() : '')}</time></div></div>`).join('')}</section>` : ''}</div>`;
}

function renderCompletedView() {
  const completed = state.tasks.filter(task => task.status === 'completed').sort(taskSort);
  return renderCompletedSection(completed, { open: true }) || emptyState('No completed tasks', 'Completed tasks will appear here.');
}

function isStudyTask(task) { return task?.assignmentType === 'study'; }
function displayTagLabel(label) { return titleCaseTaskTitle(label); }
function registerDailyVisit() {
  const gamification = state.profile.gamification || {};
  const before = JSON.stringify(gamification);
  state.profile.gamification = updateStreak(gamification, new Date());
  return JSON.stringify(state.profile.gamification) !== before;
}
function mergeGamification(remote = {}, local = {}) {
  const completedDays = [...new Set([
    ...(Array.isArray(remote.completedDays) ? remote.completedDays : []),
    ...(Array.isArray(local.completedDays) ? local.completedDays : [])
  ])].sort();
  return {
    ...remote,
    ...local,
    xp: Math.max(Number(remote.xp) || 0, Number(local.xp) || 0),
    completedDays,
    awardedTaskIds: { ...(remote.awardedTaskIds || {}), ...(local.awardedTaskIds || {}) },
    streakMilestonesAwarded: { ...(remote.streakMilestonesAwarded || {}), ...(local.streakMilestonesAwarded || {}) },
    longestStreak: Math.max(Number(remote.longestStreak) || 0, Number(local.longestStreak) || 0)
  };
}
function ensureClassColors() {
  const taskClasses = state.tasks.map(task => task.className).filter(Boolean);
  state.profile.classColors = assignUniqueClassHues([...state.classes, ...taskClasses], state.profile.classColors);
}
function classColorStyle(className) {
  ensureClassColors();
  const hue = state.profile.classColors[normalizeClassColorKey(className)] ?? stableColorHue(className);
  return `--class-hue:${hue}`;
}
function renderTaskTags(task) {
  const isFixedEvent = task.type === 'fixed_event';
  const showsAssignment = task.assignmentType && !isStudyTask(task) && (['task', 'assessment'].includes(task.type) || (isFixedEvent && task.assignmentType !== 'event'));
  const tags = [task.className ? { label: task.className, className: 'class-tag', style: classColorStyle(task.className) } : null, task.project ? { label: task.project, className: 'project-tag' } : null, showsAssignment ? { label: assignmentTypeLabel(task.assignmentType), className: `assignment-tag assignment-${task.assignmentType}` } : null, task.source === 'team' ? { label: task.teamProjectName || 'Team', className: 'team-tag' } : null, task.source === 'team' && task.subprojectName ? { label: task.subprojectName, className: 'project-tag' } : null, task.source === 'team' && task.assigneeName ? { label: `For ${task.assigneeName}`, className: 'team-tag' } : null, isStudyTask(task) ? { label: 'Study', className: 'study-tag' } : null, isFixedEvent && task.assignmentType === 'event' ? { label: 'Event', className: 'event-tag' } : null, repository && !isRemoteTaskId(task.id) && task.source !== 'team' ? { label: 'Syncing…', className: 'syncing-tag' } : null].filter(Boolean);
  return tags.map(tag => `<span class="tag ${tag.className}"${tag.style ? ` style="${tag.style}"` : ''}>${escapeHtml(displayTagLabel(tag.label))}</span>`).join('');
}

function renderTaskRow(task) {
  const isTeamTask = task.source === 'team' && task.teamTaskId && task.teamProjectId;
  const encodedTeamId = isTeamTask ? `${task.teamProjectId}::${task.teamTaskId}` : task.id;
  const toggleAction = isTeamTask ? 'toggle-team-task' : 'toggle-task';
  const titleAction = isTeamTask ? 'open-team' : 'open-task';
  const draggable = isTeamTask ? '' : 'data-drag-task="true"';
  const completion = isTeamTask && task.teamMemberCount ? `<span class="tag project-tag">${task.teamCompletionCount}/${task.teamMemberCount} complete</span>` : '';
  const displayDate = taskDisplayDate(task);
  const displayTime = taskDisplayTime(task);
  const execution = taskExecution(task);
  const isNextUp = !isTeamTask && nextUpTaskId === task.id;
  return `<div class="task-row ${isTeamTask ? 'team-task-feed-row' : ''} ${isNextUp ? 'is-next-up' : ''} ${task.status === 'completed' ? 'is-complete' : ''} ${isOverdue(task) ? 'is-overdue' : ''}" data-task-id="${task.id}" data-drop-date="${displayDate || ''}" ${draggable} title="${isTeamTask ? 'Team task' : 'Drag to reorder or move this task'}"><button class="checkbox priority-${task.priority || 1} ${task.status === 'completed' ? 'checked' : ''}" data-action="${toggleAction}" data-id="${encodedTeamId}" aria-label="${task.status === 'completed' ? 'Restore' : 'Complete'} ${escapeHtml(task.title)}">${task.status === 'completed' ? '✓' : ''}</button><div class="task-main"><button class="task-title" data-action="${titleAction}" data-id="${isTeamTask ? task.teamProjectId : task.id}">${escapeHtml(task.title)}</button><div class="task-meta">${displayTime ? `<span>${formatTime(displayTime)}</span>` : displayDate ? `<span>${formatDate(displayDate)}</span>` : ''}${task.scheduledDate ? '<span class="planned-label">Planned</span>' : ''}${task.duration ? `<span>· ${task.duration} min</span>` : ''}${isNextUp ? '<span class="tag next-up-tag">Next up</span>' : ''}${renderTaskTags(task)}${completion}${task.recurrence ? '<span class="recurrence">↻</span>' : ''}</div></div><button class="row-more" data-action="${isTeamTask ? 'edit-team-task' : 'open-task'}" data-id="${isTeamTask ? encodedTeamId : task.id}" aria-label="${isTeamTask ? `Edit ${escapeHtml(task.title)}` : `Open ${escapeHtml(task.title)}`}">${isTeamTask ? 'Edit' : '···'}</button></div>`;
}
function renderTaskSkeletons(count = 3) { return `<div class="task-skeleton-list" aria-hidden="true">${Array.from({ length: count }, () => '<div class="task-skeleton-row"><span class="skeleton skeleton-check"></span><span class="skeleton skeleton-task-copy"></span><span class="skeleton skeleton-more"></span></div>').join('')}</div>`; }
function emptyState(title = 'Clear space, clear mind', message = 'Nothing else is scheduled here.') { return `<div class="empty-state"><div class="empty-icon">✓</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`; }

function taskWindowControl() {
  const windowDays = Number(state.profile.inboxWindowDays ?? 30);
  return `<div class="inbox-toolbar"><label>Show tasks from<select id="inbox-window"><option value="7" ${windowDays === 7 ? 'selected' : ''}>Next 7 days</option><option value="30" ${windowDays === 30 ? 'selected' : ''}>Next 30 days</option><option value="90" ${windowDays === 90 ? 'selected' : ''}>Next 90 days</option><option value="0" ${windowDays === 0 ? 'selected' : ''}>All open tasks (next 12 months)</option></select></label></div>`;
}

function renderUpcoming() {
  const windowDays = Number(state.profile.inboxWindowDays ?? 30);
  const endDate = windowDays > 0 ? addDays(today(), windowDays) : addDays(today(), MAX_UPCOMING_RANGE_DAYS);
  const upcomingTasks = rangeTasks(today(), endDate).filter(task => task.status !== 'completed');
  nextUpTaskId = nextUpcomingTask(upcomingTasks)?.id || null;
  const groups = {};
  upcomingTasks.forEach(task => { const displayDate = taskDisplayDate(task); if (displayDate) (groups[displayDate] ||= []).push(task); });
  const orderedGroups = Object.entries(groups).sort(([left], [right]) => left.localeCompare(right));
  return `${taskWindowControl()}<section class="upcoming-list">${orderedGroups.length ? orderedGroups.map(([date, tasks]) => {
    // Sort at render time as a final invariant. This protects the visible
    // order even when a legacy row arrived with only one half of its old
    // scheduled_* pair or when a sync response was merged mid-render.
    const orderedTasks = [...tasks].sort((left, right) => {
      const leftTime = taskDisplayTime(left) ? dateAt(date, taskDisplayTime(left)).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = taskDisplayTime(right) ? dateAt(date, taskDisplayTime(right)).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || taskSort(left, right);
    });
    return `<div class="date-group" data-drop-date="${date}"><div class="date-label"><strong>${date === today() ? 'TODAY' : formatDate(date, { weekday: 'short', month: 'long', day: 'numeric' }).toUpperCase()}</strong><span>${orderedTasks.length}</span></div>${orderedTasks.map(renderTaskRow).join('')}</div>`;
  }).join('') : emptyState()}</section>`;
}

function renderCalendar() {
  const start = new Date(calendarCursor); const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(); const offset = start.getDay();
  const cells = Array.from({ length: offset }, () => '<div class="calendar-cell muted-cell"></div>');
  for (let day = 1; day <= days; day += 1) {
    const key = toDateKey(new Date(start.getFullYear(), start.getMonth(), day));
    const items = calendarTasksForDate(key);
    const desktopVisibleItems = items.slice(0, 2);
    const hiddenCount = Math.max(0, items.length - desktopVisibleItems.length);
    cells.push(`<div class="calendar-cell ${key === today() ? 'today-cell' : ''}" data-drop-date="${key}"><div class="calendar-day">${day}</div>${desktopVisibleItems.map(t => `<button class="calendar-task ${isStudyTask(t) ? 'study-calendar' : ''} ${t.type === 'fixed_event' ? 'event-calendar' : ''}" data-action="open-task" data-id="${t.id}" data-task-id="${t.id}" data-drop-date="${key}" data-drag-task="true" title="Drag to move this task"><span class="calendar-task-title">${escapeHtml(t.title)}</span>${calendarTaskLabels(t)}</button>`).join('')}${hiddenCount ? `<button class="more-items calendar-more" type="button" data-action="open-calendar-day" data-date="${key}" aria-label="Read ${hiddenCount} more task${hiddenCount === 1 ? '' : 's'} for ${formatDate(key, { month: 'long', day: 'numeric' })}">Read ${hiddenCount} more</button>` : ''}</div>`);
  }
  while (cells.length % 7) cells.push('<div class="calendar-cell muted-cell"></div>');
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(`<div class="calendar-week">${cells.slice(index, index + 7).join('')}</div>`);
  const monthLabel = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const mobileDays = [];
  for (let day = 1; day <= days; day += 1) {
    const key = toDateKey(new Date(start.getFullYear(), start.getMonth(), day));
    const items = calendarTasksForDate(key);
    if (!items.length) continue;
    mobileDays.push(`<section class="calendar-mobile-day ${key === today() ? 'today-cell' : ''}"><div class="calendar-mobile-day-header"><strong>${formatDate(key, { weekday: 'short', month: 'short', day: 'numeric' })}</strong><span>${items.length} ${items.length === 1 ? 'task' : 'tasks'}</span></div><div class="calendar-mobile-tasks">${items.map(task => `<button class="calendar-mobile-task ${isStudyTask(task) ? 'study-calendar' : ''} ${task.type === 'fixed_event' ? 'event-calendar' : ''}" data-action="open-task" data-id="${task.id}"><span>${escapeHtml(task.title)}</span><small>${taskDisplayTime(task) ? formatTime(taskDisplayTime(task)) : task.className || task.project || 'Scheduled task'}</small></button>`).join('')}</div></section>`);
  }
  return `<div class="calendar"><div class="calendar-toolbar"><button class="icon-button" data-action="calendar-prev">‹</button><strong>${monthLabel}</strong><button class="icon-button" data-action="calendar-next">›</button></div><div class="calendar-desktop"><div class="calendar-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${weeks.join('')}</div></div><div class="calendar-mobile-agenda">${mobileDays.length ? mobileDays.join('') : emptyState('No tasks this month', 'Scheduled work will appear here.')}</div>${selectedCalendarDate ? renderCalendarDayPopup(selectedCalendarDate) : ''}</div>`;
}

function calendarTaskLabels(task) {
  const labels = [task.className, task.project];
  if (isStudyTask(task)) labels.push('Study');
  if (task.type === 'fixed_event') labels.push(task.assignmentType && task.assignmentType !== 'event' ? assignmentTypeLabel(task.assignmentType) : 'Event');
  const visible = [...new Set(labels.filter(label => typeof label === 'string' && label.trim()))].slice(0, 2);
  return visible.length ? `<span class="calendar-task-label">${visible.map(label => escapeHtml(displayTagLabel(label))).join(' · ')}</span>` : '';
}

function renderCalendarDayPopup(dateKey) {
  const tasks = calendarTasksForDate(dateKey).sort(taskSort);
  const title = formatDate(dateKey, { weekday: 'long', month: 'long', day: 'numeric' });
  return `<div class="calendar-day-backdrop" data-action="close-calendar-day"></div><section class="calendar-day-popup" role="dialog" aria-modal="true" aria-label="Tasks for ${escapeHtml(title)}"><div class="calendar-day-popup-header"><div><div class="eyebrow">Calendar day</div><h2>${escapeHtml(title)}</h2><p class="muted">${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}</p></div><button class="icon-button" type="button" data-action="close-calendar-day" aria-label="Close day details">×</button></div><div class="calendar-day-popup-tasks">${tasks.length ? tasks.map(renderTaskRow).join('') : emptyState('Nothing scheduled', 'There are no tasks on this day.')}</div></section>`;
}

function renderClasses() { if (selectedCollection?.type === 'class' && state.classes.includes(selectedCollection.name)) return renderCollectionDetail('class', selectedCollection.name); return `${renderCapture()}<div class="cards-grid">${state.classes.map(name => { const tasks = state.tasks.filter(t => t.className === name && t.status !== 'completed'); const colorStyle = classColorStyle(name); return `<button class="class-card" type="button" data-action="open-class" data-class="${escapeHtml(name)}"><div class="class-color" style="${colorStyle}"></div><div class="class-card-top"><span class="class-icon" style="${colorStyle}">${escapeHtml(name.slice(0, 1))}</span><span class="row-more" aria-hidden="true">···</span></div><h3>${escapeHtml(name)}</h3><p>${tasks.length ? `${tasks.length} open task${tasks.length === 1 ? '' : 's'}` : 'No open tasks'}</p><div class="progress"><span style="width:${Math.min(100, tasks.length ? 24 : 100)}%"></span></div></button>`; }).join('')}<button class="add-card" type="button" data-action="focus-class">＋ <span>Add class</span></button></div>`; }
function renderProjects() { if (selectedCollection?.type === 'project' && state.projects.includes(selectedCollection.name)) return renderCollectionDetail('project', selectedCollection.name); return `${renderCapture()}<div class="projects-toolbar"><div><div class="eyebrow">Workspace</div><p class="muted">Keep related tasks together in a project.</p></div><form id="project-form" class="project-form"><input id="new-project-name" placeholder="New project" maxlength="80" autocomplete="off"/><button class="primary-button" type="submit">Add project</button></form></div><div class="cards-grid projects-grid">${state.projects.map((name, index) => { const tasks = state.tasks.filter(t => t.project === name && t.status !== 'completed'); return `<div class="project-card"><button class="project-open" type="button" data-action="open-project" data-project="${escapeHtml(name)}"><div class="project-icon">${svgIcon('folder')}</div><div><h3>${escapeHtml(name)}</h3><p>${tasks.length} open task${tasks.length === 1 ? '' : 's'}</p></div><span class="project-dot dot-${index % 4}"></span></button><button class="project-delete" type="button" data-action="delete-project" data-project="${escapeHtml(name)}" aria-label="Delete ${escapeHtml(name)}" title="Delete project">×</button></div>`; }).join('')}<div class="add-card project-add-hint">＋ <span>Add a project above</span></div></div>`; }

function teamMemberLabel(member) {
  if (member.user_id === currentUser?.id) return currentUser?.emailAddresses?.[0]?.emailAddress || member.display_name || 'You';
  return member.display_name || 'Member';
}
function renderTeamMember(member) { return `<span class="tag team-member-tag"><span>${escapeHtml(teamMemberLabel(member))}</span><small>${escapeHtml(member.user_id || 'Unknown user')}</small>${member.user_id === currentUser?.id ? ' · You' : ''}</span>`; }
function teamCompletions(detail, taskId) { return new Set(detail.completions.filter(completion => completion.team_task_id === taskId).map(completion => completion.user_id)); }
function teamAvailability(detail, userId) {
  const slots = detail.availability.find(item => item.user_id === userId)?.slots;
  if (!Array.isArray(slots)) return [];
  return slots.map(slot => {
    const weekday = Number(slot?.weekday);
    const start = teamTimeMinutes(slot?.start ?? slot?.start_time);
    const end = teamTimeMinutes(slot?.end ?? slot?.end_time);
    return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 && Number.isFinite(start) && Number.isFinite(end) && start < end
      ? { ...slot, weekday, start: teamTimeString(start), end: teamTimeString(end) }
      : null;
  }).filter(Boolean);
}
function teamTimeMinutes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : NaN;
}
function teamTimeString(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }
function teamAvailabilityRespondents(detail) {
  const submitted = new Set((detail.availability || []).map(item => item?.user_id).filter(Boolean));
  return detail.members.filter(member => submitted.has(member.user_id));
}
function teamCommonAvailability(detail) {
  const respondents = teamAvailabilityRespondents(detail);
  if (!respondents.length) return [];
  const windows = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    let intersections = teamAvailability(detail, respondents[0].user_id).filter(slot => slot.weekday === weekday);
    for (const member of respondents.slice(1)) {
      const next = teamAvailability(detail, member.user_id).filter(slot => slot.weekday === weekday);
      intersections = intersections.flatMap(left => next.map(right => ({ weekday, start: Math.max(teamTimeMinutes(left.start), teamTimeMinutes(right.start)), end: Math.min(teamTimeMinutes(left.end), teamTimeMinutes(right.end)) })).filter(window => window.start < window.end));
    }
    windows.push(...intersections);
  }
  return windows;
}
function teamCrossDayAvailability(detail) {
  const respondents = teamAvailabilityRespondents(detail);
  const overlaps = new Map();
  for (let leftIndex = 0; leftIndex < respondents.length; leftIndex += 1) {
    const leftSlots = teamAvailability(detail, respondents[leftIndex].user_id);
    for (let rightIndex = leftIndex + 1; rightIndex < respondents.length; rightIndex += 1) {
      const rightSlots = teamAvailability(detail, respondents[rightIndex].user_id);
      for (const left of leftSlots) {
        for (const right of rightSlots) {
          if (left.weekday === right.weekday) continue;
          const firstDay = Math.min(left.weekday, right.weekday);
          const secondDay = Math.max(left.weekday, right.weekday);
          const start = Math.max(teamTimeMinutes(left.start), teamTimeMinutes(right.start));
          const end = Math.min(teamTimeMinutes(left.end), teamTimeMinutes(right.end));
          if (start >= end) continue;
          const key = `${firstDay}-${secondDay}-${start}-${end}`;
          overlaps.set(key, { firstDay, secondDay, start, end });
        }
      }
    }
  }
  return [...overlaps.values()].sort((left, right) => left.firstDay - right.firstDay || left.secondDay - right.secondDay || left.start - right.start || left.end - right.end);
}
function teamAvailabilityEditor(detail) {
  const current = teamAvailability(detail, currentUser?.id);
  const weekdays = [['0', 'Sun'], ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat']];
  return `<form id="team-availability-form" class="team-availability-form"><div class="settings-title"><h3>My availability</h3><p>Share only the weekly windows you want this team to use.</p></div><div class="team-availability-grid">${weekdays.map(([day, label]) => { const slot = current.find(item => Number(item.weekday) === Number(day)); return `<div class="team-availability-row"><label class="team-day-toggle"><input type="checkbox" class="team-availability-day" data-weekday="${day}" ${slot ? 'checked' : ''}/> ${label}</label><input type="time" class="team-availability-start" data-weekday="${day}" value="${slot?.start || '16:00'}"/><span>to</span><input type="time" class="team-availability-end" data-weekday="${day}" value="${slot?.end || '18:00'}"/></div>`; }).join('')}</div><button class="secondary-button" type="submit">Save my availability</button></form>`;
}
function renderTeamAvailability(detail) {
  const windows = teamCommonAvailability(detail);
  const crossDayWindows = teamCrossDayAvailability(detail);
  const respondentCount = teamAvailabilityRespondents(detail).length;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const content = windows.length ? windows.map(window => `<span class="team-window"><strong>${names[window.weekday]}</strong> ${formatTime(teamTimeString(window.start))}–${formatTime(teamTimeString(window.end))}</span>`).join('') : respondentCount ? '<p class="muted">No overlapping windows among the availability submitted so far.</p>' : '<p class="muted">Availability will appear here as teammates submit it.</p>';
  const crossDayNotice = crossDayWindows.length ? `<div class="team-cross-day-notice"><strong>Overlapping times on different days</strong><p>You have overlapping times on these days, but the days don’t overlap. These are similar clock times, not shared meeting windows.</p><div class="team-cross-day-list">${crossDayWindows.map(window => `<span class="team-cross-day-window"><strong>${names[window.firstDay]} & ${names[window.secondDay]}</strong> ${formatTime(teamTimeString(window.start))}–${formatTime(teamTimeString(window.end))}</span>`).join('')}</div></div>` : '';
  return `<section class="team-availability-summary"><div class="settings-title"><h3>Shared availability</h3><p>Currently shared by ${respondentCount} of ${detail.members.length} member${detail.members.length === 1 ? '' : 's'} who have responded. This updates as more availability is submitted.</p></div><div class="team-windows">${content}</div>${crossDayNotice}</section>`;
}
function teamTaskValidationMessage(task) {
  if (!task.due_date) return 'Team tasks need a due date. Add one before saving.';
  if (task.due_date < today()) return 'That team task is in the past. Choose today or a future date.';
  if (task.due_date === today() && task.due_time) {
    const [hour, minute] = String(task.due_time).split(':').map(Number);
    const now = new Date();
    if (Number.isFinite(hour) && Number.isFinite(minute) && (hour * 60 + minute) < (now.getHours() * 60 + now.getMinutes())) return 'That team task time has already passed. Choose a later time.';
  }
  return '';
}
function teamSubprojectOptions(detail, selectedId = '') {
  return [`<option value="">No subproject</option>`, ...(detail?.subprojects || []).map(subproject => `<option value="${escapeHtml(subproject.id)}" ${selectedId === subproject.id ? 'selected' : ''}>${escapeHtml(subproject.name)}</option>`)].join('');
}
function teamAssigneeOptions(detail, selectedId = '') {
  return [`<option value="">Anyone on the team</option>`, ...(detail?.members || []).map(member => `<option value="${escapeHtml(member.user_id)}" ${selectedId === member.user_id ? 'selected' : ''}>${escapeHtml(teamMemberLabel(member))}${member.user_id === currentUser?.id ? ' (you)' : ''}</option>`)].join('');
}
function renderTeamSubprojects(detail) {
  const subprojects = Array.isArray(detail.subprojects) ? detail.subprojects : [];
  const owner = detail.member?.role === 'owner';
  const filters = [`<button class="team-subproject-filter ${!activeTeamSubprojectId ? 'active' : ''}" type="button" data-action="select-team-subproject" data-id="">All tasks</button>`, ...subprojects.map(subproject => `<span class="team-subproject-filter-wrap"><button class="team-subproject-filter ${activeTeamSubprojectId === subproject.id ? 'active' : ''}" type="button" data-action="select-team-subproject" data-id="${escapeHtml(subproject.id)}">${escapeHtml(subproject.name)}</button>${owner ? `<button class="team-subproject-tool" type="button" data-action="rename-team-subproject" data-id="${escapeHtml(subproject.id)}" aria-label="Rename ${escapeHtml(subproject.name)}">···</button><button class="team-subproject-tool" type="button" data-action="delete-team-subproject" data-id="${escapeHtml(subproject.id)}" aria-label="Delete ${escapeHtml(subproject.name)}">×</button>` : ''}</span>`)].join('');
  const create = owner ? '<form id="team-subproject-form" class="team-subproject-form"><input name="name" maxlength="120" placeholder="New subproject" required/><button class="secondary-button" type="submit">＋ Add subproject</button></form>' : '';
  return `<section class="team-subprojects"><div class="settings-title"><h3>Subprojects</h3><p>Organize this team into focused workstreams. Assigned tasks are visible only to their assignee.</p></div><div class="team-subproject-filters">${filters}</div>${create}</section>`;
}
function renderTeamTaskEditor(task) {
  return `<form class="team-task-edit-form" data-team-task-edit data-id="${task.id}" data-priority="${task.priority || 1}"><input name="title" maxlength="500" value="${escapeHtml(task.title)}" required/><textarea name="description" maxlength="10000" placeholder="Optional details">${escapeHtml(task.description || '')}</textarea><div class="team-task-edit-fields"><input name="due_date" type="date" value="${escapeHtml(task.due_date || '')}"/><input name="due_time" type="time" value="${escapeHtml((task.due_time || '').slice(0, 5))}"/><input name="duration_minutes" type="number" min="1" max="1440" placeholder="Minutes" value="${task.duration_minutes || ''}"/><select name="priority" aria-label="Priority"><option value="1" ${Number(task.priority) === 1 ? 'selected' : ''}>Normal</option><option value="2" ${Number(task.priority) === 2 ? 'selected' : ''}>High</option><option value="3" ${Number(task.priority) === 3 ? 'selected' : ''}>Urgent</option><option value="4" ${Number(task.priority) === 4 ? 'selected' : ''}>Critical</option></select><select name="subproject_id" aria-label="Subproject">${teamSubprojectOptions(activeTeamDetail, task.subproject_id || '')}</select><select name="assignee_id" aria-label="Assignee">${teamAssigneeOptions(activeTeamDetail, task.assignee_id || '')}</select></div><div class="team-task-edit-actions"><button class="primary-button" type="submit">Save changes</button><button class="secondary-button" type="button" data-action="cancel-team-task-edit">Cancel</button></div></form>`;
}
function renderTeamTaskRow(detail, task) {
  if (editingTeamTaskId === task.id) return renderTeamTaskEditor(task);
  const completionIds = teamCompletions(detail, task.id);
  const done = completionIds.size;
  const currentUserCompleted = completionIds.has(currentUser?.id);
  const assigneeCompleted = Boolean(task.assignee_id && completionIds.has(task.assignee_id));
  const teamCompleted = task.assignee_id ? assigneeCompleted : done >= detail.members.length;
  const blockedForAssignee = Boolean(task.assignee_id && task.assignee_id !== currentUser?.id && !assigneeCompleted);
  const subproject = task.subproject_name ? `<span class="tag project-tag">${escapeHtml(task.subproject_name)}</span>` : '';
  const assignee = task.assignee_name ? `<span class="tag team-tag">For ${escapeHtml(task.assignee_name)}</span>` : '';
  const completionLabel = task.assignee_id ? (teamCompleted ? 'Assignee complete' : blockedForAssignee ? 'Waiting for assignee' : 'Assigned to you') : `${done}/${detail.members.length} complete`;
  return `<div class="team-task-row${teamCompleted ? ' is-complete' : ''}"><button class="checkbox priority-${task.priority || 1}${currentUserCompleted ? ' checked' : ''}" type="button" data-action="toggle-team-task" data-id="${task.id}" aria-label="${currentUserCompleted ? 'Reopen' : 'Complete'} ${escapeHtml(task.title)}" ${blockedForAssignee ? 'disabled title="Waiting for the assignee to complete this task"' : ''}></button><div class="task-main"><strong class="team-task-title">${escapeHtml(task.title)}</strong>${task.description ? `<p class="muted">${escapeHtml(task.description)}</p>` : ''}<div class="task-meta">${task.due_time ? `<span>${formatTime(task.due_time)}</span>` : task.due_date ? `<span>${formatDate(task.due_date)}</span>` : ''}${task.duration_minutes ? `<span>· ${task.duration_minutes} min</span>` : ''}${subproject}${assignee}<span class="tag project-tag">${completionLabel}</span></div></div><button class="row-more" type="button" data-action="edit-team-task" data-id="${task.id}" aria-label="Edit ${escapeHtml(task.title)}">Edit</button></div>`;
}
function teamTaskIsComplete(detail, task) {
  const completionIds = teamCompletions(detail, task.id);
  return task.assignee_id ? completionIds.has(task.assignee_id) : completionIds.size >= detail.members.length;
}
function teamTaskReference(value) {
  const raw = String(value || '');
  const parts = raw.split('::');
  let teamTaskId = parts.length > 1 ? parts[1] : raw;
  let teamProjectId = parts.length > 1 ? parts[0] : activeTeamProjectId;
  const source = teamTaskFeed.find(task => task.id === teamTaskId || task.id === raw || task.team_task_id === teamTaskId)
    || activeTeamDetail?.tasks.find(task => task.id === teamTaskId);
  if (source) {
    teamTaskId = source.id;
    teamProjectId = source.team_project_id || teamProjectId;
  }
  return { teamTaskId, teamProjectId };
}
function renderTeamProject(detail) {
  const code = teamInviteCodes[detail.project.id];
  const completedByMe = new Set(detail.completions.filter(completion => completion.user_id === currentUser?.id).map(completion => completion.team_task_id));
  const visibleTasks = detail.tasks.filter(task => !teamTaskIsComplete(detail, task) && (!activeTeamSubprojectId || task.subproject_id === activeTeamSubprojectId));
  const completedMine = detail.tasks.filter(task => completedByMe.has(task.id));
  const taskRows = visibleTasks.map(task => renderTeamTaskRow(detail, task)).join('');
  const ownerActions = detail.member.role === 'owner' ? `<button class="secondary-button" type="button" data-action="rename-team-project" ${teamBusy ? 'disabled' : ''}>Rename team</button><button class="secondary-button" type="button" data-action="regenerate-team-code">Regenerate code</button><button class="danger-button" type="button" data-action="delete-team-tasks" ${teamBusy ? 'disabled' : ''}>Delete all tasks</button><button class="danger-button" type="button" data-action="delete-team-project" ${teamBusy ? 'disabled' : ''}>Delete project</button>` : '';
  const activeSubproject = detail.subprojects?.find(subproject => subproject.id === activeTeamSubprojectId);
  const fileRows = activeTeamFiles.length ? activeTeamFiles.map(file => `<li><a href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.file_name)}</a><span class="muted">${Math.ceil(Number(file.size_bytes || 0) / 1024)} KB</span><button class="row-more" type="button" data-action="delete-team-file" data-id="${escapeHtml(file.id)}" aria-label="Delete ${escapeHtml(file.file_name)}">×</button></li>`).join('') : '<li class="muted">No files shared yet.</li>';
  const teamFiles = `<section class="team-files settings-section"><div class="settings-title"><h3>Shared files</h3><p>Keep briefs, notes, and other team materials in one place. Files are private to this team.</p></div><input id="team-file-input" type="file" multiple hidden/><button class="secondary-button" type="button" data-action="choose-team-files" ${teamBusy ? 'disabled' : ''}>Upload files</button><ul class="team-file-list">${fileRows}</ul></section>`;
  return `<div class="team-project-view"><button class="back-link" type="button" data-action="back-teams">← Back to teams</button><div class="team-project-heading"><div><div class="eyebrow">Team project</div><h2>${escapeHtml(detail.project.name)}</h2><p class="muted">${detail.members.length} member${detail.members.length === 1 ? '' : 's'} · Complete tasks independently</p></div><div class="team-project-actions"><button class="secondary-button" type="button" data-action="copy-team-code" ${code ? '' : 'disabled'}>Copy join code</button>${ownerActions}</div></div><section class="team-invite-card"><div><strong>Invite teammates</strong><p class="muted">Share this code so others can join.</p></div>${code ? `<code>${escapeHtml(code)}</code>` : '<span class="muted">The code is only shown when created or regenerated.</span>'}</section><section class="team-members"><div class="section-heading"><span>Members</span><span class="muted">${detail.members.length}</span></div><div class="team-member-list">${detail.members.map(renderTeamMember).join('')}</div></section>${renderTeamSubprojects(detail)}<section class="team-task-section"><div class="settings-title"><h3>${activeSubproject ? escapeHtml(activeSubproject.name) : 'Team tasks'}</h3><p>${activeSubproject ? 'Tasks in this subproject.' : 'Unassigned tasks are visible to the whole team; assigned tasks only appear for their assignee.'}</p></div><form id="team-task-form" class="team-task-form"><input name="title" maxlength="500" placeholder="Add a team task" required/><textarea name="description" maxlength="10000" placeholder="Optional details"></textarea><input name="due_date" type="date"/><input name="due_time" type="time"/><input name="duration_minutes" type="number" min="1" max="1440" placeholder="Minutes"/><select name="subproject_id" aria-label="Subproject">${teamSubprojectOptions(detail, activeTeamSubprojectId || '')}</select><select name="assignee_id" aria-label="Assign to">${teamAssigneeOptions(detail)}</select><button class="primary-button" type="submit">Add task</button></form><div class="team-task-list">${taskRows || '<p class="muted">You have no remaining team tasks in this view.</p>'}</div>${completedMine.length ? `<p class="team-completed-note">${completedMine.length} task${completedMine.length === 1 ? '' : 's'} completed by you and hidden from your list.</p>` : ''}</section>${teamFiles}${teamAvailabilityEditor(detail)}${renderTeamAvailability(detail)}</div>`;
}
function renderTeams() {
  if (activeTeamDetail) return renderTeamProject(activeTeamDetail);
  return `<div class="teams-view"><div class="content-header"><div><div class="eyebrow">Collaboration</div><h2>Team projects</h2><p class="muted">Share tasks, collect availability, and let each person finish work on their own timeline.</p></div></div><div class="team-entry-grid"><form id="team-create-form" class="settings-section"><div class="settings-title"><h3>Create a team project</h3><p>You’ll receive a join code to share.</p></div><label>Project name<input name="name" maxlength="120" placeholder="e.g. VEX build season" required/></label><button class="primary-button" type="submit">Create team</button></form><form id="team-join-form" class="settings-section"><div class="settings-title"><h3>Join a team</h3><p>Enter the code from the project owner.</p></div><label>Join code<input name="join_code" maxlength="32" placeholder="12-character code" required/></label><button class="secondary-button" type="submit">Join team</button></form></div><section class="team-list">${teamProjects.length ? teamProjects.map(project => `<button class="team-card" type="button" data-action="open-team" data-id="${project.id}"><div><div class="eyebrow">Team project</div><h3>${escapeHtml(project.name)}</h3><p>${project.membership?.role === 'owner' ? 'Owner' : 'Member'}</p></div><span>Open →</span></button>`).join('') : '<p class="muted">No team projects yet. Create one or join with a code.</p>'}</section></div>`;
}

function renderSettings() {
  const classRows = state.classes.map(name => { const preference = state.profile.classPreferences?.[name] || defaultClassPreference(); return `<div class="class-preference"><strong>${escapeHtml(name)}</strong><label>Sessions/week<input class="class-pref-sessions" data-class="${escapeHtml(name)}" type="number" min="1" max="14" value="${preference.sessionsPerWeek ?? 2}"/></label><label>Session length<select class="class-pref-length" data-class="${escapeHtml(name)}"><option value="30" ${preference.sessionLength === 30 ? 'selected' : ''}>30 min</option><option value="45" ${(!preference.sessionLength || preference.sessionLength === 45) ? 'selected' : ''}>45 min</option><option value="60" ${preference.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label></div>`; }).join('');
  const managedClasses = state.classes.map(name => `<div class="class-management-row"><input class="class-name-edit" data-original-class="${escapeHtml(name)}" value="${escapeHtml(name)}"/><button class="danger-button" type="button" data-action="remove-class" data-class="${escapeHtml(name)}">Remove</button></div>`).join('');
  return `<div class="settings-layout"><section class="settings-section profile-settings"><div class="settings-title"><h2>Profile</h2><p>Your profile picture is saved to your signed-in account and will follow you across devices.</p></div><div class="profile-picture-editor"><span class="avatar profile-avatar">${avatarContent()}</span><div class="profile-picture-copy"><strong>${escapeHtml(currentUser?.firstName || currentUser?.username || currentUserEmail().split('@')[0] || 'Your profile')}</strong><span class="muted">${escapeHtml(accountEmail())}</span><label class="secondary-button profile-picture-button" for="profile-picture-input">${profilePictureBusy ? 'Saving…' : 'Choose profile picture'}</label><input id="profile-picture-input" type="file" accept="image/*"${profilePictureBusy ? ' disabled' : ''}/><small class="muted">Phone photos are resized automatically · 25 MB max</small></div></div></section><section class="settings-section"><div class="settings-title"><h2>Study preferences</h2><p>Silico uses these preferences to place realistic study sessions around your commitments.</p></div><label>Default session length<select id="session-length"><option value="30" ${state.profile.sessionLength === 30 ? 'selected' : ''}>30 minutes</option><option value="45" ${state.profile.sessionLength === 45 ? 'selected' : ''}>45 minutes</option><option value="60" ${state.profile.sessionLength === 60 ? 'selected' : ''}>1 hour</select></label><label>Default sessions/week<input id="sessions-per-assessment" type="number" min="1" max="14" value="${state.profile.sessionsPerWeek ?? state.profile.sessionsPerAssessment ?? 3}"/></label><div class="settings-hint">Sessions/week is also the number of consecutive days before an assessment that receive study sessions.</div><div class="settings-row"><label>Study window starts<input id="preferred-start" type="time" value="${state.profile.preferredStart}"/></label><label>Latest study time<input id="latest-study" type="time" value="${state.profile.latestStudyTime}"/></label></div><button class="primary-button" type="button" data-action="save-settings">Save preferences</button></section><section class="settings-section class-management"><div class="settings-title"><h2>Manage classes</h2><p>Add or rename classes anytime. Existing tasks keep their class when you rename it.</p></div>${managedClasses || '<p class="muted">No classes yet.</p>'}<div class="class-add-row"><input id="new-class-name" placeholder="Add a class" maxlength="80"/><button class="secondary-button" type="button" data-action="add-class">Add class</button></div><button class="primary-button" type="button" data-action="save-classes">Save class changes</button></section><section class="settings-section"><div class="settings-title"><h2>Class allocation</h2><p>Sessions/week also controls how many days before each assessment receive study sessions.</p></div><div class="class-preference-list">${classRows || '<p class="muted">Add a class to set its study allocation.</p>'}</div><button class="secondary-button" type="button" data-action="save-settings">Save class allocation</button></section><section class="settings-section"><div class="settings-title"><h2>Scheduling boundaries</h2><p>These hard boundaries are always respected by the scheduler.</p></div><div class="settings-row"><label>School starts<input id="school-start" type="time" value="${state.profile.schoolStart || '08:00'}"/></label><label>School ends<input id="school-end" type="time" value="${state.profile.schoolEnd || '16:00'}"/></label></div><div class="weekday-picker"><span>School days</span>${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['0','Sun']].map(([value,label]) => `<label class="check-label"><input class="school-day" type="checkbox" value="${value}" ${(state.profile.schoolDays || [1,2,3,4,5]).includes(Number(value)) ? 'checked' : ''}/> ${label}</label>`).join('')}</div><div class="boundary-row"><span class="boundary-icon">◷</span><div><strong>Timezone</strong><small>${Intl.DateTimeFormat().resolvedOptions().timeZone}</small></div></div><button class="primary-button" type="button" data-action="save-settings">Save boundaries</button></section><section class="settings-section danger-zone"><div class="settings-title"><h2>Workspace data</h2><p>Remove every task and derived occurrence from your signed-in workspace.</p></div><div class="header-actions"><button class="danger-button" type="button" data-action="delete-all">Delete all tasks</button></div></section></div>`;
}

function renderFeedbackSection() {
  return `<section id="feedback-section" class="settings-section feedback-section"><div class="settings-title"><h2>Feedback</h2><p>Report a bug or tell us what would make Silico better. Please don’t include passwords or other sensitive information.</p></div><form id="feedback-form" class="feedback-form"><label>Type<select name="category"><option value="feedback" ${feedbackDraft.category === 'feedback' ? 'selected' : ''}>General feedback</option><option value="bug" ${feedbackDraft.category === 'bug' ? 'selected' : ''}>Bug report</option></select></label><label>Details<textarea name="message" maxlength="5000" rows="5" placeholder="What happened, or what would you like to see?" required>${escapeHtml(feedbackDraft.message)}</textarea></label><div class="feedback-actions"><button class="primary-button" type="submit" ${feedbackBusy ? 'disabled' : ''}>${feedbackBusy ? 'Sending…' : 'Send feedback'}</button><span class="muted">Your signed-in account is attached so we can follow up if needed.</span></div></form></section>`;
}

function renderLegacyFeedbackAdminSection() {
  const content = feedbackAdminError
    ? `<p class="feedback-admin-error">${escapeHtml(feedbackAdminError)}</p>`
    : feedbackAdminLoaded
      ? feedbackItems.length
        ? `<div class="feedback-admin-list">${feedbackItems.map(item => `<article class="feedback-admin-item"><div class="feedback-admin-meta"><span class="tag ${item.category === 'bug' ? 'event-tag' : 'project-tag'}">${item.category === 'bug' ? 'Bug' : 'Feedback'}</span><time>${escapeHtml(item.created_at ? new Date(item.created_at).toLocaleString() : 'Unknown time')}</time></div><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.user_id || 'Unknown user')}${item.page ? ` · ${escapeHtml(item.page)}` : ''}</small></article>`).join('')}</div>`
        : '<p class="muted">No feedback has been submitted yet.</p>'
      : '<p class="muted">Feedback stays private to this admin view and is loaded only when requested.</p>';
  const access = feedbackAdminKey
    ? `<p class="muted feedback-admin-unlocked">Admin key saved on this device.</p><div class="feedback-admin-actions"><button class="secondary-button" type="button" data-action="load-feedback-admin" ${feedbackAdminBusy ? 'disabled' : ''}>${feedbackAdminBusy ? 'Loading…' : feedbackAdminLoaded ? 'Refresh feedback' : 'Load feedback'}</button><button class="secondary-button" type="button" data-action="forget-feedback-admin-key">Forget key</button></div>`
    : `<form id="feedback-admin-access-form" class="feedback-admin-access-form"><label>Admin key<input name="admin_key" type="password" autocomplete="off" placeholder="Enter your private admin key" required/></label><button class="primary-button" type="submit">Unlock feedback</button></form>`;
  return `<section id="feedback-admin-section" class="settings-section feedback-admin-section"><div class="settings-title"><h2>Feedback inbox</h2><p>Private owner tool. Your signed-in session and admin key are both required.</p></div>${access}${content}</section>`;
}

function renderFeedbackItem(item) {
  const isBug = item.category === 'bug';
  const resolved = Boolean(item.resolved);
  const email = item.user_email || 'Email unavailable';
  const resolvedControl = isBug ? '<label class="feedback-resolved"><input type="checkbox" data-action="toggle-feedback-resolved" data-id="' + escapeHtml(item.id) + '"' + (resolved ? ' checked' : '') + ' /> Resolved</label>' : '';
  const sender = email !== 'Email unavailable' ? '<a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + '</a>' : email;
  const page = item.page ? ' · ' + escapeHtml(item.page) : '';
  return '<article class="feedback-admin-item' + (resolved ? ' is-resolved' : '') + '"><div class="feedback-admin-meta"><span class="tag ' + (isBug ? 'event-tag">Bug' : 'project-tag">Feedback') + '</span>' + resolvedControl + '<time>' + escapeHtml(item.created_at ? new Date(item.created_at).toLocaleString() : 'Unknown time') + '</time></div><p>' + escapeHtml(item.message) + '</p><small>From: ' + sender + page + '</small></article>';
}

function renderFeedbackAdminSection() {
  const content = feedbackAdminError
    ? '<p class="feedback-admin-error">' + escapeHtml(feedbackAdminError) + '</p>'
    : feedbackAdminLoaded
      ? feedbackItems.length
        ? '<div class="feedback-admin-list">' + feedbackItems.map(renderFeedbackItem).join('') + '</div>'
        : '<p class="muted">No feedback has been submitted yet.</p>'
      : '<p class="muted">Feedback stays private to this admin view and is loaded only when requested.</p>';
  const access = feedbackAdminKey
    ? '<p class="muted feedback-admin-unlocked">Admin key saved on this device; this account is now trusted across devices.</p><div class="feedback-admin-actions"><button class="secondary-button" type="button" data-action="load-feedback-admin"' + (feedbackAdminBusy ? ' disabled' : '') + '>' + (feedbackAdminBusy ? 'Loading…' : feedbackAdminLoaded ? 'Refresh feedback' : 'Load feedback') + '</button><button class="secondary-button" type="button" data-action="revoke-feedback-admin-access"' + (feedbackAdminBusy ? ' disabled' : '') + '>Revoke account access</button></div>'
    : feedbackAdminLoaded
      ? '<p class="muted feedback-admin-unlocked">Feedback access is enabled for this account across devices.</p><div class="feedback-admin-actions"><button class="secondary-button" type="button" data-action="load-feedback-admin"' + (feedbackAdminBusy ? ' disabled' : '') + '>Refresh feedback</button><button class="secondary-button" type="button" data-action="revoke-feedback-admin-access"' + (feedbackAdminBusy ? ' disabled' : '') + '>Revoke account access</button></div>'
      : '<form id="feedback-admin-access-form" class="feedback-admin-access-form"><label>Admin key<input name="admin_key" type="password" autocomplete="off" placeholder="Enter your private admin key" required/></label><button class="primary-button" type="submit">Unlock feedback</button></form>';
  return '<section id="feedback-admin-section" class="settings-section feedback-admin-section"><div class="settings-title"><h2>Feedback inbox</h2><p>Private owner tool. Your signed-in session and admin key are both required.</p></div>' + access + content + '</section>';
}

function renderFeedbackAdminView() {
  return `<div class="feedback-admin-view"><div class="content-header"><div><div class="eyebrow">Feedback</div><h2>Help us improve Silico</h2><p class="muted">Send a bug report or product idea. The owner inbox is available below with a private admin key.</p></div></div>${renderFeedbackSection()}<div class="feedback-admin-heading"><div class="eyebrow">Owner tools</div><h3>Feedback inbox</h3><p class="muted">Review feedback sent from Silico. Only the signed-in owner with the admin key can load it.</p></div>${renderFeedbackAdminSection()}</div>`;
}

function publicFooter() {
  return '<footer class="public-footer"><a href="?page=setup">Setup Guide</a><a href="?page=about">About the Project</a><a href="?page=privacy">Privacy &amp; Security</a><a href="?page=it-admin">Information for School IT Administrators</a></footer>';
}

function renderPublicInfoPage(page) {
  const pages = {
    about: {
      eyebrow: 'Behind the project',
      title: 'Built for the school day.',
      body: '<p>Silico was built by a student to solve a very practical problem: keeping assignments, tests, calendar events, and study time organized in one calm place.</p><p>The project is focused on making school planning easier, clearer, and more realistic. It is an educational utility—not a proxy, VPN, social network, or way around school technology controls.</p>'
    },
    setup: {
      eyebrow: 'Setup guide',
      title: 'Get Silico ready in ten calm minutes.',
      body: '<p>Silico works best when it knows the shape of your real week. Set up the basics once, then capture work as it arrives and let the planner place flexible study around your commitments.</p><h2>1. Set your study rhythm</h2><p>Choose a normal session length, how many sessions you want each week, your earliest start time, and your latest acceptable finish. These are planning preferences—not rigid appointments—and you can change them later in Settings.</p><h2>2. Add your classes</h2><p>Add the classes you actually work on. For each class, choose how often you want to study and how long a typical session should be. Silico uses these preferences when it creates preparation sessions for tests and quizzes.</p><h2>3. Add hard commitments first</h2><p>Import Schoology, Todoist, or another iCalendar feed from Settings, or add fixed events manually. Imported calendar times are treated as hard commitments; flexible work is moved around them instead of replacing them.</p><h2>4. Capture tasks naturally</h2><p>Type things like “math homework today,” “chemistry quiz Friday,” or “study for history test Wednesday.” Add a date or time when it matters. If a task is flexible, Silico can find a realistic window without silently rearranging your future plan.</p><h2>5. Review Upcoming</h2><p>Use Today for the work you can do now, Upcoming for the chronological plan, and Calendar for the month view. Drag a task when you want to move it yourself; your explicit timing takes precedence.</p><h2>6. Keep the plan honest</h2><p>Complete work from the task row when you finish it. Edit duration when the estimate changes. Silico recalculates later flexible tasks around the new amount of work while preserving imported events and explicit user timings.</p><h2>Good defaults to start with</h2><ul><li>45-minute sessions</li><li>10-minute preferred breaks</li><li>Study after school and before your real bedtime</li><li>Imported calendars connected before adding many flexible tasks</li><li>One clear task per assignment instead of a long combined note</li></ul><p>You can revisit every setting at any time. The goal is a plan that reflects your life, not a schedule you have to fight.</p>'
    },
    privacy: {
      eyebrow: 'Privacy & security',
      title: 'A clear, honest privacy notice.',
      body: '<p>Silico stores the information you choose to provide so your workspace can work across sessions. This can include your account name and email, tasks, class and project labels, calendar details you import, scheduling preferences, and optional study materials.</p><p>We use this information to provide the planner, calendar organization, study planning, and optional study-generation features. We do not sell your data, and we do not track your browsing history.</p><p><strong>Silico Study disclosure:</strong> when you generate flashcards, quizzes, outlines, or summaries, the extracted material is sent to Google’s Gemini API. For image-only PDFs, OCR runs locally in your browser first; the original PDF file is not uploaded to Google. The current free Gemini tier may use submitted content to improve Google products. Do not submit grades, private messages, health or family details, or other sensitive information.</p><p>Authentication and storage are handled by managed services using standard security practices, including encryption in transit and at rest where supported. No online service is risk-free, so please do not add sensitive information that the planner does not need.</p><p>Questions about privacy or a request about your information can be sent to <a href="mailto:saharshakonda@gmail.com">saharshakonda@gmail.com</a>.</p>'
    },
    'it-admin': {
      eyebrow: 'For schools',
      title: 'Information for School IT Administrators',
      body: '<p>Silico is a student-built personal organization tool for school planning.</p><ul><li>Silico does not contain a proxy, VPN, or unmanaged chat element.</li><li>Silico is strictly a personal task, calendar, study-planning, and agenda tool.</li><li>It is not designed to bypass school filters, monitoring, access controls, or network policies.</li><li>Administrators with questions can contact <a href="mailto:saharshakonda@gmail.com">saharshakonda@gmail.com</a>.</li></ul>'
    }
  };
  const content = pages[page] || pages.about;
  document.querySelector('#app').innerHTML = `<main class="public-page"><header class="public-header"><a class="brand public-brand" href="/">${brandMarkup}</a><a class="secondary-button" href="/">Back to Silico</a></header><article class="public-card"><div class="eyebrow">${content.eyebrow}</div><h1>${content.title}</h1><div class="public-copy">${content.body}</div></article>${publicFooter()}</main>`;
}

function renderAuth() {
  const isSignUp = new URLSearchParams(location.search).get('auth') === 'sign-up';
  const mode = isSignUp ? 'sign-up' : 'sign-in';
  // Clerk owns internal auth navigation. Rebuilding its mount on every
  // transient auth callback can make the landing page jump or strand the
  // sign-in form after rapid back/forward navigation.
  if (authRenderMode === mode && document.querySelector('.auth-shell #auth-mount')) return;
  authRenderMode = mode;
  const appearance = { appearance: { variables: { colorPrimary: '#5967c7', borderRadius: '7px' } }, routing: 'hash' };
  const signInUrl = `${location.origin}/`;
  const signUpUrl = `${location.origin}/?auth=sign-up`;
  document.querySelector('#app').innerHTML = `<main class="auth-shell"><div class="auth-copy"><div class="brand">${brandMarkup}</div><div class="auth-message"><span class="eyebrow">Make time for what matters</span><h1>Your day, with a little more room to breathe.</h1><p>One calm place for tasks, commitments, and the study sessions that make deadlines feel manageable.</p></div><section class="auth-story"><div class="eyebrow">Behind the project</div><h2>Built by a student for the school day.</h2><p>Silico started as a student-built project to make assignments, calendars, and study time easier to organize.</p><a href="?page=about">Read our story →</a></section><small class="auth-footnote">Secure sign-in powered by Clerk · ${platformStatus.supabaseConfigured ? 'Supabase database connected' : 'Account workspace'}</small>${publicFooter()}</div><div class="auth-card">${clerk ? '<div id="auth-mount"></div>' : '<div class="auth-unavailable"><h2>Sign-in is unavailable</h2><p>Silico could not load Clerk. Refresh the page or check the authentication configuration.</p></div>'}</div></main>`;
  if (clerk) {
    try {
      if (isSignUp) clerk.mountSignUp(document.querySelector('#auth-mount'), { ...appearance, signInUrl, fallbackRedirectUrl: signInUrl, signInFallbackRedirectUrl: signInUrl });
      else clerk.mountSignIn(document.querySelector('#auth-mount'), { ...appearance, signUpUrl, fallbackRedirectUrl: signInUrl });
    } catch {
      document.querySelector('#auth-mount').innerHTML = '<div class="auth-unavailable"><h2>Sign-in is unavailable</h2><p>Clerk loaded without its UI module. Check the Clerk domain configuration and refresh the page.</p></div>';
    }
  }
}

function routePublicNavigation() {
  const page = new URLSearchParams(location.search).get('page');
  if (['about', 'privacy', 'it-admin', 'setup'].includes(page)) renderPublicInfoPage(page);
  else if (authenticatedUser(currentUser)) {
    authRenderMode = null;
    if (state.profile.onboardingComplete === false) renderOnboarding();
    else render();
  } else renderUnauthenticatedRoute();
}

function saveOnboardingPreferencesFromForm() {
  const value = selector => document.querySelector(selector)?.value;
  const selectedDays = [...document.querySelectorAll('.onboarding-school-day:checked')].map(input => Number(input.value));
  const sessionsPerWeek = Math.max(1, Math.min(14, Number(value('#onboarding-weekly')) || 2));
  state.profile = { ...state.profile, sessionLength: Number(value('#onboarding-length') || state.profile.sessionLength || 45), sessionsPerWeek, sessionsPerAssessment: sessionsPerWeek, preferredStart: value('#onboarding-start') || state.profile.preferredStart || '16:00', latestStudyTime: value('#onboarding-latest') || state.profile.latestStudyTime || '21:00', schoolStart: value('#onboarding-school-start') || state.profile.schoolStart || '08:00', schoolEnd: value('#onboarding-school-end') || state.profile.schoolEnd || '16:00', schoolDays: selectedDays.length ? selectedDays : state.profile.schoolDays || [1, 2, 3, 4, 5] };
}

function renderOnboarding() {
  const classFields = state.classes.map(name => { const preference = state.profile.classPreferences?.[name] || defaultClassPreference(); return `<div class="class-preference"><strong>${escapeHtml(name)}</strong><label>Sessions/week<input class="onboarding-class-sessions" data-class="${escapeHtml(name)}" type="number" min="1" max="14" value="${preference.sessionsPerWeek ?? 2}"/></label><label>Length<select class="onboarding-class-length" data-class="${escapeHtml(name)}"><option value="30" ${preference.sessionLength === 30 ? 'selected' : ''}>30 min</option><option value="45" ${(!preference.sessionLength || preference.sessionLength === 45) ? 'selected' : ''}>45 min</option><option value="60" ${preference.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label></div>`; }).join('');
  const step = onboardingStep;
  const stepContent = step === 0
    ? `<div class="onboarding-welcome"><div class="onboarding-tour-icon">✦</div><div class="eyebrow">Welcome to Silico</div><h2>Let’s set up your planning space.</h2><p class="onboarding-copy">This short tour shows you how Silico turns assignments and commitments into a schedule you can actually use.</p><div class="onboarding-tour-cards"><div><strong>Capture</strong><span>Type tasks naturally, with dates and times when you know them.</span></div><div><strong>Protect</strong><span>Imported calendar events stay fixed while flexible work moves around them.</span></div><div><strong>Focus</strong><span>Today and Next up show the next real execution, not a distant deadline.</span></div></div><button class="primary-button" type="button" data-action="onboarding-next">Start the tour <span>→</span></button></div>`
    : step === 1
      ? `<div class="eyebrow">Step 2 of 3 · Your rhythm</div><h2>Tell Silico when studying fits.</h2><p class="onboarding-copy">These preferences guide flexible work. They never override a time you explicitly set.</p><form id="onboarding-form"><label>Typical study session<select id="onboarding-length"><option value="30" ${state.profile.sessionLength === 30 ? 'selected' : ''}>30 minutes</option><option value="45" ${(!state.profile.sessionLength || state.profile.sessionLength === 45) ? 'selected' : ''}>45 minutes</option><option value="60" ${state.profile.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label><label>Sessions per week<input id="onboarding-weekly" type="number" min="0" max="14" value="${state.profile.sessionsPerWeek ?? 2}"/></label><div class="settings-row"><label>Study window starts<input id="onboarding-start" type="time" value="${state.profile.preferredStart || '16:30'}"/></label><label>Latest study time<input id="onboarding-latest" type="time" value="${state.profile.latestStudyTime || '21:00'}"/></label></div><div class="settings-row"><label>School starts<input id="onboarding-school-start" type="time" value="${state.profile.schoolStart || '08:00'}"/></label><label>School ends<input id="onboarding-school-end" type="time" value="${state.profile.schoolEnd || '16:00'}"/></label></div><div class="weekday-picker"><span>School days</span>${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['0','Sun']].map(([value,label]) => `<label class="check-label"><input class="onboarding-school-day" type="checkbox" value="${value}" ${(state.profile.schoolDays || [1,2,3,4,5]).includes(Number(value)) ? 'checked' : ''}/> ${label}</label>`).join('')}</div><div class="onboarding-step-actions"><button class="secondary-button" type="button" data-action="onboarding-back">Back</button><button class="primary-button" type="button" data-action="onboarding-next">Next: classes →</button></div></form>`
      : `<div class="eyebrow">Step 3 of 3 · Your classes and workflow</div><h2>Make the planner specific to you.</h2><p class="onboarding-copy">Class preferences help with explicit study plans. You can import calendars later from Settings.</p><form id="onboarding-form"><fieldset><legend>Class allocation</legend><div id="onboarding-class-list" class="class-preference-list">${classFields || '<p class="muted">Add your first class below.</p>'}</div><div class="class-add-row"><input id="onboarding-class-name" placeholder="Add a class" maxlength="80"/><button class="secondary-button" type="button" data-action="add-onboarding-class">Add class</button></div></fieldset><fieldset><legend>Methods you enjoy</legend><label class="check-label"><input type="checkbox" value="Review notes" ${state.profile.methods?.includes('Review notes') ? 'checked' : ''}/> Review notes</label><label class="check-label"><input type="checkbox" value="Practice problems" ${state.profile.methods?.includes('Practice problems') ? 'checked' : ''}/> Practice problems</label><label class="check-label"><input type="checkbox" value="Flashcards" ${state.profile.methods?.includes('Flashcards') ? 'checked' : ''}/> Flashcards</label><label class="check-label"><input type="checkbox" value="Reading" ${state.profile.methods?.includes('Reading') ? 'checked' : ''}/> Reading</label></fieldset><div class="onboarding-import-note"><strong>Next: connect your calendar</strong><span>After the tour, open Settings to import Schoology, Todoist, or an iCalendar feed. Those times will be protected.</span></div><div class="onboarding-step-actions"><button class="secondary-button" type="button" data-action="onboarding-back">Back</button><button class="primary-button" type="button" data-action="complete-onboarding">Finish setup <span>→</span></button></div></form>`;
  document.querySelector('#app').innerHTML = `<main class="onboarding-shell"><div class="onboarding-layout"><aside class="onboarding-guide"><div class="brand">${brandMarkup}</div><div class="eyebrow">Your first-run tour</div><h1>Build a plan that feels like your week.</h1><p>Silico makes conservative scheduling decisions around the commitments you give it.</p><ol><li><strong>Understand the planner</strong><span>Capture, protect, and focus.</span></li><li><strong>Set your rhythm</strong><span>Choose realistic hours and session lengths.</span></li><li><strong>Personalize classes</strong><span>Then connect your calendar in Settings.</span></li></ol><a href="?page=setup">Read the comprehensive setup guide →</a></aside><div class="onboarding-card"><div class="onboarding-progress"><span class="is-active"></span><span class="${step > 0 ? 'is-active' : ''}"></span><span class="${step > 1 ? 'is-active' : ''}"></span></div>${stepContent}</div></div></main>`;
  document.querySelector('#onboarding-form')?.addEventListener('submit', event => event.preventDefault());
  bindEvents();
}

function isEventTask(task) { return task?.type === 'fixed_event' || ['event', 'club_meeting', 'meeting'].includes(task?.assignmentType); }
function eventReminderForTask(task) { return state.tasks.find(item => item.id !== task?.id && (item.reminderForTaskId === task?.id || item.idempotencyKey === `event-reminder:${task?.id}`)) || null; }
async function removeEventReminder(task) {
  const reminder = eventReminderForTask(task);
  if (!reminder) return;
  state.tasks = state.tasks.filter(item => item.id !== reminder.id);
  markTaskDeleted(reminder.id);
  await repository?.remove(reminder.id).catch(() => {});
}
async function syncEventReminder(task) {
  const existing = eventReminderForTask(task);
  const enabled = isEventTask(task) && task.eventReminderEnabled === true && Boolean(task.dueDate);
  if (!enabled) {
    await removeEventReminder(task);
    saveState();
    return;
  }
  const reminderDate = addDays(task.dueDate, -2);
  const recipient = String(task.eventReminderRecipient || 'parents').trim().replace(/\s+/g, ' ').slice(0, 80) || 'parents';
  const idempotencyKey = `event-reminder:${task.id}`;
  const reminderTime = existing ? taskExecution(existing).time || existing.dueTime || null : null;
  const reminder = existing || makeTask({ title: `Inform ${recipient} about ${task.title}`, dueDate: reminderDate, priority: task.priority, duration: 10 }, { source: 'scheduler', assignmentType: 'other', idempotencyKey });
  Object.assign(reminder, { title: `Inform ${recipient} about ${task.title}`, description: `Reminder for ${task.title}`, dueDate: reminderDate, dueTime: reminderTime, duration: 10, priority: task.priority || 1, className: task.className || null, project: task.project || null, type: 'task', source: 'scheduler', assignmentType: 'reminder', eventReminderEnabled: false, eventReminderRecipient: '', reminderForTaskId: task.id, idempotencyKey, userScheduled: true, userPinned: false, autoScheduled: false, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed', schedulingReason: 'Two-day event reminder', updatedAt: new Date().toISOString() });
  setTaskExecution(reminder, reminderDate, reminderTime);
  if (!existing) state.tasks.push(reminder);
  if (repository) {
    try {
      const saved = existing ? await repository.update(reminder) : await repository.create(reminder);
      if (saved) Object.assign(reminder, saved);
      delete reminder.syncRetryAfter;
    } catch { markTaskSyncRetry(reminder); }
  }
  saveState();
}

function repairEventReminderSchedules({ persist = false } = {}) {
  const changed = [];
  state.tasks.forEach(reminder => {
    if (reminder.assignmentType !== 'reminder' && !reminder.reminderForTaskId && !String(reminder.idempotencyKey || '').startsWith('event-reminder:')) return;
    const parent = state.tasks.find(parentTask => parentTask.id === reminder.reminderForTaskId || reminder.idempotencyKey === `event-reminder:${parentTask.id}`);
    if (!parent?.dueDate) return;
    const reminderDate = addDays(parent.dueDate, -2);
    const reminderTime = taskExecution(reminder).time || reminder.dueTime || null;
    const needsRepair = reminder.dueDate !== reminderDate
      || reminder.scheduledDate !== reminderDate
      || reminder.userScheduled !== true
      || reminder.autoScheduled === true
      || reminder.scheduleOrigin !== SCHEDULE_ORIGINS.USER_SCHEDULED;
    if (!needsRepair) return;
    Object.assign(reminder, { dueDate: reminderDate, dueTime: reminderTime, userScheduled: true, userPinned: false, autoScheduled: false, scheduleOrigin: SCHEDULE_ORIGINS.USER_SCHEDULED, flexibility: 'fixed', updatedAt: new Date().toISOString() });
    setTaskExecution(reminder, reminderDate, reminderTime);
    changed.push(reminder);
  });
  if (!changed.length) return changed;
  saveState();
  if (persist && repository) Promise.all(changed.filter(task => isRemoteTaskId(task.id)).map(task => repository.update(task).catch(() => { markTaskSyncRetry(task); }))).catch(() => {});
  return changed;
}

function renderTaskDrawer() { const task = getTaskById(selectedTaskId); if (!task) return ''; const recurrenceText = task.recurrence ? `every ${task.recurrence.frequency === 'daily' ? 'day' : task.recurrence.frequency === 'monthly' ? 'month' : 'week'}` : ''; const execution = taskExecution(task); const editDate = execution.date || task.dueDate || ''; const editTime = execution.time || task.dueTime || ''; const classOptions = [...new Set([task.className, ...state.classes].filter(Boolean))].map(name => `<option value="${escapeHtml(name)}" ${task.className === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join(''); const projectOptions = [`<option value="">No project</option>`, ...state.projects.map(name => `<option value="${escapeHtml(name)}" ${task.project === name ? 'selected' : ''}>${escapeHtml(name)}</option>`), '<option value="__new_project__">＋ Add new project…</option>'].join(''); const assignmentOptions = ASSIGNMENT_TYPES.map(option => `<option value="${option.value}" ${task.assignmentType === option.value ? 'selected' : ''}>${option.label}</option>`).join(''); const duration = Number(task.duration); const displayDuration = Number.isFinite(duration) && duration > 0 ? Math.min(1440, duration) : 30; const eventReminderFields = `<div id="drawer-event-reminder-fields" class="drawer-event-reminder${isEventTask(task) ? '' : ' is-hidden'}"><label class="check-label"><input id="drawer-event-reminder" type="checkbox" ${task.eventReminderEnabled ? 'checked' : ''}/> Remind someone 2 days before</label><label>Who should be informed?<input id="drawer-event-recipient" maxlength="80" value="${escapeHtml(task.eventReminderRecipient || 'parents')}" placeholder="e.g. parents"/></label><small class="muted">Creates a task: “Inform [recipient] about [event]”.</small></div>`; return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="task-drawer"><div class="drawer-header"><span>Task details</span><button class="icon-button" data-action="close-drawer">×</button></div><input class="drawer-title" id="drawer-title" value="${escapeHtml(task.title)}"/><div class="drawer-fields"><label>Assignment type<select id="drawer-assignment-type">${assignmentOptions}</select></label><label>Date<input id="drawer-date" type="date" value="${editDate}"/></label><label>Time<input id="drawer-time" type="time" value="${editTime}"/><small class="muted">Explicit times stay fixed. Flexible study and homework begin after 4:00 PM.</small></label><label>Duration<input id="drawer-duration" type="number" min="1" step="1" value="${displayDuration}"/><small class="muted">Enter the estimated minutes.</small></label><label>Priority<select id="drawer-priority"><option value="1" ${task.priority === 1 ? 'selected' : ''}>Normal</option><option value="2" ${task.priority === 2 ? 'selected' : ''}>High</option><option value="3" ${task.priority === 3 ? 'selected' : ''}>Urgent</option><option value="4" ${task.priority === 4 ? 'selected' : ''}>Critical</option></select></label><label>Class<select id="drawer-class"><option value="">No class</option>${classOptions}</select></label><label>Project<select id="drawer-project">${projectOptions}</select></label><label>Recurrence<input id="drawer-recurrence" value="${escapeHtml(recurrenceText)}" placeholder="e.g. every Monday"/></label></div>${eventReminderFields}<textarea id="drawer-description" placeholder="Add a description…">${escapeHtml(task.description || '')}</textarea><div class="drawer-footer"><button class="danger-button" type="button" data-action="delete-task" data-id="${task.id}">Delete</button><button class="secondary-button" type="button" data-action="copy-task" data-id="${task.id}">Copy</button><button class="primary-button" type="button" data-action="save-task" data-id="${task.id}">Save</button></div></aside>`; }

function elClassName(id) { return document.querySelector(`[data-action="remove-class"][data-class="${CSS.escape(id || '')}"]`)?.dataset.class || id; }
function saveClassNames() {
  const previousState = stateSnapshot();
  const rows = [...document.querySelectorAll('.class-name-edit')];
  const renames = new Map();
  const names = [];
  for (const row of rows) {
    const original = row.dataset.originalClass;
    const name = normalizeClassName(row.value);
    if (!name || names.some(item => String(item || '').toLowerCase() === name.toLowerCase())) { showToast('Class names must be unique and cannot be empty.'); return; }
    names.push(name);
    if (original !== name) renames.set(original, name);
  }
  state.tasks.forEach(task => { if (renames.has(task.className)) task.className = renames.get(task.className); });
  const preferences = {};
  names.forEach(name => {
    const original = [...renames.entries()].find(([, next]) => next === name)?.[0] || name;
    preferences[name] = state.profile.classPreferences?.[original] || defaultClassPreference();
  });
  if (selectedCollection?.type === 'class' && renames.has(selectedCollection.name)) selectedCollection = { ...selectedCollection, name: renames.get(selectedCollection.name) };
  saveCalendarFeeds(calendarFeeds().map(feed => ({ ...feed, className: renames.get(feed.className) || feed.className })));
  state.classes = names;
  state.profile.classPreferences = preferences;
  const colors = state.profile.classColors || {};
  const renamedColors = {};
  names.forEach(name => {
    const original = [...renames.entries()].find(([, next]) => next === name)?.[0] || name;
    const originalKey = normalizeClassColorKey(original);
    const nextKey = normalizeClassColorKey(name);
    if (colors[originalKey] !== undefined) renamedColors[nextKey] = colors[originalKey];
    else if (colors[nextKey] !== undefined) renamedColors[nextKey] = colors[nextKey];
  });
  state.profile.classColors = assignUniqueClassHues(names, renamedColors);
  saveState();
  persistProfile();
  render();
  offerUndo('Class changes saved.', previousState);
}

function normalizeStudyUsage(value = {}) {
  return { basicGenerations: value.basicGenerations ?? value.basic_generations ?? 0, advancedGenerations: value.advancedGenerations ?? value.advanced_generations ?? 0, inputTokens: value.inputTokens ?? value.input_tokens ?? 0, reservedCostCents: value.reservedCostCents ?? value.reserved_cost_cents ?? 0, requestsToday: value.requestsToday ?? value.requests_today ?? 0 };
}
async function loadStudyWorkspace({ silent = false } = {}) {
  if (!repository || studyLoading) return;
  studyLoading = true;
  if (view === 'study') render();
  try {
    const [payload, billing] = await Promise.all([repository.loadStudy(), repository.loadBilling()]);
    studyMaterials = Array.isArray(payload?.materials) ? payload.materials : [];
    studyArtifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
    const selectedArtifactId = studyArtifact?.id;
    studyArtifact = studyArtifacts.find(artifact => artifact.id === selectedArtifactId) || studyArtifacts[0] || null;
    studyUsage = { enabled: payload?.enabled !== false, limits: payload?.limits || null, usage: normalizeStudyUsage(payload?.usage) };
    studyBilling = billing?.billing || null;
    studyError = '';
  } catch (error) {
    if (!silent) studyError = error.message || 'Could not load study usage.';
  } finally {
    studyLoading = false;
    if (view === 'study') render();
  }
}
function viewStudyArtifact(id) {
  const artifact = studyArtifacts.find(item => item.id === id);
  if (!artifact) { showToast('That saved study generation is no longer available.'); return; }
  studyArtifact = artifact;
  render();
  document.querySelector('.study-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function editStudyMaterial(id) {
  if (!repository || !id) return;
  studyLoading = true;
  studyError = '';
  let loaded = false;
  render();
  try {
    const payload = await repository.loadStudyMaterial(id);
    const material = payload?.materials?.[0];
    if (!material?.content) throw new Error('That saved study material could not be loaded.');
    const form = document.querySelector('#study-form');
    if (!form) throw new Error('Open the Study view before editing a saved material.');
    form.elements.title.value = material.title || '';
    form.elements.content.value = material.content;
    form.elements.content.dataset.sourceType = material.source_type || 'text';
    delete form.elements.content.dataset.sourcePages;
    form.elements.content.focus();
    loaded = true;
    showToast('Saved material loaded. Edit it or choose another study mode, then generate again.');
  } catch (error) {
    studyError = error.message || 'Could not load that saved study material.';
  } finally {
    studyLoading = false;
    if (!loaded) render();
    else document.querySelector('.study-output p.muted')?.parentElement?.remove();
  }
}
async function handleStudyGeneration(event) {
  if (studyBusy || !repository) return;
  const form = event.currentTarget;
  const title = form.elements.title?.value?.trim() || 'Untitled study material';
  const content = form.elements.content?.value?.trim() || '';
  if (!content) { showToast('Add some study material first.'); form.elements.content?.focus(); return; }
  studyBusy = true;
  studyError = '';
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.innerHTML = '<span class="capture-spinner"></span>Generating…'; }
  try {
    let sourcePages = null;
    try { sourcePages = JSON.parse(form.elements.content?.dataset.sourcePages || 'null'); } catch { sourcePages = null; }
    const payload = await repository.generateStudy({ title, content, source_type: form.elements.content?.dataset.sourceType || 'text', source_pages: sourcePages, format: form.elements.format?.value || 'flashcards', model: 'haiku', options: { difficulty: form.elements.difficulty?.value || 'medium', count: Number(form.elements.count?.value) || 20 } });
    studyArtifact = payload?.artifact || null;
    if (payload?.usage) studyUsage = { ...(studyUsage || {}), usage: normalizeStudyUsage(payload.usage) };
    await loadStudyWorkspace({ silent: true });
    showToast(payload?.cached ? 'Loaded your saved study set.' : 'Study set generated and saved.');
  } catch (error) {
    studyError = error.message || 'Could not generate the study set.';
  } finally {
    studyBusy = false;
    render();
  }
}
let pdfJsPromise = null;
let tesseractPromise = null;
const PDF_MAX_BYTES = 25 * 1024 * 1024;
const PDF_MAX_TEXT_CHARS = 250000;
const OCR_MIN_SELECTABLE_CHARS = 24;
const OCR_MIN_CONFIDENCE = 55;
const OCR_MAX_PIXELS = 12_000_000;

function cleanImportedText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/-\n(?=[\p{L}\p{N}])/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readableTextScore(value) {
  const text = cleanImportedText(value);
  if (!text) return 0;
  const characters = [...text];
  const readable = characters.filter(character => /[\p{L}\p{N}]/u.test(character)).length;
  const words = text.split(/\s+/).filter(Boolean);
  const replacementCount = characters.filter(character => character === '�' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(character)).length;
  const density = readable / Math.max(1, characters.length);
  const wordCoverage = Math.min(1, words.length / 24);
  return Math.max(0, Math.min(1, density * 0.7 + wordCoverage * 0.3 - replacementCount / Math.max(1, characters.length)));
}

function shouldOcrPage(pageText, items) {
  return !pageText || pageText.length < OCR_MIN_SELECTABLE_CHARS || !items.length || readableTextScore(pageText) < 0.62;
}

async function extractPdfText(file) {
  if (file.size > PDF_MAX_BYTES) throw new Error('That PDF is larger than 25 MB. Split it into smaller sections first.');
  if (!pdfJsPromise) pdfJsPromise = import(/* @vite-ignore */ 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
  const pdfjs = await pdfJsPromise;
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = new Array(pdf.numPages).fill('');
  const ocrPageNumbers = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = cleanImportedText(content.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join(' '));
    pages[pageNumber - 1] = pageText;
    if (shouldOcrPage(pageText, content.items)) ocrPageNumbers.push(pageNumber);
    page.cleanup();
  }
  if (ocrPageNumbers.length) {
    showToast(`Scanning ${ocrPageNumbers.length} PDF ${ocrPageNumbers.length === 1 ? 'page' : 'pages'} locally with OCR…`);
      const ocrPages = await ocrPdfPages(pdf, ocrPageNumbers);
    ocrPageNumbers.forEach((pageNumber, index) => {
      const ocrText = ocrPages[index];
      const existingText = pages[pageNumber - 1];
      if (ocrText?.text && (!existingText || readableTextScore(existingText) < 0.62 || (ocrText.confidence >= 70 && readableTextScore(ocrText.text) > readableTextScore(existingText) + 0.12))) pages[pageNumber - 1] = ocrText.text;
    });
  }
  const cleanedPages = pages.map((page, index) => ({ pageNumber: index + 1, text: cleanImportedText(page) })).filter(page => page.text);
  const text = cleanImportedText(cleanedPages.map(page => page.text).join('\n\n'));
  if (!text) throw new Error('That PDF did not contain readable text. Local OCR could not recognize it, so nothing was uploaded.');
  if (text.length > PDF_MAX_TEXT_CHARS) throw new Error('That PDF contains more than 250,000 characters. Import one chapter or section at a time.');
  let offset = 0;
  const pageRanges = cleanedPages.map(page => {
    const start = offset;
    offset += page.text.length + 2;
    return { page: page.pageNumber, start, end: start + page.text.length };
  });
  return { text, pages: { contentLength: text.length, pages: pageRanges } };
}
async function ocrPdfPages(pdf, pageNumbers) {
  if (!tesseractPromise) tesseractPromise = import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js');
  let tesseract;
  try {
    tesseract = await tesseractPromise;
  } catch {
    throw new Error('This PDF needs local OCR, but the OCR engine could not load. The PDF was not uploaded.');
  }
  const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
  if (typeof createWorker !== 'function') throw new Error('This PDF needs local OCR, but the OCR engine is unavailable. The PDF was not uploaded.');
  const worker = await createWorker('eng', 1, {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2',
    langPath: 'https://tessdata.projectnaptha.com/4.0.0'
  });
  const texts = [];
  try {
    if (typeof worker.setParameters === 'function') await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
    for (let index = 0; index < pageNumbers.length; index += 1) {
      const pageNumber = pageNumbers[index];
      showToast(`OCR scanning PDF page ${index + 1} of ${pageNumbers.length} locally…`);
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      // Small textbook fonts are materially easier for Tesseract at roughly
      // 250-300 DPI. Keep a pixel ceiling so a large page cannot exhaust the
      // browser tab while still rendering more detail than the old 2x cap.
      const scale = Math.min(3, Math.max(1.5, Math.sqrt(OCR_MAX_PIXELS / (baseViewport.width * baseViewport.height))));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('The browser could not prepare a local OCR canvas. The PDF was not uploaded.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const prepared = document.createElement('canvas');
      prepared.width = canvas.width;
      prepared.height = canvas.height;
      const preparedContext = prepared.getContext('2d', { alpha: false });
      if (!preparedContext) throw new Error('The browser could not prepare a local OCR image. The PDF was not uploaded.');
      preparedContext.filter = 'grayscale(1) contrast(1.35)';
      preparedContext.drawImage(canvas, 0, 0);
      const recognize = async () => {
        const result = await worker.recognize(prepared);
        const text = cleanImportedText(result?.data?.text || '');
        return { text, confidence: Number(result?.data?.confidence) || 0 };
      };
      let best = await recognize();
      // PSM 6 works well for textbook pages. If it produces sparse or low
      // confidence text, retry the same rendered page as scattered text;
      // this helps slides, callouts, and scanned diagrams without sending the
      // image to any server.
      if (best.confidence < OCR_MIN_CONFIDENCE || readableTextScore(best.text) < 0.52) {
        if (typeof worker.setParameters === 'function') await worker.setParameters({ tessedit_pageseg_mode: '11' });
        const alternate = await recognize();
        if (alternate.confidence > best.confidence || readableTextScore(alternate.text) > readableTextScore(best.text)) best = alternate;
        if (typeof worker.setParameters === 'function') await worker.setParameters({ tessedit_pageseg_mode: '6' });
      }
      texts.push(best);
      prepared.width = 0;
      prepared.height = 0;
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  return texts;
}
async function handleStudyFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  try {
    const imported = isPdf ? await extractPdfText(file) : { text: await file.text(), pages: null };
    const content = imported.text;
    const textArea = document.querySelector('#study-content');
    if (textArea) {
      textArea.value = content;
      textArea.dataset.sourceType = 'file';
      if (imported.pages) textArea.dataset.sourcePages = JSON.stringify(imported.pages);
      else delete textArea.dataset.sourcePages;
    }
    const title = document.querySelector('#study-form input[name="title"]');
    if (title && !title.value.trim()) title.value = file.name.replace(/\.(txt|md|markdown|pdf)$/i, '');
    showToast(isPdf ? 'PDF text imported.' : 'Text material imported.');
  } catch (error) {
    showToast(error.message || 'Could not read that study file.');
  } finally {
    event.target.value = '';
  }
}
async function startStudyCheckout(selection = 'student:monthly') {
  if (billingBusy || !repository) return;
  const [plan = 'student', interval = 'monthly'] = String(selection).split(':');
  billingBusy = true;
  render();
  try {
    const payload = await repository.createCheckout(interval, plan);
    if (!payload?.url) throw new Error('Stripe did not return a checkout URL.');
    window.location.assign(payload.url);
  } catch (error) {
    showToast(error.message || 'Could not start checkout.');
    billingBusy = false;
    render();
  }
}
async function openStudyBillingPortal() {
  if (billingBusy || !repository) return;
  billingBusy = true;
  render();
  try {
    const payload = await repository.openBillingPortal();
    if (!payload?.url) throw new Error('Stripe did not return a billing portal URL.');
    window.location.assign(payload.url);
  } catch (error) {
    showToast(error.message || 'Could not open billing management.');
    billingBusy = false;
    render();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-action="toggle-feedback-resolved"]').forEach(input => input.addEventListener('click', event => event.stopPropagation()));
  document.querySelectorAll('[data-action="toggle-feedback-resolved"]').forEach(input => input.addEventListener('change', event => { void updateFeedbackResolved(input.dataset.id, event.target.checked); }));
  if (view === 'feedback-admin' && repository && !feedbackAdminLoaded && !feedbackAdminBusy && !feedbackAdminError) void loadAdminFeedback();
  if (view === 'settings' && !document.querySelector('#ical-import')) document.querySelector('.settings-layout')?.insertAdjacentHTML('beforeend', calendarImportSection());
  if (view === 'settings' && !document.querySelector('#calendar-export-section')) document.querySelector('.settings-layout')?.insertAdjacentHTML('beforeend', calendarExportSection());
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => { view = el.dataset.view; location.hash = view; selectedTaskId = null; isSidebarOpen = false; render(); }));
  document.querySelectorAll('.class-pref-sessions').forEach(input => { input.max = '30'; input.step = '1'; input.inputMode = 'numeric'; input.addEventListener('input', () => updateClassAllocation(input)); });
  document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', event => { if (el.classList.contains('calendar-more')) return; if (el.dataset.action === 'sign-out') event.stopPropagation(); handleAction(el.dataset.action, el.dataset.id || el.dataset.feedId || el.dataset.class || el.dataset.project || el.dataset.date); }));
  document.querySelectorAll('.calendar-more').forEach(el => el.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); handleAction('open-calendar-day', el.dataset.date); }));
  bindDragAndDrop();
  document.querySelector('#profile-picture-input')?.addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; void updateProfilePicture(file); });
  document.querySelector('.profile-chip')?.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleAction('open-settings'); } });
  document.querySelector('#project-form')?.addEventListener('submit', event => { event.preventDefault(); addProject(); });
  document.querySelector('#brain-dump-form')?.addEventListener('submit', event => { event.preventDefault(); void createBrainDumpTask(event); });
  const form = document.querySelector('#capture-form');
  form?.addEventListener('submit', event => { event.preventDefault(); captureValue = document.querySelector('#capture-input').value; handleCapture(captureValue, { dueDate: form.querySelector('[data-capture-field="dueDate"]')?.value || '', priority: form.querySelector('[data-capture-field="priority"]')?.value || '', className: form.querySelector('[data-capture-field="className"]')?.value || '', project: form.querySelector('[data-capture-field="project"]')?.value || '', scopeType: form.dataset.scopeType, scopeName: form.dataset.scopeName }); });
  document.querySelector('#drawer-project')?.addEventListener('change', handleDrawerProjectChange);
  document.querySelector('#drawer-assignment-type')?.addEventListener('change', event => {
    const fields = document.querySelector('#drawer-event-reminder-fields');
    if (!fields) return;
    fields.classList.toggle('is-hidden', !['event', 'club_meeting', 'meeting'].includes(event.target.value));
  });
  document.querySelector('#capture-input')?.addEventListener('input', event => {
    captureValue = event.target.value;
    const detectedPriority = resolvePriority(captureValue);
    const detectedClass = form?.dataset.scopeType === 'class' ? null : matchExistingClass(parseCapture(captureValue), state.classes);
    const priorityField = form?.querySelector('[data-capture-field="priority"]');
    const classField = form?.querySelector('[data-capture-field="className"]');
    if (detectedPriority) {
      capturePriorityAutoDetected = true;
      captureDraft.priority = String(detectedPriority);
      if (priorityField) priorityField.value = String(detectedPriority);
    } else if (capturePriorityAutoDetected) {
      capturePriorityAutoDetected = false;
      captureDraft.priority = '';
      if (priorityField) priorityField.value = '';
    }
    if (detectedClass && (!captureDraft.className || captureClassAutoDetected)) {
      captureClassAutoDetected = true;
      captureDraft.className = detectedClass;
      if (classField) classField.value = detectedClass;
    } else if (!detectedClass && captureClassAutoDetected) {
      captureClassAutoDetected = false;
      captureDraft.className = '';
      if (classField) classField.value = '';
    }
  });
  document.querySelectorAll('.capture-field').forEach(field => field.addEventListener('change', event => { captureDraft[event.target.dataset.captureField] = event.target.value; if (event.target.dataset.captureField === 'priority') capturePriorityAutoDetected = false; if (event.target.dataset.captureField === 'className') captureClassAutoDetected = false; }));
  document.querySelector('#ical-import')?.addEventListener('change', handleCalendarImport);
  document.querySelectorAll('[data-calendar-feed-form]').forEach(form => form.addEventListener('submit', handleCalendarFeedSubmit));
  document.querySelector('#calendar-export-url')?.addEventListener('focus', event => event.target.select());
  document.querySelectorAll('[data-calendar-feed-class]').forEach(select => select.addEventListener('change', event => {
    const feeds = calendarFeeds().map(feed => feed.id === select.closest('[data-calendar-feed-form]')?.dataset.feedId ? { ...feed, className: event.target.value || '' } : feed);
    saveCalendarFeeds(feeds);
    saveState();
    persistProfile();
  }));
  document.querySelector('#inbox-window')?.addEventListener('change', event => { state.profile.inboxWindowDays = Number(event.target.value); saveState(); persistProfile(); render(); });
  document.querySelector('#team-create-form')?.addEventListener('submit', event => { event.preventDefault(); void createTeamProject(event.currentTarget.elements.name.value); });
  document.querySelector('#team-join-form')?.addEventListener('submit', event => { event.preventDefault(); void joinTeamProject(event.currentTarget.elements.join_code.value); });
  document.querySelector('#team-subproject-form')?.addEventListener('submit', event => { event.preventDefault(); void createTeamSubproject(event); });
  document.querySelector('#team-task-form')?.addEventListener('submit', event => { event.preventDefault(); void createTeamTask(event); });
  document.querySelectorAll('[data-team-task-edit]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); void updateTeamTask(event); }));
  document.querySelector('#team-availability-form')?.addEventListener('submit', event => { event.preventDefault(); void saveTeamAvailability(event); });
  document.querySelector('[data-action="choose-team-files"]')?.addEventListener('click', () => document.querySelector('#team-file-input')?.click());
  document.querySelector('#team-file-input')?.addEventListener('change', event => { void uploadTeamFiles(event); });
  document.querySelector('#study-form')?.addEventListener('submit', event => { event.preventDefault(); void handleStudyGeneration(event); });
  document.querySelector('#study-file')?.addEventListener('change', handleStudyFile);
  document.querySelector('#study-form')?.addEventListener('change', event => {
    if (event.target.name === 'format') studyDraft.format = event.target.value;
    if (event.target.name === 'difficulty') studyDraft.difficulty = event.target.value;
    if (event.target.name === 'count') studyDraft.count = Math.min(50, Math.max(5, Math.round(Number(event.target.value) || 20)));
    saveStudyDraft();
    syncStudyCountControl();
  });
  syncStudyCountControl();
  if (view === 'study' && repository && !studyUsage && !studyLoading) void loadStudyWorkspace();
  document.querySelector('#feedback-form')?.addEventListener('submit', event => { event.preventDefault(); void submitFeedback(event); });
  document.querySelector('#feedback-form')?.addEventListener('input', event => { if (event.target.name === 'message') feedbackDraft.message = event.target.value; });
  document.querySelector('#feedback-form')?.addEventListener('change', event => { if (event.target.name === 'category') feedbackDraft.category = event.target.value; });
  document.querySelector('#feedback-admin-access-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const key = event.currentTarget.elements.admin_key?.value?.trim() || '';
    if (!key) { showToast('Enter your admin key.'); return; }
    feedbackAdminKey = key;
    localStorage.setItem(`${STORAGE_KEY}.feedback-admin-key`, key);
    void loadAdminFeedback();
  });
}

function bindDragAndDrop() {
  if (!pointerDragFallbackBound) {
    pointerDragFallbackBound = true;
    document.addEventListener('pointermove', event => {
      if (!pointerDragState || event.pointerId !== pointerDragState.pointerId) return;
      const distance = Math.hypot(event.clientX - pointerDragState.x, event.clientY - pointerDragState.y);
      if (!pointerDragState.active && distance < 8) return;
      pointerDragState.active = true;
      pointerDragState.row.classList.add('dragging');
      event.preventDefault();
      if (!pointerDragState.ghost) {
        const rect = pointerDragState.row.getBoundingClientRect();
        const ghost = pointerDragState.row.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.removeAttribute('data-drag-task');
        ghost.style.width = `${rect.width}px`;
        ghost.style.left = `${rect.left}px`;
        ghost.style.top = `${rect.top}px`;
        document.body.appendChild(ghost);
        pointerDragState.ghost = ghost;
      }
      pointerDragState.ghost.style.transform = `translate3d(${event.clientX - pointerDragState.x}px, ${event.clientY - pointerDragState.y}px, 0) scale(1.02)`;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-drop-date]');
      if (pointerDragState.hoverTarget && pointerDragState.hoverTarget !== target) pointerDragState.hoverTarget.classList.remove('drop-target');
      pointerDragState.hoverTarget = target || null;
      target?.classList.add('drop-target');
    }, { passive: false });
    document.addEventListener('pointerup', event => {
      const drag = pointerDragState;
      if (!drag || event.pointerId !== drag.pointerId) return;
      pointerDragState = null;
      drag.row.classList.remove('dragging');
      drag.hoverTarget?.classList.remove('drop-target');
      drag.ghost?.remove();
      if (!drag.active) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-drop-date]');
      const targetDate = target?.dataset.dropDate || '';
      if (!targetDate || !drag.sourceId) return;
      if (drag.sourceDate === targetDate) {
        const targetId = target.classList.contains('task-row') || target.classList.contains('calendar-task') ? target.dataset.taskId : null;
        if (targetId && targetId !== drag.sourceId) reorderTaskWithinDay(drag.sourceId, targetId, targetDate);
        else reorderTaskToEndOfDay(drag.sourceId, targetDate);
      } else {
        moveTaskToDate(drag.sourceId, targetDate);
      }
    });
    document.addEventListener('pointercancel', event => {
      const drag = pointerDragState;
      if (!drag || event.pointerId !== drag.pointerId) return;
      pointerDragState = null;
      drag.row.classList.remove('dragging');
      drag.hoverTarget?.classList.remove('drop-target');
      drag.ghost?.remove();
      try { drag.row.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
    });
  }
  document.querySelectorAll('[data-drag-task="true"]').forEach(row => {
    row.addEventListener('pointerdown', event => {
      const interactive = event.target.closest('button, a, input, select, textarea');
      // The task title is the natural drag handle. Keep completion, overflow,
      // and form controls clickable without making the whole row impossible
      // to move with the pointer fallback.
      if (event.button !== 0 || interactive && !interactive.classList.contains('task-title') && !row.classList.contains('calendar-task')) return;
      pointerDragState = { sourceId: row.dataset.taskId || '', sourceDate: row.dataset.dropDate || '', row, x: event.clientX, y: event.clientY, pointerId: event.pointerId, active: false, hoverTarget: null, ghost: null };
      try { row.setPointerCapture(event.pointerId); } catch { /* pointer capture is unavailable in some browsers */ }
    });
  });
}

async function submitFeedback(event) {
  if (feedbackBusy) return;
  if (!repository) { showToast('Sign in to send feedback.'); return; }
  const form = event.currentTarget;
  const category = form.elements.category?.value || 'feedback';
  const message = form.elements.message?.value?.trim() || '';
  feedbackDraft = { category, message: form.elements.message?.value || '' };
  if (!message) { showToast('Add some details before sending feedback.'); form.elements.message?.focus(); return; }
  feedbackBusy = true;
  const button = form.querySelector('button[type="submit"]');
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }
  try {
    await repository.submitFeedback({ category, message, page: view });
    feedbackDraft = { category: 'feedback', message: '' };
    form.reset();
    showToast('Thanks — your feedback was sent.');
  } catch (error) {
    showToast(error.message || 'Could not send feedback.');
  } finally {
    feedbackBusy = false;
    if (button) { button.disabled = false; button.textContent = 'Send feedback'; }
  }
}

async function loadAdminFeedback() {
  if (feedbackAdminBusy || !repository) return;
  const suppliedKey = feedbackAdminKey;
  feedbackAdminBusy = true;
  feedbackAdminError = '';
  render();
  try {
    const payload = await repository.loadFeedback(feedbackAdminKey);
    feedbackItems = Array.isArray(payload?.feedback) ? payload.feedback : [];
    feedbackAdminLoaded = true;
  } catch (error) {
    if (error.status === 403) {
      if (suppliedKey) {
        feedbackAdminKey = '';
        localStorage.removeItem(`${STORAGE_KEY}.feedback-admin-key`);
        feedbackAdminError = 'That admin key was not accepted.';
      } else {
        feedbackAdminError = 'Enter your admin key once to unlock feedback on this account.';
      }
      feedbackItems = [];
      feedbackAdminLoaded = false;
    } else feedbackAdminError = error.message || 'Could not load feedback.';
  } finally {
    feedbackAdminBusy = false;
    render();
  }
}

async function updateFeedbackResolved(id, resolved) {
  const item = feedbackItems.find(entry => entry.id === id);
  if (!item || !repository || feedbackAdminBusy) return;
  const previous = Boolean(item.resolved);
  item.resolved = resolved;
  render();
  try {
    await repository.updateFeedbackStatus(feedbackAdminKey, id, resolved);
    showToast(resolved ? 'Bug marked resolved.' : 'Bug reopened.');
  } catch (error) {
    item.resolved = previous;
    showToast(error.message || 'Could not update bug status.');
    render();
  }
}

async function revokeFeedbackAdminAccess() {
  if (!repository || feedbackAdminBusy) return;
  feedbackAdminBusy = true;
  try {
    await repository.revokeFeedbackAdminAccess(feedbackAdminKey);
    showToast('Feedback access revoked for this account.');
  } catch (error) {
    showToast(error.message || 'Could not revoke feedback access.');
  } finally {
    feedbackAdminBusy = false;
    feedbackAdminKey = '';
    feedbackItems = [];
    feedbackAdminLoaded = false;
    feedbackAdminError = '';
    forgetFeedbackAdminKey();
  }
}

function forgetFeedbackAdminKey() {
  feedbackAdminKey = '';
  feedbackItems = [];
  feedbackAdminLoaded = false;
  feedbackAdminError = '';
  localStorage.removeItem(`${STORAGE_KEY}.feedback-admin-key`);
  render();
}

function reorderTaskWithinDay(sourceId, targetId, dateKey) {
  if (!sourceId || !targetId || sourceId === targetId || !dateKey) return;
  const tasks = tasksForDate(dateKey).filter(task => task.status !== 'completed');
  const orderedIds = tasks.map(task => task.id);
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex < 0 || orderedIds.indexOf(targetId) < 0) return;
  orderedIds.splice(sourceIndex, 1);
  orderedIds.splice(orderedIds.indexOf(targetId), 0, sourceId);
  applyManualDayOrder(dateKey, orderedIds, { movingTaskId: sourceId });
}

function reorderTaskToEndOfDay(sourceId, dateKey) {
  if (!sourceId || !dateKey) return;
  const orderedIds = tasksForDate(dateKey).filter(task => task.status !== 'completed').map(task => task.id);
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex < 0) return;
  orderedIds.splice(sourceIndex, 1);
  orderedIds.push(sourceId);
  applyManualDayOrder(dateKey, orderedIds, { movingTaskId: sourceId });
}

function isLegacyDragFixed(task) {
  const assignmentType = String(task.assignmentType || '').toLowerCase();
  const flexibleAssignment = ['study', 'homework', 'reminder', 'project', 'essay', 'other'].includes(assignmentType) || task.type === 'study_session';
  return flexibleAssignment
    && task.source !== 'calendar'
    && task.type !== 'fixed_event'
    && task.scheduleOrigin === SCHEDULE_ORIGINS.USER_SCHEDULED
    && task.userScheduled === true
    && task.flexibility === 'fixed'
    && task.userPinned !== true
    && task.explicitExecution !== true;
}

function markLocalScheduleMutation(tasks) {
  const version = ++localScheduleMutationVersion;
  const timestamp = Date.now();
  tasks.forEach(task => { if (task?.id) localScheduleMutations.set(task.id, { version, timestamp, pending: Boolean(repository) }); });
  return version;
}

function settleLocalScheduleMutation(taskId, version) {
  const mutation = localScheduleMutations.get(taskId);
  if (mutation?.version === version) mutation.pending = false;
}

// Completion is a task mutation just like a drag. Without the same local
// mutation barrier, the three-second remote refresh can merge its pre-click
// snapshot back over an imported task while PATCH is still in flight, making
// the user click the checkbox repeatedly. Keep the canonical local record
// authoritative until every related write has settled.
function persistTaskMutations(tasks = []) {
  const uniqueTasks = [...new Map(tasks.filter(task => task?.id).map(task => [task.id, task])).values()];
  const mutationVersion = markLocalScheduleMutation(uniqueTasks);
  if (!repository) return Promise.resolve([]);
  const updates = uniqueTasks.filter(task => isRemoteTaskId(task.id)).map(task => repository.update(task)
    .then(saved => {
      if (saved && saved.id === task.id) Object.assign(task, saved);
      delete task.syncRetryAfter;
      return task;
    })
    .catch(error => {
      markTaskSyncRetry(task);
      throw error;
    })
    .finally(() => settleLocalScheduleMutation(task.id, mutationVersion)));
  uniqueTasks.filter(task => !isRemoteTaskId(task.id)).forEach(task => settleLocalScheduleMutation(task.id, mutationVersion));
  return Promise.all(updates);
}

function applyManualDayOrder(dateKey, orderedIds, { movingTaskId = null } = {}) {
  const tasksById = new Map(state.tasks.map(task => [task.id, task]));
  const tasks = orderedIds.map(id => tasksById.get(id)).filter(Boolean);
  if (!tasks.length) return;
  state.profile.taskOrder[dateKey] = orderedIds;
  const breakMinutes = Math.max(0, Math.min(30, Number(state.profile.preferredBreakMinutes || state.profile.preferredBreakLength) || 10));
  // Keep real anchors exactly where they are. A task being dragged is the
  // one explicit exception: the gesture is a new user placement for that
  // task, while every other fixed date/time remains an immovable constraint.
  const fixedTasks = tasks.filter(task => task.id !== movingTaskId && isRigidExecution(task) && !isLegacyDragFixed(task));
  const fixedBlocks = fixedTasks.map(task => {
    const start = timeToMinutes(task.scheduledTime || task.dueTime);
    return { start, end: start + (Number(task.remainingDuration ?? task.duration) || 30) };
  }).filter(block => Number.isFinite(block.start));
  // Manual reordering should use the full post-school window. A later
  // preferred-study setting is a ranking preference for automatic planning,
  // not a reason to throw away usable time when the user explicitly drags.
  const preferredStart = timeToMinutes(state.profile.schoolEnd || state.profile.preferredStart || '16:00');
  // A drag is an order instruction, not permission to preserve a stale
  // allocation. Start at the configured cutoff every time, then flow around
  // fixed commitments so a clear day recovers its full study window.
  let cursor = Math.max(preferredStart, dateKey === today() ? new Date().getHours() * 60 + new Date().getMinutes() + 15 : 0);

  for (const task of tasks) {
    const duration = Math.max(15, Number(task.remainingDuration ?? task.duration) || 30);
    if (fixedTasks.includes(task)) {
      if (task.scheduledTime) cursor = Math.max(cursor, timeToMinutes(task.scheduledTime) + duration + breakMinutes);
      continue;
    }
    // A drag onto a day is a date decision even for an undated Moment. Give
    // it a real planning anchor so later planner passes can reflow it instead
    // of treating it as an unassigned record with a stale execution timestamp.
    if (!task.dueDate) task.dueDate = dateKey;
    task.datePinned = true;
    while (fixedBlocks.some(block => cursor < block.end && cursor + duration > block.start)) {
      const blocking = fixedBlocks.find(block => cursor < block.end && cursor + duration > block.start);
      cursor = blocking.end + breakMinutes;
    }
    const latest = timeToMinutes(state.profile.latestStudyTime || '21:00');
    if (cursor + duration > latest) {
      showToast(`${task.title} does not fit before your ${formatTime(state.profile.latestStudyTime || '21:00')} hard stop.`);
      continue;
    }
    setTaskExecution(task, dateKey, toClock(cursor));
    if (task.type === 'study_session') {
      task.dueDate = dateKey;
      task.dueTime = toClock(cursor);
      task.studyDateLocked = true;
    }
    // Drag order is intentional, but it is not an explicit clock-time edit.
    // Persist the resulting scheduler allocation as planned work so the
    // ordinary render/sync loop does not repack it again and push it later.
    // A subsequent drag is the explicit instruction that may recalculate the
    // whole flexible block; true user-fixed commitments remain untouched.
    if (task.id === movingTaskId) {
      task.autoScheduled = false;
      task.userScheduled = true;
      task.userPinned = true;
      task.scheduleOrigin = SCHEDULE_ORIGINS.USER_SCHEDULED;
      task.flexibility = 'fixed';
      task.explicitExecution = true;
      task.executionPinned = true;
    } else {
      task.autoScheduled = true;
      task.userScheduled = false;
      task.userPinned = false;
      task.scheduleOrigin = SCHEDULE_ORIGINS.SILICO_SCHEDULED;
      task.flexibility = 'planned';
      task.explicitExecution = false;
      task.executionPinned = false;
    }
    task.scheduleChangeReason = null;
    task.scheduleChangeMessage = null;
    task.updatedAt = new Date().toISOString();
    cursor += duration + breakMinutes;
  }
  const changed = tasks.filter(task => !fixedTasks.includes(task));
  const mutationVersion = markLocalScheduleMutation(changed);
  changed.forEach(task => {
    if (!repository) return;
    repository.update(task)
      .catch(() => { markTaskSyncRetry(task); })
      .finally(() => settleLocalScheduleMutation(task.id, mutationVersion));
  });
  saveState();
  persistProfile();
  render();
  showToast('Task times updated.');
}

function reflowDurationChain(dateKey, { anchorFromPreferredStart = false } = {}) {
  if (!dateKey) return [];
  const tasks = state.tasks
    .filter(task => task.status !== 'completed' && taskDisplayDate(task) === dateKey && (taskDisplayTime(task) || !isRigidExecution(task)))
    .sort((left, right) => {
      const leftStart = timeToMinutes(taskDisplayTime(left));
      const rightStart = timeToMinutes(taskDisplayTime(right));
      return (Number.isFinite(leftStart) ? leftStart : Number.MAX_SAFE_INTEGER) - (Number.isFinite(rightStart) ? rightStart : Number.MAX_SAFE_INTEGER) || taskSort(left, right);
    });
  if (!tasks.length) return [];
  const breakMinutes = Math.max(0, Math.min(30, Number(state.profile.preferredBreakMinutes || state.profile.preferredBreakLength) || 10));
  const fixedTasks = tasks.filter(task => isRigidExecution(task));
  const fixedBlocks = fixedTasks.map(task => {
    const start = timeToMinutes(task.scheduledTime || task.dueTime || taskDisplayTime(task));
    return { start, end: start + (Number(task.remainingDuration ?? task.duration) || 30) };
  }).filter(block => Number.isFinite(block.start));
  const preferredStart = timeToMinutes(state.profile.preferredStart || '16:00');
  const existingAfterCutoff = Math.min(...tasks
    .filter(task => !fixedTasks.includes(task))
    .map(task => timeToMinutes(taskDisplayTime(task)))
    .filter(time => Number.isFinite(time) && time >= preferredStart));
  let cursor = anchorFromPreferredStart ? preferredStart : Number.isFinite(existingAfterCutoff) ? existingAfterCutoff : preferredStart;
  cursor = Math.max(cursor, preferredStart, dateKey === today() ? new Date().getHours() * 60 + new Date().getMinutes() + 15 : 0);
  if (!Number.isFinite(cursor)) return [];
  const changed = [];
  for (const task of tasks) {
    const duration = Math.max(1, Number(task.remainingDuration ?? task.duration) || 30);
    if (fixedTasks.includes(task)) {
      const fixedStart = timeToMinutes(task.scheduledTime || task.dueTime || taskDisplayTime(task));
      // Morning rigid commitments must not move the after-school cursor to
      // noon. They only affect flexible work when their interval reaches the
      // preferred study boundary, or when the commitment itself is after it.
      if (Number.isFinite(fixedStart) && fixedStart + duration > preferredStart) cursor = Math.max(cursor, fixedStart + duration + breakMinutes);
      continue;
    }
    // A flexible task must fit completely, including its break, before a
    // later rigid commitment. If it would consume that gap, continue after
    // the commitment instead of leaving an overlap or a too-short break.
    const blockingFixed = fixedBlocks.find(block => block.start >= cursor && cursor + duration + breakMinutes > block.start);
    if (blockingFixed) cursor = Math.max(cursor, blockingFixed.end + breakMinutes);
    const nextTime = toClock(cursor);
    if (taskDisplayDate(task) !== dateKey || taskDisplayTime(task) !== nextTime) {
      setTaskExecution(task, dateKey, nextTime);
      if (task.type === 'study_session') {
        task.dueDate = dateKey;
        task.dueTime = nextTime;
      }
      task.updatedAt = new Date().toISOString();
      changed.push(task);
    }
    cursor += duration + breakMinutes;
  }
  return changed;
}

function timeToMinutes(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function moveTaskToDate(taskId, dueDate) {
  if (!taskId || !dueDate) return;
  if (isPastSchedule(dueDate, null, new Date())) {
    showToast('Tasks cannot be scheduled in the past. Choose today or a future date.');
    return;
  }
  const baseId = taskId.includes('::') ? taskId.split('::')[0] : taskId;
  const task = state.tasks.find(item => item.id === baseId);
  if (!task) return;
  if (task.recurrence) { showToast('Recurring tasks can be edited from Task details.'); return; }
  if (taskDisplayDate(task) === dueDate && task.scheduledTime) { showToast('That task is already on this date.'); return; }
  const previousState = stateSnapshot();
  const currentDate = today();
  const targetDistance = Math.max(0, Math.ceil((dateAt(dueDate, '23:59').getTime() - dateAt(currentDate, '00:00').getTime()) / 86_400_000));
  // Flexible work already occupying the destination is not a hard blocker:
  // it is exactly the work that should move around the dragged task. Keep
  // only real anchors in the candidate search so a crowded day can still be
  // reflowed instead of rejecting the move before the scheduler gets a say.
  const planningState = buildPlanningState({
    tasks: state.tasks.filter(item => item.id !== task.id && (taskDisplayDate(item) !== dueDate || isRigidExecution(item))),
    profile: { ...state.profile, now: new Date() },
    currentTime: new Date()
  });
  const candidate = generateCandidateWindows(planningState, { ...task, dueDate, dueTime: null, scheduledDate: null, scheduledTime: null, userScheduled: false, userPinned: false }, { horizonDays: targetDistance, allowFlexibleFallback: true, allowBeforePreferredStart: true }).find(window => window.dateKey === dueDate);
  if (!candidate) { showToast(`There is no open ${task.duration || 30}-minute slot on ${formatDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric' })}.`); return; }
  const preserveAnchor = isRigidExecution(task) || task.source === 'calendar' || task.type === 'fixed_event' || task.type === 'assessment';
  // A manual move is explicit user intent. Preserve the deadline separately,
  // but give the moved execution an actual time so chronological rendering and
  // future planner passes agree about where the task lives.
  if (!task.dueDate) task.dueDate = dueDate;
  setTaskExecution(task, dueDate, toClock(candidate.start));
  if (task.type === 'study_session') {
    task.dueDate = dueDate;
    task.dueTime = toClock(candidate.start);
    task.studyDateLocked = true;
    task.schedulingIdentity = `${task.relatedAssessmentId || 'study'}:${dueDate}:${task.dueTime}`;
  }
  task.datePinned = true;
  task.autoScheduled = !preserveAnchor;
  task.userScheduled = preserveAnchor;
  task.userPinned = preserveAnchor;
  task.scheduleOrigin = preserveAnchor ? SCHEDULE_ORIGINS.USER_SCHEDULED : SCHEDULE_ORIGINS.SILICO_SCHEDULED;
  task.flexibility = preserveAnchor ? 'fixed' : 'flexible';
  task.explicitExecution = preserveAnchor;
  task.executionPinned = preserveAnchor;
  task.scheduleChangeReason = null;
  task.scheduleChangeMessage = null;
  task.updatedAt = new Date().toISOString();
  // Repack the destination date around the moved task. This is the missing
  // link between a drag gesture and automatic scheduling: the dragged item
  // establishes the new date/order, while flexible neighbors remain movable.
  const destinationOrder = tasksForDate(dueDate).filter(item => item.status !== 'completed').map(item => item.id);
  applyManualDayOrder(dueDate, destinationOrder, { movingTaskId: baseId });
  if (preserveAnchor) repository?.update(task).catch(() => { markTaskSyncRetry(task); showToast('Could not sync the moved task. It is saved locally.'); });
  offerUndo(`Moved to ${formatDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric' })}.`, previousState);
}

function awardCompletion(task, completedAt = new Date()) {
  const previousLevel = gamificationLevel(state.profile.gamification?.xp);
  state.profile.gamification = recordCompletion(state.profile.gamification, task, completedAt);
  const nextLevel = gamificationLevel(state.profile.gamification?.xp);
  if (nextLevel > previousLevel) showLevelUp(nextLevel);
}

function handleAction(action, id) {
  if (action === 'focus-capture') { openTaskCreationOverlay(); return; }
  if (action === 'voice-capture') { startVoiceCapture(); return; }
  if (action === 'upgrade-study-billing') { void startStudyCheckout(id || 'student:monthly'); return; }
  if (action === 'manage-study-billing') { void openStudyBillingPortal(); return; }
  if (action === 'view-study-artifact') { viewStudyArtifact(id); return; }
  if (action === 'edit-study-material') { void editStudyMaterial(id); return; }
  if (action === 'start-recommendation') { selectedTaskId = id; render(); requestAnimationFrame(() => document.querySelector('#drawer-title')?.focus()); showToast('Task opened. Start when you’re ready.'); return; }
  if (action === 'schedule-recommendation') { scheduleRecommendation(id); return; }
  if (action === 'focus-class') { isSidebarOpen = false; if (!document.querySelector('#new-class-name')) { view = 'settings'; location.hash = view; render(); } document.querySelector('#new-class-name')?.focus(); return; }
  if (action === 'focus-project') { isSidebarOpen = false; if (!document.querySelector('#new-project-name')) { view = 'projects'; location.hash = view; render(); } document.querySelector('#new-project-name')?.focus(); return; }
  if (action === 'toggle-sidebar') { isSidebarOpen = !isSidebarOpen; render(); return; }
  if (action === 'close-sidebar') { isSidebarOpen = false; render(); return; }
  if (action === 'open-settings') { view = 'settings'; location.hash = view; selectedTaskId = null; isSidebarOpen = false; render(); return; }
  if (action === 'save-display-name') {
    const previousState = stateSnapshot();
    state.profile.displayName = String(document.querySelector('#display-name')?.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    saveState();
    persistProfile();
    render();
    offerUndo('Display name saved.', previousState);
    return;
  }
  if (action === 'notifications') { notificationsOpen = true; render(); return; }
  if (action === 'close-notifications') { notificationsOpen = false; render(); return; }
  if (action === 'mark-notifications-read') { state.profile.notifications ||= []; state.profile.notifications.forEach(item => { item.read = true; }); saveState(); persistProfile(); render(); return; }
  if (action === 'open-notification') {
    const item = (state.profile.notifications || []).find(notification => notification.id === id);
    if (item) item.read = true;
    notificationsOpen = false;
    saveState();
    if (item?.taskId && state.tasks.some(task => task.id === item.taskId)) { selectedTaskId = item.taskId; render(); }
    else render();
    return;
  }
  if (action === 'load-feedback-admin') { void loadAdminFeedback(); return; }
  if (action === 'forget-feedback-admin-key') { forgetFeedbackAdminKey(); return; }
  if (action === 'revoke-feedback-admin-access') { void revokeFeedbackAdminAccess(); return; }
  if (action === 'copy-calendar-feed') { copyCalendarExportUrl(); return; }
  if (action === 'generate-calendar-feed') { void generateCalendarExport(Boolean(calendarExportActive)); return; }
  if (action === 'revoke-calendar-feed') { void revokeCalendarExport(); return; }
  if (action === 'open-team') { void openTeamProject(id); return; }
  if (action === 'back-teams') { activeTeamProjectId = null; activeTeamSubprojectId = null; activeTeamDetail = null; activeTeamFiles = []; render(); return; }
  if (action === 'select-team-subproject') { activeTeamSubprojectId = id || null; render(); return; }
  if (action === 'rename-team-subproject') {
    const subproject = activeTeamDetail?.subprojects?.find(item => item.id === id);
    if (subproject) showTeamRenameDialog(subproject.name, name => { void renameTeamSubproject(id, name); }, { title: 'Rename subproject', label: 'Subproject', description: 'Choose a name everyone on the team will see.' });
    return;
  }
  if (action === 'delete-team-subproject') { showConfirm('Delete this subproject? Its tasks will remain in the team without a subproject.', () => { void deleteTeamSubproject(id); }); return; }
  if (action === 'copy-team-code') { void copyTeamInviteCode(); return; }
  if (action === 'regenerate-team-code') { void regenerateTeamCode(); return; }
  if (action === 'rename-team-project') { showTeamRenameDialog(activeTeamDetail?.project?.name || '', name => { void renameTeamProject(name); }); return; }
  if (action === 'edit-team-task') {
    const reference = teamTaskReference(id);
    if (!reference.teamProjectId || !reference.teamTaskId) return;
    editingTeamTaskId = reference.teamTaskId;
    if (activeTeamProjectId === reference.teamProjectId && activeTeamDetail) {
      view = 'teams';
      location.hash = view;
      render();
    } else {
      void openTeamProject(reference.teamProjectId);
    }
    return;
  }
  if (action === 'cancel-team-task-edit') { editingTeamTaskId = null; render(); return; }
  if (action === 'delete-team-tasks') {
    showConfirm('Delete every task in this team project? This cannot be undone for any teammate.', () => { void deleteAllTeamTasks(); });
    return;
  }
  if (action === 'delete-team-project') {
    showConfirm('Delete this team project and all of its shared tasks? Personal tasks will not be affected.', () => { void deleteTeamProject(); });
    return;
  }
  if (action === 'toggle-team-task') {
    const { teamProjectId, teamTaskId } = teamTaskReference(id);
    void toggleTeamTask(teamTaskId, teamProjectId);
    return;
  }
  if (action === 'calendar-prev') { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1); selectedCalendarDate = null; render(); return; }
  if (action === 'calendar-next') { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1); selectedCalendarDate = null; render(); return; }
  if (action === 'calendar-today') { calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); selectedCalendarDate = null; render(); return; }
  if (action === 'open-calendar-day') { selectedCalendarDate = id; render(); return; }
  if (action === 'close-calendar-day') { selectedCalendarDate = null; render(); return; }
  if (action === 'remove-calendar-feed') {
    const previousState = stateSnapshot();
    const feeds = calendarFeeds().map(feed => feed.id === id ? { ...feed, url: '', lastSyncedAt: null } : feed);
    saveCalendarFeeds(feeds);
    saveState();
    persistProfile();
    render();
    offerUndo(`${calendarFeed(id)?.label || 'Calendar'} feed removed.`, previousState);
    return;
  }
  if (action === 'open-class') { selectedCollection = { type: 'class', name: id }; selectedTaskId = null; render(); return; }
  if (action === 'open-project') { selectedCollection = { type: 'project', name: id }; selectedTaskId = null; render(); return; }
  if (action === 'close-collection') { selectedCollection = null; render(); return; }
  if (action === 'open-task') {
    selectedTaskId = id?.includes('::') ? id.split('::')[0] : id;
    render();
    requestAnimationFrame(() => {
      const row = selectedTaskId ? [...document.querySelectorAll('.task-row')].find(item => item.dataset.taskId === selectedTaskId) : null;
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.querySelector('#drawer-title')?.focus();
    });
    return;
  }
  if (action === 'close-drawer') { selectedTaskId = null; render(); return; }
  if (action === 'toggle-task') {
    const task = getTaskById(id);
    if (task?.occurrenceKey) {
      const previousState = stateSnapshot();
      state.occurrenceCompletions ||= {};
      const completed = task.status !== 'completed';
      if (completed) { state.occurrenceCompletions[task.occurrenceKey] = new Date().toISOString(); awardCompletion(task); }
      else delete state.occurrenceCompletions[task.occurrenceKey];
      saveState();
      persistProfile();
      repository?.setOccurrence(task.recurrenceSourceId, task.dueDate, completed).catch(() => showToast('Could not sync this occurrence. It is saved locally.'));
      render();
      offerUndo(completed ? 'Task completed.' : 'Task reopened.', previousState);
      return;
    }
    if (task) {
      const previousState = stateSnapshot();
      task.status = task.status === 'completed' ? 'open' : 'completed';
      task.completedAt = task.status === 'completed' ? new Date().toISOString() : null;
      task.remainingDuration = task.status === 'completed' ? 0 : Number(task.duration) || 30;
      task.updatedAt = new Date().toISOString();
      if (task.status === 'completed') awardCompletion(task, new Date(task.completedAt));
      const replanned = replanAssessmentWork({ persist: false });
      saveState();
      persistProfile();
      void persistTaskMutations([task, ...replanned]).catch(() => showToast('Could not sync this task. It is saved locally.'));
      render();
      offerUndo(task.status === 'completed' ? 'Task completed.' : 'Task reopened.', previousState);
    }
    return;
  }
  if (action === 'delete-task') {
    const baseId = id?.includes('::') ? id.split('::')[0] : id;
    const previousState = stateSnapshot();
    const deletedTask = state.tasks.find(task => task.id === baseId);
    const reminder = eventReminderForTask(deletedTask);
    markTaskDeleted(baseId, deletedTask);
    if (reminder) markTaskDeleted(reminder.id, reminder);
    state.tasks = state.tasks.filter(t => t.id !== baseId && t.id !== reminder?.id);
    selectedTaskId = null;
    saveState();
    repository?.remove(baseId).catch(() => showToast('Could not sync deletion. It is removed locally.'));
    if (reminder) repository?.remove(reminder.id).catch(() => {});
    render();
    offerUndo('Task deleted.', previousState);
    return;
  }
  if (action === 'copy-task') { void copyTask(id); return; }
  if (action === 'save-task') { saveDrawerTask(id); return; }
  if (action === 'onboarding-back') { onboardingStep = Math.max(0, onboardingStep - 1); renderOnboarding(); return; }
  if (action === 'onboarding-next') {
    if (onboardingStep === 1) {
      saveOnboardingPreferencesFromForm();
      saveState();
    }
    onboardingStep = Math.min(2, onboardingStep + 1);
    renderOnboarding();
    return;
  }
  if (action === 'add-onboarding-class') {
    collectOnboardingClassPreferences();
    const input = document.querySelector('#onboarding-class-name');
    const name = normalizeClassName(input?.value);
    if (!name) return;
    if (state.classes.some(item => String(item || '').toLowerCase() === name.toLowerCase())) { showToast('That class already exists.'); return; }
    const previousState = stateSnapshot();
    state.classes.push(name);
    state.profile.classPreferences ||= {};
    state.profile.classPreferences[name] ||= defaultClassPreference();
    ensureClassColors();
    renderOnboarding();
    offerUndo(`${name} added.`, previousState);
    return;
  }
  if (action === 'add-class') {
    const input = document.querySelector('#new-class-name');
    const name = normalizeClassName(input?.value);
    if (!name) return;
    if (state.classes.some(item => String(item || '').toLowerCase() === name.toLowerCase())) { showToast('That class already exists.'); return; }
    const previousState = stateSnapshot();
    state.classes.push(name);
    state.profile.classPreferences ||= {};
    state.profile.classPreferences[name] ||= defaultClassPreference();
    ensureClassColors();
    saveState();
    persistProfile();
    render();
    offerUndo(`${name} added.`, previousState);
    return;
  }
  if (action === 'delete-project') { deleteProject(id); return; }
  if (action === 'remove-class') {
    const name = elClassName(id);
    if (!name) return;
    showConfirm(`Remove ${name} from your classes? Tasks will lose this class label.`, () => {
      const previousState = stateSnapshot();
      if (selectedCollection?.type === 'class' && selectedCollection.name === name) selectedCollection = null;
      state.classes = state.classes.filter(item => item !== name);
      state.tasks.forEach(task => { if (task.className === name) task.className = null; });
      delete state.profile.classPreferences?.[name];
      delete state.profile.classColors?.[normalizeClassColorKey(name)];
      ensureClassColors();
      saveCalendarFeeds(calendarFeeds().map(feed => feed.className === name ? { ...feed, className: '' } : feed));
      saveState();
      persistProfile();
      render();
      offerUndo(`${name} removed from your classes.`, previousState);
    });
    return;
  }
  if (action === 'save-classes') { saveClassNames(); return; }
  if (action === 'save-settings') {
    const previousState = stateSnapshot();
    state.profile.sessionLength = Number(document.querySelector('#session-length')?.value || state.profile.sessionLength);
    const defaultSessions = Math.max(1, Math.min(14, Number(document.querySelector('#sessions-per-assessment')?.value || state.profile.sessionsPerWeek || state.profile.sessionsPerAssessment || 3)));
    state.profile.sessionsPerWeek = defaultSessions;
    state.profile.sessionsPerAssessment = defaultSessions;
    state.profile.preferredStart = document.querySelector('#preferred-start')?.value || state.profile.preferredStart;
    state.profile.latestStudyTime = document.querySelector('#latest-study')?.value || state.profile.latestStudyTime;
    state.profile.schoolStart = document.querySelector('#school-start')?.value || state.profile.schoolStart;
    state.profile.schoolEnd = document.querySelector('#school-end')?.value || state.profile.schoolEnd;
    const selectedDays = [...document.querySelectorAll('.school-day:checked')].map(input => Number(input.value));
    if (selectedDays.length) state.profile.schoolDays = selectedDays;
    state.profile.classPreferences ||= {};
    document.querySelectorAll('.class-pref-sessions').forEach(input => updateClassAllocation(input));
    document.querySelectorAll('.class-pref-length').forEach(input => { state.profile.classPreferences[input.dataset.class] ||= defaultClassPreference(); state.profile.classPreferences[input.dataset.class].sessionLength = Number(input.value); });
    saveState();
    persistProfile();
    render();
    offerUndo('Preferences saved.', previousState);
    return;
  }
  if (action === 'complete-onboarding') {
    const previousState = stateSnapshot();
    collectOnboardingClassPreferences();
    const weekly = Math.max(1, Math.min(14, Number(state.profile.sessionsPerWeek) || 2));
    state.profile = { ...state.profile, onboardingComplete: true, sessionsPerWeek: weekly, sessionsPerAssessment: weekly, methods: [...document.querySelectorAll('#onboarding-form input[type="checkbox"]:checked')].filter(input => !input.classList.contains('onboarding-school-day')).map(input => input.value) };
    onboardingStep = 0;
    saveState();
    persistProfile();
    render();
    offerUndo('Onboarding preferences saved.', previousState);
    return;
  }
  if (action === 'sign-out') { clerk?.signOut().then(() => { currentUser = null; authRenderMode = null; renderUnauthenticatedRoute(); }); return; }
  if (action === 'delete-all') {
    showConfirm('Delete every task in this workspace?', () => {
      const previousState = stateSnapshot();
      const requestedAt = new Date().toISOString();
      state.tasks.forEach(task => markTaskDeleted(task.id));
      state.tasks = [];
      state.occurrenceCompletions = {};
      state.profile.tasksClearedAt = requestedAt;
      state.profile.tasksClearPendingAt = requestedAt;
      saveState();
      repository?.removeAll(requestedAt).then(result => {
        state.profile.tasksClearedAt = result?.cleared_at || requestedAt;
        delete state.profile.tasksClearPendingAt;
        saveState();
      }).catch(() => showToast('Could not sync the delete-all operation. Local data was cleared and will stay hidden until the server is reachable.'));
      render();
      offerUndo('All tasks cleared.', previousState);
    });
    return;
  }
}

function addProject() {
  const input = document.querySelector('#new-project-name');
  const name = normalizeClassName(input?.value);
  if (!name) { showToast('Enter a project name.'); return; }
  if (state.projects.some(project => String(project || '').toLowerCase() === name.toLowerCase())) { showToast('That project already exists.'); return; }
  const previousState = stateSnapshot();
  state.projects.push(name);
  saveState();
  persistProfile();
  render();
  offerUndo(`${name} added.`, previousState);
}

async function loadTeamProjects({ silent = false } = {}) {
  if (!repository) { teamProjects = []; return; }
  try {
    const projects = await repository.loadTeamProjects();
    teamProjects = (Array.isArray(projects) ? projects : []).filter(project => project?.id && typeof project.name === 'string' && project.name.trim());
    if (activeTeamProjectId && !teamProjects.some(project => project.id === activeTeamProjectId)) {
      activeTeamProjectId = null;
      activeTeamDetail = null;
    }
  } catch (error) {
    if (!silent) showToast(error.message || 'Could not load team projects.');
  }
}

async function loadTeamTaskFeed({ silent = false } = {}) {
  if (!repository) { teamTaskFeed = []; return; }
  try {
    const payload = await repository.loadTeamTaskFeed(accountEmail());
    const tasks = Array.isArray(payload) ? payload : payload?.tasks;
    if (payload && !Array.isArray(payload) && payload.tasksClearedAt && typeof payload.tasksClearedAt === 'object') {
      teamTaskClearTimestamps = { ...teamTaskClearTimestamps, ...payload.tasksClearedAt };
      saveTeamTaskClearTimestamps();
    }
    teamTaskFeed = Array.isArray(tasks) ? tasks : [];
    if (activeTeamProjectId && activeTeamDetail?.tasks?.length && !teamTaskFeed.some(task => task.team_project_id === activeTeamProjectId)) {
      activeTeamDetail = { ...activeTeamDetail, tasks: [], completions: [] };
    }
  } catch (error) {
    if (!silent) showToast(error.message || 'Could not load team tasks.');
  }
}

async function refreshTeamData(projectId = activeTeamProjectId) {
  await Promise.all([
    loadTeamTaskFeed({ silent: true }),
    projectId ? repository.loadTeamProject(projectId, teamWeekStart(), accountEmail()).then(detail => { if (activeTeamProjectId === projectId) activeTeamDetail = detail; }) : Promise.resolve(),
    projectId ? repository.loadTeamFiles(projectId).then(files => { if (activeTeamProjectId === projectId) activeTeamFiles = Array.isArray(files) ? files : []; }).catch(() => {}) : Promise.resolve()
  ]);
}

async function openTeamProject(id) {
  if (!repository || !id || teamBusy) return;
  teamBusy = true;
  try {
    activeTeamProjectId = id;
    activeTeamSubprojectId = null;
    activeTeamDetail = await repository.loadTeamProject(id, teamWeekStart(), accountEmail());
    activeTeamFiles = await repository.loadTeamFiles(id).catch(() => []);
    view = 'teams';
    location.hash = view;
  } catch (error) {
    activeTeamProjectId = null;
    activeTeamDetail = null;
    showToast(error.message || 'Could not open that team project.');
  } finally {
    teamBusy = false;
    render();
  }
}

function encodeFileData(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function uploadTeamFiles(event) {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  teamBusy = true;
  try {
    for (const file of files) {
      if (file.size > 4 * 1024 * 1024) { showToast(`${file.name} is larger than 4 MB.`); continue; }
      const uploaded = await repository.uploadTeamFile(activeTeamProjectId, { name: file.name, mime: file.type, size: file.size, data: encodeFileData(await file.arrayBuffer()) });
      if (uploaded) activeTeamFiles = [uploaded, ...activeTeamFiles];
    }
    showToast('Shared files updated.');
  } catch (error) {
    showToast(error.message || 'Could not upload the file.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function deleteTeamFile(id) {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  teamBusy = true;
  try {
    await repository.deleteTeamFile(activeTeamProjectId, id);
    activeTeamFiles = activeTeamFiles.filter(file => file.id !== id);
    showToast('File deleted.');
  } catch (error) {
    showToast(error.message || 'Could not delete the file.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function createTeamProject(name) {
  if (!repository || teamBusy) return;
  teamBusy = true;
  render();
  try {
    const result = await repository.createTeamProject(name, accountEmail());
    teamInviteCodes[result.project.id] = result.joinCode;
    saveTeamInviteCodes();
    teamProjects = [...teamProjects, { ...result.project, membership: { role: 'owner' } }];
    activeTeamProjectId = result.project.id;
    await refreshTeamData(result.project.id);
    showToast(`Team created. Share join code ${result.joinCode}.`);
  } catch (error) {
    showToast(error.message || 'Could not create the team project.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function createTeamSubproject(event) {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  const name = event.currentTarget.elements.name?.value?.trim() || '';
  if (!name) { showToast('Enter a subproject name.'); return; }
  teamBusy = true;
  try {
    await repository.createTeamSubproject(activeTeamProjectId, name);
    activeTeamSubprojectId = null;
    await refreshTeamData(activeTeamProjectId);
    showToast('Subproject added.');
  } catch (error) {
    showToast(error.status === 409 ? 'That subproject already exists.' : (error.message || 'Could not add the subproject.'));
  } finally {
    teamBusy = false;
    render();
  }
}

async function renameTeamSubproject(id, name) {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  teamBusy = true;
  try {
    await repository.renameTeamSubproject(activeTeamProjectId, id, name);
    await refreshTeamData(activeTeamProjectId);
    showToast('Subproject renamed.');
  } catch (error) {
    showToast(error.status === 409 ? 'That subproject already exists.' : (error.message || 'Could not rename the subproject.'));
  } finally {
    teamBusy = false;
    render();
  }
}

async function deleteTeamSubproject(id) {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  const subproject = activeTeamDetail.subprojects?.find(item => item.id === id);
  if (!subproject) return;
  teamBusy = true;
  try {
    await repository.deleteTeamSubproject(activeTeamProjectId, id);
    if (activeTeamSubprojectId === id) activeTeamSubprojectId = null;
    await refreshTeamData(activeTeamProjectId);
    showToast(`Deleted ${subproject.name}. Its tasks remain in the team.`);
  } catch (error) {
    showToast(error.message || 'Could not delete the subproject.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function joinTeamProject(joinCode) {
  if (!repository || teamBusy) return;
  teamBusy = true;
  render();
  try {
    const result = await repository.joinTeamProject(joinCode, accountEmail());
    await loadTeamProjects({ silent: true });
    activeTeamProjectId = result.project.id;
    await refreshTeamData(result.project.id);
    showToast(`Joined ${result.project.name}.`);
  } catch (error) {
    showToast(error.message || 'Could not join that team project.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function createTeamTask(event) {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const task = { title: String(data.get('title') || '').trim(), description: String(data.get('description') || '').trim(), due_date: data.get('due_date') || null, due_time: data.get('due_time') || null, duration_minutes: data.get('duration_minutes') ? Number(data.get('duration_minutes')) : null, subproject_id: data.get('subproject_id') || null, assignee_id: data.get('assignee_id') || null, priority: 1 };
  if (!task.title) { showToast('Add a title before saving the team task.'); return; }
  const validationMessage = teamTaskValidationMessage(task);
  if (validationMessage) { showToast(validationMessage); return; }
  teamBusy = true;
  try {
    await repository.createTeamTask(activeTeamProjectId, task);
    await refreshTeamData(activeTeamProjectId);
    showToast('Team task added.');
  } catch (error) {
    showToast(error.message || 'Could not add the team task.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function updateTeamTask(event) {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const task = { title: String(data.get('title') || '').trim(), description: String(data.get('description') || '').trim(), due_date: data.get('due_date') || null, due_time: data.get('due_time') || null, duration_minutes: data.get('duration_minutes') ? Number(data.get('duration_minutes')) : null, subproject_id: data.get('subproject_id') || null, assignee_id: data.get('assignee_id') || null, priority: Number(data.get('priority')) || 1 };
  if (!task.title) { showToast('Add a title before saving the team task.'); return; }
  const validationMessage = teamTaskValidationMessage(task);
  if (validationMessage) { showToast(validationMessage); return; }
  teamBusy = true;
  try {
    await repository.updateTeamTask(activeTeamProjectId, form.dataset.id, task);
    editingTeamTaskId = null;
    await refreshTeamData(activeTeamProjectId);
    showToast('Team task updated.');
  } catch (error) {
    showToast(error.message || 'Could not update the team task.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function toggleTeamTask(id, projectId = activeTeamProjectId) {
  if (!repository || !projectId || teamBusy) return;
  const feedTask = teamTaskFeed.find(task => task.id === id);
  const completion = activeTeamDetail?.completions.find(item => item.team_task_id === id && item.user_id === currentUser?.id);
  const completed = feedTask ? Boolean(feedTask.completed_by_me) : Boolean(completion);
  teamBusy = true;
  try {
    await repository.toggleTeamTask(projectId, id, !completed);
    await refreshTeamData(projectId);
    showToast(completed ? 'Team task reopened.' : 'Team task completed.');
  } catch (error) {
    showToast(error.message || 'Could not update the team task.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function saveTeamAvailability(event) {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  const form = event.currentTarget;
  const slots = [...form.querySelectorAll('.team-availability-day:checked')].map(day => {
    const weekday = Number(day.dataset.weekday);
    return { weekday, start: form.querySelector(`.team-availability-start[data-weekday="${weekday}"]`)?.value, end: form.querySelector(`.team-availability-end[data-weekday="${weekday}"]`)?.value };
  });
  teamBusy = true;
  try {
    await repository.saveTeamAvailability(activeTeamProjectId, teamWeekStart(), slots);
    activeTeamDetail = await repository.loadTeamProject(activeTeamProjectId, teamWeekStart(), accountEmail());
    showToast('Availability saved.');
  } catch (error) {
    showToast(error.message || 'Could not save availability.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function regenerateTeamCode() {
  if (!repository || !activeTeamProjectId || teamBusy) return;
  teamBusy = true;
  try {
    const result = await repository.regenerateTeamCode(activeTeamProjectId);
    teamInviteCodes[activeTeamProjectId] = result.joinCode;
    saveTeamInviteCodes();
    showToast(`New join code: ${result.joinCode}.`);
  } catch (error) {
    showToast(error.message || 'Could not regenerate the join code.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function renameTeamProject(name) {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  teamBusy = true;
  render();
  try {
    const project = await repository.renameTeamProject(activeTeamProjectId, name);
    const nextName = project?.name || name;
    activeTeamDetail = { ...activeTeamDetail, project: { ...activeTeamDetail.project, name: nextName } };
    teamProjects = teamProjects.map(item => item.id === activeTeamProjectId ? { ...item, name: nextName } : item);
    showToast('Team name updated.');
  } catch (error) {
    showToast(error.status === 409 ? 'Another team already uses that name.' : (error.message || 'Could not rename the team.'));
  } finally {
    teamBusy = false;
    render();
  }
}

async function deleteAllTeamTasks() {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  const projectId = activeTeamProjectId;
  teamBusy = true;
  render();
  try {
    const result = await repository.deleteAllTeamTasks(projectId);
    const clearedAt = result?.cleared_at || new Date().toISOString();
    teamTaskClearTimestamps[projectId] = clearedAt;
    saveTeamTaskClearTimestamps();
    teamTaskFeed = teamTaskFeed.filter(task => task.team_project_id !== projectId);
    if (activeTeamProjectId === projectId && activeTeamDetail) {
      activeTeamDetail = { ...activeTeamDetail, tasks: [], completions: [], project: { ...activeTeamDetail.project, tasks_cleared_at: clearedAt } };
    }
    showToast('All team tasks were deleted across devices.');
  } catch (error) {
    showToast(error.message || 'Could not delete the team tasks.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function deleteTeamProject() {
  if (!repository || !activeTeamProjectId || activeTeamDetail?.member?.role !== 'owner' || teamBusy) return;
  const projectId = activeTeamProjectId;
  teamBusy = true;
  render();
  try {
    await repository.deleteTeamProject(projectId);
    delete teamTaskClearTimestamps[projectId];
    saveTeamTaskClearTimestamps();
    teamTaskFeed = teamTaskFeed.filter(task => task.team_project_id !== projectId);
    teamProjects = teamProjects.filter(project => project.id !== projectId);
    activeTeamProjectId = null;
    activeTeamDetail = null;
    activeTeamFiles = [];
    view = 'teams';
    location.hash = view;
    showToast('Team project deleted across devices.');
  } catch (error) {
    showToast(error.message || 'Could not delete the team project.');
  } finally {
    teamBusy = false;
    render();
  }
}

async function copyTeamInviteCode() {
  const code = teamInviteCodes[activeTeamProjectId];
  if (!code) { showToast('Only the owner can view the join code after creating or regenerating it.'); return; }
  try {
    await navigator.clipboard.writeText(code);
    showToast('Join code copied.');
  } catch {
    showToast(`Join code: ${code}`);
  }
}

function handleDrawerProjectChange(event) {
  if (event.target.value !== '__new_project__') return;
  const task = getTaskById(selectedTaskId);
  event.target.value = task?.project || '';
  showProjectCreator(name => {
    const existing = state.projects.find(project => String(project || '').toLowerCase() === name.toLowerCase());
    const project = existing || name;
    if (!existing) {
      state.projects.push(name);
      saveState();
      persistProfile();
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      event.target.insertBefore(option, event.target.lastElementChild);
    }
    event.target.value = project;
    showToast(existing ? `${existing} selected.` : `${name} created. Save the task to assign it.`);
  });
}

function deleteProject(name) {
  if (!name || !state.projects.includes(name)) return;
  showConfirm(`Delete ${name}? Its tasks will remain in your workspace without a project label.`, () => {
    const previousState = stateSnapshot();
    if (selectedCollection?.type === 'project' && selectedCollection.name === name) selectedCollection = null;
    state.projects = state.projects.filter(project => project !== name);
    const affectedTasks = state.tasks.filter(task => task.project === name);
    affectedTasks.forEach(task => { task.project = null; task.updatedAt = new Date().toISOString(); });
    saveState();
    persistProfile();
    Promise.all(affectedTasks.map(task => repository?.update(task))).catch(() => showToast('Project removed locally, but some task labels could not sync.'));
    render();
    offerUndo(`${name} deleted. Its tasks were kept.`, previousState);
  });
}

function saveDrawerTask(id) {
  const task = state.tasks.find(t => t.id === id) || state.tasks.find(item => item.id === id.split('::')[0]);
  if (!task) return;
  const previousState = stateSnapshot();
  const recurrenceText = document.querySelector('#drawer-recurrence').value.trim();
  const projectValue = document.querySelector('#drawer-project').value;
  const enteredDuration = Number(document.querySelector('#drawer-duration').value);
  const duration = Number.isFinite(enteredDuration) && enteredDuration > 0 ? Math.min(1440, enteredDuration) : 30;
  const previousDuration = Math.max(15, Number(task.duration) || 30);
  const previousRemaining = task.status === 'completed'
    ? 0
    : Math.max(0, Math.min(previousDuration, task.remainingDuration == null ? previousDuration : Number.isFinite(Number(task.remainingDuration)) ? Number(task.remainingDuration) : previousDuration));
  const completedMinutes = Math.max(0, previousDuration - previousRemaining);
  const nextRemainingDuration = task.status === 'completed' ? 0 : Math.max(0, duration - completedMinutes);
  const nextTitle = document.querySelector('#drawer-title').value.trim() || 'Untitled task';
  const reminderToggle = document.querySelector('#drawer-event-reminder');
  const reminderRecipient = document.querySelector('#drawer-event-recipient');
  const reminderSettings = { eventReminderEnabled: reminderToggle ? reminderToggle.checked : task.eventReminderEnabled === true, eventReminderRecipient: reminderRecipient ? reminderRecipient.value.trim().slice(0, 80) : task.eventReminderRecipient || '' };
  const nextDueDate = document.querySelector('#drawer-date').value || null;
  const nextDueTime = document.querySelector('#drawer-time').value || null;
  const nextRecurrence = recurrenceText ? recurrenceFromText(recurrenceText) : null;
  if (recurrenceText && !nextRecurrence) {
    showToast('I could not understand that recurrence. Try “every weekday”, “every day”, or “every Monday”.');
    return;
  }
  const nextClassName = document.querySelector('#drawer-class').value || null;
  const classChanged = task.className !== nextClassName;
  const captureIdentityChanged = task.source === 'capture'
    && String(task.idempotencyKey || '').startsWith('capture:')
    && (task.title !== nextTitle || task.dueDate !== nextDueDate || task.dueTime !== nextDueTime || task.className !== nextClassName || JSON.stringify(task.recurrence || null) !== JSON.stringify(nextRecurrence));
  const previousExecution = taskExecution(task);
  // The drawer exposes one date and one time: the date/time the work happens.
  // Deadline metadata remains internal and is not allowed to override this
  // value when a task has already been planned.
  const displayedDate = previousExecution.date || task.dueDate || null;
  const displayedTime = previousExecution.time || task.dueTime || null;
  // Native time inputs may return HH:MM while remote rows can contain
  // HH:MM:SS. Compare the canonical minute value so a duration-only edit
  // does not accidentally pin a flexible task and freeze the chain.
  const hasStoredExecution = Boolean(task.scheduledDate || task.scheduledTime || task.schedule?.execution?.date || task.schedule?.execution?.time);
  // A legacy/due-only task can show a time in this drawer without having an
  // execution timestamp of its own. Saving that visible time must promote it
  // to a real fixed execution; comparing only against the displayed fallback
  // would leave it flexible and let the next planning pass move it.
  const timingChanged = nextDueDate !== displayedDate
    || (nextDueTime || '').slice(0, 5) !== (displayedTime || '').slice(0, 5)
    || Boolean(nextDueTime) && !hasStoredExecution && task.autoScheduled !== true;
  const explicitExecutionTime = Boolean(nextDueTime);
  const nextExecutionDate = nextDueDate;
  const nextExecutionTime = nextDueTime;
  if (task.status !== 'completed' && timingChanged && isPastSchedule(nextExecutionDate, nextExecutionTime, new Date())) {
    showToast('Tasks cannot be scheduled in the past. Choose today or a future date and time.');
    return;
  }
  Object.assign(task, {
    title: nextTitle,
    // Keep due fields compatible with the API, but mirror the same user-facing
    // execution date/time instead of maintaining a second editable clock.
    dueDate: timingChanged ? nextDueDate : task.dueDate,
    dueTime: timingChanged ? nextDueTime : task.dueTime,
    userScheduled: timingChanged ? Boolean(nextDueDate || nextDueTime) : task.userScheduled,
    datePinned: timingChanged ? Boolean(nextDueDate) : task.datePinned,
    executionPinned: timingChanged ? explicitExecutionTime || task.type === 'fixed_event' || task.source === 'calendar' || task.type === 'assessment' : task.executionPinned,
    explicitExecution: timingChanged ? explicitExecutionTime : task.explicitExecution,
    autoScheduled: timingChanged ? false : task.autoScheduled,
    userPinned: timingChanged ? (explicitExecutionTime || task.type === 'fixed_event' || task.source === 'calendar' || task.type === 'assessment') : task.userPinned,
    studyDateLocked: timingChanged && task.type === 'study_session' ? true : task.studyDateLocked,
    flexibility: timingChanged ? (explicitExecutionTime ? 'fixed' : 'flexible') : task.flexibility,
    schedulingIdentity: timingChanged && task.type === 'study_session' ? `${task.relatedAssessmentId || 'study'}:${nextDueDate || ''}:${nextDueTime || ''}` : task.schedulingIdentity,
    duration,
    remainingDuration: nextRemainingDuration,
    priority: Number(document.querySelector('#drawer-priority').value),
    assignmentType: document.querySelector('#drawer-assignment-type').value,
    assignmentTypeExplicit: true,
    className: nextClassName,
    calendarClassManuallySet: task.source === 'calendar' && classChanged ? true : task.calendarClassManuallySet,
    project: projectValue === '__new_project__' ? task.project || null : projectValue || null,
    recurrence: nextRecurrence,
    idempotencyKey: captureIdentityChanged ? null : task.idempotencyKey,
    description: document.querySelector('#drawer-description').value,
    eventReminderEnabled: reminderToggle ? reminderToggle.checked : task.eventReminderEnabled === true,
    eventReminderRecipient: reminderRecipient ? reminderRecipient.value.trim().slice(0, 80) : task.eventReminderRecipient || '',
    updatedAt: new Date().toISOString()
  });
  // Keep one canonical execution timestamp in memory and mirror the legacy
  // scheduled_* fields through the setter. Deadline edits above stay
  // independent from execution edits.
  setTaskExecution(task, nextExecutionDate, nextExecutionTime);
  if (timingChanged) task.scheduleOrigin = SCHEDULE_ORIGINS.USER_SCHEDULED;
  else if (!task.scheduledDate && !task.scheduledTime && !task.dueTime) task.scheduleOrigin = SCHEDULE_ORIGINS.UNSCHEDULED;
  else task.scheduleOrigin = scheduleOriginOf(task);
  replanAssessmentWork({ persist: false });
  const durationChanged = duration !== previousDuration;
  // Reflow every affected day after every timing or duration edit. This is a
  // local deterministic chain: rigid anchors stay put, while flexible work
  // after 4:00 PM is recalculated from the current durations each time.
  const affectedDates = new Set([taskDisplayDate(task), previousExecution.date].filter(Boolean));
  // Saving a task is also a reconciliation point for legacy schedules. This
  // catches old adjacent allocations even when the current edit did not
  // change the visible duration/time fields.
  const preferredStart = timeToMinutes(state.profile.preferredStart || '16:00');
  const anchorFromPreferredStart = timingChanged && Number.isFinite(timeToMinutes(nextExecutionTime)) && timeToMinutes(nextExecutionTime) >= preferredStart;
  const durationReflowChanged = [...affectedDates].flatMap(dateKey => reflowDurationChain(dateKey, { anchorFromPreferredStart }));
  const collisionChanged = [];
  selectedTaskId = null;
  saveState();
  const tasksToPersist = [...new Map([task, ...durationReflowChanged, ...collisionChanged].map(item => [item.id, item])).values()];
  const persist = repository ? Promise.all(tasksToPersist.map(item => repository.update(item))).then(savedTasks => { const savedTask = savedTasks.find(item => item?.id === task.id); if (savedTask) Object.assign(task, savedTask); Object.assign(task, reminderSettings); tasksToPersist.forEach(item => { delete item.syncRetryAfter; }); saveState(); }) : Promise.resolve();
  persist.catch(() => { markTaskSyncRetry(task); showToast('Could not sync this edit yet. It is saved locally and will retry.'); }).then(() => syncEventReminder(task)).then(() => { if (!selectedTaskId) render(); }).catch(() => showToast('The event reminder could not be created yet.'));
  render();
  offerUndo('Task changes saved.', previousState);
}

async function copyTask(id) {
  const baseId = id?.includes('::') ? id.split('::')[0] : id;
  const source = state.tasks.find(task => task.id === baseId);
  if (!source) return;
  const previousState = stateSnapshot();
  const copy = {
    ...source,
    id: uid(),
    title: `Copy of ${source.title}`,
    status: 'open',
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: 'capture',
    idempotencyKey: null,
    schedulingIdentity: null,
    relatedAssessmentId: null,
    syncRetryAfter: undefined
  };
  delete copy.syncRetryAfter;
  state.tasks.push(copy);
  addAppNotification({ type: 'task-created', task: copy, title: 'Task copied', body: copy.title });
  selectedTaskId = copy.id;
  let synced = true;
  if (repository) {
    try {
      const saved = await persistCreatedTask(copy);
      if (saved) Object.assign(copy, saved);
    } catch {
      synced = false;
      markTaskSyncRetry(copy);
    }
  }
  saveState();
  render();
  offerUndo(synced ? 'Task copied.' : 'Task copied locally; it will sync when the connection is available.', previousState);
}

async function createBrainDumpTask(event) {
  const form = event.currentTarget;
  const title = form.elements.title?.value?.trim() || '';
  if (!title) { showToast('Add something to your Moment first.'); return; }
  const shouldPlan = form.elements.planning?.value === 'yes';
  const task = makeTask({ title, priority: Number(form.elements.priority?.value || 1) }, { source: 'capture' });
  task.description = form.elements.description?.value?.trim() || '';
  task.dueDate = null;
  task.dueTime = null;
  state.tasks.push(task);
  addAppNotification({ type: 'task-created', task, title: 'Moment captured', body: task.title });
  if (repository) {
    try {
      const savedTask = await persistCreatedTask(task);
      Object.assign(task, savedTask);
      delete task.syncRetryAfter;
    } catch {
      markTaskSyncRetry(task);
    }
  }
  const plannedTasks = shouldPlan ? applyWorkloadPlan([task.id], { includeUndated: true }) : [];
  if (shouldPlan) {
    // An explicit request to plan a Moment is user intent, so preserve it as
    // a user-owned placement instead of letting the next automatic pass move
    // it back into the unscheduled Moments bucket.
    plannedTasks.forEach(item => {
      item.autoScheduled = false;
      item.userScheduled = true;
      item.scheduleOrigin = SCHEDULE_ORIGINS.USER_SCHEDULED;
      item.flexibility = 'fixed';
    });
  }
  if (repository && plannedTasks.length) await Promise.all(plannedTasks.map(item => repository.update(item).catch(() => { markTaskSyncRetry(item); })));
  saveState();
  render();
  showToast(shouldPlan && task.scheduledDate ? 'Moment saved and scheduled.' : 'Moment saved. Schedule it whenever you’re ready.');
}

function studyAssessmentForCommand(command, resolvedClass) {
  const assessments = state.tasks.filter(task => {
    if (task.status === 'completed') return false;
    return task.type === 'assessment' || ['test', 'quiz'].includes(task.assignmentType) || /\b(test|exam|quiz|assessment)\b/i.test(task.title || '');
  });
  const matching = assessments.filter(task => {
    if (command.dueDate && task.dueDate !== command.dueDate) return false;
    if (!resolvedClass) return true;
    if (task.className === resolvedClass) return true;
    const titleClass = extractSubject(task.title || '');
    return titleClass === resolvedClass || matchExistingClass({ subject: resolvedClass, title: task.title, raw: task.title }, [task.className].filter(Boolean)) === task.className;
  }).sort(taskSort);
  return matching[0] || null;
}

function captureIdempotencyKey(command) {
  const recurrence = command.recurrence ? JSON.stringify(command.recurrence) : '';
  const parts = [command.intent, command.subject || '', command.title || '', command.dueDate || '', command.dueTime || '', recurrence]
    .map(value => String(value).trim().toLowerCase().replace(/\s+/g, ' '));
  return `capture:${parts.join('|')}`.slice(0, 255);
}

function captureDuplicateTitle(value) {
  return String(value || '').toLowerCase().replace(/\bws\b/g, 'worksheet').replace(/\b(?:ela|english)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function createStudyPlanFromCommand(command, metadata = {}) {
  const matchedClass = matchExistingClass(command, state.classes);
  const selectedClass = metadata.scopeType === 'class' ? metadata.scopeName : metadata.className;
  const scopedClass = selectedClass ? matchExistingClass({ subject: selectedClass, classHint: selectedClass, title: selectedClass, raw: selectedClass }, state.classes) || selectedClass : null;
  const resolvedClass = scopedClass || matchedClass || command.subject || null;
  const assessment = command.studyDates?.length ? null : studyAssessmentForCommand(command, resolvedClass);
  const dueDate = assessment?.dueDate || command.dueDate;
  if (!dueDate && !command.studyDates?.length) return { studyPlan: true, task: null, sessions: [], message: 'I couldn’t find an upcoming test to plan against. Add the test date or say which days to study.' };

  // A virtual target lets “study for … test” schedule preparation without
  // manufacturing a visible assessment from the request itself.
  const target = assessment || { id: 'study-plan:' + String(resolvedClass || 'general').toLowerCase() + ':' + (dueDate || 'requested'), className: resolvedClass, dueDate, priority: command.priority || 1 };
  const sessions = (command.studyDates?.length
    ? planStudySessionsOnDates(target, command.studyDates, state.tasks, { ...state.profile, now: new Date() })
    : planStudySessions(target, state.tasks, { ...state.profile, now: new Date() })).map(session => ({
    ...session,
    idempotencyKey: 'study-plan:' + target.id + ':' + session.schedulingIdentity
  }));
  state.tasks.push(...sessions);
  let persistenceWarning = false;
  if (repository) {
    await Promise.all(sessions.map(async session => {
      try { const saved = await persistCreatedTask(session); Object.assign(session, saved); } catch { persistenceWarning = true; markTaskSyncRetry(session); }
    }));
  }
  return { studyPlan: true, task: assessment || null, sessions, persistenceWarning, command };
}

async function createTaskFromCommand(command, metadata = {}) {
  if (command.intent === INTENTS.STUDY_PLANNING) return createStudyPlanFromCommand(command, metadata);
  const matchedClass = matchExistingClass(command, state.classes);
  const selectedClass = metadata.scopeType === 'class' ? metadata.scopeName : metadata.className;
  const scopedClass = selectedClass ? matchExistingClass({ subject: selectedClass, classHint: selectedClass, title: selectedClass, raw: selectedClass }, state.classes) || selectedClass : null;
  const scopedProject = metadata.scopeType === 'project' ? metadata.scopeName : metadata.project;
  const resolvedClass = scopedClass || matchedClass;
  const baseTitle = command.intent === INTENTS.CREATE_ASSESSMENT && resolvedClass ? assessmentTitle(command, resolvedClass) : command.title;
  // A grouped command has already resolved each occurrence to its own date.
  // The optional capture-form date applies to a single task, not to every
  // member of a Monday/Tuesday/Wednesday expansion.
  const resolvedDate = command.groupOccurrenceDate || (command.dueDates?.length ? command.dueDate : metadata.dueDate || command.dueDate);
  const resolvedCommand = { ...command, dueDate: resolvedDate, subject: resolvedClass || command.subject, title: resolvedClass && command.intent !== INTENTS.CREATE_ASSESSMENT ? removeClassFromTitle(baseTitle, resolvedClass) : baseTitle, priority: metadata.priority ? Number(metadata.priority) : command.priority };
  const requestedAssignmentType = metadata.assignmentType || resolvedCommand.assignmentType || command.assignmentType || null;
  const inferredAssignmentType = inferAssignmentType(resolvedCommand.title, 'task', 'capture');
  const isAssessment = resolvedCommand.intent === INTENTS.CREATE_ASSESSMENT
    || ['test', 'quiz'].includes(String(requestedAssignmentType || inferredAssignmentType).toLowerCase());
  const idempotencyKey = captureIdempotencyKey(resolvedCommand);
  const sameIdentityTasks = idempotencyKey ? state.tasks.filter(item => item.idempotencyKey === idempotencyKey && item.status !== 'completed' && !item.deletedAt).sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''))) : [];
  const existingDuplicate = sameIdentityTasks[0]
    || state.tasks.find(item => item.status !== 'completed' && !item.deletedAt && captureDuplicateTitle(item.title) === captureDuplicateTitle(resolvedCommand.title) && taskDisplayDate(item) === resolvedCommand.dueDate && (!resolvedCommand.dueTime || taskDisplayTime(item) === resolvedCommand.dueTime));
  if (sameIdentityTasks.length > 1) {
    const redundant = sameIdentityTasks.slice(1);
    redundant.forEach(item => markTaskDeleted(item.id));
    state.tasks = state.tasks.filter(item => !redundant.includes(item));
    saveState();
    await Promise.all(redundant.filter(item => isRemoteTaskId(item.id)).map(item => repository?.remove(item.id).catch(() => { markTaskSyncRetry(item); })));
  }
  if (existingDuplicate && captureDuplicateTitle(existingDuplicate.title) === captureDuplicateTitle(resolvedCommand.title) && existingDuplicate.title !== resolvedCommand.title) {
    existingDuplicate.title = resolvedClass ? removeClassFromTitle(cleanTaskTitle(existingDuplicate.title), resolvedClass) : cleanTaskTitle(existingDuplicate.title);
    existingDuplicate.updatedAt = new Date().toISOString();
    saveState();
    repository?.update(existingDuplicate).catch(() => { markTaskSyncRetry(existingDuplicate); });
  }
  if (existingDuplicate) return { duplicate: true, command, existing: existingDuplicate };
  // A date chosen in the capture form is just as intentional as “tomorrow” in
  // the text.  Mark it as a user placement immediately so the workload pass
  // cannot pull it into today before the user has a chance to move it.
  const userSelectedDate = resolvedCommand.dueDateExplicit === true || Boolean(metadata.dueDate);
  const userSelectedTime = Boolean(resolvedCommand.dueTime);
  const userSelectedSchedule = userSelectedDate || userSelectedTime;
  if (userSelectedSchedule && isPastSchedule(resolvedCommand.dueDate, resolvedCommand.dueTime, new Date())) {
    return { blocked: true, message: 'That schedule is in the past. Choose a current or future date and time.' };
  }
  // An explicit clock time is execution intent even when the date came from
  // the default today. Do not let the planner reinterpret that timestamp as
  // a deadline and move the task to an earlier opening.
  const task = makeTask(resolvedCommand, { source: 'capture', idempotencyKey, project: scopedProject || null, userScheduled: userSelectedSchedule, datePinned: userSelectedDate, executionPinned: userSelectedTime, explicitExecution: userSelectedTime });
  task.description = String(metadata.description || '').trim();
  if (metadata.duration) {
    task.duration = Math.max(1, Math.min(1440, Number(metadata.duration) || task.duration || 30));
    task.remainingDuration = task.duration;
  }
  if (isAssessment) task.type = 'assessment';
  if (/\b(?:meet|meeting|appointment|event|practice|vex)\b/i.test(command.raw || command.title || '')) task.type = 'fixed_event';
  task.assignmentType = ASSIGNMENT_TYPES.some(option => option.value === requestedAssignmentType)
    ? requestedAssignmentType
    : inferAssignmentType(task.title, task.type, task.source);
  task.assignmentTypeExplicit = Boolean(ASSIGNMENT_TYPES.some(option => option.value === requestedAssignmentType));
  state.tasks.push(task);
  addAppNotification({ type: 'task-created', task, title: 'Task created', body: `${task.title}${taskDisplayDate(task) ? ` · ${formatDate(taskDisplayDate(task))}` : ''}` });
  let persistenceWarning = false;
  let persistenceMessage = '';
  if (repository) {
    const createdTask = await persistCreatedTask(task).catch(error => { persistenceWarning = true; persistenceMessage = error.message; markTaskSyncRetry(task); return task; });
    Object.assign(task, createdTask);
    if (!persistenceWarning) delete task.syncRetryAfter;
  }
  // An assessment is the anchor for its class study plan. Generate the
  // configured number of preparation sessions immediately so creating a
  // test/exam never leaves the student with an assessment and no study time.
  // Explicit “study for …” requests still use the separate path above for
  // custom dates or a virtual assessment.
  let sessions = task.type === 'assessment'
    ? planStudySessions(task, state.tasks, { ...state.profile, now: new Date() })
    : [];
  state.tasks.push(...sessions);
  // A crowded day can make the first pass skip a date. Run the explicit
  // assessment reconciler once with creation enabled so a test/quiz never
  // silently loses part of its configured preparation plan.
  if (task.type === 'assessment') {
    const recovery = replanAssessmentSessions(task, state.tasks, { ...state.profile, now: new Date() }, { createMissing: true });
    if (recovery.created.length) {
      state.tasks.push(...recovery.created);
      sessions = [...sessions, ...recovery.created];
    }
  }
  const createdSessions = await Promise.all(sessions.map(item => repository ? persistCreatedTask(item).catch(error => { persistenceWarning = true; persistenceMessage ||= error.message; markTaskSyncRetry(item); return item; }) : item));
  sessions.forEach((item, index) => Object.assign(item, createdSessions[index]));
  if (task.type === 'fixed_event' || task.dueTime) {
    const moved = rebalanceStudySessions();
    if (moved.length && repository) await Promise.all(moved.map(item => repository.update(item).catch(() => { markTaskSyncRetry(item); persistenceWarning = true; })));
  }
  return { task, sessions, persistenceWarning, persistenceMessage, command };
}

function rebalanceStudySessions() {
  const moved = [];
  const sessions = state.tasks.filter(task => task.status !== 'completed' && task.type === 'study_session' && task.dueDate && task.dueTime);
  for (const session of sessions) {
    const assessment = state.tasks.find(task => task.id === session.relatedAssessmentId && task.type === 'assessment');
    const planningState = buildPlanningState({ tasks: state.tasks.filter(task => task.id !== session.id), profile: { ...state.profile, now: new Date() }, currentTime: new Date() });
    const windows = generateCandidateWindows(planningState, { ...session, dueDate: assessment?.dueDate || session.dueDate }, { horizonDays: 14 });
    const start = Number(session.dueTime.slice(0, 2)) * 60 + Number(session.dueTime.slice(3, 5));
    const stillFits = windows.some(window => window.dateKey === session.dueDate && start >= window.start && start + (session.duration || 30) <= window.end);
    if (stillFits || !windows.length) continue;
    // A study session may move within its assigned date to resolve a time
    // collision, but its date is part of the study plan and must not drift.
    const replacement = windows.find(window => window.dateKey === session.dueDate);
    if (!replacement) continue;
    session.dueTime = toClock(replacement.start);
    session.schedulingIdentity = `${session.relatedAssessmentId || 'study'}:${session.dueDate}:${session.dueTime}`;
    session.schedulingReason = session.schedulingReason || 'Moved to resolve a calendar conflict';
    session.updatedAt = new Date().toISOString();
    moved.push(session);
  }
  return moved;
}

function applyWorkloadPlan(taskIds = null, options = {}) {
  const plan = planWorkload(currentPlanningState(), { horizonDays: 14, ...options, ...(Array.isArray(taskIds) ? { taskIds } : {}) });
  const changed = [];
  for (const action of plan.scheduled) {
    // Planner actions may carry a copied item (collision repair and duration
    // reordering intentionally return immutable snapshots). Always apply the
    // result to the canonical task in local state before persisting it, or the
    // next render will immediately resurrect the old time.
    const task = state.tasks.find(item => item.id === action.item?.id) || action.item;
    const automaticReschedule = [SCHEDULE_CHANGE_REASONS.OVERDUE_RECOVERY, SCHEDULE_CHANGE_REASONS.HARD_STOP_CONFLICT, SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT, SCHEDULE_CHANGE_REASONS.TIME_CONFLICT].includes(action.reason);
    const hardCommitmentReschedule = action.reason === SCHEDULE_CHANGE_REASONS.HARD_COMMITMENT_CONFLICT;
    // An explicit time is already a user decision/deadline. Preserve it and
    // only add a plan to genuinely unscheduled work. The two objective
    // recovery cases are the narrow exception and carry their reason through
    // to persistence/UI.
    // User/imported commitments are anchors. A planner repair may move the
    // flexible task around them, never move the anchor itself. In particular,
    // saving a planned task must not rewrite a fixed calendar event or a
    // manually timed assignment as a side effect of a global collision pass.
    if (!task || isRigidExecution(task) || (task.type && task.type !== 'task' && action.reason !== SCHEDULE_CHANGE_REASONS.TIME_CONFLICT && !hardCommitmentReschedule) || !task.autoScheduled && !automaticReschedule && task.executionPinned) continue;
    if (task.scheduledDate === action.dateKey && task.scheduledTime === action.time) continue;
    setTaskExecution(task, action.dateKey, action.time);
    if (!automaticReschedule) {
      task.autoScheduled = true;
      task.userScheduled = false;
      task.scheduleOrigin = SCHEDULE_ORIGINS.SILICO_SCHEDULED;
      task.flexibility = 'planned';
      if (action.rescheduled && action.reason) {
        task.scheduleChangeReason = action.reason;
        task.scheduleChangeMessage = action.message;
        task.schedulingReason = action.message;
      } else {
        task.schedulingReason = action.relaxed ? 'Placed in the next available opening outside your preferred window' : action.risk === 'HIGH' || action.risk === 'CRITICAL' ? 'Scheduled early to protect the deadline' : 'Placed around your availability';
      }
    } else {
      task.scheduleChangeReason = action.reason;
      task.scheduleChangeMessage = action.message;
      task.schedulingReason = action.message;
      if (task.scheduleOrigin === SCHEDULE_ORIGINS.UNSCHEDULED && !task.userScheduled && !task.userPinned) {
        task.autoScheduled = true;
        task.scheduleOrigin = SCHEDULE_ORIGINS.SILICO_SCHEDULED;
        task.flexibility = 'planned';
      }
    }
    task.updatedAt = new Date().toISOString();
    changed.push(task);
  }
  return changed;
}

function planFlexibleWork({ persist = false, allowRebalance = false } = {}) {
  const releasedMoments = state.tasks.filter(task => task.type === 'task' && task.status !== 'completed' && task.autoScheduled === true && !task.dueDate && !task.userScheduled && !task.userPinned && (task.scheduledDate || task.scheduledTime));
  releasedMoments.forEach(task => {
    clearTaskExecution(task);
    task.autoScheduled = false;
    task.flexibility = 'flexible';
    task.updatedAt = new Date().toISOString();
  });
  const changed = [...releasedMoments, ...applyWorkloadPlan(null, { allowRebalance })];
  if (!changed.length) return changed;
  saveState();
  const explainedTask = changed.find(task => task.scheduleChangeMessage);
  const explanation = explainedTask?.scheduleChangeMessage;
  const explanationKey = explainedTask && explanation
    ? `${explainedTask.id}|${explainedTask.scheduledDate || ''}|${explainedTask.scheduledTime || ''}|${explainedTask.scheduleChangeReason || ''}|${explanation}`
    : '';
  if (explanation && explanationKey !== lastPlannerToastKey && typeof document !== 'undefined' && document.body) {
    lastPlannerToastKey = explanationKey;
    showToast(explanation);
  }
  if (persist && repository) {
    const uniqueChanged = [...new Map(changed.map(task => [task.id, task])).values()];
    Promise.all(uniqueChanged.filter(task => isRemoteTaskId(task.id)).map(task => repository.update(task).catch(() => { markTaskSyncRetry(task); }))).catch(() => {});
  }
  return changed;
}

function answerPlanningQuery(command) {
  // Refresh stale/missed assessment sessions before answering a question so
  // “what should I do?” reflects recovery work without requiring a manual
  // sync or a second user action.
  replanAssessmentWork({ persist: true });
  const stateForPlanning = currentPlanningState();
  const queryTaskIds = command.subject ? stateForPlanning.tasks.filter(task => queryTaskMatches(task, command.subject)).map(task => task.id) : null;
  const queryOptions = queryTaskIds ? { taskIds: queryTaskIds } : {};
  if (command.intent === INTENTS.QUERY_CAPACITY) {
    const horizonDays = command.dueDate ? Math.max(1, Math.ceil((dateAt(command.dueDate, '23:59').getTime() - Date.now()) / 86_400_000)) : 7;
    return { type: 'capacity', summary: planningSummary(stateForPlanning, { horizonDays, ...queryOptions }) };
  }
  if (command.intent === INTENTS.QUERY_DAY_SUMMARY) return { type: 'day', tasks: tasksForDate(today()).filter(task => task.status !== 'completed') };
  const availableMinutes = command.duration || Infinity;
  const asksToGetAhead = /get ahead|move .+ earlier|reorganize|reorganise|optimi[sz]e|replan/i.test(command.raw || '');
  const result = recommendNextAction(stateForPlanning, { availableMinutes, now: new Date(), ...(command.dueDate ? { dateKey: command.dueDate } : {}), preferImmediate: !asksToGetAhead && [INTENTS.QUERY_RECOMMENDATION, INTENTS.QUERY_FREE_TIME].includes(command.intent), ...queryOptions });
  return { type: 'recommendation', result };
}

function scheduleRecommendation(id) {
  const task = state.tasks.find(item => item.id === id);
  const result = assistantResult?.result;
  if (!task || !result?.window) { showToast('There is no feasible window for that task yet.'); return; }
  const recommendationTime = toClock(result.window.start);
  if (isPastSchedule(result.window.dateKey, recommendationTime, new Date())) {
    showToast('That recommendation is already in the past. Choose a current or future window.');
    return;
  }
  const previousState = stateSnapshot();
  setTaskExecution(task, result.window.dateKey, recommendationTime);
  task.userScheduled = true;
  task.autoScheduled = false;
  task.scheduleOrigin = SCHEDULE_ORIGINS.USER_SCHEDULED;
  task.flexibility = 'fixed';
  task.updatedAt = new Date().toISOString();
  saveState();
  repository?.update(task).catch(() => { markTaskSyncRetry(task); showToast('The task is scheduled locally and will sync when the connection is available.'); });
  render();
  offerUndo(`Scheduled for ${formatDate(task.scheduledDate, { weekday: 'short', month: 'short', day: 'numeric' })} at ${formatTime(task.scheduledTime)}.`, previousState);
}

function clearPlannedSchedule() {
  const previousState = stateSnapshot();
  const planned = state.tasks.filter(task => task.status !== 'completed' && task.type === 'task' && taskExecution(task).date === today());
  if (!planned.length) { showToast('There is no planned work to clear tonight.'); return; }
  planned.forEach(task => { clearTaskExecution(task); task.schedulingReason = null; task.updatedAt = new Date().toISOString(); });
  saveState();
  if (repository) Promise.all(planned.map(task => repository.update(task).catch(() => markTaskSyncRetry(task))));
  render();
  offerUndo('Tonight’s planned work was cleared.', previousState);
}

async function handleCapture(input, metadata = {}) {
  if (!input.trim() || isProcessingCapture) return;
  isProcessingCapture = true;
  render();
  try {
    const parsedCommands = await parseCaptureCommands(input);
    const commands = parsedCommands.map(command => {
      const localCommand = parseCapture(command.raw || input);
    const localCreate = [INTENTS.CREATE_TASK, INTENTS.CREATE_ASSESSMENT, INTENTS.CREATE_RECURRING_TASK, INTENTS.STUDY_PLANNING].includes(localCommand.intent);
      const taskMutation = [INTENTS.EDIT_TASK, INTENTS.DELETE_TASK, INTENTS.COMPLETE_TASK, INTENTS.RESCHEDULE_TASK].includes(command.intent);
      // A plain task entry must never become a task lookup because an AI
      // response guessed the wrong intent. Mutation commands require an
      // explicit local command prefix (edit, delete, complete, or reschedule).
      return localCreate && taskMutation ? { ...localCommand, warning: command.warning } : command;
    });
    if (commands.length === 1 && commands[0].intent === INTENTS.CLEAR_SCHEDULE) {
      showConfirm('Clear planned work for tonight? Deadlines and fixed calendar events will stay unchanged.', () => clearPlannedSchedule());
      return;
    }
    if (commands.length === 1 && [INTENTS.QUERY_FREE_TIME, INTENTS.QUERY_RECOMMENDATION, INTENTS.QUERY_CAPACITY, INTENTS.QUERY_DAY_SUMMARY, INTENTS.QUERY_WHEN_TO_DO, INTENTS.QUERY_TODAY, INTENTS.QUERY_UPCOMING].includes(commands[0].intent)) {
      const command = commands[0];
      captureValue = '';
      if ([INTENTS.QUERY_TODAY, INTENTS.QUERY_UPCOMING].includes(command.intent)) {
        assistantResult = null;
        view = command.intent === INTENTS.QUERY_UPCOMING ? 'upcoming' : 'today';
        location.hash = view;
        render();
        showToast(command.warning || 'Here’s what is on your schedule.');
      } else {
        assistantResult = answerPlanningQuery(command);
        view = 'today';
        location.hash = view;
        render();
        showToast(command.warning || (assistantResult.type === 'recommendation' ? assistantResult.result.task ? `Best next step: ${assistantResult.result.task.title}.` : assistantResult.result.reason : assistantResult.summary.summary));
      }
      return;
    }
    if (commands.length === 1 && [INTENTS.EDIT_TASK, INTENTS.DELETE_TASK, INTENTS.COMPLETE_TASK, INTENTS.RESCHEDULE_TASK].includes(commands[0].intent)) { handleTaskCommand(commands[0]); return; }
    const createIntents = [INTENTS.CREATE_TASK, INTENTS.CREATE_ASSESSMENT, INTENTS.CREATE_RECURRING_TASK, INTENTS.STUDY_PLANNING];
    const queryIntents = [INTENTS.QUERY_FREE_TIME, INTENTS.QUERY_RECOMMENDATION, INTENTS.QUERY_CAPACITY, INTENTS.QUERY_DAY_SUMMARY, INTENTS.QUERY_WHEN_TO_DO];
    const queryCommands = commands.filter(command => queryIntents.includes(command.intent));
    const createCommands = commands.filter(command => createIntents.includes(command.intent));
    if (commands.some(command => !createIntents.includes(command.intent) && !queryIntents.includes(command.intent)) || (queryCommands.length && !createCommands.length)) { showToast('I could not split that into separate tasks. Try joining each task with “and”.'); return; }
    const previousState = stateSnapshot();
    const expandedCommands = createCommands.flatMap(command => command.dueDates?.length > 1
      ? command.dueDates.map(dueDate => ({ ...command, dueDate, groupOccurrenceDate: dueDate, dueDates: [] }))
      : [command]);
    // Date extraction and remote parsing can both describe the same calendar
    // day. Collapse that logical occurrence before persistence so one user
    // command cannot create multiple rows with the same identity.
    const uniqueExpandedCommands = [...new Map(expandedCommands.map(command => [captureIdempotencyKey(command), command])).values()];
    const results = [];
    for (const command of uniqueExpandedCommands) results.push(await createTaskFromCommand(command, metadata));
    // Blocked intents are validation outcomes, not created records. Treating
    // them as creations made the summary/planner dereference missing
    // `sessions` and crash the capture flow (most visible with a recurring
    // command that also contained a past time/date).
    const created = results.filter(result => !result.duplicate && !result.blocked);
    const plannedTaskIds = created.filter(result => !result.studyPlan && result.task?.type === 'task').map(result => result.task.id);
    const plannedTasks = applyWorkloadPlan(plannedTaskIds);
    const preferredStart = timeToMinutes(state.profile.preferredStart || '16:00');
    const durationReflow = created
      .filter(result => result.task && taskDisplayDate(result.task) && timeToMinutes(taskDisplayTime(result.task)) >= preferredStart)
      .flatMap(result => reflowDurationChain(taskDisplayDate(result.task), { anchorFromPreferredStart: true }));
    const recoveredSessions = replanAssessmentWork({ persist: false });
    const planningChanges = [...new Map([...plannedTasks, ...durationReflow, ...recoveredSessions].map(task => [task.id, task])).values()];
    if (repository && planningChanges.length) await Promise.all(planningChanges.filter(task => isRemoteTaskId(task.id)).map(task => repository.update(task).catch(() => { markTaskSyncRetry(task); })));
    captureValue = '';
    captureDraft = { priority: '', className: '', project: '', dueDate: '' };
    capturePriorityAutoDetected = false;
    captureClassAutoDetected = false;
    if (created.length) {
      const hasTodayWork = created.some(result => result.task?.dueDate === today() || result.sessions?.some(session => session.dueDate === today()));
      view = hasTodayWork ? 'today' : 'upcoming';
      saveState();
      render();
    }
    if (queryCommands.length) {
      // The mutation is committed before the query runs, so a mixed turn such
      // as “Bio test Wednesday and math homework tomorrow — what first?”
      // receives an answer from the new workload rather than stale state.
      assistantResult = answerPlanningQuery(queryCommands[0]);
      view = 'today';
      location.hash = view;
      render();
      showToast(assistantResult.type === 'recommendation' ? assistantResult.result.task ? `Best next step: ${assistantResult.result.task.title}.` : assistantResult.result.reason : assistantResult.summary.summary);
      return;
    }
    const duplicates = results.filter(result => result.duplicate).length;
    const duplicateSummary = results.filter(result => result.duplicate).map(result => {
      const existing = result.existing;
      if (!existing) return 'A duplicate task was skipped.';
      const dateKey = existing.scheduledDate || existing.dueDate;
      const time = existing.scheduledTime || existing.dueTime;
      const location = dateKey ? ` already exists for ${formatDate(dateKey, { month: 'short', day: 'numeric' })}${time ? ` at ${formatTime(time)}` : ''}` : ' already exists without a date';
      return `Skipped duplicate “${existing.title}”${location}.`;
    }).join(' ');
    const blocked = results.filter(result => result.blocked).map(result => result.message).filter(Boolean);
    const failed = created.filter(result => result.persistenceWarning);
    const sessions = created.reduce((total, result) => total + (Array.isArray(result.sessions) ? result.sessions.length : 0), 0);
    const regularTasks = created.filter(result => !result.studyPlan);
    const studyPlans = created.filter(result => result.studyPlan);
    const regularTaskSummary = regularTasks.length ? String(regularTasks.length) + ' ' + (regularTasks.length === 1 ? 'task' : 'tasks') + ' added' + (sessions ? ' with ' + sessions + ' study ' + (sessions === 1 ? 'session' : 'sessions') : '') + '.' : null;
    const studyPlanSummary = studyPlans.map(result => (result.sessions || []).length ? String(result.sessions.length) + ' study ' + (result.sessions.length === 1 ? 'session' : 'sessions') + ' scheduled.' : result.message || 'I could not find a matching test to plan against.').join(' ');
    const summary = [regularTaskSummary, studyPlanSummary || null, duplicates ? duplicateSummary : null, blocked.length ? blocked.join(' ') : null, failed.length ? 'Some items were saved locally and will retry syncing.' : null, commands.find(command => command.warning)?.warning].filter(Boolean).join(' ');
    if (created.length) offerUndo(summary, previousState);
    else showToast(summary);
  } finally {
    isProcessingCapture = false;
    render();
  }
}

function findTaskForCommand(title) {
  const words = String(title || '').toLowerCase().replace(/\b(my|the|task|to)\b/g, '').split(/\s+/).filter(Boolean);
  return state.tasks.filter(task => task.status !== 'completed' || commandCanRestore(title)).sort(taskSort).find(task => words.every(word => String(task.title || '').toLowerCase().includes(word)));
}

function commandCanRestore(title) { return /restore|uncomplete|not done/.test(String(title || '').toLowerCase()); }

function handleTaskCommand(command) {
  let task = findTaskForCommand(command.title || '');
  if (!task && command.intent === INTENTS.RESCHEDULE_TASK) {
    const subject = String(command.subject || '').toLowerCase();
    task = state.tasks.filter(item => item.status !== 'completed' && (item.type === 'assessment' || item.type === 'study_session'))
      .filter(item => !subject || String(item.className || item.title || '').toLowerCase().includes(subject))
      .sort(taskSort)[0] || null;
  }
  if (!task) { captureValue = ''; render(); showToast('I couldn’t find a matching task. Try the task name again.'); return; }
  if (command.intent === INTENTS.RESCHEDULE_TASK && (command.dueDate || command.dueTime)) {
    const requestedDate = command.dueDate || taskDisplayDate(task);
    const requestedTime = command.dueTime || (command.dueDate ? null : taskDisplayTime(task));
    if (isPastSchedule(requestedDate, requestedTime, new Date())) {
      captureValue = '';
      render();
      showToast('Tasks cannot be scheduled in the past. Choose a current or future date and time.');
      return;
    }
  }
  const previousState = stateSnapshot();
  if (command.intent === INTENTS.DELETE_TASK) { markTaskDeleted(task.id, task); state.tasks = state.tasks.filter(item => item.id !== task.id); repository?.remove(task.id).catch(() => showToast('Could not sync deletion. It is removed locally.')); }
  if (command.intent === INTENTS.COMPLETE_TASK) { task.status = 'completed'; task.completedAt = new Date().toISOString(); task.remainingDuration = 0; task.updatedAt = new Date().toISOString(); awardCompletion(task, new Date(task.completedAt)); const replanned = replanAssessmentWork({ persist: false }); void persistTaskMutations([task, ...replanned]).catch(() => showToast('Could not sync completion. It is saved locally.')); }
  if (command.intent === INTENTS.RESCHEDULE_TASK) {
    if (task.type === 'assessment') {
      task.dueDate = command.dueDate || task.dueDate;
      task.dueTime = command.dueTime || task.dueTime;
    } else {
      const targetDate = command.dueDate || task.scheduledDate || task.dueDate;
      const planningState = buildPlanningState({ tasks: state.tasks.filter(item => item.id !== task.id), profile: { ...state.profile, now: new Date() }, currentTime: new Date() });
      const candidate = generateCandidateWindows(planningState, { ...task, dueDate: targetDate, dueTime: null, scheduledDate: null, scheduledTime: null, userScheduled: false }, { horizonDays: 0, allowFlexibleFallback: true, allowBeforePreferredStart: false }).find(window => window.dateKey === targetDate);
      task.dueDate = task.dueDate || targetDate;
      const targetTime = command.dueTime || (candidate ? toClock(candidate.start) : taskExecution(task).time);
      setTaskExecution(task, targetDate, targetTime);
      task.userScheduled = true;
      task.autoScheduled = false;
      task.scheduleOrigin = SCHEDULE_ORIGINS.USER_SCHEDULED;
      task.flexibility = 'fixed';
    }
    task.updatedAt = new Date().toISOString();
    const replanned = replanAssessmentWork({ persist: false });
    repository?.update(task).catch(() => { markTaskSyncRetry(task); showToast('Could not sync rescheduling. It is saved locally.'); });
    if (repository && replanned.length) Promise.all(replanned.filter(item => isRemoteTaskId(item.id)).map(item => repository.update(item).catch(() => { markTaskSyncRetry(item); }))).catch(() => {});
  }
  if (command.intent === INTENTS.EDIT_TASK) { selectedTaskId = task.id; render(); showToast('Task opened for editing.'); return; }
  captureValue = ''; saveState(); render(); offerUndo(command.intent === INTENTS.DELETE_TASK ? 'Task deleted.' : command.intent === INTENTS.COMPLETE_TASK ? 'Task completed.' : 'Task rescheduled.', previousState);
}

function calendarEventClass(calendarEvent, feedId = 'file') {
  const raw = [calendarEvent.classHint, calendarEvent.categories, calendarEvent.calendarName, calendarEvent.title, calendarEvent.description, calendarEvent.location].filter(Boolean).join(' ');
  const hints = [calendarEvent.classHint, calendarEvent.categories, calendarEvent.calendarName].filter(Boolean).flatMap(value => String(value).split(/[,;|/]+/).map(part => part.trim()).filter(Boolean));
  const matched = matchExistingClass({ subject: extractSubject(hints.join(' ') || raw), classHint: calendarEvent.classHint, hints, title: calendarEvent.title, raw }, state.classes);
  if (matched) return matched;

  // The all-course Schoology feed omits the course field. Use distinctive
  // title/description signals before considering the user's default class.
  const inferredHint = inferSchoologyClassHint(calendarEvent);
  if (inferredHint) {
    const inferredMatch = matchExistingClass({ subject: inferredHint, classHint: inferredHint, hints: [inferredHint], title: calendarEvent.title, raw }, state.classes);
    if (inferredMatch) return inferredMatch;
  }

  // A club/science-fair event is not an academic class. It must not inherit a
  // default course merely because the feed has no course metadata.
  if (feedId === 'schoology' && isNonAcademicSchoologyEvent(calendarEvent)) return null;

  // Some providers omit a custom course property but put the course in a
  // category, calendar name, or the event title. Only use this broad matcher
  // before the default when it finds an existing class.
  const inferred = matchExistingClass({ subject: extractSubject(raw), hints, title: calendarEvent.title, raw }, state.classes);
  if (inferred) return inferred;

  // Schoology's all-course feed does not reliably identify the owning course.
  // Never apply its configured default to an unrecognized event: an incorrect
  // class is worse than leaving the task unassigned for the user to fix.
  const defaultClass = feedId === 'file' || feedId === 'todoist' ? calendarFeed(feedId)?.className : null;
  return matchExistingClass({ subject: defaultClass, classHint: defaultClass, title: defaultClass, raw: defaultClass }, state.classes)
    || state.classes.find(name => String(name).trim().toLowerCase() === String(defaultClass || '').trim().toLowerCase())
    || null;
}

async function removePastImportedCalendarTasks() {
  const stale = state.tasks.filter(task => isPastImportedOneTimeTask(task, today()));
  if (!stale.length) return { removed: 0, failed: 0 };
  const results = await Promise.all(stale.map(async task => {
    if (!isRemoteTaskId(task.id)) return { task, removed: true };
    try { await repository?.remove(task.id); return { task, removed: true }; } catch { return { task, removed: false }; }
  }));
  const removedIds = new Set(results.filter(result => result.removed).map(result => result.task.id));
  results.filter(result => result.removed).forEach(result => markTaskDeleted(result.task.id));
  state.tasks = state.tasks.filter(task => !removedIds.has(task.id));
  if (removedIds.size) { saveState(); renderBackgroundState(); }
  return { removed: removedIds.size, failed: results.length - removedIds.size };
}

function calendarTaskFromEvent(calendarEvent, existing = null, feedId = 'file') {
  const matchedClass = calendarEventClass(calendarEvent, feedId);
  if (matchedClass && !state.classes.some(name => String(name).toLowerCase() === String(matchedClass).toLowerCase())) {
    state.classes.push(matchedClass);
    ensureClassColors();
  }
  const task = makeTask({ title: calendarEvent.title, description: calendarEvent.description, dueDate: calendarEvent.dueDate, dueTime: calendarEvent.dueTime, duration: calendarEvent.duration, subject: matchedClass, recurrence: calendarEvent.recurrence }, { source: 'calendar', idempotencyKey: calendarTaskKey(calendarEvent.uid, feedId) });
  task.type = 'fixed_event';
  task.assignmentType = inferAssignmentType(task.title, task.type, task.source);
  task.title = calendarEvent.title;
  task.description = calendarEvent.description || '';
  task.calendarClassName = matchedClass || null;
  task.calendarClassHint = calendarEvent.classHint || calendarEvent.categories || calendarEvent.calendarName || null;
  task.calendarDefaultClass = feedId === 'file' ? state.profile.calendarFeedClassName : calendarFeed(feedId)?.className || null;
  task.calendarClassResolution = feedId === 'schoology' && isNonAcademicSchoologyEvent(calendarEvent)
    ? 'non_academic'
    : matchedClass ? 'matched' : feedId === 'schoology' ? 'unmatched' : 'default';
  task.calendarClassManuallySet = false;
  const preserved = preserveImportedCalendarTask(existing, task);
  const repairedClass = repairImportedCalendarClass(existing, task);
  if (repairedClass.changed) {
    preserved.task = repairedClass.task;
    preserved.changed = true;
  } else if (!existing) preserved.task = task;
  return preserved;
}

function normalizeCalendarFeedUrl(value) {
  const raw = String(value || '').trim().replace(/^webcal:/i, 'https:');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

async function copyCalendarExportUrl() {
  if (!calendarExportUrl) return;
  try {
    await navigator.clipboard.writeText(calendarExportUrl);
    showToast('Feed URL copied.');
  } catch {
    document.querySelector('#calendar-export-url')?.select();
    showToast('Select and copy the feed URL.');
  }
}

async function generateCalendarExport(regenerate = false) {
  if (!repository || calendarExportBusy) return;
  calendarExportBusy = true;
  render();
  try {
    const result = await repository.generateCalendarExport(regenerate);
    calendarExportUrl = result.feedUrl || '';
    calendarExportActive = Boolean(calendarExportUrl);
    if (calendarExportUrl) localStorage.setItem(calendarExportStorageKey(), calendarExportUrl);
    render();
    showToast(regenerate ? 'Feed URL regenerated. The previous URL is no longer valid.' : 'Private feed URL generated.');
  } catch (error) {
    showToast(error.message || 'Could not generate the calendar feed URL.');
  } finally {
    calendarExportBusy = false;
    render();
  }
}

async function revokeCalendarExport() {
  if (!repository || calendarExportBusy) return;
  calendarExportBusy = true;
  try {
    await repository.revokeCalendarExport();
    calendarExportUrl = '';
    calendarExportActive = false;
    localStorage.removeItem(calendarExportStorageKey());
    render();
    showToast('Silico calendar feed revoked.');
  } catch (error) {
    showToast(error.message || 'Could not revoke the calendar feed.');
  } finally {
    calendarExportBusy = false;
    render();
  }
}

async function handleCalendarFeedSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedId = form.dataset.feedId;
  const input = form.querySelector('[data-calendar-feed-url]');
  const url = normalizeCalendarFeedUrl(input?.value);
  if (!url) { showToast('Enter a valid webcal:// or https:// calendar feed URL.'); return; }
  const className = form.querySelector('[data-calendar-feed-class]')?.value || '';
  const feeds = calendarFeeds().map(feed => feed.id === feedId ? { ...feed, url, className, lastSyncedAt: null } : feed);
  saveCalendarFeeds(feeds);
  saveState();
  await persistProfile();
  await syncCalendarFeed(feedId);
}

async function syncCalendarFeed(feedId, { silent = false } = {}) {
  const feed = calendarFeed(feedId);
  if (!repository || !feed?.url || calendarFeedSyncPromise) return;
  calendarFeedBusy = true;
  renderBackgroundState();
  calendarFeedSyncPromise = (async () => {
    try {
      const payload = await repository.fetchCalendarFeed(feed.url);
      const events = parseICal(payload.body || '').filter(calendarEvent => !calendarEvent.dueDate || calendarEvent.dueDate >= today() || calendarEvent.recurrence);
      await handleCalendarImport({ target: { files: [{ text: async () => payload.body }], value: '' }, feedSync: true, feedId });
      const syncedAt = new Date().toISOString();
      saveCalendarFeeds(calendarFeeds().map(item => item.id === feedId ? { ...item, url: payload.url || item.url, lastSyncedAt: syncedAt } : item));
      saveState();
      await persistProfile();
      if (!events.length && !silent) showToast('The feed loaded, but it contained no supported events.');
    } catch (error) {
      if (!silent) showToast(error.message || 'Could not sync that calendar feed.');
    }
  })().finally(() => {
    calendarFeedBusy = false;
    calendarFeedSyncPromise = null;
    renderBackgroundState();
  });
  return calendarFeedSyncPromise;
}

async function syncCalendarFeeds({ silent = false } = {}) {
  for (const feed of calendarFeeds()) if (feed.url) await syncCalendarFeed(feed.id, { silent });
}

async function handleCalendarImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const feedSync = Boolean(event.feedSync);
  const feedId = event.feedId || 'file';
  const previousState = stateSnapshot();
  try {
    const stale = await removePastImportedCalendarTasks();
    const events = filterCalendarEvents(parseICal(await file.text()), today());
    const repaired = [];
    const imported = events.filter(calendarEvent => {
      const keys = [calendarTaskKey(calendarEvent.uid, feedId), ...(feedId === 'schoology' ? [`ical:${calendarEvent.uid}`] : [])];
      const identities = keys.map(key => taskIdentity({ idempotencyKey: key })).filter(Boolean);
      // A deleted provider event is a durable local decision. Do not recreate
      // it on every calendar refresh just because the upstream feed still
      // contains the same UID.
      if (identities.some(identity => localDeletedTaskIdentities.has(identity))) return false;
      const existing = state.tasks.find(task => keys.includes(task.idempotencyKey));
      if (!existing) return true;
      const repairedTask = calendarTaskFromEvent(calendarEvent, existing, feedId);
      if (repairedTask.changed) {
        const taskIndex = state.tasks.indexOf(existing);
        if (taskIndex >= 0) state.tasks[taskIndex] = repairedTask.task;
        repaired.push(repairedTask.task);
      }
      return false;
    }).map(calendarEvent => {
      return calendarTaskFromEvent(calendarEvent, null, feedId).task;
    });
    if (repaired.length) {
      saveState();
      await Promise.all(repaired.map(task => repository ? repository.update(task).catch(() => { markTaskSyncRetry(task); return null; }) : null));
      await persistProfile();
      renderBackgroundState();
    }
    if (!imported.length) {
      const cleanupMessage = [stale.removed ? `Removed ${stale.removed} past imported ${stale.removed === 1 ? 'event' : 'events'}.` : '', stale.failed ? `${stale.failed} past imported ${stale.failed === 1 ? 'event could' : 'events could'} not be deleted yet.` : ''].filter(Boolean).join(' ');
      if (repaired.length) { const message = [cleanupMessage, `${repaired.length} imported ${repaired.length === 1 ? 'event kept' : 'events kept'} their local edits.`].filter(Boolean).join(' '); if (feedSync) showToast(message); else offerUndo(message, previousState); }
      else showToast(cleanupMessage || (events.length ? 'Those calendar events are already imported.' : 'No supported events were found in that file.'));
      return;
    }
    state.tasks.push(...imported);
    if (imported.length) addAppNotification({ type: 'task-created', id: `notification:calendar-import:${feedId}:${new Date().toISOString().slice(0, 16)}`, title: 'Calendar synced', body: `${imported.length} new event${imported.length === 1 ? '' : 's'} imported.` });
    saveState();
    renderBackgroundState();
    let importMessage = `${stale.removed ? `Removed ${stale.removed} past imported ${stale.removed === 1 ? 'event' : 'events'}. ` : ''}Imported ${imported.length} calendar ${imported.length === 1 ? 'event' : 'events'}.`;
    if (stale.failed) importMessage += ` ${stale.failed} past imported ${stale.failed === 1 ? 'event could' : 'events could'} not be deleted yet.`;
    if (repository) {
      const results = await Promise.all(imported.map(task => persistCreatedTask(task).catch(error => { markTaskSyncRetry(task); return null; })));
      const failed = results.filter(result => !result).length;
      results.forEach((result, index) => { if (result) Object.assign(imported[index], result); });
      saveState();
      await persistProfile();
      renderBackgroundState();
      if (failed) importMessage += ` ${imported.length - failed} synced; ${failed} saved locally for retry.`;
    }
    if (repaired.length) importMessage += repaired.length === 1 ? ' 1 existing event kept its local edits.' : ` ${repaired.length} existing events kept their local edits.`;
    if (feedSync) showToast(importMessage); else offerUndo(importMessage, previousState);
  } catch {
    showToast('Could not read that calendar file. Export it as a valid .ics file and try again.');
  } finally {
    event.target.value = '';
  }
}

function recommendation(duration) {
  const result = recommendNextAction(currentPlanningState(), { availableMinutes: duration || Infinity, now: new Date() });
  return result.task ? `Try “${result.task.title}” — ${result.reason}` : result.reason || 'You have some open space. Add a task and Silico will help place it.';
}
function showProjectCreator(onCreate) {
  document.querySelector('.project-create-backdrop')?.remove();
  document.querySelector('.project-create-card')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'project-create-backdrop';
  const card = document.createElement('div');
  card.className = 'project-create-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'project-create-title');
  card.innerHTML = '<div class="project-create-header"><div><div class="eyebrow">Workspace</div><h2 id="project-create-title">Create a project</h2></div><button class="icon-button" type="button" aria-label="Close">×</button></div><p class="muted">Give this task a project label.</p><form><label for="project-create-name">Project name<input id="project-create-name" maxlength="80" autocomplete="off" placeholder="e.g. College applications"/></label><p class="project-create-error" role="alert" aria-live="polite"></p><div class="confirm-actions"><button class="secondary-button" type="button" data-project-cancel>Cancel</button><button class="primary-button" type="submit">Create project</button></div></form>';
  const close = () => { backdrop.remove(); card.remove(); };
  const form = card.querySelector('form');
  const input = card.querySelector('#project-create-name');
  const error = card.querySelector('.project-create-error');
  card.querySelector('.icon-button').addEventListener('click', close);
  card.querySelector('[data-project-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = normalizeClassName(input.value);
    if (!name) { error.textContent = 'Enter a project name.'; input.focus(); return; }
    onCreate(name);
    close();
  });
  document.body.appendChild(backdrop);
  document.body.appendChild(card);
  input.focus();
}

function showTeamRenameDialog(currentName, onRename, options = {}) {
  document.querySelector('.team-rename-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'team-rename-backdrop project-create-backdrop';
  const card = document.createElement('div');
  card.className = 'team-rename-card project-create-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const title = options.title || 'Rename team';
  const label = options.label || 'Team name';
  const description = options.description || 'Choose a name everyone on the team will see.';
  card.innerHTML = `<div class="project-create-header"><div><div class="eyebrow">Team project</div><h2>${escapeHtml(title)}</h2></div><button class="icon-button" type="button" aria-label="Close">×</button></div><p class="muted">${escapeHtml(description)}</p><form><label for="team-rename-name">${escapeHtml(label)}<input id="team-rename-name" maxlength="120" autocomplete="off"/></label><p class="project-create-error" role="alert" aria-live="polite"></p><div class="confirm-actions"><button class="secondary-button" type="button" data-team-rename-cancel>Cancel</button><button class="primary-button" type="submit">Save name</button></div></form>`;
  const close = () => { backdrop.remove(); card.remove(); };
  const form = card.querySelector('form');
  const input = card.querySelector('#team-rename-name');
  const error = card.querySelector('.project-create-error');
  input.value = currentName;
  card.querySelector('.icon-button').addEventListener('click', close);
  card.querySelector('[data-team-rename-cancel]').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = normalizeClassName(input.value);
    if (!name) { error.textContent = `Enter a ${label.toLowerCase()}.`; input.focus(); return; }
    onRename(name);
    close();
  });
  document.body.appendChild(backdrop);
  document.body.appendChild(card);
  input.focus();
  input.select();
}

function showConfirm(message, onConfirm) {
  document.querySelector('.confirm-backdrop')?.remove();
  document.querySelector('.confirm-card')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-backdrop';
  const card = document.createElement('div');
  card.className = 'confirm-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.innerHTML = `<p>${escapeHtml(message)}</p><div class="confirm-actions"><button class="secondary-button" type="button">Cancel</button><button class="danger-button" type="button">Continue</button></div>`;
  const close = () => { backdrop.remove(); card.remove(); };
  card.querySelector('.secondary-button').addEventListener('click', close);
  card.querySelector('.danger-button').addEventListener('click', () => { close(); onConfirm(); });
  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(card);
  card.querySelector('.secondary-button').focus();
}
function streakCelebrationStorageKey() { return currentUser?.id ? `${STORAGE_KEY}.streak-seen.${currentUser.id}` : null; }
function maybeCelebrateStreak() {
  const storageKey = streakCelebrationStorageKey();
  if (!storageKey) return;
  const currentStreak = Math.max(0, Number(state.profile.gamification?.currentStreak) || 0);
  const todayKey = today();
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { seen = null; }
  if (!seen) {
    localStorage.setItem(storageKey, JSON.stringify({ date: todayKey, streak: currentStreak }));
    showStreakCelebration(currentStreak, 1, currentStreak > 0 && currentStreak % 7 === 0 ? currentStreak : 0);
    return;
  }
  if (seen.date === todayKey) return;
  const previousStreak = Math.max(0, Number(seen.streak) || 0);
  localStorage.setItem(storageKey, JSON.stringify({ date: todayKey, streak: currentStreak }));
  const addedDays = Math.max(1, currentStreak - previousStreak);
  const previousMilestone = Math.floor(previousStreak / 7);
  const currentMilestone = Math.floor(currentStreak / 7);
  const milestone = currentMilestone > previousMilestone ? currentMilestone * 7 : 0;
  showStreakCelebration(currentStreak, addedDays, milestone);
}
function showStreakCelebration(streak, addedDays, milestone = 0) {
  document.querySelector('.streak-celebration')?.remove();
  const celebration = document.createElement('div');
  celebration.className = `streak-celebration${milestone ? ' streak-milestone' : ''}`;
  celebration.setAttribute('role', 'status');
  celebration.setAttribute('aria-live', 'polite');
  const visibleDays = Math.min(addedDays, 14);
  const dayDots = Array.from({ length: visibleDays }, (_, index) => `<span class="streak-day-dot" style="--streak-delay:${index * 70}ms"></span>`).join('');
  const overflow = addedDays > visibleDays ? `<span class="streak-day-overflow">+${addedDays - visibleDays}</span>` : '';
  celebration.innerHTML = `<div class="streak-celebration-card"><div class="streak-celebration-icon">${svgIcon('streak')}</div><div class="streak-celebration-copy"><p class="streak-celebration-kicker">${milestone ? `${milestone}-day milestone` : 'Streak growing'}</p><strong>+${addedDays} ${addedDays === 1 ? 'day' : 'days'}</strong><span>${milestone ? 'You reached a new weekly streak.' : `${streak} days in a row.`}</span>${milestone ? '<b class="streak-reward">+200 XP reward</b>' : ''}<div class="streak-day-dots" aria-hidden="true">${dayDots}${overflow}</div></div><button class="icon-button" type="button" aria-label="Dismiss streak celebration">×</button></div>`;
  const close = () => celebration.remove();
  celebration.querySelector('button').addEventListener('click', close);
  document.body.appendChild(celebration);
  window.setTimeout(close, milestone ? 6500 : 4200);
}
function showLevelUp(level) {
  document.querySelector('.level-up-celebration')?.remove();
  const celebration = document.createElement('div');
  celebration.className = 'level-up-celebration';
  celebration.setAttribute('role', 'status');
  celebration.setAttribute('aria-live', 'assertive');
  celebration.innerHTML = `<div class="level-up-card"><div class="level-up-confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, index) => `<span class="confetti confetti-${index % 6}"></span>`).join('')}</div><div class="level-up-badge">★</div><p class="level-up-kicker">Level up!</p><strong>Level ${level}</strong><p>You earned another 100 XP. Keep going.</p><button class="secondary-button" type="button">Continue</button></div>`;
  const close = () => celebration.remove();
  celebration.addEventListener('click', event => { if (event.target === celebration) close(); });
  celebration.querySelector('button').addEventListener('click', close);
  document.body.appendChild(celebration);
  window.setTimeout(close, 4200);
}
function showToast(message, action = null) {
  activeToast?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  const copy = document.createElement('span');
  copy.textContent = message;
  toast.appendChild(copy);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    toast.appendChild(button);
  }
  activeToast = toast;
  document.body.appendChild(toast);
  setTimeout(() => { if (activeToast === toast) activeToast = null; toast.remove(); }, action ? 6000 : 2600);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

window.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'q' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('.task-create-backdrop')) {
    event.preventDefault();
    openTaskCreationOverlay();
    return;
  }
  if (event.key === 'Escape' && document.querySelector('.task-create-backdrop')) { closeTaskCreationOverlay(); return; }
  if (event.key === 'Escape' && isSidebarOpen) { isSidebarOpen = false; render(); return; }
  if (event.key === 'Escape' && selectedTaskId) { selectedTaskId = null; render(); }
});
window.addEventListener('focusout', () => window.setTimeout(flushBackgroundRender, 0));
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (views.has(next)) { view = next; selectedTaskId = null; isSidebarOpen = false; render(); } });
window.addEventListener('popstate', routePublicNavigation);
window.addEventListener('pageshow', event => { if (event.persisted) routePublicNavigation(); });
document.addEventListener('click', event => {
  const link = event.target.closest('.public-footer a, .auth-story a, .public-header a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.hash || !['/', location.pathname].includes(url.pathname)) return;
  if (!url.searchParams.has('page') && url.pathname !== '/') return;
  event.preventDefault();
  history.pushState({}, '', `${url.pathname}${url.search}`);
  routePublicNavigation();
});
window.addEventListener('online', () => { void syncRemoteState(); });
window.addEventListener('visibilitychange', () => { if (!document.hidden) void syncRemoteState(); });
window.addEventListener('silico-task-not-found', event => {
  const id = event.detail?.id;
  if (!id || !state.tasks.some(task => task.id === id)) return;
  markTaskDeleted(id);
  state.tasks = state.tasks.filter(task => task.id !== id);
  if (selectedTaskId === id) selectedTaskId = null;
  saveState();
  renderBackgroundState();
  showToast('That task no longer exists on the server. Your workspace was refreshed.');
  void syncRemoteState({ includeCalendar: false });
});
function refreshTimeSensitiveView() {
  checkDueNotifications(new Date());
  if (document.hidden) return;
  if (view !== 'today' || isProcessingCapture || isEditingControl()) return;
  const next = nextPlanningAction();
  const signature = JSON.stringify([
    today(),
    next.task?.id || null,
    next.window?.dateKey || null,
    next.window?.start ?? null,
    next.window?.end ?? null
  ]);
  if (signature !== timeSensitiveViewSignature) renderBackgroundState();
}
window.setInterval(refreshTimeSensitiveView, CLOCK_REFRESH_INTERVAL_MS);
window.setInterval(() => { if (!document.hidden) void syncRemoteState({ includeCalendar: false }); }, SYNC_INTERVAL_MS);

function syncRemoteState(options = {}) {
  if (!repository) return Promise.resolve();
  if (remoteSyncPromise) return remoteSyncPromise;
  remoteSyncPromise = runRemoteSync(options).finally(() => { remoteSyncPromise = null; });
  return remoteSyncPromise;
}

async function runRemoteSync({ includeCalendar = true } = {}) {
  if (!repository) return;
  const profileVersionAtStart = profileMutationVersion;
  const scheduleMutationVersionAtStart = localScheduleMutationVersion;
  const deletedTaskIdsAtSyncStart = new Set(localDeletedTaskIds);
  isSyncing = true;
  renderBackgroundState();
  const teamSyncPromise = Promise.all([
    loadTeamProjects({ silent: true }),
    loadTeamTaskFeed({ silent: true })
  ]);
  try {
    const [remoteTasks, remoteProfile, exportStatus] = await Promise.all([repository.load(), repository.loadProfile(), includeCalendar ? repository.calendarExportStatus().catch(() => null) : Promise.resolve(null)]);
    const remoteSettings = remoteProfile?.profile?.settings;
    const remoteClearedAt = remoteSettings?.tasksClearedAt || remoteSettings?.tasks_cleared_at;
    const localClearedAt = state.profile.tasksClearedAt;
    const remoteClearTimestamp = Math.max(Date.parse(localClearedAt || '') || 0, Date.parse(remoteClearedAt || '') || 0);
    if (remoteClearTimestamp) {
      state.profile.tasksClearedAt = new Date(remoteClearTimestamp).toISOString();
      const staleLocalTasks = state.tasks.filter(task => isClearedByTaskTombstone(task, state.profile.tasksClearedAt));
      staleLocalTasks.forEach(task => markTaskDeleted(task.id));
      if (staleLocalTasks.length) state.tasks = state.tasks.filter(task => !isClearedByTaskTombstone(task, state.profile.tasksClearedAt));
    }
    if (state.profile.tasksClearPendingAt) {
      const result = await repository.removeAll(state.profile.tasksClearPendingAt);
      state.profile.tasksClearedAt = result?.cleared_at || state.profile.tasksClearedAt || state.profile.tasksClearPendingAt;
      delete state.profile.tasksClearPendingAt;
    }
    if (exportStatus) {
      calendarExportActive = Boolean(exportStatus.active);
      if (!calendarExportActive) {
        calendarExportUrl = '';
        localStorage.removeItem(calendarExportStorageKey());
      }
    }
    // Any task without a database UUID is device-local, including records
    // created by older app versions. Retry these immediately so legacy
    // backoff timestamps cannot strand them on one device.
    const pendingLocalTasks = state.tasks
      .filter(task => !isRemoteTaskId(task.id) && !localRecoveryAttempts.has(task.id) && !taskPersistence.hasPending(task.id))
      .sort((a, b) => Number(b.type === 'assessment') - Number(a.type === 'assessment'));
    const recoveredTaskIds = new Map();
    const recoveredTasks = [];
    for (const localTask of pendingLocalTasks) {
      localRecoveryAttempts.add(localTask.id);
      const payload = { ...localTask, relatedAssessmentId: recoveredTaskIds.get(localTask.relatedAssessmentId) || localTask.relatedAssessmentId };
      try {
        const recovered = await persistCreatedTask(payload);
        delete localTask.syncRetryAfter;
        recoveredTaskIds.set(localTask.id, recovered.id);
        recoveredTasks.push(recovered);
      } catch {
        localRecoveryAttempts.delete(localTask.id);
        localTask.syncRetryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        saveState();
        recoveredTasks.push(localTask);
      }
    }
    const deletedTaskIds = new Set([...deletedTaskIdsAtSyncStart, ...localDeletedTaskIds]);
    const byId = new Map();
    [...remoteTasks, ...recoveredTasks].filter(task => !remoteClearTimestamp || taskSyncTimestamp(task) > remoteClearTimestamp).forEach(task => {
      const identity = taskIdentity(task);
      if (task?.id && !deletedTaskIds.has(task.id) && !(identity && localDeletedTaskIdentities.has(identity))) byId.set(task.id, task);
    });
    const localTasksAtMerge = new Map(state.tasks.map(task => [task.id, task]));
    for (const [id, localTask] of localTasksAtMerge) {
      if (deletedTaskIds.has(id) || (taskIdentity(localTask) && localDeletedTaskIdentities.has(taskIdentity(localTask)))) continue;
      if (recoveredTaskIds.has(id)) continue;
      const remoteTask = byId.get(id);
      // The remote task list is authoritative for database-backed records.
      // Keeping a missing UUID locally creates a ghost that renders normally
      // but can never be PATCHed, producing repeated 404s when interacted
      // with. Device-local records use task_* ids and are recovered above.
      if (!remoteTask && isRemoteTaskId(id)) {
        markTaskDeleted(id);
        continue;
      }
      const localScheduleMutation = localScheduleMutations.get(id);
      const changedDuringSync = localScheduleMutation && localScheduleMutation.version > scheduleMutationVersionAtStart;
      const recentlyChangedLocally = localScheduleMutation && Date.now() - localScheduleMutation.timestamp < 15_000;
      // A refresh that started before a drag must not merge its stale remote
      // snapshot over the local placement while the PATCH is still in flight.
      // The next refresh will reconcile against the server response normally.
      if (changedDuringSync || localScheduleMutation?.pending || recentlyChangedLocally || localTask.syncRetryAfter) {
        byId.set(id, localTask);
        continue;
      }
      const localUpdated = Date.parse(localTask.updatedAt || localTask.completedAt || localTask.createdAt || '') || 0;
      const remoteUpdated = Date.parse(remoteTask?.updated_at || remoteTask?.updatedAt || remoteTask?.created_at || '') || 0;
      if (/^task_[0-9a-f_-]+$/i.test(id) || localUpdated > remoteUpdated) byId.set(id, localTask);
    }
    const mergedRecords = deduplicateTaskRecords([...byId.values()]);
    mergedRecords.duplicates.forEach(task => markTaskDeleted(task.id));
    await Promise.all(mergedRecords.duplicates.filter(task => isRemoteTaskId(task.id)).map(task => repository.remove(task.id).catch(() => {})));
    state.tasks = mergedRecords.tasks.map((task, index) => normalizeTaskRecord(task, index)).filter(Boolean);
    // Imported one-time events are lifecycle-bound to their calendar date.
    // Reconcile them after the remote merge as well as during feed import, so
    // a stale remote row cannot be merged back after its local copy is gone.
    await removePastImportedCalendarTasks();
    const pendingUpdates = state.tasks.filter(task => isRemoteTaskId(task.id) && task.syncRetryAfter && Date.parse(task.syncRetryAfter) <= Date.now());
    await Promise.all(pendingUpdates.map(async task => {
      try { await repository.update(task); delete task.syncRetryAfter; } catch { markTaskSyncRetry(task); }
    }));
    let gamificationChanged = false;
    if (remoteSettings && typeof remoteSettings === 'object' && profileVersionAtStart === profileMutationVersion) {
      const { classes: remoteClasses, projects: remoteProjects, ...profileSettings } = remoteSettings;
      const localGamification = state.profile.gamification || {};
      state.profile = { ...state.profile, ...profileSettings, displayName: typeof remoteProfile.profile?.display_name === 'string' ? remoteProfile.profile.display_name : state.profile.displayName, onboardingComplete: Boolean(remoteProfile.profile?.onboarding_complete), classPreferences: { ...state.profile.classPreferences, ...(profileSettings.classPreferences || {}) } };
      state.profile.gamification = mergeGamification(profileSettings.gamification || {}, localGamification);
      if (Array.isArray(remoteClasses)) state.classes = remoteClasses.filter(name => typeof name === 'string' && name.trim()).map(normalizeClassName);
      if (Array.isArray(remoteProjects)) state.projects = remoteProjects.filter(name => typeof name === 'string' && name.trim()).map(normalizeClassName);
      ensureClassColors();
    }
    gamificationChanged = registerDailyVisit();
    if (gamificationChanged) persistProfile();
    saveState();
    // Make task/profile changes visible as soon as the fast remote merge is
    // complete. Calendar feeds are external and can be considerably slower.
    renderBackgroundState();
    maybeCelebrateStreak();
    await teamSyncPromise.catch(() => {});
    renderBackgroundState();
    if (includeCalendar) await syncCalendarFeeds({ silent: true });
  } catch {
    // A signed-in user's cached workspace remains usable when the server is slow or unavailable.
    await teamSyncPromise.catch(() => {});
  } finally {
    isSyncing = false;
    renderBackgroundState();
  }
}

async function bootstrap() {
  const requestedPublicPage = new URLSearchParams(location.search).get('page');
  if (['about', 'privacy', 'it-admin', 'setup'].includes(requestedPublicPage)) { renderPublicInfoPage(requestedPublicPage); return; }
  if (platformStatus.clerkConfigured && !clerk) { renderUnauthenticatedRoute(); return; }
  if (clerk) {
    await clerk.load({ ...clerkLoadOptions, ui: { ClerkUI: window.__internal_ClerkUICtor } });
    currentUser = authenticatedUser(clerk.user);
    clerk.addListener(({ user }) => {
      const nextUser = authenticatedUser(user);
      if (nextUser?.id === currentUser?.id && nextUser?.imageUrl === currentUser?.imageUrl) return;
      currentUser = nextUser;
      localRecoveryAttempts.clear();
      localDeletedTaskIds.clear();
      localDeletedTaskIdentities.clear();
      feedbackItems = [];
      feedbackAdminLoaded = false;
      feedbackAdminError = '';
      studyMaterials = [];
      studyArtifacts = [];
      studyUsage = null;
      studyArtifact = null;
      studyLoading = false;
      studyBusy = false;
      billingBusy = false;
      studyError = '';
      repository = currentUser ? createTaskRepository() : null;
    if (!currentUser) { selectedTaskId = null; selectedCollection = null; teamProjects = []; teamTaskFeed = []; teamTaskClearTimestamps = {}; activeTeamProjectId = null; activeTeamDetail = null; activeTeamFiles = []; renderUnauthenticatedRoute(); return; }
      authRenderMode = null;
      state = loadState();
      loadCalendarExportState();
      loadTeamInviteCodes();
      loadTeamTaskClearTimestamps();
      teamProjects = [];
      teamTaskFeed = [];
      activeTeamProjectId = null;
      activeTeamDetail = null;
      normalizeState();
      if (registerDailyVisit()) persistProfile();
      saveState();
      render();
      void syncRemoteState();
    });
    if (!currentUser) { renderUnauthenticatedRoute(); return; }
  }
  if (!currentUser) { authRenderMode = null; renderUnauthenticatedRoute(); return; }
  repository = createTaskRepository();
  state = loadState();
  loadCalendarExportState();
  loadTeamInviteCodes();
  loadTeamTaskClearTimestamps();
  normalizeState();
  if (registerDailyVisit()) persistProfile();
  saveState();
  if (currentUser && state.profile.onboardingComplete === false) renderOnboarding();
  else render();
  void syncRemoteState();
}

renderLoadingShell();
bootstrap().catch(() => renderUnauthenticatedRoute());
