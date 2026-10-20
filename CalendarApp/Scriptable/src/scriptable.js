// Scriptable runtime for 一览. The build prepends core.js and fills in APP_HTML.
//
// Run from the app or a Home Screen icon → full-screen UI in a WebView.
// Run as a widget → today's shift, events and tasks.
// Run from Shortcuts/Siri with text, or scriptable:///run/一览?add=… → quick add without UI.

const C = globalThis.GlanceCore;
const APP_HTML = __APP_HTML__;
const VERSION = '__VERSION__';
const UPDATE_URL = 'https://raw.githubusercontent.com/woodyair233-oss/claude/claude/zealous-knuth-jpnk92/CalendarApp/Scriptable/dist/%E4%B8%80%E8%A7%88.js';

const FM = FileManager.local();
const DIR = FM.joinPath(FM.documentsDirectory(), 'oneglance');
const SETTINGS_PATH = FM.joinPath(DIR, 'settings.json');
const NOTIFY_PREFIX = 'oneglance-task-';
const DAY = 864e5;

// ------------------------------------------------------------------ settings

function readSettings() {
  try {
    if (FM.fileExists(SETTINGS_PATH)) return JSON.parse(FM.readString(SETTINGS_PATH));
  } catch (e) {
    logError(e);
  }
  return {};
}

function writeSettings(s) {
  if (!FM.fileExists(DIR)) FM.createDirectory(DIR, true);
  FM.writeString(SETTINGS_PATH, JSON.stringify(s));
}

let settings = readSettings();
if (!settings.taskDurations) settings.taskDurations = {};
const templates = () => (settings.shiftTemplates && settings.shiftTemplates.length ? settings.shiftTemplates : C.shifts.defaults());

// ------------------------------------------------------------------ data

const eventMap = new Map();
const reminderMap = new Map();
let lastRange = null;
let lastNotifySync = 0;
let lastNotifyKey = '';

const hex = (color) => {
  const h = (color && color.hex) || '8E8E93';
  return h.charAt(0) === '#' ? h : '#' + h;
};
const uidOf = (ev) => `${ev.identifier}|${ev.startDate.getTime()}`;

async function loadData(range) {
  lastRange = range;
  let calendars;
  try {
    calendars = await Calendar.forEvents();
  } catch (e) {
    return { error: 'permission' };
  }
  let lists = [];
  try {
    lists = await Calendar.forReminders();
  } catch (e) {
    lists = [];
  }
  const hidden = new Set(settings.hidden || []);
  const visibleCalendars = calendars.filter((c) => !hidden.has(c.identifier));
  const visibleLists = lists.filter((l) => !hidden.has(l.identifier));
  const start = new Date(range.start);
  const end = new Date(range.end);

  const events = visibleCalendars.length ? await CalendarEvent.between(start, end, visibleCalendars) : [];
  let open = [];
  let done = [];
  if (visibleLists.length) {
    open = await Reminder.allIncomplete(visibleLists);
    done = await Reminder.completedBetween(start, end, visibleLists);
  }

  eventMap.clear();
  reminderMap.clear();
  for (const ev of events) eventMap.set(uidOf(ev), ev);
  for (const r of open.concat(done)) reminderMap.set(r.identifier, r);

  const defaults = {};
  try { defaults.eventCalendarId = (await Calendar.defaultForEvents()).identifier; } catch (e) { /* none */ }
  try { defaults.reminderListId = (await Calendar.defaultForReminders()).identifier; } catch (e) { /* none */ }

  syncNotifications(open).catch(logError);

  return {
    calendars: calendars.map((c) => ({
      id: c.identifier, title: c.title, color: hex(c.color),
      editable: c.allowsContentModifications && !c.isSubscribed,
    })),
    lists: lists.map((l) => ({ id: l.identifier, title: l.title, color: hex(l.color), editable: l.allowsContentModifications })),
    events: events.map((ev) => ({
      uid: uidOf(ev), id: ev.identifier, title: ev.title || '', start: ev.startDate.getTime(), end: ev.endDate.getTime(),
      allDay: ev.isAllDay, calendarId: ev.calendar.identifier, location: ev.location || '', notes: ev.notes || '',
    })),
    reminders: Array.from(reminderMap.values()).map((r) => ({
      id: r.identifier, title: r.title || '', notes: r.notes || '',
      due: r.dueDate ? r.dueDate.getTime() : null, hasTime: !!(r.dueDate && r.dueDateIncludesTime),
      completed: r.isCompleted, completionDate: r.completionDate ? r.completionDate.getTime() : null,
      priority: r.priority || 0, listId: r.calendar.identifier,
    })),
    settings,
    defaults,
    version: VERSION,
  };
}

const fresh = async () => (lastRange ? loadData(lastRange) : null);

async function findEvent(uid) {
  if (eventMap.has(uid)) return eventMap.get(uid);
  const cut = uid.lastIndexOf('|');
  const id = uid.slice(0, cut);
  const ms = Number(uid.slice(cut + 1));
  const list = await CalendarEvent.between(new Date(ms - DAY), new Date(ms + DAY));
  return list.find((e) => e.identifier === id && e.startDate.getTime() === ms) || null;
}

async function findReminder(id) {
  if (reminderMap.has(id)) return reminderMap.get(id);
  return (await Reminder.all()).find((r) => r.identifier === id) || null;
}

/** Scriptable does not say which part of a series save() changes, so series are left to the system editor. */
async function isRecurring(ev) {
  const t = ev.startDate.getTime();
  const near = await CalendarEvent.between(new Date(t - 400 * DAY), new Date(t + 400 * DAY), [ev.calendar]);
  return near.filter((e) => e.identifier === ev.identifier).length > 1;
}

async function calendarById(id) {
  if (id) {
    const c = (await Calendar.forEvents()).find((x) => x.identifier === id);
    if (c) return c;
  }
  return Calendar.defaultForEvents();
}

async function listById(id) {
  if (id) {
    const l = (await Calendar.forReminders()).find((x) => x.identifier === id);
    if (l) return l;
  }
  try {
    return await Calendar.defaultForReminders();
  } catch (e) {
    return Calendar.findOrCreateForReminders('待办');
  }
}

function setTimes(ev, p) {
  if (p.allDay != null) ev.isAllDay = !!p.allDay;
  if (p.start != null) ev.startDate = new Date(p.start);
  if (p.end != null) ev.endDate = new Date(ev.isAllDay ? Math.max(p.end, p.start != null ? p.start : p.end) : p.end);
}

async function createEvent(p) {
  const ev = new CalendarEvent();
  ev.title = p.title || '新日程';
  ev.calendar = await calendarById(p.calendarId);
  setTimes(ev, p);
  if (p.location) ev.location = p.location;
  if (p.notes) ev.notes = p.notes;
  ev.save();
  return ev;
}

async function deleteEvent(uid) {
  const ev = await findEvent(uid);
  if (!ev) return { error: '找不到这个日程，可能已在别处删除' };
  if (await isRecurring(ev)) return { recurring: true };
  ev.remove();
  return { ok: true };
}

function applyReminderFields(r, p) {
  if (p.title != null) r.title = p.title;
  if (p.notes != null) r.notes = p.notes;
  if (p.priority != null) r.priority = p.priority;
  if ('due' in p) {
    if (p.due == null) {
      r.dueDate = null;
      r.dueDateIncludesTime = false;
    } else {
      r.dueDate = new Date(p.due);
      r.dueDateIncludesTime = !!p.hasTime;
    }
  }
  if (p.completed != null) r.isCompleted = !!p.completed;
}

function rememberDuration(id, minutes) {
  if (!minutes) return;
  settings.taskDurations[id] = minutes;
  writeSettings(settings);
}

const handlers = {
  async load(p) {
    return loadData(p);
  },

  async saveSettings(p) {
    const durations = Object.assign({}, (p.settings && p.settings.taskDurations) || {}, settings.taskDurations);
    settings = Object.assign({}, p.settings, { taskDurations: durations });
    writeSettings(settings);
    return { ok: true, data: await fresh() };
  },

  async createEvent(p) {
    const ev = await createEvent(p);
    return { ok: true, uid: uidOf(ev), data: await fresh() };
  },

  async updateEvent(p) {
    const ev = await findEvent(p.uid);
    if (!ev) return { error: '找不到这个日程，可能已在别处删除' };
    if (!ev.calendar.allowsContentModifications) return { error: '这个日历是只读的' };
    if (await isRecurring(ev)) return { recurring: true };
    if (p.title != null) ev.title = p.title;
    if (p.location != null) ev.location = p.location;
    if (p.notes != null) ev.notes = p.notes;
    setTimes(ev, p);
    if (p.calendarId && p.calendarId !== ev.calendar.identifier) ev.calendar = await calendarById(p.calendarId);
    ev.save();
    return { ok: true, data: await fresh() };
  },

  async deleteEvent(p) {
    const res = await deleteEvent(p.uid);
    return res.ok ? { ok: true, data: await fresh() } : res;
  },

  async editNative(p) {
    const ev = await findEvent(p.uid);
    if (!ev) return { error: '找不到这个日程' };
    await ev.presentEdit();
    return { ok: true, data: await fresh() };
  },

  async createReminder(p) {
    const r = new Reminder();
    r.calendar = await listById(p.listId);
    applyReminderFields(r, Object.assign({ title: '新待办' }, p));
    r.save();
    rememberDuration(r.identifier, p.duration);
    return { ok: true, id: r.identifier, data: await fresh() };
  },

  async updateReminder(p) {
    const r = await findReminder(p.id);
    if (!r) return { error: '找不到这个待办，可能已在别处删除' };
    applyReminderFields(r, p);
    if (p.listId && p.listId !== r.calendar.identifier) r.calendar = await listById(p.listId);
    r.save();
    rememberDuration(p.id, p.duration);
    return { ok: true, data: await fresh() };
  },

  async deleteReminder(p) {
    const r = await findReminder(p.id);
    if (r) r.remove();
    return { ok: true, data: await fresh() };
  },

  /** Several changes in one round trip (the shift brush). */
  async batch(p) {
    const problems = [];
    for (const op of p.ops || []) {
      if (op.type === 'deleteEvent') {
        const res = await deleteEvent(op.uid);
        if (!res.ok) problems.push(res.recurring ? '重复的班次请在系统日历修改' : res.error);
      } else if (op.type === 'createEvent') {
        await createEvent(op);
      }
    }
    return problems.length ? { error: problems.join('；'), data: await fresh() } : { ok: true, data: await fresh() };
  },

  /** Downloads the latest build from GitHub and replaces this script file. */
  async selfUpdate() {
    const code = await new Request(UPDATE_URL).loadString();
    if (!code || code.indexOf('icon-glyph') < 0 || code.indexOf('GlanceCore') < 0) return { error: '下载的内容不正确，请稍后再试' };
    const m = code.match(/@version (\S+)/);
    const latest = m ? m[1] : '';
    if (latest === VERSION) return { ok: true, message: `已经是最新版本（${VERSION}）` };
    try {
      FileManager.iCloud().writeString(module.filename, code);
    } catch (e) {
      FileManager.local().writeString(module.filename, code);
    }
    return { ok: true, message: `已更新到 ${latest}：关闭后重新打开即可使用` };
  },

  async openSettingsApp() {
    Safari.open('app-settings:');
    return { ok: true };
  },
};

async function handle(type, payload) {
  const fn = handlers[type];
  if (!fn) throw new Error('unknown request ' + type);
  return fn(payload || {});
}

// ------------------------------------------------------------------ notifications

/** Reminders cannot get alarms through Scriptable, so timed tasks get a Scriptable notification. */
async function syncNotifications(openReminders) {
  const key = openReminders
    .filter((r) => r.dueDate && r.dueDateIncludesTime)
    .map((r) => r.identifier + r.dueDate.getTime()).join(',') + (settings.notifyTasks === false ? 'off' : 'on');
  if (key === lastNotifyKey && Date.now() - lastNotifySync < 10 * 60e3) return;
  lastNotifyKey = key;
  lastNotifySync = Date.now();

  const now = Date.now();
  const wanted = new Map();
  if (settings.notifyTasks !== false) {
    for (const r of openReminders) {
      if (!r.dueDate || !r.dueDateIncludesTime) continue;
      const t = r.dueDate.getTime();
      if (t > now && t < now + 7 * DAY) wanted.set(`${NOTIFY_PREFIX}${r.identifier}-${t}`, r);
      if (wanted.size >= 40) break;
    }
  }
  const pending = (await Notification.allPending()).filter((n) => (n.identifier || '').indexOf(NOTIFY_PREFIX) === 0);
  const have = new Set(pending.map((n) => n.identifier));
  const stale = pending.map((n) => n.identifier).filter((id) => !wanted.has(id));
  if (stale.length) await Notification.removePending(stale);
  for (const [id, r] of wanted) {
    if (have.has(id)) continue;
    const n = new Notification();
    n.identifier = id;
    n.title = r.title || '待办';
    n.body = `待办 · ${C.fmt.hm(r.dueDate)}`;
    n.sound = 'default';
    n.openURL = URLScheme.forRunningScript();
    n.setTriggerDate(r.dueDate);
    await n.schedule();
  }
}

// ------------------------------------------------------------------ full-screen UI

async function runApp() {
  const wv = new WebView();
  await wv.loadHTML(APP_HTML);
  let closed = false;
  const presented = wv.present(true).then(() => { closed = true; });
  while (!closed) {
    let messages = null;
    try {
      messages = await Promise.race([
        wv.evaluateJavaScript('__nextMessages(typeof completion !== "undefined" ? completion : null)', true),
        presented.then(() => null),
      ]);
    } catch (e) {
      if (closed) break;
      logError(e);
      continue;
    }
    if (!messages || closed) continue;
    for (const m of messages) {
      let ok = true;
      let result;
      try {
        result = await handle(m.type, m.payload);
      } catch (e) {
        ok = false;
        result = String((e && e.message) || e);
      }
      if (closed) break;
      await wv.evaluateJavaScript(`__reply(${Number(m.id)}, ${ok}, ${JSON.stringify(result === undefined ? null : result)})`);
    }
  }
}

// ------------------------------------------------------------------ quick add (Siri / Shortcuts / URL)

function quickAddInput() {
  if (typeof args === 'undefined' || !args) return null;
  if (typeof args.shortcutParameter === 'string' && args.shortcutParameter.trim()) return args.shortcutParameter.trim();
  if (args.queryParameters && args.queryParameters.add) return String(args.queryParameters.add);
  if (args.plainTexts && args.plainTexts.length && args.plainTexts[0].trim()) return args.plainTexts[0].trim();
  return null;
}

async function runQuickAdd(text) {
  const now = new Date();
  const r = C.parseQuickAdd(text, {
    now, defaultDay: now, defaultEventMinutes: settings.defaultEventMinutes || 60,
    shiftNames: templates().map((t) => t.name),
  });
  let message;
  if (r.kind === 'shift') {
    const t = templates().find((x) => x.name === r.shiftName);
    const day = C.startOfDay(r.day);
    const existing = (await CalendarEvent.between(day, C.addDays(day, 1)))
      .filter((e) => C.sameDay(e.startDate, day) && templates().some((x) => x.name === e.title));
    for (const e of existing) if (!(await isRecurring(e))) e.remove();
    const iv = C.shifts.interval(t, day);
    await createEvent({ title: t.name, allDay: t.isAllDay, start: +iv.start, end: +(t.isAllDay ? iv.start : iv.end), calendarId: settings.shiftCalendarId });
    message = `已排${t.name}：${C.fmt.relativeDay(day)}`;
  } else if (!r.title) {
    message = '没有听到标题，未新增';
  } else if (r.kind === 'event' || r.kind === 'allDayEvent') {
    const allDay = r.kind === 'allDayEvent';
    const cals = (await Calendar.forEvents()).filter((c) => c.allowsContentModifications);
    const hinted = r.calendarHint && cals.find((c) => c.title.toLowerCase().indexOf(r.calendarHint.toLowerCase()) >= 0);
    await createEvent({
      title: r.title, allDay, start: +(r.start || r.day), end: +(allDay ? r.day : r.end),
      calendarId: hinted ? hinted.identifier : settings.defaultEventCalendarId,
    });
    message = `已新增日程「${r.title}」${allDay ? C.fmt.relativeDay(r.day) : C.fmt.relativeDay(r.day) + ' ' + C.fmt.range(r.start, r.end)}`;
  } else {
    const lists = await Calendar.forReminders();
    const hinted = r.calendarHint && lists.find((l) => l.title.toLowerCase().indexOf(r.calendarHint.toLowerCase()) >= 0);
    await handlers.createReminder({
      title: r.title, due: +(r.start || r.day), hasTime: r.hasTime, priority: r.priority,
      listId: hinted ? hinted.identifier : settings.defaultReminderListId, duration: r.durationMinutes,
    });
    message = `已新增待办「${r.title}」${C.fmt.relativeDay(r.day)}${r.start ? ' ' + C.fmt.hm(r.start) : ''}`;
  }
  if (config.runsWithSiri || typeof args.shortcutParameter === 'string') {
    Script.setShortcutOutput(message);
  } else {
    const n = new Notification();
    n.title = '一览';
    n.body = message;
    await n.schedule();
  }
}

// ------------------------------------------------------------------ widget

async function runWidget() {
  const now = new Date();
  const day = C.startOfDay(now);
  const hidden = new Set(settings.hidden || []);
  let events = [];
  let tasks = [];
  let allowed = true;
  try {
    const cals = (await Calendar.forEvents()).filter((c) => !hidden.has(c.identifier));
    events = cals.length ? await CalendarEvent.between(day, C.addDays(day, 1), cals) : [];
  } catch (e) {
    allowed = false;
  }
  try {
    const lists = (await Calendar.forReminders()).filter((l) => !hidden.has(l.identifier));
    const open = lists.length ? await Reminder.allIncomplete(lists) : [];
    const end = C.addDays(day, 1);
    tasks = open.filter((r) => r.dueDate && r.dueDate < end).sort((a, b) => {
      const ao = a.dueDate < day, bo = b.dueDate < day;
      if (ao !== bo) return ao ? -1 : 1;
      if (a.dueDateIncludesTime !== b.dueDateIncludesTime) return a.dueDateIncludesTime ? -1 : 1;
      return a.dueDate - b.dueDate;
    });
  } catch (e) { /* no reminders access */ }

  const tpls = templates();
  const shiftEvent = events.find((e) => C.sameDay(e.startDate, day) && tpls.some((t) => t.name === e.title));
  const shift = shiftEvent && tpls.find((t) => t.name === shiftEvent.title);
  const timed = events.filter((e) => !e.isAllDay && e.endDate > now).sort((a, b) => a.startDate - b.startDate);
  const allDay = events.filter((e) => e.isAllDay && e !== shiftEvent);

  const text = Color.dynamic(new Color('#1c1c1e'), new Color('#f2f2f7'));
  const sub = Color.dynamic(new Color('#6c6c70'), new Color('#98989f'));
  const w = new ListWidget();
  w.url = URLScheme.forRunningScript();
  const family = config.widgetFamily || 'medium';
  const nextChange = timed.length ? Math.min(...timed.map((e) => e.endDate.getTime())) : now.getTime() + 30 * 60e3;
  w.refreshAfterDate = new Date(Math.min(nextChange, now.getTime() + 30 * 60e3));

  const add = (stack, str, font, color, lines) => {
    const t = stack.addText(str);
    t.font = font;
    t.textColor = color || text;
    if (lines) t.lineLimit = lines;
    return t;
  };

  if (!allowed) {
    add(w, '打开「一览」允许访问日历', Font.mediumSystemFont(12), sub, 2);
    Script.setWidget(w);
    return;
  }

  if (family === 'accessoryInline') {
    const parts = [shift && shift.name, timed[0] && `${C.fmt.hm(timed[0].startDate)} ${timed[0].title}`, tasks.length ? `待办${tasks.length}` : null];
    add(w, parts.filter(Boolean).join(' · ') || '今天没有安排', Font.systemFont(12));
    Script.setWidget(w);
    return;
  }

  if (family === 'accessoryRectangular') {
    w.addAccessoryWidgetBackground = true;
    add(w, `${C.fmt.mdw(day)}${shift ? ' · ' + shift.name : ''}`, Font.boldSystemFont(13), null, 1);
    if (timed[0]) add(w, `${C.fmt.hm(timed[0].startDate)} ${timed[0].title}`, Font.systemFont(12), null, 1);
    add(w, tasks.length ? `待办 ${tasks.length}：${tasks[0].title}` : (timed.length ? '' : '今天没有安排'), Font.systemFont(12), null, 1);
    Script.setWidget(w);
    return;
  }

  w.backgroundColor = Color.dynamic(new Color('#ffffff'), new Color('#1c1c1e'));
  w.setPadding(12, 14, 12, 14);
  const head = w.addStack();
  head.layoutHorizontally();
  head.centerAlignContent();
  add(head, C.fmt.mdw(day), Font.boldSystemFont(15), null, 1);
  head.addSpacer();
  if (shift) {
    const b = head.addStack();
    b.backgroundColor = new Color(shift.color);
    b.cornerRadius = 4;
    b.setPadding(1, 5, 1, 5);
    add(b, shift.name, Font.boldSystemFont(11), Color.white(), 1);
  }
  w.addSpacer(6);

  const rows = family === 'large' ? 12 : family === 'small' ? 3 : 5;
  let used = 0;
  if (allDay.length && family !== 'small') {
    add(w, allDay.map((e) => e.title).join(' · '), Font.systemFont(11), sub, 1);
    used++;
  }
  for (const e of timed) {
    if (used >= rows) break;
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const bar = row.addStack();
    bar.size = new Size(3, 14);
    bar.cornerRadius = 1.5;
    bar.backgroundColor = new Color(hex(e.calendar.color));
    row.addSpacer(5);
    add(row, C.fmt.hm(e.startDate), Font.regularMonospacedSystemFont(11), sub, 1);
    row.addSpacer(5);
    add(row, e.title, Font.mediumSystemFont(12), null, 1);
    w.addSpacer(3);
    used++;
  }
  for (const r of tasks) {
    if (used >= rows) break;
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    add(row, '○', Font.systemFont(12), new Color(hex(r.calendar.color)), 1);
    row.addSpacer(5);
    add(row, r.title, Font.systemFont(12), null, 1);
    row.addSpacer();
    if (r.dueDate < day) add(row, '逾期', Font.systemFont(10), Color.red(), 1);
    else if (r.dueDateIncludesTime) add(row, C.fmt.hm(r.dueDate), Font.regularMonospacedSystemFont(10), sub, 1);
    w.addSpacer(3);
    used++;
  }
  if (!timed.length && !tasks.length) add(w, '今天没有安排了', Font.systemFont(12), sub, 1);
  const hiddenCount = timed.length + tasks.length + (allDay.length && family !== 'small' ? 1 : 0) - used;
  w.addSpacer();
  if (hiddenCount > 0) add(w, `还有 ${hiddenCount} 项`, Font.systemFont(10), sub, 1);
  Script.setWidget(w);
}

// ------------------------------------------------------------------ main

async function main() {
  if (config.runsInWidget || config.runsInAccessoryWidget) {
    await runWidget();
    return;
  }
  const text = quickAddInput();
  if (text) {
    await runQuickAdd(text);
    return;
  }
  await runApp();
}

await main();
Script.complete();
