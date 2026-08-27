import { addDays, assessmentIdempotencyKey, dateAt, expandRecurringTask, formatDate, formatLongDate, formatTime, gamificationLevel, isOverdue, makeTask, planStudySessions, rankRecommendations, recordCompletion, recurrenceFromText, seedState, taskSort, toDateKey, INTENTS } from './core.js';
import { parseCaptureCommand } from './capture.js';
import { clerk, platformStatus } from './platform.js';
import { createTaskRepository } from './repository.js';
import './styles.css';

const STORAGE_KEY = 'silico.state.v1';
let currentUser = null;
let state = seedState();
let repository = null;
const views = new Set(['today', 'upcoming', 'calendar', 'inbox', 'classes', 'projects', 'settings']);
let view = views.has(location.hash.slice(1)) ? location.hash.slice(1) : 'today';
let selectedTaskId = null;
let captureValue = '';
let searchTerm = '';
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function storageKey() { return `${STORAGE_KEY}.${currentUser?.id || 'guest'}`; }
function loadState() {
  try { return JSON.parse(localStorage.getItem(storageKey())) || seedState(); } catch { return seedState(); }
}
function saveState() { localStorage.setItem(storageKey(), JSON.stringify(state)); }
function persistProfile() { repository?.saveProfile(state.profile, state.classes).catch(() => showToast('Could not sync preferences. They are saved locally.')); }
function defaultClassPreference() { return { sessionsPerWeek: 2, sessionLength: 45 }; }
function normalizeState() {
  const defaults = seedState();
  state = { ...defaults, ...state, profile: { ...defaults.profile, ...(state.profile || {}), gamification: { ...defaults.profile.gamification, ...(state.profile?.gamification || {}) } } };
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.classes = Array.isArray(state.classes) ? state.classes : [];
  state.projects = Array.isArray(state.projects) ? state.projects : [];
}
function normalizeClassName(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function collectOnboardingClassPreferences() {
  state.profile.classPreferences ||= {};
  document.querySelectorAll('.onboarding-class-sessions').forEach(input => {
    const name = input.dataset.class;
    const length = document.querySelector(`.onboarding-class-length[data-class="${CSS.escape(name)}"]`);
    state.profile.classPreferences[name] = { sessionsPerWeek: Math.max(0, Math.min(14, Number(input.value) || 0)), sessionLength: Number(length?.value || 45) };
  });
}
function today() { return toDateKey(); }
function tasksForDate(dateKey) { return state.tasks.flatMap(task => task.recurrence ? expandRecurringTask(task, dateKey, dateKey, state.occurrenceCompletions || {}) : [task]).filter(task => task.dueDate === dateKey).sort(taskSort); }
function rangeTasks(fromKey, toKey) { return state.tasks.flatMap(task => task.recurrence ? expandRecurringTask(task, fromKey, toKey, state.occurrenceCompletions || {}) : [task]).filter(task => task.dueDate && task.dueDate >= fromKey && task.dueDate <= toKey).sort(taskSort); }
function visibleTasks() { return rangeTasks(today(), addDays(today(), 30)); }
function getTaskById(id) { return state.tasks.find(task => task.id === id) || visibleTasks().find(task => task.id === id); }

function render() {
  document.querySelector('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">S</span><span>Silico</span></div>
        <button class="add-task-button" data-action="focus-capture"><span>＋</span> Add task <kbd>Q</kbd></button>
        <nav class="nav primary">
          ${navItem('today', 'Today', 'today', countToday())}
          ${navItem('upcoming', 'Upcoming', 'calendar', countUpcoming())}
          ${navItem('calendar', 'Calendar', 'grid', '')}
          ${navItem('inbox', 'Inbox', 'inbox', countInbox())}
        </nav>
        <div class="sidebar-section"><div class="section-label">Workspace <button class="tiny-button">＋</button></div>
          ${navItem('classes', 'Classes', 'book', '')}
          ${navItem('projects', 'Projects', 'folder', '')}
        </div>
        <div class="sidebar-bottom">${navItem('settings', 'Settings', 'settings', '')}<div class="profile-chip"><span class="avatar">${escapeHtml((currentUser?.firstName || currentUser?.emailAddresses?.[0]?.emailAddress || 'H').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(currentUser?.firstName || 'Personal space')}</strong><small>${escapeHtml(currentUser?.emailAddresses?.[0]?.emailAddress || 'Local workspace')}</small></span><button class="dots" data-action="sign-out" title="Sign out">↗</button></div></div>
      </aside>
      <main class="main"><header class="topbar"><button class="mobile-menu" data-action="toggle-sidebar">☰</button><div class="breadcrumbs">${viewLabel()}</div><div class="top-actions"><button class="icon-button" aria-label="Search" data-action="search">⌕</button><button class="icon-button" aria-label="Notifications">♧</button><button class="avatar small">H</button></div></header>
        <div class="content"><div class="content-header"><div><div class="eyebrow">${view === 'today' ? formatDate(today(), { weekday: 'long' }) : 'Your workspace'}</div><h1>${viewTitle()}</h1>${view === 'today' ? `<p class="subtitle">${formatLongDate(today())}</p>` : ''}</div><div class="header-actions">${view === 'calendar' ? '<button class="secondary-button" data-action="calendar-today">Today</button>' : ''}<button class="secondary-button" data-action="focus-capture">＋ Task</button></div></div>
        ${view === 'today' ? renderProgressSummary() : ''}
        ${view === 'settings' ? renderSettings() : view === 'classes' ? renderClasses() : view === 'projects' ? renderProjects() : renderTaskView()}
        </div>
      </main>
      ${selectedTaskId ? renderTaskDrawer() : ''}
    </div>`;
  bindEvents();
}

function navItem(key, label, icon, count) { return `<button class="nav-item ${view === key ? 'active' : ''}" data-view="${key}"><span class="nav-icon icon-${icon}"></span><span>${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`; }
function viewLabel() { return view === 'today' ? 'My tasks' : view[0].toUpperCase() + view.slice(1); }
function viewTitle() { return ({ today: 'Today', upcoming: 'Upcoming', calendar: 'Calendar', inbox: 'Inbox', classes: 'Classes', projects: 'Projects', settings: 'Settings' })[view] || 'Today'; }
function countToday() { return tasksForDate(today()).filter(t => t.status !== 'completed').length; }
function countUpcoming() { return rangeTasks(today(), addDays(today(), 30)).filter(t => t.dueDate > today() && t.status !== 'completed').length; }
function countInbox() { return state.tasks.filter(t => !t.project && !t.className && t.status !== 'completed').length; }
function renderProgressSummary() { const gamification = state.profile.gamification || {}; const todayTasks = tasksForDate(today()); const completed = todayTasks.filter(task => task.status === 'completed').length; return `<div class="progress-summary"><div><strong>${completed}/${todayTasks.length || 0}</strong><span>planned today</span></div><div><strong>🔥 ${gamification.currentStreak || 0}</strong><span>day streak</span></div><div><strong>Level ${gamificationLevel(gamification.xp)}</strong><span>${gamification.xp || 0} XP</span></div></div>`; }

function renderTaskView() {
  const capture = `<form class="capture" id="capture-form"><span class="capture-plus">＋</span><input id="capture-input" value="${escapeHtml(captureValue)}" placeholder="Add a task or ask Silico anything…" autocomplete="off"/><span class="capture-hint">Press <kbd>↵</kbd></span></form>`;
  if (view === 'calendar') return `${capture}${renderCalendar()}`;
  if (view === 'upcoming') return `${capture}${renderUpcoming()}`;
  const date = view === 'today' ? today() : null;
  const baseTasks = view === 'today' ? tasksForDate(date) : view === 'inbox' ? visibleTasks().filter(t => !t.project && !t.className).sort(taskSort) : visibleTasks();
  const tasks = searchTerm ? baseTasks.filter(task => `${task.title} ${task.description} ${task.className || ''} ${task.project || ''}`.toLowerCase().includes(searchTerm.toLowerCase())) : baseTasks;
  const open = tasks.filter(t => t.status !== 'completed');
  const done = tasks.filter(t => t.status === 'completed');
  return `${capture}<section class="task-section"><div class="section-heading"><span>${searchTerm ? `Search results for “${escapeHtml(searchTerm)}”` : view === 'today' ? 'Up next' : 'Tasks'}</span><span class="muted">${open.length} ${open.length === 1 ? 'task' : 'tasks'}</span></div>${open.length ? open.map(renderTaskRow).join('') : emptyState()}${done.length ? `<div class="section-heading completed-heading"><span>Completed</span><span class="muted">${done.length}</span></div>${done.map(renderTaskRow).join('')}` : ''}</section>`;
}

function renderTaskRow(task) { return `<div class="task-row ${task.status === 'completed' ? 'is-complete' : ''} ${isOverdue(task) ? 'is-overdue' : ''}" data-task-id="${task.id}"><button class="checkbox priority-${task.priority || 1} ${task.status === 'completed' ? 'checked' : ''}" data-action="toggle-task" data-id="${task.id}" aria-label="${task.status === 'completed' ? 'Restore' : 'Complete'} ${escapeHtml(task.title)}">${task.status === 'completed' ? '✓' : ''}</button><div class="task-main"><button class="task-title" data-action="open-task" data-id="${task.id}">${escapeHtml(task.title)}</button><div class="task-meta">${task.dueTime ? `<span>${formatTime(task.dueTime)}</span>` : task.dueDate ? `<span>${formatDate(task.dueDate)}</span>` : ''}${task.duration ? `<span>· ${task.duration} min</span>` : ''}${task.className ? `<span class="tag">${escapeHtml(task.className)}</span>` : ''}${task.type === 'study_session' ? '<span class="study-tag">Study</span>' : ''}${task.type === 'fixed_event' ? '<span class="event-tag">Event</span>' : ''}${task.recurrence ? '<span class="recurrence">↻</span>' : ''}</div></div><button class="row-more" data-action="open-task" data-id="${task.id}">···</button></div>`; }
function emptyState() { return `<div class="empty-state"><div class="empty-icon">✓</div><h3>Clear space, clear mind</h3><p>Nothing else is scheduled here.</p></div>`; }

function renderUpcoming() {
  const groups = {};
  rangeTasks(today(), addDays(today(), 30)).forEach(task => { (groups[task.dueDate] ||= []).push(task); });
  return `<section class="upcoming-list">${Object.keys(groups).length ? Object.entries(groups).map(([date, tasks]) => `<div class="date-group"><div class="date-label"><strong>${date === today() ? 'TODAY' : formatDate(date, { weekday: 'short', month: 'long', day: 'numeric' }).toUpperCase()}</strong><span>${tasks.length}</span></div>${tasks.map(renderTaskRow).join('')}</div>`).join('') : emptyState()}</section>`;
}

function renderCalendar() {
  const start = new Date(calendarCursor); const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(); const offset = start.getDay();
  let cells = Array.from({ length: offset }, () => '<div class="calendar-cell muted-cell"></div>');
  for (let day = 1; day <= days; day += 1) { const key = toDateKey(new Date(start.getFullYear(), start.getMonth(), day)); const items = tasksForDate(key); cells.push(`<div class="calendar-cell ${key === today() ? 'today-cell' : ''}"><div class="calendar-day">${day}</div>${items.slice(0, 3).map(t => `<button class="calendar-task ${t.type === 'study_session' ? 'study-calendar' : ''} ${t.type === 'fixed_event' ? 'event-calendar' : ''}" data-action="open-task" data-id="${t.id}">${escapeHtml(t.title)}</button>`).join('')}${items.length > 3 ? `<span class="more-items">+${items.length - 3} more</span>` : ''}</div>`); }
  return `<div class="calendar"><div class="calendar-toolbar"><button class="icon-button" data-action="calendar-prev">‹</button><strong>${start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong><button class="icon-button" data-action="calendar-next">›</button></div><div class="calendar-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<span>${day}</span>`).join('')}</div><div class="calendar-grid">${cells.join('')}</div></div>`;
}

function renderClasses() { return `<div class="cards-grid">${state.classes.map((name, index) => { const tasks = state.tasks.filter(t => t.className === name && t.status !== 'completed'); return `<div class="class-card"><div class="class-color color-${index % 5}"></div><div class="class-card-top"><span class="class-icon">${name.slice(0, 1)}</span><button class="row-more">···</button></div><h3>${name}</h3><p>${tasks.length ? `${tasks.length} open task${tasks.length === 1 ? '' : 's'}` : 'No open tasks'}</p><div class="progress"><span style="width:${Math.min(100, tasks.length ? 24 : 100)}%"></span></div></div>`; }).join('')}<button class="add-card">＋ <span>Add class</span></button></div>`; }
function renderProjects() { return `<div class="cards-grid projects-grid">${state.projects.map((name, index) => { const tasks = state.tasks.filter(t => t.project === name && t.status !== 'completed'); return `<div class="project-card"><div class="project-icon icon-folder"></div><div><h3>${name}</h3><p>${tasks.length} open task${tasks.length === 1 ? '' : 's'}</p></div><span class="project-dot dot-${index % 4}"></span></div>`; }).join('')}<button class="add-card">＋ <span>Add project</span></button></div>`; }

function renderSettings() {
  const classRows = state.classes.map(name => { const preference = state.profile.classPreferences?.[name] || defaultClassPreference(); return `<div class="class-preference"><strong>${escapeHtml(name)}</strong><label>Sessions/week<input class="class-pref-sessions" data-class="${escapeHtml(name)}" type="number" min="0" max="14" value="${preference.sessionsPerWeek ?? 2}"/></label><label>Session length<select class="class-pref-length" data-class="${escapeHtml(name)}"><option value="30" ${preference.sessionLength === 30 ? 'selected' : ''}>30 min</option><option value="45" ${(!preference.sessionLength || preference.sessionLength === 45) ? 'selected' : ''}>45 min</option><option value="60" ${preference.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label></div>`; }).join('');
  const managedClasses = state.classes.map(name => `<div class="class-management-row"><input class="class-name-edit" data-original-class="${escapeHtml(name)}" value="${escapeHtml(name)}"/><button class="danger-button" type="button" data-action="remove-class" data-class="${escapeHtml(name)}">Remove</button></div>`).join('');
  return `<div class="settings-layout"><section class="settings-section"><div class="settings-title"><h2>Study preferences</h2><p>Silico uses these preferences to place realistic study sessions around your commitments.</p></div><label>Default session length<select id="session-length"><option value="30" ${state.profile.sessionLength === 30 ? 'selected' : ''}>30 minutes</option><option value="45" ${state.profile.sessionLength === 45 ? 'selected' : ''}>45 minutes</option><option value="60" ${state.profile.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label><label>Sessions per assessment<input id="sessions-per-assessment" type="number" min="1" max="5" value="${state.profile.sessionsPerAssessment}"/></label><div class="settings-row"><label>Study window starts<input id="preferred-start" type="time" value="${state.profile.preferredStart}"/></label><label>Latest study time<input id="latest-study" type="time" value="${state.profile.latestStudyTime}"/></label></div><button class="primary-button" type="button" data-action="save-settings">Save preferences</button></section><section class="settings-section class-management"><div class="settings-title"><h2>Manage classes</h2><p>Add or rename classes anytime. Existing tasks keep their class when you rename it.</p></div>${managedClasses || '<p class="muted">No classes yet.</p>'}<div class="class-add-row"><input id="new-class-name" placeholder="Add a class" maxlength="80"/><button class="secondary-button" type="button" data-action="add-class">Add class</button></div><button class="primary-button" type="button" data-action="save-classes">Save class changes</button></section><section class="settings-section"><div class="settings-title"><h2>Class allocation</h2><p>Give each class its own rhythm. Silico uses these values when planning around an assessment.</p></div><div class="class-preference-list">${classRows || '<p class="muted">Add a class to set its study allocation.</p>'}</div><button class="secondary-button" type="button" data-action="save-settings">Save class allocation</button></section><section class="settings-section"><div class="settings-title"><h2>Scheduling boundaries</h2><p>These hard boundaries are always respected by the scheduler.</p></div><div class="settings-row"><label>School starts<input id="school-start" type="time" value="${state.profile.schoolStart || '08:00'}"/></label><label>School ends<input id="school-end" type="time" value="${state.profile.schoolEnd || '16:00'}"/></label></div><div class="weekday-picker"><span>School days</span>${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['0','Sun']].map(([value,label]) => `<label class="check-label"><input class="school-day" type="checkbox" value="${value}" ${(state.profile.schoolDays || [1,2,3,4,5]).includes(Number(value)) ? 'checked' : ''}/> ${label}</label>`).join('')}</div><div class="boundary-row"><span class="boundary-icon">◷</span><div><strong>Timezone</strong><small>${Intl.DateTimeFormat().resolvedOptions().timeZone}</small></div></div><button class="primary-button" type="button" data-action="save-settings">Save boundaries</button></section><section class="settings-section danger-zone"><div class="settings-title"><h2>Workspace data</h2><p>Reset the local demo workspace or remove every task and derived occurrence.</p></div><div class="header-actions"><button class="danger-button" type="button" data-action="delete-all">Delete all tasks</button><button class="secondary-button" type="button" data-action="reset-data">Reset demo</button></div></section></div>`;
}

function renderAuth() {
  document.querySelector('#app').innerHTML = `<main class="auth-shell"><div class="auth-copy"><div class="brand"><span class="brand-mark">S</span><span>Silico</span></div><div class="auth-message"><span class="eyebrow">Make time for what matters</span><h1>Your day, with a little more room to breathe.</h1><p>One calm place for tasks, commitments, and the study sessions that make deadlines feel manageable.</p></div><small class="auth-footnote">Secure sign-in powered by Clerk · ${platformStatus.supabaseConfigured ? 'Supabase database connected' : 'Demo workspace'}</small></div><div class="auth-card">${clerk ? '<div id="auth-mount"></div>' : '<div class="auth-unavailable"><h2>Sign-in is unavailable</h2><p>Silico could not load Clerk. Refresh the page or check the authentication configuration.</p></div>'}</div></main>`;
  if (clerk) {
    try {
      clerk.mountSignIn(document.querySelector('#auth-mount'), { appearance: { variables: { colorPrimary: '#5967c7', borderRadius: '7px' } } });
    } catch {
      document.querySelector('#auth-mount').innerHTML = '<div class="auth-unavailable"><h2>Sign-in is unavailable</h2><p>Clerk loaded without its UI module. Check the Clerk domain configuration and refresh the page.</p></div>';
    }
  }
}

function renderOnboarding() {
  const classFields = state.classes.map(name => { const preference = state.profile.classPreferences?.[name] || defaultClassPreference(); return `<div class="class-preference"><strong>${escapeHtml(name)}</strong><label>Sessions/week<input class="onboarding-class-sessions" data-class="${escapeHtml(name)}" type="number" min="0" max="14" value="${preference.sessionsPerWeek ?? 2}"/></label><label>Length<select class="onboarding-class-length" data-class="${escapeHtml(name)}"><option value="30" ${preference.sessionLength === 30 ? 'selected' : ''}>30 min</option><option value="45" ${(!preference.sessionLength || preference.sessionLength === 45) ? 'selected' : ''}>45 min</option><option value="60" ${preference.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label></div>`; }).join('');
  document.querySelector('#app').innerHTML = `<main class="onboarding-shell"><div class="onboarding-card"><div class="brand"><span class="brand-mark">S</span><span>Silico</span></div><div class="eyebrow">A few preferences first</div><h1>Make study time fit your life.</h1><p class="onboarding-copy">Silico uses these defaults to place realistic study sessions around your commitments. You can change them anytime.</p><form id="onboarding-form"><label>How long should a typical study session be?<select id="onboarding-length"><option value="30" ${state.profile.sessionLength === 30 ? 'selected' : ''}>30 minutes</option><option value="45" ${(!state.profile.sessionLength || state.profile.sessionLength === 45) ? 'selected' : ''}>45 minutes</option><option value="60" ${state.profile.sessionLength === 60 ? 'selected' : ''}>1 hour</option></select></label><label>How many sessions per week should Silico aim for?<input id="onboarding-weekly" type="number" min="0" max="14" value="${state.profile.sessionsPerWeek ?? 2}"/></label><div class="settings-row"><label>Study window starts<input id="onboarding-start" type="time" value="${state.profile.preferredStart || '16:30'}"/></label><label>Latest study time<input id="onboarding-latest" type="time" value="${state.profile.latestStudyTime || '21:00'}"/></label></div><div class="settings-row"><label>School starts<input id="onboarding-school-start" type="time" value="${state.profile.schoolStart || '08:00'}"/></label><label>School ends<input id="onboarding-school-end" type="time" value="${state.profile.schoolEnd || '16:00'}"/></label></div><div class="weekday-picker"><span>School days</span>${[['1','Mon'],['2','Tue'],['3','Wed'],['4','Thu'],['5','Fri'],['6','Sat'],['0','Sun']].map(([value,label]) => `<label class="check-label"><input class="onboarding-school-day" type="checkbox" value="${value}" ${(state.profile.schoolDays || [1,2,3,4,5]).includes(Number(value)) ? 'checked' : ''}/> ${label}</label>`).join('')}</div><fieldset><legend>Class allocation</legend><div id="onboarding-class-list" class="class-preference-list">${classFields || '<p class="muted">Add your first class below.</p>'}</div><div class="class-add-row"><input id="onboarding-class-name" placeholder="Add a class" maxlength="80"/><button class="secondary-button" type="button" data-action="add-onboarding-class">Add class</button></div></fieldset><fieldset><legend>Methods you enjoy</legend><label class="check-label"><input type="checkbox" value="Review notes" ${state.profile.methods?.includes('Review notes') ? 'checked' : ''}/> Review notes</label><label class="check-label"><input type="checkbox" value="Practice problems" ${state.profile.methods?.includes('Practice problems') ? 'checked' : ''}/> Practice problems</label><label class="check-label"><input type="checkbox" value="Flashcards" ${state.profile.methods?.includes('Flashcards') ? 'checked' : ''}/> Flashcards</label><label class="check-label"><input type="checkbox" value="Reading" ${state.profile.methods?.includes('Reading') ? 'checked' : ''}/> Reading</label></fieldset><button class="primary-button" type="button" data-action="complete-onboarding">Continue to Silico <span>→</span></button></form></div></main>`;
  document.querySelector('#onboarding-form')?.addEventListener('submit', event => event.preventDefault());
  bindEvents();
}

function renderTaskDrawer() { const task = getTaskById(selectedTaskId); if (!task) return ''; const recurrenceText = task.recurrence ? `every ${task.recurrence.frequency === 'daily' ? 'day' : task.recurrence.frequency === 'monthly' ? 'month' : 'week'}` : ''; const classOptions = [...new Set([task.className, ...state.classes].filter(Boolean))].map(name => `<option value="${escapeHtml(name)}" ${task.className === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join(''); return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="task-drawer"><div class="drawer-header"><span>Task details</span><button class="icon-button" data-action="close-drawer">×</button></div><input class="drawer-title" id="drawer-title" value="${escapeHtml(task.title)}"/><div class="drawer-fields"><label>Due date<input id="drawer-date" type="date" value="${task.dueDate || ''}"/></label><label>Time<input id="drawer-time" type="time" value="${task.dueTime || ''}"/></label><label>Duration<select id="drawer-duration"><option ${task.duration === 30 ? 'selected' : ''}>30</option><option ${task.duration === 45 ? 'selected' : ''}>45</option><option ${task.duration === 60 ? 'selected' : ''}>60</option><option ${task.duration === 90 ? 'selected' : ''}>90</option></select></label><label>Priority<select id="drawer-priority"><option value="1" ${task.priority === 1 ? 'selected' : ''}>Normal</option><option value="2" ${task.priority === 2 ? 'selected' : ''}>High</option><option value="3" ${task.priority === 3 ? 'selected' : ''}>Urgent</option><option value="4" ${task.priority === 4 ? 'selected' : ''}>Critical</option></select></label><label>Class<select id="drawer-class"><option value="">No class</option>${classOptions}</select></label><label>Project<input id="drawer-project" value="${escapeHtml(task.project || '')}" placeholder="e.g. Homework"/></label><label>Recurrence<input id="drawer-recurrence" value="${escapeHtml(recurrenceText)}" placeholder="e.g. every Monday"/></label></div><textarea id="drawer-description" placeholder="Add a description…">${escapeHtml(task.description || '')}</textarea><div class="drawer-footer"><button class="danger-button" type="button" data-action="delete-task" data-id="${task.id}">Delete</button><button class="primary-button" type="button" data-action="save-task" data-id="${task.id}">Save</button></div></aside>`; }

function elClassName(id) { return document.querySelector(`[data-action="remove-class"][data-class="${CSS.escape(id || '')}"]`)?.dataset.class || id; }
function saveClassNames() {
  const rows = [...document.querySelectorAll('.class-name-edit')];
  const renames = new Map();
  const names = [];
  for (const row of rows) {
    const original = row.dataset.originalClass;
    const name = normalizeClassName(row.value);
    if (!name || names.some(item => item.toLowerCase() === name.toLowerCase())) { showToast('Class names must be unique and cannot be empty.'); return; }
    names.push(name);
    if (original !== name) renames.set(original, name);
  }
  state.tasks.forEach(task => { if (renames.has(task.className)) task.className = renames.get(task.className); });
  const preferences = {};
  names.forEach(name => {
    const original = [...renames.entries()].find(([, next]) => next === name)?.[0] || name;
    preferences[name] = state.profile.classPreferences?.[original] || defaultClassPreference();
  });
  state.classes = names;
  state.profile.classPreferences = preferences;
  saveState();
  persistProfile();
  render();
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => { view = el.dataset.view; location.hash = view; selectedTaskId = null; render(); }));
  document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.action, el.dataset.id || el.dataset.class)));
  const form = document.querySelector('#capture-form');
  form?.addEventListener('submit', event => { event.preventDefault(); captureValue = document.querySelector('#capture-input').value; handleCapture(captureValue); });
  document.querySelector('#capture-input')?.addEventListener('input', event => { captureValue = event.target.value; });
}

function handleAction(action, id) {
  if (action === 'focus-capture') { document.querySelector('#capture-input')?.focus(); return; }
  if (action === 'toggle-sidebar') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }
  if (action === 'search') { const query = window.prompt('Search tasks'); if (query?.trim()) { searchTerm = query.trim(); view = 'inbox'; location.hash = view; render(); } return; }
  if (action === 'calendar-prev') { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1); render(); return; }
  if (action === 'calendar-next') { calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1); render(); return; }
  if (action === 'calendar-today') { calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); render(); return; }
  if (action === 'open-task') { selectedTaskId = id; render(); return; }
  if (action === 'close-drawer') { selectedTaskId = null; render(); return; }
  if (action === 'toggle-task') { const task = getTaskById(id); if (task?.occurrenceKey) { state.occurrenceCompletions ||= {}; const completed = task.status !== 'completed'; if (completed) { state.occurrenceCompletions[task.occurrenceKey] = new Date().toISOString(); state.profile.gamification = recordCompletion(state.profile.gamification, task); } else delete state.occurrenceCompletions[task.occurrenceKey]; saveState(); persistProfile(); repository?.setOccurrence(task.recurrenceSourceId, task.dueDate, completed).catch(() => showToast('Could not sync this occurrence. It is saved locally.')); render(); return; } if (task) { task.status = task.status === 'completed' ? 'open' : 'completed'; task.completedAt = task.status === 'completed' ? new Date().toISOString() : null; task.updatedAt = new Date().toISOString(); if (task.status === 'completed') state.profile.gamification = recordCompletion(state.profile.gamification, task, new Date(task.completedAt)); saveState(); persistProfile(); repository?.update(task).catch(() => showToast('Could not sync this task. It is saved locally.')); render(); } return; }
  if (action === 'delete-task') { const baseId = id?.includes('::') ? id.split('::')[0] : id; state.tasks = state.tasks.filter(t => t.id !== baseId); selectedTaskId = null; saveState(); repository?.remove(baseId).catch(() => showToast('Could not sync deletion. It is removed locally.')); render(); return; }
  if (action === 'save-task') { saveDrawerTask(id); return; }
  if (action === 'add-onboarding-class') { collectOnboardingClassPreferences(); const input = document.querySelector('#onboarding-class-name'); const name = normalizeClassName(input?.value); if (!name) return; if (state.classes.some(item => item.toLowerCase() === name.toLowerCase())) { showToast('That class already exists.'); return; } state.classes.push(name); state.profile.classPreferences ||= {}; state.profile.classPreferences[name] ||= defaultClassPreference(); renderOnboarding(); return; }
  if (action === 'add-class') { const input = document.querySelector('#new-class-name'); const name = normalizeClassName(input?.value); if (!name) return; if (state.classes.some(item => item.toLowerCase() === name.toLowerCase())) { showToast('That class already exists.'); return; } state.classes.push(name); state.profile.classPreferences ||= {}; state.profile.classPreferences[name] ||= defaultClassPreference(); saveState(); persistProfile(); render(); return; }
  if (action === 'remove-class') { const name = elClassName(id); if (!name || !confirm(`Remove ${name} from your classes? Tasks will lose this class label.`)) return; state.classes = state.classes.filter(item => item !== name); state.tasks.forEach(task => { if (task.className === name) task.className = null; }); delete state.profile.classPreferences?.[name]; saveState(); persistProfile(); render(); return; }
  if (action === 'save-classes') { saveClassNames(); return; }
  if (action === 'save-settings') { state.profile.sessionLength = Number(document.querySelector('#session-length')?.value || state.profile.sessionLength); state.profile.sessionsPerAssessment = Math.max(1, Math.min(5, Number(document.querySelector('#sessions-per-assessment')?.value || state.profile.sessionsPerAssessment))); state.profile.preferredStart = document.querySelector('#preferred-start')?.value || state.profile.preferredStart; state.profile.latestStudyTime = document.querySelector('#latest-study')?.value || state.profile.latestStudyTime; state.profile.schoolStart = document.querySelector('#school-start')?.value || state.profile.schoolStart; state.profile.schoolEnd = document.querySelector('#school-end')?.value || state.profile.schoolEnd; const selectedDays = [...document.querySelectorAll('.school-day:checked')].map(input => Number(input.value)); if (selectedDays.length) state.profile.schoolDays = selectedDays; state.profile.classPreferences ||= {}; document.querySelectorAll('.class-pref-sessions').forEach(input => { state.profile.classPreferences[input.dataset.class] ||= defaultClassPreference(); state.profile.classPreferences[input.dataset.class].sessionsPerWeek = Math.max(0, Math.min(14, Number(input.value) || 0)); }); document.querySelectorAll('.class-pref-length').forEach(input => { state.profile.classPreferences[input.dataset.class] ||= defaultClassPreference(); state.profile.classPreferences[input.dataset.class].sessionLength = Number(input.value); }); saveState(); persistProfile(); render(); return; }
  if (action === 'complete-onboarding') { collectOnboardingClassPreferences(); const weekly = Math.max(0, Math.min(14, Number(document.querySelector('#onboarding-weekly').value) || 0)); const selectedDays = [...document.querySelectorAll('.onboarding-school-day:checked')].map(input => Number(input.value)); state.profile = { ...state.profile, onboardingComplete: true, sessionLength: Number(document.querySelector('#onboarding-length').value), sessionsPerWeek: weekly, sessionsPerAssessment: Math.max(1, Math.min(5, weekly || 2)), preferredStart: document.querySelector('#onboarding-start').value, latestStudyTime: document.querySelector('#onboarding-latest').value, schoolStart: document.querySelector('#onboarding-school-start').value, schoolEnd: document.querySelector('#onboarding-school-end').value, schoolDays: selectedDays.length ? selectedDays : [1, 2, 3, 4, 5], methods: [...document.querySelectorAll('#onboarding-form input[type="checkbox"]:checked')].filter(input => !input.classList.contains('onboarding-school-day')).map(input => input.value) }; saveState(); persistProfile(); render(); return; }
  if (action === 'sign-out') { clerk?.signOut().then(() => { currentUser = null; renderAuth(); }); return; }
  if (action === 'reset-data' && confirm('Reset this local workspace?')) { state = seedState(); saveState(); render(); }
  if (action === 'delete-all' && confirm('Delete every task in this workspace? This cannot be undone.')) { state.tasks = []; state.occurrenceCompletions = {}; saveState(); repository?.removeAll().catch(() => showToast('Could not sync the delete-all operation. Local data was cleared.')); render(); }
}

function saveDrawerTask(id) { const task = state.tasks.find(t => t.id === id) || state.tasks.find(item => item.id === id.split('::')[0]); if (!task) return; const recurrenceText = document.querySelector('#drawer-recurrence').value.trim(); Object.assign(task, { title: document.querySelector('#drawer-title').value.trim() || 'Untitled task', dueDate: document.querySelector('#drawer-date').value || null, dueTime: document.querySelector('#drawer-time').value || null, duration: Number(document.querySelector('#drawer-duration').value), priority: Number(document.querySelector('#drawer-priority').value), className: document.querySelector('#drawer-class').value || null, project: document.querySelector('#drawer-project').value.trim() || null, recurrence: recurrenceText ? recurrenceFromText(recurrenceText) : null, description: document.querySelector('#drawer-description').value, updatedAt: new Date().toISOString() }); selectedTaskId = null; saveState(); repository?.update(task).catch(() => showToast('Could not sync this edit. It is saved locally.')); render(); }

async function handleCapture(input) {
  if (!input.trim()) return;
  const command = await parseCaptureCommand(input);
  if ([INTENTS.QUERY_FREE_TIME, INTENTS.QUERY_RECOMMENDATION, INTENTS.QUERY_TODAY, INTENTS.QUERY_UPCOMING].includes(command.intent)) { captureValue = ''; view = command.intent === INTENTS.QUERY_UPCOMING ? 'upcoming' : 'today'; location.hash = view; render(); showToast(command.warning || (command.intent === INTENTS.QUERY_TODAY || command.intent === INTENTS.QUERY_UPCOMING ? 'Here’s what is on your schedule.' : recommendation(command.duration))); return; }
  if ([INTENTS.EDIT_TASK, INTENTS.DELETE_TASK, INTENTS.COMPLETE_TASK, INTENTS.RESCHEDULE_TASK].includes(command.intent)) { handleTaskCommand(command); return; }
  const isAssessment = command.intent === INTENTS.CREATE_ASSESSMENT;
  const idempotencyKey = isAssessment ? assessmentIdempotencyKey(command) : null;
  if (idempotencyKey && state.tasks.some(item => item.idempotencyKey === idempotencyKey)) { captureValue = ''; render(); showToast('That assessment is already on your schedule.'); return; }
  const task = makeTask(command, { source: 'capture', idempotencyKey });
  if (isAssessment) task.type = 'assessment';
  state.tasks.push(task);
  let persistenceWarning = false;
  if (repository) {
    const createdAssessment = await repository.create(task).catch(() => { persistenceWarning = true; return task; });
    Object.assign(task, createdAssessment);
  }
  const sessions = isAssessment ? planStudySessions(task, state.tasks, state.profile) : [];
  state.tasks.push(...sessions);
  const createdSessions = await Promise.all(sessions.map(item => repository ? repository.create(item).catch(() => { persistenceWarning = true; return item; }) : item));
  sessions.forEach((item, index) => Object.assign(item, createdSessions[index]));
  captureValue = ''; saveState(); view = task.dueDate === today() || !task.dueDate ? 'today' : 'upcoming'; render(); showToast(command.warning || (persistenceWarning ? 'Saved locally. Database sync is unavailable.' : command.intent === INTENTS.CREATE_ASSESSMENT && !sessions.length ? 'Assessment added, but no open study slot was available.' : command.intent === INTENTS.CREATE_ASSESSMENT ? 'Assessment added and study sessions scheduled.' : 'Task added.'));
}

function findTaskForCommand(title) {
  const words = title.toLowerCase().replace(/\b(my|the|task|to)\b/g, '').split(/\s+/).filter(Boolean);
  return state.tasks.filter(task => task.status !== 'completed' || commandCanRestore(title)).sort(taskSort).find(task => words.every(word => task.title.toLowerCase().includes(word)));
}

function commandCanRestore(title) { return /restore|uncomplete|not done/.test(title.toLowerCase()); }

function handleTaskCommand(command) {
  const task = findTaskForCommand(command.title || '');
  if (!task) { captureValue = ''; render(); showToast('I couldn’t find a matching task. Try the task name again.'); return; }
  if (command.intent === INTENTS.DELETE_TASK) { state.tasks = state.tasks.filter(item => item.id !== task.id); repository?.remove(task.id).catch(() => showToast('Could not sync deletion. It is removed locally.')); }
  if (command.intent === INTENTS.COMPLETE_TASK) { task.status = 'completed'; task.completedAt = new Date().toISOString(); repository?.update(task).catch(() => showToast('Could not sync completion. It is saved locally.')); }
  if (command.intent === INTENTS.RESCHEDULE_TASK) { task.dueDate = command.dueDate || task.dueDate; task.dueTime = command.dueTime || task.dueTime; task.updatedAt = new Date().toISOString(); repository?.update(task).catch(() => showToast('Could not sync rescheduling. It is saved locally.')); }
  if (command.intent === INTENTS.EDIT_TASK) { selectedTaskId = task.id; render(); showToast('Task opened for editing.'); return; }
  captureValue = ''; saveState(); render(); showToast(command.intent === INTENTS.DELETE_TASK ? 'Task deleted.' : command.intent === INTENTS.COMPLETE_TASK ? 'Task completed.' : 'Task rescheduled.');
}

function recommendation(duration) { const fit = rankRecommendations(state.tasks, new Date(), duration || Infinity)[0]; return fit ? `Try “${fit.title}” — it fits your ${duration || fit.duration}-minute window.` : 'You have some open space. Add a task and Silico will help place it.'; }
function showToast(message) { const toast = document.createElement('div'); toast.className = 'toast'; toast.textContent = message; document.body.appendChild(toast); setTimeout(() => toast.remove(), 2600); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

window.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'q' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); document.querySelector('#capture-input')?.focus(); } if (event.key === 'Escape' && selectedTaskId) { selectedTaskId = null; render(); } });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (views.has(next)) { view = next; selectedTaskId = null; render(); } });

async function bootstrap() {
  if (platformStatus.clerkConfigured && !clerk) { renderAuth(); return; }
  if (clerk) {
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    currentUser = clerk.user;
    clerk.addListener(({ user }) => { if (user && user.id !== currentUser?.id) { currentUser = user; repository = createTaskRepository(); state = loadState(); if (state.profile.onboardingComplete === false) renderOnboarding(); else render(); } });
    if (!currentUser) { renderAuth(); return; }
  }
  repository = currentUser ? createTaskRepository() : null;
  state = loadState();
  normalizeState();
  if (repository) { try { state.tasks = await repository.load(); const remoteProfile = await repository.loadProfile(); const remoteSettings = remoteProfile?.profile?.settings; if (remoteSettings && typeof remoteSettings === 'object') { const { classes: remoteClasses, ...profileSettings } = remoteSettings; state.profile = { ...state.profile, ...profileSettings, onboardingComplete: Boolean(remoteProfile.profile.onboarding_complete), classPreferences: { ...state.profile.classPreferences, ...(profileSettings.classPreferences || {}) } }; if (Array.isArray(remoteClasses)) state.classes = remoteClasses.filter(name => typeof name === 'string' && name.trim()).map(normalizeClassName); } saveState(); } catch { /* local fallback remains available until server secrets are configured */ } }
  if (currentUser && state.profile.onboardingComplete === false) { renderOnboarding(); return; }
  render();
}

bootstrap().catch(() => renderAuth());
