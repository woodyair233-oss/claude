// A minimal stand-in for the Scriptable runtime, so dist/一览.js can run in
// Node: EventKit-like classes over an in-memory store, and a WebView backed by
// a real Chromium page (Playwright).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const DAY = 864e5;

export function createStore() {
  let seq = 0;
  const store = {
    granted: true,
    calendars: [],
    events: [],
    reminders: [],
    files: new Map(),
    pending: [],
    nativeEdits: [],
    opened: [],
    widget: null,
    shortcutOutput: null,
    completed: false,
    nextId: (p) => `${p}${++seq}`,
  };
  return store;
}

export function makeGlobals(store, { page, args = {}, config = {} } = {}) {
  class Color {
    constructor(hex) { this.hex = String(hex).replace('#', '').toUpperCase(); }
    static dynamic(light) { return light; }
    static white() { return new Color('FFFFFF'); }
    static red() { return new Color('FF0000'); }
  }

  class Calendar {
    constructor(init) { Object.assign(this, { isSubscribed: false, allowsContentModifications: true }, init); }
    static check() { if (!store.granted) throw new Error('Access denied'); }
    static async forEvents() { Calendar.check(); return store.calendars.filter((c) => c.type === 'event'); }
    static async forReminders() { Calendar.check(); return store.calendars.filter((c) => c.type === 'reminder'); }
    static async defaultForEvents() { return (await Calendar.forEvents())[0]; }
    static async defaultForReminders() { return (await Calendar.forReminders())[0]; }
    static async findOrCreateForReminders(title) {
      let c = store.calendars.find((x) => x.type === 'reminder' && x.title === title);
      if (!c) { c = new Calendar({ identifier: store.nextId('L'), title, type: 'reminder', color: new Color('888888') }); store.calendars.push(c); }
      return c;
    }
  }

  class CalendarEvent {
    constructor() { this.title = ''; this.location = ''; this.notes = ''; this.isAllDay = false; }
    static async between(s, e, cals) {
      Calendar.check();
      return store.events.filter((ev) => ev.startDate < e && ev.endDate > s && (!cals || cals.includes(ev.calendar)));
    }
    save() {
      if (!this.identifier) { this.identifier = store.nextId('E'); store.events.push(this); }
      this.saved = (this.saved || 0) + 1;
    }
    remove() { store.events = store.events.filter((e) => e !== this); }
    async presentEdit() { store.nativeEdits.push(this.identifier); return this; }
  }

  class Reminder {
    constructor() { this.title = ''; this.notes = ''; this.isCompleted = false; this.priority = 0; this.dueDate = null; this.dueDateIncludesTime = false; this.completionDate = null; }
    static async all(lists) { return store.reminders.filter((r) => !lists || lists.includes(r.calendar)); }
    static async allIncomplete(lists) { return (await Reminder.all(lists)).filter((r) => !r.isCompleted); }
    static async completedBetween(s, e, lists) {
      return (await Reminder.all(lists)).filter((r) => r.isCompleted && r.completionDate >= s && r.completionDate < e);
    }
    save() {
      if (!this.identifier) { this.identifier = store.nextId('R'); store.reminders.push(this); }
      if (this.isCompleted && !this.completionDate) this.completionDate = new Date();
      if (!this.isCompleted) this.completionDate = null;
    }
    remove() { store.reminders = store.reminders.filter((r) => r !== this); }
  }

  class Notification {
    constructor() { this.identifier = ''; this.title = ''; this.body = ''; }
    static async allPending() { return store.pending.slice(); }
    static async removePending(ids) { store.pending = store.pending.filter((n) => !ids.includes(n.identifier)); }
    setTriggerDate(d) { this.trigger = d; }
    async schedule() { store.pending = store.pending.filter((n) => n.identifier !== this.identifier || !this.identifier); store.pending.push(this); }
  }

  const fileManager = () => ({
      documentsDirectory: () => '/docs',
      joinPath: (a, b) => `${a}/${b}`,
      fileExists: (p) => store.files.has(p) || p === '/docs/oneglance',
      createDirectory: () => {},
      readString: (p) => store.files.get(p),
      writeString: (p, s) => store.files.set(p, s),
  });
  const FileManager = { local: fileManager, iCloud: fileManager };

  class Stack {
    constructor() { this.items = []; }
    addText(t) { const x = { text: t }; this.items.push(x); return x; }
    addStack() { const s = new Stack(); this.items.push(s); return s; }
    addSpacer() {}
    setPadding() {}
    layoutHorizontally() {}
    centerAlignContent() {}
    texts() { return this.items.flatMap((i) => (i instanceof Stack ? i.texts() : [i.text])); }
  }
  class ListWidget extends Stack {}

  let closeWebView;
  const webViewClosed = new Promise((r) => { closeWebView = r; });
  class WebView {
    async loadHTML(html) { await page.setContent(html); }
    async evaluateJavaScript(js, useCallback) {
      if (!useCallback) return page.evaluate(js);
      // `completion` is visible to the evaluated code, as in Scriptable
      return page.evaluate((code) => new Promise((completion) => { eval(code); }), js);
    }
    present() { return webViewClosed; }
  }

  const font = () => ({});
  return {
    globals: {
      Color, Calendar, CalendarEvent, Reminder, Notification, FileManager, ListWidget, WebView,
      Font: new Proxy({}, { get: () => font }),
      Size: class { constructor(w, h) { this.w = w; this.h = h; } },
      URLScheme: { forRunningScript: () => 'scriptable:///run/%E4%B8%80%E8%A7%88' },
      Safari: { open: (u) => store.opened.push(u) },
      Request: class { constructor(url) { this.url = url; } async loadString() { store.requests = (store.requests || []).concat(this.url); return store.remote; } },
      module: { filename: '/docs/一览.js', exports: {} },
      Script: {
        setWidget: (w) => { store.widget = w; },
        setShortcutOutput: (v) => { store.shortcutOutput = v; },
        complete: () => { store.completed = true; },
      },
      config: Object.assign({ runsInApp: true, runsInWidget: false, runsInAccessoryWidget: false, runsWithSiri: false, widgetFamily: null }, config),
      args: Object.assign({ plainTexts: [], urls: [], fileURLs: [], images: [], queryParameters: {}, shortcutParameter: null }, args),
      log: () => {},
      logError: (e) => { store.errors = (store.errors || []).concat(String(e)); },
      console,
    },
    closeWebView,
    Color, Calendar,
  };
}

/** Runs the bundled script; resolves when it finishes. */
export function runScript(path, globals) {
  const code = readFileSync(path, 'utf8');
  const context = vm.createContext(Object.assign({}, globals));
  return new vm.Script(`(async () => {\n${code}\n})()`, { filename: '一览.js' }).runInContext(context);
}

export function seed(store, env, today) {
  const { Color, Calendar } = env;
  const work = new Calendar({ identifier: 'C-work', title: '工作', type: 'event', color: new Color('2F6FED') });
  const shift = new Calendar({ identifier: 'C-shift', title: '排班', type: 'event', color: new Color('6366F1') });
  const holiday = new Calendar({ identifier: 'C-hol', title: '节假日', type: 'event', color: new Color('E5383B'), isSubscribed: true, allowsContentModifications: false });
  const inbox = new Calendar({ identifier: 'L-main', title: '提醒事项', type: 'reminder', color: new Color('F08C00') });
  store.calendars.push(work, shift, holiday, inbox);
  const at = (d, h, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + d, h, m);
  const add = (cls, init) => { const o = Object.assign(new cls(), init); store[cls === env.globals.Reminder ? 'reminders' : 'events'].push(o); return o; };
  const E = env.globals.CalendarEvent;
  const R = env.globals.Reminder;
  add(E, { identifier: 'E-clinic', title: '门诊', startDate: at(0, 9), endDate: at(0, 12), calendar: work });
  add(E, { identifier: 'E-holiday', title: '纪念日', startDate: at(1, 0), endDate: at(1, 23, 59), isAllDay: true, calendar: holiday });
  // A yearly series: only one occurrence falls inside the loaded weeks
  add(E, { identifier: 'E-yearly', title: '年度体检', startDate: at(0, 14), endDate: at(0, 15), calendar: work });
  add(E, { identifier: 'E-yearly', title: '年度体检', startDate: at(365, 14), endDate: at(365, 15), calendar: work });
  add(R, { identifier: 'R-1', title: '回复会诊意见', dueDate: at(0, 0), calendar: inbox });
  add(R, { identifier: 'R-2', title: '交病历', dueDate: at(1, 17), dueDateIncludesTime: true, calendar: inbox });
  add(R, { identifier: 'R-3', title: '买牛奶', calendar: inbox });
  return { at, work, shift, inbox };
}

export { DAY };
