const dayNames = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfoldLines(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  return unfolded;
}

function unescapeIcal(value) {
  return String(value || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

function parseProperty(line) {
  const separator = line.indexOf(':');
  if (separator < 0) return null;
  const [name, ...parameterParts] = line.slice(0, separator).split(';');
  const params = {};
  parameterParts.forEach(part => {
    const [key, ...values] = part.split('=');
    if (key) params[key.toUpperCase()] = values.join('=').replace(/^"|"$/g, '');
  });
  return { name: name.toUpperCase(), params, value: line.slice(separator + 1) };
}

function pad(value) { return String(value).padStart(2, '0'); }

function parseDateValue(value, params = {}) {
  const raw = String(value || '').trim();
  if (/^\d{8}$/.test(raw) || params.VALUE === 'DATE') {
    if (!/^\d{8}$/.test(raw)) return null;
    return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, time: null, allDay: true };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i);
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds, utc] = match;
  if (utc) {
    const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds)));
    return { date: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`, time: `${pad(local.getHours())}:${pad(local.getMinutes())}`, allDay: false };
  }
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}`, allDay: false };
}

function parseDuration(value) {
  const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (!match) return null;
  const minutes = (Number(match[1] || 0) * 1440) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
  return minutes || null;
}

function durationBetween(start, end) {
  if (!start || !end || start.allDay || end.allDay || start.date !== end.date || !start.time || !end.time) return null;
  const toMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const minutes = toMinutes(end.time) - toMinutes(start.time);
  return minutes > 0 ? minutes : null;
}

function parseRecurrence(value) {
  const parts = String(value || '').split(';').map(part => part.split('='));
  const values = Object.fromEntries(parts.filter(([key]) => key).map(([key, partValue]) => [key.toUpperCase(), partValue]));
  const frequency = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' })[values.FREQ];
  if (!frequency) return null;
  const days = values.BYDAY ? values.BYDAY.split(',').map(day => dayNames[day.replace(/[-+]?\d+/g, '')]).filter(day => Number.isInteger(day)) : [];
  return { frequency, interval: Math.max(1, Number(values.INTERVAL) || 1), days };
}

function isClassMetadataProperty(name) {
  const normalized = String(name || '').toUpperCase();
  if (normalized === 'CLASS' || normalized === 'COURSE' || normalized === 'SUBJECT') return true;
  return /^X-(?:[^:;]*)(?:CLASS|COURSE|SUBJECT)(?:[-_][^:;]*)?$/.test(normalized);
}

function isGenericClassValue(value) {
  return /^(?:PUBLIC|PRIVATE|CONFIDENTIAL|ASSIGNMENT|HOMEWORK|EVENT|SCHOOL|SCHOOLOGY|CALENDAR)$/i.test(String(value || '').trim());
}

// Schoology's all-course iCal export does not include the course that owns an
// event. Keep the fallback rules here, next to the feed parser, so imports do
// not silently turn every event into the selected default class. These are
// intentionally conservative: a rule only wins when the title/description
// contains a distinctive course signal.
const schoologyClassSignals = [
  { className: 'Spanish', patterns: [/\b(?:despu[eé]s de leer|tarea|verbos|pr[aá]ctica|prueba|pronombres|palabras interrogativas|qu[eé] vs\.? cu[aá]l|encuesta|calentamiento)\b/i] },
  { className: 'AP US History', patterns: [/\b(?:apush|reconstruction|populism|frontier thesis|turner thesis|captains of industry|robber baron|lep\s*\d+)\b/i] },
  { className: 'English', patterns: [/\b(?:prufrock|catcher in the rye|imagist poem|tone and mood|critical essay|socratic discussion)\b/i] },
  { className: 'Chemistry', patterns: [/\b(?:chemical or physical|homogeneous or heterogeneous|reversible or irreversible|states of matter|separating mixtures|emission spectra|bohr model|macromolecules?|matter and energy)\b/i] },
  { className: 'Principles of Engineering', patterns: [/\b(?:simple machines?|scientific notation|flinn safety|adding vectors|graphing assignment|engineering field report|wedge and screw)\b/i] },
  { className: 'Calculus', patterns: [/\b(?:ap classroom|trig mini[- ]quiz|practice trig|calculus|chapter\s*2|ch\s*2\s*#|summer ap calculus|test#?1\s*\(unit\s*1)\b/i] },
  { className: 'Physics', patterns: [/\b(?:constant motion|kinematics|newton(?:'s|s)? laws|projectile|measurement quiz)\b/i] }
];

const schoologyNonAcademicSignals = /\b(?:fbla|science fair|pjas|lvsf|dvsf|club meeting|mandatory club|project submission|forms? due|project set[- ]?up|competition at|registration deadline)\b/i;

export function inferSchoologyClassHint(event) {
  const text = [event?.title, event?.description, event?.location, event?.categories, event?.calendarName]
    .filter(Boolean).join(' ');
  return schoologyClassSignals.find(rule => rule.patterns.some(pattern => pattern.test(text)))?.className || null;
}

export function isNonAcademicSchoologyEvent(event) {
  const text = [event?.title, event?.description, event?.location, event?.categories, event?.calendarName]
    .filter(Boolean).join(' ');
  return schoologyNonAcademicSignals.test(text);
}

export function parseICal(text) {
  const events = [];
  let current = null;
  let calendarName = '';
  for (const line of unfoldLines(text)) {
    if (line.toUpperCase() === 'BEGIN:VEVENT') { current = []; continue; }
    if (line.toUpperCase() === 'END:VEVENT') {
      if (current) {
        const properties = current.map(parseProperty).filter(Boolean);
        const first = name => properties.find(property => property.name === name);
        const start = first('DTSTART') && parseDateValue(first('DTSTART').value, first('DTSTART').params);
        const end = first('DTEND') && parseDateValue(first('DTEND').value, first('DTEND').params);
        const summary = unescapeIcal(first('SUMMARY')?.value);
        const categories = properties
          .filter(property => property.name === 'CATEGORIES')
          .map(property => unescapeIcal(property.value))
          .filter(Boolean)
          .join(', ');
        const classProperty = properties
          .filter(property => isClassMetadataProperty(property.name))
          .sort((left, right) => {
            const rank = name => /COURSE|SUBJECT/.test(name) ? 0 : 1;
            return rank(left.name) - rank(right.name);
          })
          .find(property => !isGenericClassValue(unescapeIcal(property.value)));
        if (start?.date && summary) {
          events.push({
            uid: unescapeIcal(first('UID')?.value) || `${start.date}:${summary}`,
            title: summary,
            description: unescapeIcal(first('DESCRIPTION')?.value),
            location: unescapeIcal(first('LOCATION')?.value),
            categories,
            classHint: unescapeIcal(classProperty?.value),
            calendarName,
            dueDate: start.date,
            dueTime: start.time,
            duration: parseDuration(first('DURATION')?.value) || durationBetween(start, end) || 60,
            recurrence: parseRecurrence(first('RRULE')?.value)
          });
        }
      }
      current = null;
      continue;
    }
    if (current) current.push(line);
    else {
      const property = parseProperty(line);
      if (property?.name === 'X-WR-CALNAME') calendarName = unescapeIcal(property.value);
    }
  }
  return events;
}

export function isImportableCalendarEvent(event, todayKey = new Date().toISOString().slice(0, 10)) {
  return Boolean(event?.dueDate && (event.dueDate >= todayKey || event.recurrence));
}

export function filterCalendarEvents(events, todayKey = new Date().toISOString().slice(0, 10)) {
  const seenUids = new Set();
  return (Array.isArray(events) ? events : []).filter(event => {
    if (!event?.uid || seenUids.has(event.uid) || !isImportableCalendarEvent(event, todayKey)) return false;
    seenUids.add(event.uid);
    return true;
  });
}

export function isPastImportedOneTimeTask(task, todayKey = new Date().toISOString().slice(0, 10)) {
  // Imported rows can retain the feed deadline while an older client has
  // already moved their execution date. Use the execution date when it is
  // present so a valid user move is not treated as a stale feed occurrence.
  const executionDate = task?.scheduledDate || task?.dueDate;
  // Completed imported events are historical user work, not stale feed rows.
  // Removing them makes another device/feed refresh recreate the same event as
  // open because the provider still publishes it.
  return Boolean(task?.status !== 'completed' && (task?.source === 'calendar' || String(task?.idempotencyKey || '').startsWith('ical:')) && executionDate && executionDate < todayKey && !task.recurrence);
}

// Feed data establishes an imported task once. After that, the task in Silico
// is authoritative so manual edits are not overwritten by a later resync.
// The identity key is the only field a resync may repair (for legacy imports).
export function preserveImportedCalendarTask(existing, incoming) {
  if (!existing) return { task: incoming, changed: false };
  const changed = existing.idempotencyKey !== incoming.idempotencyKey;
  return { task: changed ? { ...existing, idempotencyKey: incoming.idempotencyKey } : existing, changed };
}

// Provider UIDs are stable, but early imports stored them as ical:<uid>
// while newer imports scope them to the feed as ical:<feed>:<uid>. Treat the
// legacy key as the same event during reconciliation; otherwise a refresh
// creates a second provider row and the user's local edits appear to vanish.
export function matchesImportedCalendarTask(task, uid, feedId = 'file') {
  if (!task || !uid) return false;
  const keys = [task.idempotencyKey, task.schedulingIdentity].filter(Boolean).map(String);
  return keys.some(currentKey => currentKey === `ical:${feedId}:${uid}` || currentKey === `ical:${uid}`);
}

// Class matching is import-owned until the user explicitly changes it in the
// task drawer. This lets a later Schoology resync repair legacy rows that were
// created without a class, while preserving a deliberate user override.
export function repairImportedCalendarClass(existing, incoming) {
  if (!existing) return { task: existing, changed: false };
  const previousAutoClass = existing.calendarClassName || existing.importedClassName || null;
  const existingClass = String(existing.className || '').trim();
  // Once a user assigns an imported event in the task drawer, that choice is
  // authoritative. Do not let a later feed refresh reinterpret the event as
  // unmatched/non-academic or replace it with the feed default.
  if (existing.calendarClassManuallySet === true) return { task: existing, changed: false };
  const isFeedDefault = incoming?.calendarDefaultClass && existingClass.toLowerCase() === String(incoming.calendarDefaultClass).trim().toLowerCase();
  if (incoming?.calendarClassResolution === 'non_academic' && (isFeedDefault || previousAutoClass && existingClass.toLowerCase() === String(previousAutoClass).trim().toLowerCase())) {
    return {
      task: { ...existing, className: null, calendarClassName: null, calendarClassHint: incoming.calendarClassHint || null, calendarClassResolution: 'non_academic' },
      changed: Boolean(existingClass || existing.calendarClassName)
    };
  }
  if (incoming?.calendarClassResolution === 'unmatched' && (isFeedDefault || previousAutoClass && existingClass.toLowerCase() === String(previousAutoClass).trim().toLowerCase())) {
    return {
      task: { ...existing, className: null, calendarClassName: null, calendarClassHint: incoming.calendarClassHint || null, calendarClassResolution: 'unmatched' },
      changed: Boolean(existingClass || existing.calendarClassName)
    };
  }
  if (!incoming?.className) return { task: existing, changed: false };
  const canReplace = !existingClass || !previousAutoClass || existingClass.toLowerCase() === String(previousAutoClass).trim().toLowerCase();
  if (!canReplace || existingClass === String(incoming.className).trim()) {
    const metadataChanged = existing.calendarClassName !== incoming.className || existing.calendarClassHint !== (incoming.calendarClassHint || null);
    return metadataChanged ? { task: { ...existing, calendarClassName: incoming.className, calendarClassHint: incoming.calendarClassHint || null }, changed: true } : { task: existing, changed: false };
  }
  return {
    task: { ...existing, className: incoming.className, calendarClassName: incoming.className, calendarClassHint: incoming.calendarClassHint || null, calendarClassManuallySet: false },
    changed: true
  };
}
