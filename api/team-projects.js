import { createHash, randomBytes } from 'node:crypto';
import { ensureProfile, requireClerkUser, supabaseRequest, supabaseStorageRequest, json } from './_auth.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(\d{1,2}):(\d{2})$/;
const maxFileBytes = 4 * 1024 * 1024;

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') { try { return JSON.parse(request.body); } catch { return {}; } }
  return {};
}

function queryParams(request) {
  if (request.query && typeof request.query === 'object') return request.query;
  return Object.fromEntries(new URL(request.url || 'http://localhost').searchParams.entries());
}

function hashCode(code) { return createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex'); }
function newJoinCode() { return randomBytes(6).toString('hex').toUpperCase(); }
function validUuid(value) { return typeof value === 'string' && uuidPattern.test(value); }
function validDate(value) { return typeof value === 'string' && datePattern.test(value); }
function memberDisplayName(auth, requestedEmail = '') {
  const email = [auth.claims?.email, auth.claims?.email_address, auth.claims?.emailAddress, requestedEmail].find(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
  return String(email || auth.claims?.name || auth.claims?.username || auth.userId).trim().slice(0, 320);
}

function normalizeTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).trim().match(timePattern);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('Time is invalid');
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}:00`;
}

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120) throw new Error('Team project name is invalid');
  return name;
}

function normalizeSubprojectName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120) throw new Error('Team subproject name is invalid');
  return name;
}

async function assertUniqueProjectName(userId, name, excludeProjectId = null) {
  const [memberships, ownedProjects] = await Promise.all([
    supabaseRequest(`team_project_members?user_id=eq.${encodeURIComponent(userId)}&select=team_project_id`),
    supabaseRequest(`team_projects?owner_id=eq.${encodeURIComponent(userId)}&select=id`)
  ]);
  const ids = [...new Set([...(memberships || []).map(row => row.team_project_id), ...(ownedProjects || []).map(row => row.id)].filter(validUuid))].filter(id => id !== excludeProjectId);
  if (!ids.length) return;
  const projects = await supabaseRequest(`team_projects?id=in.(${ids.join(',')})&select=id,name`);
  if ((projects || []).some(project => String(project.name || '').trim().toLowerCase() === name.toLowerCase())) {
    const error = new Error('A team project with that name already exists');
    error.status = 409;
    throw error;
  }
}

function normalizeTask(input = {}) {
  const title = String(input.title || '').trim();
  if (!title || title.length > 500) throw new Error('Team task title is invalid');
  const duration = input.duration_minutes == null ? null : Number(input.duration_minutes);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) throw new Error('Team task duration is invalid');
  const priority = input.priority == null ? 1 : Number(input.priority);
  if (![1, 2, 3, 4].includes(priority)) throw new Error('Team task priority is invalid');
  if (!validDate(input.due_date)) throw new Error('Add a due date before saving a team task');
  const today = new Date().toISOString().slice(0, 10);
  if (input.due_date < today) throw new Error('That team task date is in the past; choose today or a future date');
  const subprojectId = input.subproject_id == null || input.subproject_id === '' ? null : String(input.subproject_id).trim();
  if (subprojectId && !validUuid(subprojectId)) throw new Error('Team subproject is invalid');
  const assigneeId = input.assignee_id == null || input.assignee_id === '' ? null : String(input.assignee_id).trim();
  if (assigneeId && assigneeId.length > 255) throw new Error('Team assignee is invalid');
  return { title, description: String(input.description || '').slice(0, 10000), due_date: input.due_date, due_time: normalizeTime(input.due_time), duration_minutes: duration, priority, subproject_id: subprojectId, assignee_id: assigneeId };
}

function safeFileName(value) { return String(value || '').trim().replace(/[\\/\0]/g, '_').replace(/\s+/g, ' ').slice(0, 180); }
function storagePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function fileView(row) { return { id: row.id, team_project_id: row.team_project_id, uploaded_by: row.uploaded_by, file_name: row.file_name, mime_type: row.mime_type, size_bytes: row.size_bytes, created_at: row.created_at }; }
async function signedTeamFileUrl(objectPath) {
  const result = await supabaseStorageRequest(`object/sign/team-files/${storagePath(objectPath)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
  const relative = result?.signedURL || result?.signedUrl || '';
  return relative.startsWith('http') ? relative : `${process.env.SUPABASE_URL}/storage/v1${relative}`;
}

function teamTaskCompletionState(task, completionRows = [], memberCount = 0) {
  const completedBy = new Set((Array.isArray(completionRows) ? completionRows : []).filter(row => row?.team_task_id === task?.id).map(row => row.user_id));
  const completedByAssignee = Boolean(task?.assignee_id && completedBy.has(task.assignee_id));
  return {
    completedByAssignee,
    completed: task?.assignee_id ? completedByAssignee : memberCount > 0 && completedBy.size >= memberCount,
    completionCount: completedBy.size
  };
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots) || slots.length > 28) throw new Error('Availability is invalid');
  return slots.map(slot => {
    const weekday = Number(slot?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Availability day is invalid');
    const start = normalizeTime(slot?.start)?.slice(0, 5);
    const end = normalizeTime(slot?.end)?.slice(0, 5);
    if (!start || !end || start >= end) throw new Error('Availability window is invalid');
    return { weekday, start, end };
  });
}

async function memberFor(userId, projectId) {
  if (!validUuid(projectId)) return null;
  const rows = await supabaseRequest(`team_project_members?team_project_id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}&select=team_project_id,user_id,role,display_name&limit=1`);
  if (rows?.[0]) return rows[0];
  const project = await projectFor(projectId);
  return project?.owner_id === userId ? { team_project_id: projectId, user_id: userId, role: 'owner', display_name: null } : null;
}

async function projectFor(projectId) {
  const rows = await supabaseRequest(`team_projects?id=eq.${encodeURIComponent(projectId)}&select=id,owner_id,name&limit=1`);
  return rows?.[0] || null;
}

async function assertTaskTargets(projectId, task) {
  if (task.subproject_id) {
    const rows = await supabaseRequest(`team_subprojects?id=eq.${encodeURIComponent(task.subproject_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`);
    if (!rows?.length) throw new Error('That subproject does not belong to this team');
  }
  if (task.assignee_id) {
    const rows = await supabaseRequest(`team_project_members?team_project_id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(task.assignee_id)}&select=user_id&limit=1`);
    const project = await projectFor(projectId);
    if (!rows?.length && project?.owner_id !== task.assignee_id) throw new Error('That assignee is not a member of this team');
  }
  return task;
}

async function assertUniqueSubprojectName(projectId, name, excludeSubprojectId = null) {
  const rows = await supabaseRequest(`team_subprojects?team_project_id=eq.${encodeURIComponent(projectId)}&select=id,name`);
  if ((rows || []).some(row => row.id !== excludeSubprojectId && String(row.name || '').trim().toLowerCase() === name.toLowerCase())) {
    const error = new Error('A subproject with that name already exists in this team');
    error.status = 409;
    throw error;
  }
}

async function detailFor(userId, projectId, weekStart, identityEmail = '') {
  let member = await memberFor(userId, projectId);
  if (!member) return null;
  const memberName = memberDisplayName({ userId }, identityEmail);
  if (memberName.includes('@') && member.display_name !== memberName) {
    await supabaseRequest(`team_project_members?team_project_id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ display_name: memberName }) });
    member = { ...member, display_name: memberName };
  }
  const project = await projectFor(projectId);
  if (!project) return null;
  const week = validDate(weekStart) ? weekStart : null;
  const [members, tasks, subprojects] = await Promise.all([
    supabaseRequest(`team_project_members?team_project_id=eq.${encodeURIComponent(projectId)}&select=user_id,role,display_name&order=joined_at.asc`),
    supabaseRequest(`team_tasks?team_project_id=eq.${encodeURIComponent(projectId)}&select=id,team_project_id,title,description,due_date,due_time,duration_minutes,priority,subproject_id,assignee_id,created_at,updated_at&order=due_date.asc,due_time.asc`),
    supabaseRequest(`team_subprojects?team_project_id=eq.${encodeURIComponent(projectId)}&select=id,team_project_id,name,created_by,created_at,updated_at&order=name.asc`)
  ]);
  const taskRows = (Array.isArray(tasks) ? tasks : []).filter(task => member.role === 'owner' || !task.assignee_id || task.assignee_id === userId);
  const taskIds = taskRows.map(task => task.id).filter(validUuid);
  const [completions, availability] = await Promise.all([
    taskIds.length ? supabaseRequest(`team_task_completions?team_task_id=in.(${taskIds.join(',')})&select=team_task_id,user_id,completed_at`) : Promise.resolve([]),
    week ? supabaseRequest(`team_availability?team_project_id=eq.${encodeURIComponent(projectId)}&week_start=eq.${encodeURIComponent(week)}&select=team_project_id,user_id,week_start,slots`) : Promise.resolve([])
  ]);
  const memberRows = Array.isArray(members) ? members : [];
  const memberNames = new Map(memberRows.map(row => [row.user_id, row.display_name || row.user_id]));
  const enrichedTasks = taskRows.map(task => ({ ...task, assignee_name: task.assignee_id ? memberNames.get(task.assignee_id) || task.assignee_id : null }));
  return { project, member, members: memberRows, tasks: enrichedTasks, subprojects: Array.isArray(subprojects) ? subprojects : [], completions: Array.isArray(completions) ? completions : [], availability: Array.isArray(availability) ? availability : [] };
}

async function feedFor(userId, identityEmail = '') {
  const [memberships, ownedProjects] = await Promise.all([
    supabaseRequest(`team_project_members?user_id=eq.${encodeURIComponent(userId)}&select=team_project_id,role,display_name&order=joined_at.asc`),
    supabaseRequest(`team_projects?owner_id=eq.${encodeURIComponent(userId)}&select=id,owner_id`)
  ]);
  const memberName = memberDisplayName({ userId }, identityEmail);
  if (memberName.includes('@') && Array.isArray(memberships) && memberships.some(row => row.display_name !== memberName)) {
    await supabaseRequest(`team_project_members?user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ display_name: memberName }) });
  }
  const projectIds = [...new Set([...(Array.isArray(memberships) ? memberships.map(row => row.team_project_id) : []), ...(Array.isArray(ownedProjects) ? ownedProjects.map(row => row.id) : [])].filter(validUuid))];
  if (!projectIds.length) return { tasks: [], tasks_cleared_at: {} };
  const [projects, tasks, subprojects] = await Promise.all([
    supabaseRequest(`team_projects?id=in.(${projectIds.join(',')})&select=id,owner_id,name`),
    supabaseRequest(`team_tasks?team_project_id=in.(${projectIds.join(',')})&select=id,team_project_id,title,description,due_date,due_time,duration_minutes,priority,subproject_id,assignee_id,created_at,updated_at&order=due_date.asc,due_time.asc`),
    supabaseRequest(`team_subprojects?team_project_id=in.(${projectIds.join(',')})&select=id,team_project_id,name`)
  ]);
  const projectNames = new Map((Array.isArray(projects) ? projects : []).map(project => [project.id, project.name]));
  const ownedProjectIds = new Set((Array.isArray(projects) ? projects : []).filter(project => project.owner_id === userId).map(project => project.id));
  const memberProjectIds = new Set((Array.isArray(memberships) ? memberships : []).map(row => row.team_project_id));
  const taskRows = (Array.isArray(tasks) ? tasks : []).filter(task => ownedProjectIds.has(task.team_project_id) || memberProjectIds.has(task.team_project_id) && (!task.assignee_id || task.assignee_id === userId));
  const subprojectNames = new Map((Array.isArray(subprojects) ? subprojects : []).map(subproject => [subproject.id, subproject.name]));
  const taskIds = taskRows.map(task => task.id).filter(validUuid);
  const completions = taskIds.length ? await supabaseRequest(`team_task_completions?team_task_id=in.(${taskIds.join(',')})&select=team_task_id,user_id,completed_at`) : [];
  const completionMap = new Map();
  for (const completion of completions || []) {
    const entry = completionMap.get(completion.team_task_id) || { count: 0, mine: null };
    entry.count += 1;
    if (completion.user_id === userId) entry.mine = completion.completed_at || true;
    completionMap.set(completion.team_task_id, entry);
  }
  const memberCounts = new Map();
  for (const projectId of projectIds) memberCounts.set(projectId, 0);
  const memberRows = await supabaseRequest(`team_project_members?team_project_id=in.(${projectIds.join(',')})&select=team_project_id,user_id,display_name`);
  for (const member of memberRows || []) memberCounts.set(member.team_project_id, (memberCounts.get(member.team_project_id) || 0) + 1);
  const memberNames = new Map((memberRows || []).map(member => [`${member.team_project_id}:${member.user_id}`, member.display_name || member.user_id]));
  return { tasks: taskRows.map(task => {
    const completion = completionMap.get(task.id) || { count: 0, mine: null };
    const completionState = teamTaskCompletionState(task, completions, memberCounts.get(task.team_project_id) || 0);
    return { ...task, project_name: projectNames.get(task.team_project_id) || 'Team project', subproject_name: subprojectNames.get(task.subproject_id) || null, assignee_name: task.assignee_id ? memberNames.get(`${task.team_project_id}:${task.assignee_id}`) || task.assignee_id : null, completed_by_me: Boolean(completion.mine), completed_at: typeof completion.mine === 'string' ? completion.mine : null, completed: completionState.completed, completed_by_assignee: completionState.completedByAssignee, completion_count: completionState.completionCount, member_count: memberCounts.get(task.team_project_id) || 0 };
  }) };
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  const params = queryParams(request);
  const input = requestBody(request);
  try {
    if (request.method === 'GET') {
      if (params.feed === 'true' || params.feed === '1') return json(response, 200, await feedFor(auth.userId, params.member_email));
      if (!params.id) {
        const [memberships, ownedProjects] = await Promise.all([
          supabaseRequest(`team_project_members?user_id=eq.${encodeURIComponent(auth.userId)}&select=team_project_id,role,display_name,joined_at&order=joined_at.asc`),
          supabaseRequest(`team_projects?owner_id=eq.${encodeURIComponent(auth.userId)}&select=id,owner_id,name`)
        ]);
        const membershipRows = Array.isArray(memberships) ? memberships : [];
        const ownedRows = Array.isArray(ownedProjects) ? ownedProjects : [];
        const ids = [...new Set([...membershipRows.map(row => row.team_project_id), ...ownedRows.map(row => row.id)].filter(validUuid))];
        const projects = ids.length ? await supabaseRequest(`team_projects?id=in.(${ids.join(',')})&select=id,owner_id,name`) : [];
        return json(response, 200, { projects: (Array.isArray(projects) ? projects : []).map(project => ({ ...project, membership: membershipRows.find(row => row.team_project_id === project.id) || (project.owner_id === auth.userId ? { team_project_id: project.id, user_id: auth.userId, role: 'owner', display_name: null } : null) })) });
      }
      const detail = await detailFor(auth.userId, params.id, params.week_start, params.member_email);
      return detail ? json(response, 200, detail) : json(response, 404, { error: 'Team project not found' });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
    const action = input.action;
    if (action === 'create') {
      const name = normalizeName(input.name);
      await assertUniqueProjectName(auth.userId, name);
      await ensureProfile(auth.userId);
      const joinCode = newJoinCode();
      const projects = await supabaseRequest('team_projects', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ owner_id: auth.userId, name, join_code_hash: hashCode(joinCode) }]) });
      const project = projects?.[0];
      if (!project) throw new Error('Team project could not be created');
      await supabaseRequest('team_project_members', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ team_project_id: project.id, user_id: auth.userId, role: 'owner', display_name: memberDisplayName(auth, input.email) }]) });
      return json(response, 201, { project: { id: project.id, name: project.name, owner_id: project.owner_id }, joinCode });
    }
    if (action === 'join') {
      const code = String(input.join_code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{8,32}$/.test(code)) return json(response, 400, { error: 'Enter a valid team join code' });
      const projects = await supabaseRequest(`team_projects?join_code_hash=eq.${encodeURIComponent(hashCode(code))}&select=id,name,owner_id&limit=1`);
      const project = projects?.[0];
      if (!project) return json(response, 404, { error: 'That team join code is not valid' });
      await ensureProfile(auth.userId);
      await supabaseRequest('team_project_members', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ team_project_id: project.id, user_id: auth.userId, role: 'member', display_name: memberDisplayName(auth, input.email) }]) });
      return json(response, 200, { project });
    }
    let projectId = input.team_project_id;
    let member = await memberFor(auth.userId, projectId);
    // Older cached feed rows can carry a stale or malformed project id. For
    // task mutations, recover the project from the server-owned task row before
    // authorizing; this never bypasses the membership check.
    if (!member && action === 'toggle_task' && validUuid(input.team_task_id)) {
      const taskRows = await supabaseRequest(`team_tasks?id=eq.${encodeURIComponent(input.team_task_id)}&select=team_project_id&limit=1`);
      const taskProjectId = taskRows?.[0]?.team_project_id;
      const recoveredMember = taskProjectId ? await memberFor(auth.userId, taskProjectId) : null;
      if (recoveredMember) {
        projectId = taskProjectId;
        member = recoveredMember;
      }
    }
    if (!member) return json(response, 404, { error: 'Team project not found' });
    if (action === 'list_files') {
      const rows = await supabaseRequest(`team_files?team_project_id=eq.${encodeURIComponent(projectId)}&select=id,team_project_id,uploaded_by,object_path,file_name,mime_type,size_bytes,created_at&order=created_at.desc`);
      const files = await Promise.all((rows || []).map(async row => ({ ...fileView(row), url: await signedTeamFileUrl(row.object_path) })));
      return json(response, 200, { files });
    }
    if (action === 'upload_file') {
      const file = input.file || {};
      const name = safeFileName(file.name);
      const size = Number(file.size);
      if (!name || name.length > 180) return json(response, 400, { error: 'File name is invalid' });
      if (!Number.isInteger(size) || size < 1 || size > maxFileBytes) return json(response, 400, { error: 'Files must be 4 MB or smaller' });
      if (typeof file.data !== 'string' || !file.data) return json(response, 400, { error: 'File data is missing' });
      const data = Buffer.from(file.data, 'base64');
      if (data.length !== size || data.length > maxFileBytes) return json(response, 400, { error: 'File data is invalid' });
      await ensureProfile(auth.userId);
      const objectPath = `${projectId}/${randomBytes(16).toString('hex')}-${name}`;
      const mimeType = String(file.mime || 'application/octet-stream').slice(0, 120);
      await supabaseStorageRequest(`object/team-files/${storagePath(objectPath)}`, { method: 'POST', headers: { 'Content-Type': mimeType, 'x-upsert': 'false' }, body: data });
      const rows = await supabaseRequest('team_files', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ team_project_id: projectId, uploaded_by: auth.userId, object_path: objectPath, file_name: name, mime_type: mimeType, size_bytes: data.length }]) });
      const row = rows?.[0];
      return json(response, 201, { file: { ...fileView(row), url: await signedTeamFileUrl(objectPath) } });
    }
    if (action === 'delete_file') {
      if (!validUuid(input.file_id)) return json(response, 400, { error: 'File is invalid' });
      const rows = await supabaseRequest(`team_files?id=eq.${encodeURIComponent(input.file_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id,object_path,uploaded_by&limit=1`);
      const row = rows?.[0];
      if (!row) return json(response, 404, { error: 'File not found' });
      if (member.role !== 'owner' && row.uploaded_by !== auth.userId) return json(response, 403, { error: 'Only the uploader or team owner can delete this file' });
      await supabaseStorageRequest(`object/team-files/${storagePath(row.object_path)}`, { method: 'DELETE' });
      await supabaseRequest(`team_files?id=eq.${encodeURIComponent(input.file_id)}&team_project_id=eq.${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      return json(response, 200, { deleted: true, file_id: input.file_id });
    }
    if (action === 'create_subproject') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can create subprojects' });
      const name = normalizeSubprojectName(input.name);
      await assertUniqueSubprojectName(projectId, name);
      const rows = await supabaseRequest('team_subprojects', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ team_project_id: projectId, created_by: auth.userId, name }]) });
      return json(response, 201, { subproject: rows?.[0] || null });
    }
    if (action === 'rename_subproject') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can rename subprojects' });
      if (!validUuid(input.subproject_id)) return json(response, 400, { error: 'Invalid team subproject' });
      const name = normalizeSubprojectName(input.name);
      const ownedSubproject = await supabaseRequest(`team_subprojects?id=eq.${encodeURIComponent(input.subproject_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`);
      if (!ownedSubproject?.length) return json(response, 404, { error: 'Team subproject not found' });
      await assertUniqueSubprojectName(projectId, name, input.subproject_id);
      const rows = await supabaseRequest(`team_subprojects?id=eq.${encodeURIComponent(input.subproject_id)}&team_project_id=eq.${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name, updated_at: new Date().toISOString() }) });
      return json(response, 200, { subproject: rows?.[0] || { id: input.subproject_id, team_project_id: projectId, name } });
    }
    if (action === 'delete_subproject') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can delete subprojects' });
      if (!validUuid(input.subproject_id)) return json(response, 400, { error: 'Invalid team subproject' });
      const ownedSubproject = await supabaseRequest(`team_subprojects?id=eq.${encodeURIComponent(input.subproject_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`);
      if (!ownedSubproject?.length) return json(response, 404, { error: 'Team subproject not found' });
      await supabaseRequest(`team_subprojects?id=eq.${encodeURIComponent(input.subproject_id)}&team_project_id=eq.${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      return json(response, 200, { deleted: true, subproject_id: input.subproject_id });
    }
    if (action === 'create_task') {
      const task = normalizeTask(input.task);
      await assertTaskTargets(projectId, task);
      const rows = await supabaseRequest('team_tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ ...task, team_project_id: projectId, created_by: auth.userId }]) });
      return json(response, 201, { task: rows?.[0] || null });
    }
    if (action === 'update_task') {
      if (!validUuid(input.team_task_id)) return json(response, 400, { error: 'Invalid team task' });
      const ownedTask = await supabaseRequest(`team_tasks?id=eq.${encodeURIComponent(input.team_task_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`);
      if (!ownedTask?.length) return json(response, 404, { error: 'Team task not found' });
      const task = normalizeTask(input.task);
      await assertTaskTargets(projectId, task);
      const rows = await supabaseRequest(`team_tasks?id=eq.${encodeURIComponent(input.team_task_id)}&team_project_id=eq.${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...task, updated_at: new Date().toISOString() }) });
      return json(response, 200, { task: rows?.[0] || null });
    }
    if (action === 'toggle_task') {
      if (!validUuid(input.team_task_id) || typeof input.completed !== 'boolean') return json(response, 400, { error: 'Invalid team task completion request' });
      const ownedTask = await supabaseRequest(`team_tasks?id=eq.${encodeURIComponent(input.team_task_id)}&team_project_id=eq.${encodeURIComponent(projectId)}&select=id,assignee_id&limit=1`);
      if (!ownedTask?.length) return json(response, 404, { error: 'Team task not found' });
      if (ownedTask[0].assignee_id && ownedTask[0].assignee_id !== auth.userId) return json(response, 403, { error: 'Only the assignee can complete this task' });
      const completionFilter = `team_task_id=eq.${encodeURIComponent(input.team_task_id)}&user_id=eq.${encodeURIComponent(auth.userId)}`;
      if (input.completed) await supabaseRequest('team_task_completions', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ team_task_id: input.team_task_id, user_id: auth.userId }]) });
      else await supabaseRequest(`team_task_completions?${completionFilter}`, { method: 'DELETE' });
      return json(response, 200, { completed: input.completed });
    }
    if (action === 'save_availability') {
      if (!validDate(input.week_start)) return json(response, 400, { error: 'Availability week is invalid' });
      const slots = normalizeSlots(input.slots);
      await supabaseRequest('team_availability', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ team_project_id: projectId, user_id: auth.userId, week_start: input.week_start, slots }]) });
      return json(response, 200, { saved: true, slots });
    }
    if (action === 'regenerate_code') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can regenerate the join code' });
      const joinCode = newJoinCode();
      await supabaseRequest(`team_projects?id=eq.${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ join_code_hash: hashCode(joinCode), updated_at: new Date().toISOString() }) });
      return json(response, 200, { joinCode });
    }
    if (action === 'rename_project') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can rename this team project' });
      const name = normalizeName(input.name);
      await assertUniqueProjectName(auth.userId, name, projectId);
      const rows = await supabaseRequest(`team_projects?id=eq.${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name, updated_at: new Date().toISOString() }) });
      return json(response, 200, { project: rows?.[0] || { id: projectId, name } });
    }
    if (action === 'delete_all_tasks') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can delete all team tasks' });
      await supabaseRequest(`team_tasks?team_project_id=eq.${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      return json(response, 200, { deleted: true });
    }
    if (action === 'delete_project') {
      if (member.role !== 'owner') return json(response, 403, { error: 'Only the team owner can delete this team project' });
      await supabaseRequest(`team_projects?id=eq.${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      return json(response, 200, { deleted: true, team_project_id: projectId });
    }
    return json(response, 400, { error: 'Unsupported team project operation' });
  } catch (error) {
    return json(response, error.status || 422, { error: error.message || 'Team project operation failed' });
  }
}

export { hashCode, memberDisplayName, normalizeSlots, normalizeSubprojectName, normalizeTask, teamTaskCompletionState };
