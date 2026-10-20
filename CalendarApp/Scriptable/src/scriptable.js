// Scriptable runtime for 一览. The build prepends core.js and fills in APP_HTML.
//
// Run from the app or a Home Screen icon → full-screen UI in a WebView.
// Run as a widget → today's events and tasks.
// Run from Shortcuts/Siri with text, or scriptable:///run/一览?add=… → adds a task without UI.

const C = globalThis.GlanceCore;
const APP_HTML = __APP_HTML__;
const VERSION = '__VERSION__';
const UPDATE_URL = 'https://raw.githubusercontent.com/woodyair233-oss/claude/claude/zealous-knuth-jpnk92/CalendarApp/Scriptable/dist/%E4%B8%80%E8%A7%88.js';

const FM = FileManager.local();
const DIR = FM.joinPath(FM.documentsDirectory(), 'oneglance');
const SETTINGS_PATH = FM.joinPath(DIR, 'settings.json');
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

// ------------------------------------------------------------------ data

const eventMap = new Map();
const reminderMap = new Map();
let lastRange = null;

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
  try { defaults.reminderListId = (await Calendar.defaultForReminders()).identifier; } catch (e) { /* none */ }

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

async function createReminder(p) {
  const r = new Reminder();
  r.calendar = await listById(p.listId);
  applyReminderFields(r, Object.assign({ title: '新待办' }, p));
  r.save();
  return r;
}

const handlers = {
  async load(p) {
    return loadData(p);
  },

  async saveSettings(p) {
    settings = Object.assign({}, p.settings);
    writeSettings(settings);
    return { ok: true, data: await fresh() };
  },

  /** Event changes keep the time of day; the UI only moves events by whole days. */
  async updateEvent(p) {
    const ev = await findEvent(p.uid);
    if (!ev) return { error: '找不到这个日程，可能已在别处删除' };
    if (!ev.calendar.allowsContentModifications) return { error: '这个日历是只读的' };
    if (await isRecurring(ev)) return { recurring: true };
    if (p.title != null) ev.title = p.title;
    if (p.location != null) ev.location = p.location;
    if (p.notes != null) ev.notes = p.notes;
    if (p.start != null) ev.startDate = new Date(p.start);
    if (p.end != null) ev.endDate = new Date(Math.max(p.end, p.start != null ? p.start : p.end));
    if (p.calendarId && p.calendarId !== ev.calendar.identifier) {
      const cal = (await Calendar.forEvents()).find((c) => c.identifier === p.calendarId);
      if (cal) ev.calendar = cal;
    }
    ev.save();
    return { ok: true, data: await fresh() };
  },

  async deleteEvent(p) {
    const ev = await findEvent(p.uid);
    if (!ev) return { error: '找不到这个日程，可能已在别处删除' };
    if (await isRecurring(ev)) return { recurring: true };
    ev.remove();
    return { ok: true, data: await fresh() };
  },

  async editNative(p) {
    const ev = await findEvent(p.uid);
    if (!ev) return { error: '找不到这个日程' };
    await ev.presentEdit();
    return { ok: true, data: await fresh() };
  },

  async createReminder(p) {
    const r = await createReminder(p);
    return { ok: true, id: r.identifier, data: await fresh() };
  },

  async updateReminder(p) {
    const r = await findReminder(p.id);
    if (!r) return { error: '找不到这个待办，可能已在别处删除' };
    applyReminderFields(r, p);
    if (p.listId && p.listId !== r.calendar.identifier) r.calendar = await listById(p.listId);
    r.save();
    return { ok: true, data: await fresh() };
  },

  async deleteReminder(p) {
    const r = await findReminder(p.id);
    if (r) r.remove();
    return { ok: true, data: await fresh() };
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
  const r = C.parseTask(text, { now: new Date() });
  let message;
  if (!r.title) {
    message = '没有听到内容，未新增';
  } else {
    const lists = await Calendar.forReminders();
    const h = r.listHint && r.listHint.toLowerCase();
    const hinted = h && lists.find((l) => l.title.toLowerCase().indexOf(h) >= 0);
    await createReminder({
      title: r.title, due: r.day ? +r.day : null, hasTime: false, priority: r.priority,
      listId: hinted ? hinted.identifier : settings.defaultReminderListId,
    });
    message = `已加入${r.day ? C.fmt.relativeDay(r.day) : '待办区'}：「${r.title}」`;
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
  const tomorrow = C.addDays(day, 1);
  const hidden = new Set(settings.hidden || []);
  let events = [];
  let open = [];
  let allowed = true;
  try {
    const cals = (await Calendar.forEvents()).filter((c) => !hidden.has(c.identifier));
    events = cals.length ? await CalendarEvent.between(day, tomorrow, cals) : [];
  } catch (e) {
    allowed = false;
  }
  try {
    const lists = (await Calendar.forReminders()).filter((l) => !hidden.has(l.identifier));
    open = lists.length ? await Reminder.allIncomplete(lists) : [];
  } catch (e) { /* no reminders access */ }

  // Same rule as the app: timed events on their start day, all-day events on each day
  const todays = events
    .filter((e) => C.eventDays(e.startDate, e.endDate, e.isAllDay).some((d) => C.sameDay(d, day)))
    .sort((a, b) => (b.isAllDay - a.isAllDay) || (a.startDate - b.startDate));
  const tasks = open.filter((r) => r.dueDate && C.sameDay(r.dueDate, day));
  const overdue = open.filter((r) => r.dueDate && r.dueDate < day).length;
  const unscheduled = open.filter((r) => !r.dueDate).length;

  const text = Color.dynamic(new Color('#1c1c1e'), new Color('#f2f2f7'));
  const sub = Color.dynamic(new Color('#6c6c70'), new Color('#98989f'));
  const w = new ListWidget();
  w.url = URLScheme.forRunningScript();
  w.refreshAfterDate = new Date(Math.min(now.getTime() + 30 * 60e3, tomorrow.getTime() + 60e3));
  const family = config.widgetFamily || 'medium';
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

  const summary = [`日程${todays.length}`, `待办${tasks.length}`, overdue ? `逾期${overdue}` : null].filter(Boolean).join(' · ');
  if (family === 'accessoryInline') {
    add(w, summary, Font.systemFont(12));
    Script.setWidget(w);
    return;
  }
  if (family === 'accessoryRectangular') {
    w.addAccessoryWidgetBackground = true;
    add(w, C.fmt.mdw(day), Font.boldSystemFont(13), null, 1);
    add(w, summary, Font.systemFont(12), null, 1);
    const first = todays[0] || tasks[0];
    if (first) add(w, first.title, Font.systemFont(12), null, 1);
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
  if (overdue) add(head, `逾期 ${overdue}`, Font.semiboldSystemFont(11), Color.red(), 1);
  w.addSpacer(6);

  const rows = family === 'large' ? 13 : family === 'small' ? 4 : 5;
  let used = 0;
  for (const e of todays) {
    if (used >= rows) break;
    const row = w.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const bar = row.addStack();
    bar.size = new Size(3, 14);
    bar.cornerRadius = 1.5;
    bar.backgroundColor = new Color(hex(e.calendar.color));
    row.addSpacer(6);
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
    w.addSpacer(3);
    used++;
  }
  if (!todays.length && !tasks.length) add(w, '今天没有安排', Font.systemFont(12), sub, 1);
  w.addSpacer();
  const more = todays.length + tasks.length - used;
  const foot = [more > 0 ? `还有 ${more} 项` : null, unscheduled ? `待办区 ${unscheduled}` : null].filter(Boolean).join(' · ');
  if (foot) add(w, foot, Font.systemFont(10), sub, 1);
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
