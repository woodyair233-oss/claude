// In-browser stand-in for the Scriptable side, used by preview.html and the UI
// tests. Same request/response shapes as scriptable.js, with sample data.
window.__MOCK__ = (function () {
  'use strict';
  const C = window.GlanceCore;
  const params = new URLSearchParams(location.search);
  const today = params.get('today') ? C.startOfDay(new Date(params.get('today'))) : C.startOfDay(new Date());
  const at = (dayOffset, h, m) => {
    const d = C.addDays(today, dayOffset);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m || 0).getTime();
  };
  const dayAt = (dayOffset) => C.addDays(today, dayOffset).getTime();
  const endOfDay = (dayOffset) => C.addDays(today, dayOffset + 1).getTime() - 1000;

  const calendars = [
    { id: 'cal-work', title: '工作', color: '#2F6FED', editable: true },
    { id: 'cal-home', title: '个人', color: '#34C759', editable: true },
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
    ev('文献阅读', at(0, 15), at(0, 16, 30), 'cal-home'),
    ev('夜间值班', at(1, 20), at(2, 8), 'cal-work'),
    ev('健身', at(1, 19), at(1, 20), 'cal-home'),
    ev('学术会议', dayAt(3), endOfDay(4), 'cal-work', { allDay: true }),
    ev('纪念日', dayAt(5), endOfDay(5), 'cal-holiday', { allDay: true }),
  ];
  // A weekly series: occurrences share one identifier
  for (let w = -6; w <= 6; w++) {
    const monday = C.addDays(C.startOfWeek(today, 1), w * 7);
    const s = monday.getTime() + 7.5 * 3600e3;
    events.push({ id: 'evt-weekly', title: '科室例会', start: s, end: s + 3600e3, allDay: false, calendarId: 'cal-work', location: '', notes: '', series: true });
  }

  const task = (title, due, extra) => Object.assign({ id: nid('rem'), title, notes: '', due, hasTime: false, completed: false,
    completionDate: null, priority: 0, listId: 'list-main' }, extra || {});
  let reminders = [
    task('回复会诊意见', dayAt(0), { priority: 5, listId: 'list-work' }),
    task('交病历', dayAt(0), { listId: 'list-work' }),
    task('续开处方', dayAt(-1)),
    task('整理随访名单', dayAt(2), { listId: 'list-work' }),
    task('准备病例讨论 PPT', null, { listId: 'list-work' }),
    task('买牛奶', null),
    task('预约体检', null, { priority: 9 }),
    task('更新简历', null),
    task('查看化验结果', dayAt(0), { completed: true, completionDate: at(0, 8, 40), listId: 'list-work' }),
  ];
  let settings = {};
  let lastRange = null;
  const log = [];

  const uid = (e) => `${e.id}|${e.start}`;
  const findEvent = (u) => events.find((e) => uid(e) === u);
  const wait = () => new Promise((r) => setTimeout(r, 15));

  function data() {
    const r = lastRange || { start: dayAt(-60), end: dayAt(60) };
    const hidden = settings.hidden || [];
    return {
      calendars, lists, settings, version: 'preview',
      defaults: { reminderListId: 'list-main' },
      events: events.filter((e) => !hidden.includes(e.calendarId) && e.start < r.end && e.end >= r.start)
        .map((e) => ({ uid: uid(e), id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendarId: e.calendarId, location: e.location, notes: e.notes })),
      reminders: reminders.filter((x) => !hidden.includes(x.listId) &&
        (!x.completed || (x.completionDate >= r.start && x.completionDate < r.end))).map((x) => Object.assign({}, x)),
    };
  }

  const handlers = {
    load(p) { lastRange = p; return data(); },
    saveSettings(p) { settings = Object.assign({}, p.settings); return { ok: true, data: data() }; },
    updateEvent(p) {
      const e = findEvent(p.uid);
      if (!e) return { error: '找不到这个日程' };
      if (e.series) return { recurring: true };
      for (const k of ['title', 'location', 'notes', 'calendarId']) if (p[k] != null) e[k] = p[k];
      if (p.start != null) e.start = p.start;
      if (p.end != null) e.end = Math.max(p.end, e.start);
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
      const r = task(p.title || '新待办', p.due != null ? p.due : null,
        { hasTime: !!(p.due != null && p.hasTime), priority: p.priority || 0, listId: p.listId || 'list-main', notes: p.notes || '' });
      reminders.push(r);
      return { ok: true, id: r.id, data: data() };
    },
    updateReminder(p) {
      const r = reminders.find((x) => x.id === p.id);
      if (!r) return { error: '找不到这个待办' };
      for (const k of ['title', 'notes', 'priority', 'listId']) if (p[k] != null) r[k] = p[k];
      if ('due' in p) { r.due = p.due; r.hasTime = !!(p.due != null && p.hasTime); }
      if (p.completed != null) { r.completed = p.completed; r.completionDate = p.completed ? Date.now() : null; }
      return { ok: true, data: data() };
    },
    deleteReminder(p) { reminders = reminders.filter((x) => x.id !== p.id); return { ok: true, data: data() }; },
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
