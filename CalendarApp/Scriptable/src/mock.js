// In-browser stand-in for the Scriptable side, used by preview.html and the UI
// tests. Same request/response shapes as scriptable.js, with sample data.
window.__MOCK__ = (function () {
  'use strict';
  const C = window.GlanceCore;
  const params = new URLSearchParams(location.search);
  const today = params.get('today') ? C.startOfDay(new Date(params.get('today'))) : C.startOfDay(new Date());
  const at = (dayOffset, h, m) => C.dateOnDay(C.addDays(today, dayOffset), h * 60 + (m || 0)).getTime();
  const dayAt = (dayOffset) => C.addDays(today, dayOffset).getTime();
  const endOfDay = (dayOffset) => C.addDays(today, dayOffset + 1).getTime() - 1000;

  const calendars = [
    { id: 'cal-work', title: '工作', color: '#2F6FED', editable: true },
    { id: 'cal-home', title: '个人', color: '#34C759', editable: true },
    { id: 'cal-shift', title: '排班', color: '#6366F1', editable: true },
    { id: 'cal-holiday', title: '节假日', color: '#E5383B', editable: false },
  ];
  const lists = [
    { id: 'list-main', title: '提醒事项', color: '#F08C00', editable: true },
    { id: 'list-work', title: '工作待办', color: '#2F6FED', editable: true },
  ];
  let seq = 0;
  const nid = (p) => `${p}-${++seq}`;
  const ev = (title, start, end, calendarId, extra) =>
    Object.assign({ id: nid('evt'), title, start, end, allDay: false, calendarId, location: '', notes: '' }, extra || {});

  let events = [
    ev('晨会', at(0, 8), at(0, 8, 30), 'cal-work', { location: '3楼会议室' }),
    ev('门诊', at(0, 9), at(0, 12), 'cal-work', { location: '门诊二区' }),
    ev('电话会诊', at(0, 10, 30), at(0, 11), 'cal-work'),
    ev('文献阅读', at(0, 15), at(0, 16, 30), 'cal-home'),
    ev('健身', at(1, 19), at(1, 20), 'cal-home'),
    ev('学术会议', dayAt(2), endOfDay(2), 'cal-work', { allDay: true }),
    ev('白班', at(-1, 8), at(-1, 17), 'cal-shift'),
    ev('夜班', at(3, 20), at(4, 8), 'cal-shift'),
    ev('白班', at(4, 16), at(4, 23), 'cal-shift'),
    ev('纪念日', dayAt(5), endOfDay(5), 'cal-holiday', { allDay: true }),
  ];
  // A weekly series: occurrences share one identifier
  for (let w = -6; w <= 6; w++) {
    const monday = C.addDays(C.startOfWeek(today, 1), w * 7);
    const s = C.dateOnDay(monday, 7 * 60 + 30).getTime();
    events.push({ id: 'evt-weekly', title: '科室例会', start: s, end: s + 3600e3, allDay: false, calendarId: 'cal-work', location: '', notes: '', series: true });
  }

  let reminders = [
    { id: nid('rem'), title: '回复会诊意见', notes: '', due: dayAt(0), hasTime: false, completed: false, completionDate: null, priority: 5, listId: 'list-work' },
    { id: nid('rem'), title: '交病历', notes: '', due: at(0, 17), hasTime: true, completed: false, completionDate: null, priority: 0, listId: 'list-work' },
    { id: nid('rem'), title: '续开处方', notes: '', due: dayAt(-1), hasTime: false, completed: false, completionDate: null, priority: 0, listId: 'list-main' },
    { id: nid('rem'), title: '准备病例讨论 PPT', notes: '', due: null, hasTime: false, completed: false, completionDate: null, priority: 0, listId: 'list-work' },
    { id: nid('rem'), title: '买牛奶', notes: '', due: null, hasTime: false, completed: false, completionDate: null, priority: 0, listId: 'list-main' },
    { id: nid('rem'), title: '预约体检', notes: '', due: null, hasTime: false, completed: false, completionDate: null, priority: 9, listId: 'list-main' },
    { id: nid('rem'), title: '查看化验结果', notes: '', due: dayAt(0), hasTime: false, completed: true, completionDate: at(0, 8, 40), priority: 0, listId: 'list-work' },
  ];
  let settings = { taskDurations: {} };
  let lastRange = null;
  const log = [];

  const uid = (e) => `${e.id}|${e.start}`;
  const findEvent = (u) => events.find((e) => uid(e) === u);
  const wait = () => new Promise((r) => setTimeout(r, 15));

  function data() {
    const r = lastRange || { start: dayAt(-60), end: dayAt(60) };
    return {
      calendars, lists, settings, version: 'preview',
      defaults: { eventCalendarId: 'cal-work', reminderListId: 'list-main' },
      events: events.filter((e) => !(settings.hidden || []).includes(e.calendarId) && e.start < r.end && e.end >= r.start)
        .map((e) => ({ uid: uid(e), id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendarId: e.calendarId, location: e.location, notes: e.notes })),
      reminders: reminders.filter((x) => !(settings.hidden || []).includes(x.listId) &&
        (!x.completed || (x.completionDate >= r.start && x.completionDate < r.end))).map((x) => Object.assign({}, x)),
    };
  }

  function createEvent(p) {
    const e = ev(p.title || '新日程', p.start, p.end, p.calendarId || 'cal-work', { allDay: !!p.allDay, location: p.location || '', notes: p.notes || '' });
    if (e.allDay) { e.start = C.startOfDay(e.start).getTime(); e.end = C.addDays(C.startOfDay(Math.max(p.end, p.start)), 1).getTime() - 1000; }
    events.push(e);
    return e;
  }

  const handlers = {
    load(p) { lastRange = p; return data(); },
    saveSettings(p) {
      settings = Object.assign({}, p.settings, { taskDurations: Object.assign({}, p.settings.taskDurations, settings.taskDurations) });
      return { ok: true, data: data() };
    },
    createEvent(p) { const e = createEvent(p); return { ok: true, uid: uid(e), data: data() }; },
    updateEvent(p) {
      const e = findEvent(p.uid);
      if (!e) return { error: '找不到这个日程' };
      if (e.series) return { recurring: true };
      for (const k of ['title', 'location', 'notes', 'calendarId']) if (p[k] != null) e[k] = p[k];
      if (p.allDay != null) e.allDay = p.allDay;
      if (p.start != null) e.start = p.start;
      if (p.end != null) e.end = e.allDay ? C.addDays(C.startOfDay(Math.max(p.end, e.start)), 1).getTime() - 1000 : p.end;
      return { ok: true, data: data() };
    },
    deleteEvent(p) {
      const e = findEvent(p.uid);
      if (e && e.series) return { recurring: true };
      events = events.filter((x) => x !== e);
      return { ok: true, data: data() };
    },
    editNative() { return { ok: true, data: data() }; },
    createReminder(p) {
      const r = { id: nid('rem'), title: p.title || '新待办', notes: p.notes || '', due: p.due != null ? p.due : null,
        hasTime: !!(p.due != null && p.hasTime), completed: false, completionDate: null, priority: p.priority || 0, listId: p.listId || 'list-main' };
      reminders.push(r);
      if (p.duration) settings.taskDurations[r.id] = p.duration;
      return { ok: true, id: r.id, data: data() };
    },
    updateReminder(p) {
      const r = reminders.find((x) => x.id === p.id);
      if (!r) return { error: '找不到这个待办' };
      for (const k of ['title', 'notes', 'priority', 'listId']) if (p[k] != null) r[k] = p[k];
      if ('due' in p) { r.due = p.due; r.hasTime = !!(p.due != null && p.hasTime); }
      if (p.completed != null) { r.completed = p.completed; r.completionDate = p.completed ? Date.now() : null; }
      if (p.duration) settings.taskDurations[p.id] = p.duration;
      return { ok: true, data: data() };
    },
    deleteReminder(p) { reminders = reminders.filter((x) => x.id !== p.id); return { ok: true, data: data() }; },
    batch(p) {
      for (const op of p.ops || []) {
        if (op.type === 'deleteEvent') handlers.deleteEvent(op);
        else if (op.type === 'createEvent') createEvent(op);
      }
      return { ok: true, data: data() };
    },
    openSettingsApp() { return { ok: true }; },
    selfUpdate() { return { ok: true, message: '预览版不需要更新' }; },
  };

  return {
    log,
    events: () => events,
    reminders: () => reminders,
    async handle(type, payload) {
      log.push({ type, payload });
      await wait();
      const fn = handlers[type];
      if (!fn) throw new Error('unknown ' + type);
      return JSON.parse(JSON.stringify(fn(payload)));
    },
  };
})();
