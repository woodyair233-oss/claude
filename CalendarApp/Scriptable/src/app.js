// 一览 web UI. Runs inside Scriptable's WebView (data via the Scriptable
// bridge) or in a desktop browser with the mock bridge (preview / tests).
(function () {
  'use strict';
  const C = window.GlanceCore;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const pad = (n) => String(n).padStart(2, '0');
  const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fromInputs = (dv, tv) => {
    const [y, m, d] = (dv || '').split('-').map(Number);
    const [h, mi] = (tv || '00:00').split(':').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, h || 0, mi || 0);
  };

  const DEFAULT_SETTINGS = {
    hidden: [], weekStart: 1, capacityHours: 8, defaultEventMinutes: 60, defaultTaskMinutes: 30,
    restHours: 11, showCompleted: true, hourHeight: 56, dayStyle: 'timeline',
    shiftCalendarId: null, defaultEventCalendarId: null, defaultReminderListId: null,
    shiftTemplates: C.shifts.defaults(), taskDurations: {}, notifyTasks: true,
  };

  const S = {
    ready: false, error: null,
    calendars: [], lists: [], events: [], reminders: [], defaults: {},
    settings: Object.assign({}, DEFAULT_SETTINGS),
    mode: 'day', day: C.startOfDay(new Date()), range: null,
    trayCollapsed: false, showInbox: false, listInbox: false,
    brushOn: false, brush: null, menu: false,
    sheet: null, toast: null, override: 'automatic',
    viewKey: '', blocks: {}, loading: false,
  };
  const ws = () => S.settings.weekStart;

  // ------------------------------------------------------------- bridge

  const Bridge = (() => {
    let seq = 0;
    const pending = new Map();
    let queue = [];
    let waiter = null;
    let timer = null;
    const flush = () => {
      if (waiter && queue.length) {
        const w = waiter;
        waiter = null;
        clearTimeout(timer);
        w(queue.splice(0));
      }
    };
    // Scriptable calls `__nextMessages(completion)` with evaluateJavaScript(…, true)
    // and gets the queued messages back through `completion` (long poll).
    window.__nextMessages = function (completion) {
      const done = completion || window.completion;
      if (queue.length) { done(queue.splice(0)); return; }
      waiter = done;
      timer = setTimeout(() => { if (waiter === done) { waiter = null; done([]); } }, 2000);
    };
    window.__reply = (id, ok, result) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(result));
    };
    return {
      call(type, payload) {
        if (window.__MOCK__) return window.__MOCK__.handle(type, JSON.parse(JSON.stringify(payload || {})));
        return new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          queue.push({ id, type, payload: payload || {} });
          flush();
        });
      },
    };
  })();

  // ------------------------------------------------------------- data

  function rangeAround(day) {
    const grid = C.monthGrid(day, ws());
    return { start: C.addDays(grid[0], -7).getTime(), end: C.addDays(grid[41], 8).getTime() };
  }

  async function load(force) {
    const need = rangeAround(S.day);
    if (!force && S.range && need.start >= S.range.start && need.end <= S.range.end) return;
    S.range = need;
    await refresh();
  }

  async function refresh() {
    if (!S.range) S.range = rangeAround(S.day);
    S.loading = true;
    try {
      apply(await Bridge.call('load', S.range));
    } catch (err) {
      toast('读取失败：' + err.message);
    } finally {
      S.loading = false;
    }
  }

  let lastDataJSON = '';
  function apply(res) {
    if (!res) return;
    if (res.data) res = res.data;
    if (res.error) {
      S.error = res.error;
      S.ready = true;
      render();
      return;
    }
    const json = JSON.stringify(res);
    if (json === lastDataJSON && S.ready && !S.error) return;
    lastDataJSON = json;
    S.error = null;
    S.calendars = res.calendars || [];
    S.lists = res.lists || [];
    S.defaults = res.defaults || {};
    S.version = res.version || '';
    S.settings = Object.assign({}, DEFAULT_SETTINGS, res.settings || {});
    if (!S.settings.shiftTemplates || !S.settings.shiftTemplates.length) S.settings.shiftTemplates = C.shifts.defaults();
    enrich(res.events || [], res.reminders || []);
    S.ready = true;
    if (!Gest.active) render();
  }

  function enrich(events, reminders) {
    const cal = Object.fromEntries(S.calendars.map((c) => [c.id, c]));
    const list = Object.fromEntries(S.lists.map((l) => [l.id, l]));
    const count = {};
    for (const e of events) count[e.id] = (count[e.id] || 0) + 1;
    const tpls = S.settings.shiftTemplates;
    S.events = events.map((e) => {
      const c = cal[e.calendarId] || {};
      return Object.assign({}, e, {
        start: new Date(e.start), end: new Date(e.end),
        color: c.color || '#8e8e93', calTitle: c.title || '',
        canEdit: c.editable !== false,
        recurring: !!e.recurring || count[e.id] > 1,
        shift: C.shifts.match(tpls, e.title),
      });
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    S.reminders = reminders.map((r) => {
      const l = list[r.listId] || {};
      const due = r.due != null ? new Date(r.due) : null;
      const duration = S.settings.taskDurations[r.id] || S.settings.defaultTaskMinutes;
      return Object.assign({}, r, {
        due, completionDate: r.completionDate != null ? new Date(r.completionDate) : null,
        color: l.color || '#f08c00', listTitle: l.title || '', duration,
        end: due ? new Date(due.getTime() + duration * 60e3) : null,
      });
    });
    agendaCache.clear();
  }

  const agendaCache = new Map();
  function agenda(day) {
    const start = C.startOfDay(day);
    const key = start.getTime();
    if (agendaCache.has(key)) return agendaCache.get(key);
    const end = C.addDays(start, 1);
    const isToday = C.sameDay(start, new Date());
    const a = { day: start, shifts: [], allDay: [], timed: [], overdue: [], untimed: [], timedTasks: [], completed: [] };
    for (const e of S.events) {
      if (!(e.start < end && (e.end > start || (+e.end === +e.start && e.start >= start)))) continue;
      if (e.shift) {
        if (C.sameDay(e.start, start)) a.shifts.push(e);
        if (!e.shift.isAllDay && !e.allDay) a.timed.push(e);
      } else if (e.allDay) a.allDay.push(e);
      else a.timed.push(e);
    }
    for (const r of S.reminders) {
      if (r.completed) {
        const d = r.completionDate || r.due;
        if (d && C.sameDay(d, start)) a.completed.push(r);
      } else if (r.due) {
        if (C.sameDay(r.due, start)) (r.hasTime ? a.timedTasks : a.untimed).push(r);
        else if (isToday && r.due < start) a.overdue.push(r);
      }
    }
    const pr = (p) => (p === 0 ? 10 : p);
    a.untimed.sort((x, y) => pr(x.priority) - pr(y.priority) || x.title.localeCompare(y.title));
    a.timedTasks.sort((x, y) => x.due - y.due);
    a.pending = a.overdue.length + a.untimed.length + a.timedTasks.length;
    agendaCache.set(key, a);
    return a;
  }

  const inbox = () => S.reminders.filter((r) => !r.completed && !r.due);

  function loadLevel(day) {
    const a = agenda(day);
    const iv = a.timed.map((e) => ({ start: C.minuteOfDay(e.start, day), end: C.minuteOfDay(e.end, day) }));
    for (const t of a.timedTasks) {
      const s = C.minuteOfDay(t.due, day);
      iv.push({ start: s, end: s + t.duration });
    }
    return C.loadLevel(C.busyMinutes(iv) + a.untimed.length * 15, S.settings.capacityHours * 60);
  }

  function shortRest(ev) {
    if (!ev.shift || ev.shift.isAllDay || ev.allDay) return null;
    let prev = null;
    for (const e of S.events) {
      if (e === ev || !e.shift || e.shift.isAllDay || e.allDay || e.start >= ev.start) continue;
      if (!prev || e.end > prev.end) prev = e;
    }
    if (!prev) return null;
    const h = (ev.start - prev.end) / 3600e3;
    return h < S.settings.restHours ? Math.max(h, 0) : null;
  }

  const findEvent = (uid) => S.events.find((e) => e.uid === uid);
  const findTask = (id) => S.reminders.find((r) => r.id === id);
  const editableCalendars = () => S.calendars.filter((c) => c.editable);
  const editableLists = () => S.lists.filter((l) => l.editable !== false);
  const defaultCalendarId = () => S.settings.defaultEventCalendarId || S.defaults.eventCalendarId || (editableCalendars()[0] || {}).id;
  const defaultListId = () => S.settings.defaultReminderListId || S.defaults.reminderListId || (editableLists()[0] || {}).id;
  const shiftCalendarId = () => S.settings.shiftCalendarId || defaultCalendarId();
  const byHint = (hint, items) => {
    if (!hint) return null;
    const h = hint.toLowerCase();
    return items.find((c) => c.title.toLowerCase() === h) || items.find((c) => c.title.toLowerCase().startsWith(h)) ||
      items.find((c) => c.title.toLowerCase().includes(h)) || null;
  };

  // ------------------------------------------------------------- mutations

  async function mutate(type, payload, okMessage, undo) {
    try {
      const res = await Bridge.call(type, payload);
      if (res && res.recurring) {
        toast('这是重复日程：为免改到整个系列，请用系统编辑器修改', {
          label: '打开', fn: () => mutate('editNative', { uid: payload.uid }),
        });
        await refresh();
        return null;
      }
      if (res && res.error) {
        toast('操作失败：' + res.error);
        await refresh();
        return null;
      }
      if (res && res.data) apply(res.data);
      else if (!(res && res.message)) await refresh();
      if (res && res.message) toast(res.message);
      if (okMessage) toast(okMessage, undo ? { label: '撤销', fn: () => undo(res) } : null);
      return res;
    } catch (err) {
      toast('操作失败：' + err.message);
      await refresh();
      return null;
    }
  }

  function optimistic(fn) {
    fn();
    lastDataJSON = '';
    agendaCache.clear();
    render();
  }

  function moveEvent(ev, newStart, newEnd) {
    optimistic(() => { ev.start = newStart; ev.end = newEnd; });
    return mutate('updateEvent', { uid: ev.uid, start: +newStart, end: +newEnd, allDay: ev.allDay });
  }

  function scheduleTask(task, due, hasTime) {
    optimistic(() => {
      task.due = due;
      task.hasTime = !!(due && hasTime);
      task.end = due ? new Date(due.getTime() + task.duration * 60e3) : null;
    });
    return mutate('updateReminder', { id: task.id, due: due ? +due : null, hasTime: !!(due && hasTime) });
  }

  function toggleTask(task) {
    optimistic(() => {
      task.completed = !task.completed;
      task.completionDate = task.completed ? new Date() : null;
    });
    return mutate('updateReminder', { id: task.id, completed: task.completed });
  }

  function setTaskDuration(task, minutes) {
    optimistic(() => {
      task.duration = Math.max(15, minutes);
      task.end = task.due ? new Date(task.due.getTime() + task.duration * 60e3) : null;
    });
    return mutate('updateReminder', { id: task.id, duration: task.duration });
  }

  function postpone(task, days) {
    const today = C.startOfDay(new Date());
    const base = task.due && task.due > today ? task.due : (task.hasTime && task.due ? new Date(today.getTime() + C.minuteOfDay(task.due, task.due) * 60e3) : today);
    return scheduleTask(task, C.addDays(base, days), task.hasTime);
  }

  /** Brush: the same shift again removes it, another one replaces it. */
  function applyShift(template, day) {
    const existing = agenda(day).shifts;
    const same = existing.some((e) => e.shift && e.shift.id === template.id);
    const ops = existing.map((e) => ({ type: 'deleteEvent', uid: e.uid }));
    if (!same) {
      const iv = C.shifts.interval(template, day);
      ops.push({
        type: 'createEvent', title: template.name, allDay: !!template.isAllDay,
        start: +iv.start, end: +(template.isAllDay ? iv.start : iv.end), calendarId: shiftCalendarId(),
      });
    }
    return mutate('batch', { ops });
  }

  function clearShifts(day) {
    const ops = agenda(day).shifts.map((e) => ({ type: 'deleteEvent', uid: e.uid }));
    if (ops.length) return mutate('batch', { ops });
  }

  function saveSettings(patch) {
    Object.assign(S.settings, patch);
    return mutate('saveSettings', { settings: S.settings });
  }

  // ------------------------------------------------------------- toast

  let toastTimer = null;
  function toast(message, action) {
    S.toast = { message, action, id: Date.now() };
    renderToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { S.toast = null; renderToast(); }, action ? 5000 : 3000);
  }

  function renderToast() {
    let el = $('#toast');
    if (!S.toast) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      $('#main').appendChild(el);
    }
    el.innerHTML = `<span>${esc(S.toast.message)}</span>` +
      (S.toast.action ? `<button data-act="toast-action">${esc(S.toast.action.label)}</button>` : '');
  }

  // ------------------------------------------------------------- render

  function render() {
    renderHeader();
    renderMain();
    renderPreview();
    renderToast();
  }

  function renderHeader() {
    const hdr = $('#hdr');
    if (!S.ready || S.error) { hdr.innerHTML = ''; return; }
    const day = S.day;
    let title;
    if (S.mode === 'day') title = C.fmt.mdw(day);
    else if (S.mode === 'week') {
      const d = C.weekDays(day, ws());
      title = `${C.fmt.md(d[0])}–${C.sameMonth(d[0], d[6]) ? d[6].getDate() + '日' : C.fmt.md(d[6])}`;
    } else title = C.fmt.ym(day);

    const a = agenda(day);
    const parts = [];
    if (S.mode !== 'day') parts.push(C.fmt.relativeDay(day));
    else if (C.sameDay(day, new Date())) parts.push('今天');
    for (const s of a.shifts) parts.push(s.shift.name);
    const evCount = a.timed.filter((e) => !e.shift).length + a.allDay.length;
    if (evCount) parts.push(`${evCount}个日程`);
    if (a.pending) parts.push(`${a.pending}个待办`);
    if (a.overdue.length) parts.push(`逾期${a.overdue.length}`);
    if (!parts.length || (parts.length === 1 && parts[0] === '今天')) parts.push('没有安排');

    const isToday = C.sameDay(day, new Date()) && S.mode === 'day';
    hdr.innerHTML = `
      <div class="hdr">
        <div class="hdr-row">
          <div class="hdr-title"><h1>${esc(title)}</h1><p>${esc(parts.join(' · '))}</p></div>
          <button class="icon-btn" data-act="prev" aria-label="上一页">‹</button>
          <button class="text-btn" data-act="today" ${isToday ? 'disabled' : ''}>今天</button>
          <button class="icon-btn" data-act="next" aria-label="下一页">›</button>
          <button class="icon-btn" data-act="settings" aria-label="设置">⚙︎</button>
        </div>
        <div class="seg-row">
          <div class="seg">${['day', 'week', 'month'].map((m) =>
            `<button data-act="mode" data-v="${m}" class="${S.mode === m ? 'on' : ''}">${{ day: '日', week: '周', month: '月' }[m]}</button>`).join('')}</div>
          ${S.mode === 'day' ? `<button class="style-btn" data-act="style" aria-label="${S.settings.dayStyle === 'timeline' ? '切换到清单' : '切换到时间轴'}">${S.settings.dayStyle === 'timeline' ? '清单' : '时间轴'}</button>` : ''}
        </div>
        ${S.mode === 'day' ? stripHTML() : ''}
      </div>`;
  }

  function stripHTML() {
    return `<div class="strip" data-swipe="week">${C.weekDays(S.day, ws()).map((d) => {
      const a = agenda(d);
      const shift = a.shifts[0] && a.shifts[0].shift;
      const mark = shift ? badge(shift) : `<span class="loadbar" style="background:${heat(loadLevel(d))}"></span>`;
      return `<div class="strip-day ${C.sameDay(d, S.day) ? 'sel' : ''} ${C.sameDay(d, new Date()) ? 'today' : ''}"
        data-act="pick" data-day="${+d}" data-drop-day="${+d}">
        <span class="wd">${C.fmt.weekdayLetter(d)}</span><span class="num">${d.getDate()}</span>
        <span class="mark">${mark}</span></div>`;
    }).join('')}</div>`;
  }

  const heat = (level) => level ? `rgba(var(--heat), ${[0, 0.16, 0.32, 0.52, 0.78][level]})` : 'var(--surface2)';
  const badge = (t, size) => `<span class="badge" style="background:${esc(t.color)};${size ? `font-size:${size}px;` : ''}">${esc(t.shortName || t.name.slice(0, 1))}</span>`;

  function viewKey() {
    if (S.mode === 'day') return `day:${+S.day}:${S.settings.dayStyle}`;
    if (S.mode === 'week') return `week:${+C.startOfWeek(S.day, ws())}`;
    return `month:${S.day.getFullYear()}-${S.day.getMonth()}`;
  }

  function renderMain() {
    const main = $('#main');
    if (!S.ready) {
      main.innerHTML = `<div class="center-msg"><p>正在读取日历…</p></div>`;
      return;
    }
    if (S.error) {
      main.innerHTML = errorHTML();
      return;
    }
    const key = viewKey();
    const keep = key === S.viewKey;
    const scrollers = {};
    if (keep) for (const el of $$('[data-keep-scroll]', main)) scrollers[el.dataset.keepScroll] = el.scrollTop;
    S.blocks = {};
    let html;
    if (S.mode === 'day') html = S.settings.dayStyle === 'timeline' ? trayHTML() + gridHTML([S.day], false) : listHTML();
    else if (S.mode === 'week') html = weekHTML();
    else html = monthHTML();
    main.innerHTML = html;
    if (keep) {
      for (const el of $$('[data-keep-scroll]', main)) {
        if (scrollers[el.dataset.keepScroll] != null) el.scrollTop = scrollers[el.dataset.keepScroll];
      }
    } else {
      scrollGridToFocus();
    }
    S.viewKey = key;
  }

  function errorHTML() {
    if (S.error === 'permission') {
      return `<div class="center-msg"><h2>需要日历权限</h2>
        <p>「一览」通过 Scriptable 读写系统的日历与提醒事项。请到「设置 → Scriptable」打开「日历」与「提醒事项」（选择完全访问）。</p>
        <button class="primary" data-act="open-settings-app">打开设置</button>
        <button class="text-btn" data-act="reload">我已开启，重新读取</button></div>`;
    }
    return `<div class="center-msg"><h2>读取失败</h2><p>${esc(S.error)}</p><button class="primary" data-act="reload">重试</button></div>`;
  }

  // ----- tray

  function trayHTML() {
    const a = agenda(S.day);
    const ib = inbox();
    const showDone = S.settings.showCompleted;
    const has = a.shifts.length || a.allDay.length || a.pending || (showDone && a.completed.length);
    const sum = [];
    if (a.allDay.length) sum.push(`全天 ${a.allDay.length}`);
    if (a.untimed.length + a.timedTasks.length) sum.push(`待办 ${a.untimed.length + a.timedTasks.length}`);
    if (a.overdue.length) sum.push(`逾期 ${a.overdue.length}`);
    if (a.completed.length) sum.push(`已完成 ${a.completed.length}`);
    return `<div class="tray">
      <div class="tray-head"><span class="grow">${sum.length ? sum.join(' · ') : '没有全天事项或待办'}</span>
        ${ib.length ? `<button class="pill-btn" data-act="inbox">未排期 ${ib.length} ${S.showInbox ? '▴' : '▾'}</button>` : ''}
        ${has ? `<button class="pill-btn" data-act="collapse">${S.trayCollapsed ? '展开' : '收起'}</button>` : ''}
      </div>
      ${has && !S.trayCollapsed ? `<div class="tray-body" data-keep-scroll="tray">
        ${a.shifts.map(shiftBannerHTML).join('')}
        <div class="chips">
          ${a.allDay.map(eventChipHTML).join('')}
          ${a.overdue.map((t) => taskChipHTML(t, { overdue: true })).join('')}
          ${a.untimed.map((t) => taskChipHTML(t)).join('')}
          ${a.timedTasks.map((t) => taskChipHTML(t, { time: true })).join('')}
          ${showDone ? a.completed.map((t) => taskChipHTML(t)).join('') : ''}
        </div></div>` : ''}
      ${S.showInbox && ib.length ? `<div class="inbox"><div class="hint">长按拖到时间轴即排进当天；也可拖到上方日期</div>
        <div class="chips" data-keep-scroll="inbox">${ib.map((t) => taskChipHTML(t)).join('')}</div></div>` : ''}
    </div>`;
  }

  function shiftBannerHTML(e) {
    const t = e.shift;
    const rest = shortRest(e);
    return `<div class="shift-banner" style="--c:${esc(t.color)}" data-act="open-event" data-uid="${esc(e.uid)}">
      ${badge(t)}<span class="name">${esc(t.name)}</span>
      <span class="muted mono">${e.allDay || t.isAllDay ? '全天' : C.fmt.range(e.start, e.end)}</span>
      ${rest != null ? `<span class="warn">⚠︎ 距上一班 ${rest.toFixed(1)} 小时</span>` : ''}</div>`;
  }

  function eventChipHTML(e) {
    return `<div class="chip" style="--c:${esc(e.color)}" data-act="open-event" data-uid="${esc(e.uid)}">
      <span class="dot"></span><span class="t">${esc(e.title || '（无标题）')}</span></div>`;
  }

  const prioMark = (p) => (p >= 1 && p <= 4 ? '!!!' : p === 5 ? '!!' : p >= 6 && p <= 9 ? '!' : '');

  function taskChipHTML(t, opt) {
    const o = opt || {};
    const pm = prioMark(t.priority);
    return `<div class="chip ${t.completed ? 'done' : ''} ${o.overdue ? 'overdue' : ''}" style="--c:${esc(t.color)}"
        data-act="open-task" data-task="${esc(t.id)}" data-drag="chip">
      <span class="check ${t.completed ? 'on' : ''}" data-act="toggle" data-task="${esc(t.id)}">${t.completed ? '✓' : ''}</span>
      ${pm ? `<span class="prio">${pm}</span>` : ''}<span class="t">${esc(t.title || '（无标题）')}</span>
      ${o.time && t.due ? `<span class="sub mono">${C.fmt.hm(t.due)}</span>` : ''}
      ${o.overdue && t.due ? `<span class="sub red">${C.fmt.md(t.due)}</span>` : ''}</div>`;
  }

  // ----- time grid

  function hourHeight(compact) {
    return compact ? 44 : clamp(S.settings.hourHeight || 56, 28, 160);
  }

  function makeBlocks(days) {
    const out = [];
    days.forEach((day, i) => {
      const a = agenda(day);
      for (const e of a.timed) {
        const s = Math.max(0, C.minuteOfDay(e.start, day));
        const en = Math.min(1440, C.minuteOfDay(e.end, day));
        if (!(en > s || +e.end === +e.start)) continue;
        out.push({ id: `${i}|e|${e.uid}`, dayIndex: i, src: 'e', ref: e, start: s, end: Math.max(en, s),
          title: e.title || '（无标题）', color: e.shift ? e.shift.color : e.color, canEdit: e.canEdit, task: false,
          detail: e.location || '' });
      }
      for (const t of a.timedTasks) {
        const s = C.minuteOfDay(t.due, day);
        out.push({ id: `${i}|t|${t.id}`, dayIndex: i, src: 't', ref: t, start: s, end: Math.min(1440, s + t.duration),
          title: t.title || '（无标题）', color: t.color, canEdit: true, task: true, detail: t.listTitle });
      }
    });
    return out;
  }

  function gridHTML(days, compact) {
    const hh = hourHeight(compact);
    const n = days.length;
    const gutter = compact ? 30 : 46;
    const minH = compact ? 16 : 22;
    const blocks = makeBlocks(days);
    let blocksHTML = '';
    days.forEach((day, i) => {
      const col = blocks.filter((b) => b.dayIndex === i);
      const slots = C.layoutTimeline(col.map((b) => ({ id: b.id, start: b.start, end: b.end })), minH / hh * 60);
      for (const b of col) {
        b.slot = slots[b.id] || { column: 0, columnCount: 1, span: 1 };
        S.blocks[b.id] = b;
        blocksHTML += blockHTML(b, n, compact, minH, hh);
      }
    });
    let hours = '';
    for (let h = 0; h < 24; h++) {
      hours += `<div class="hour" style="top:calc(var(--hh) * ${h} * 1px)">${h ? `<span>${compact ? h : pad(h) + ':00'}</span>` : ''}</div>`;
      if (!compact && hh >= 80) hours += `<div class="hour half" style="top:calc(var(--hh) * ${h + 0.5} * 1px)"></div>`;
    }
    let cols = '';
    if (n > 1) days.forEach((d, i) => {
      cols += `<div class="colbg ${C.sameDay(d, new Date()) ? 'today' : ''}" style="left:calc(var(--gutter) + (100% - var(--gutter)) * ${i / n});width:calc((100% - var(--gutter)) / ${n})"></div>`;
    });
    const ti = days.findIndex((d) => C.sameDay(d, new Date()));
    const now = ti >= 0 ? `<div class="now" data-now="${ti}" style="top:calc(var(--hh) * ${C.minuteOfDay(new Date(), days[ti]) / 60} * 1px);left:calc(var(--gutter) + (100% - var(--gutter)) * ${ti / n});width:calc((100% - var(--gutter)) / ${n})"></div>` : '';
    return `<div class="grid-scroll" data-grid data-keep-scroll="grid" data-days="${days.map((d) => +d).join(',')}" data-compact="${compact ? 1 : 0}">
      <div class="grid" style="--hh:${hh};--gutter:${gutter}px">
        ${hours}${cols}<div class="surface" data-drag="create" data-act="surface"></div>${blocksHTML}${now}
      </div></div>`;
  }

  function blockHTML(b, n, compact, minH, hh) {
    const x = (b.dayIndex + b.slot.column / b.slot.columnCount) / n;
    const w = b.slot.span / b.slot.columnCount / n;
    const len = b.end - b.start;
    const px = Math.max(len / 60 * hh - 1, minH);
    const lines = compact ? Math.max(1, Math.floor(px / 12)) : (px > 44 ? 2 : 1);
    const time = `${C.fmt.clock(b.start)}–${C.fmt.clock(b.end)}`;
    const editable = b.canEdit && !(b.src === 'e' && b.ref.recurring);
    const check = b.task && !compact ? `<span class="check" style="--c:${esc(b.color)}" data-act="toggle" data-task="${esc(b.ref.id)}"></span>` : '';
    return `<div class="blk ${b.task ? 'task' : ''} ${b.canEdit ? '' : 'ro'} ${compact ? 'compact' : ''} ${px < 34 ? 'short' : ''}"
        data-blk="${esc(b.id)}" data-act="open-block" ${editable ? 'data-drag="move"' : 'data-drag="locked"'}
        style="--c:${esc(b.color)};--s:${b.start};--len:${len};--minh:${minH}px;--lines:${lines};left:calc(var(--gutter) + (100% - var(--gutter)) * ${x});width:calc((100% - var(--gutter)) * ${w} - 2px)">
      <div class="bt">${check}<span class="tt">${esc(b.title)}</span></div>
      ${!compact && px >= 34 ? `<div class="bs">${[time, b.detail].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      ${editable && !compact ? '<div class="handle" data-drag="resize"></div>' : ''}
    </div>`;
  }

  function scrollGridToFocus() {
    const el = $('.grid-scroll');
    if (!el) return;
    const days = el.dataset.days.split(',').map((x) => new Date(+x));
    const hh = +getComputedStyle(el.firstElementChild).getPropertyValue('--hh') || 56;
    let hour;
    if (days.some((d) => C.sameDay(d, new Date()))) hour = new Date().getHours() - 1;
    else {
      const starts = Object.values(S.blocks).map((b) => b.start);
      hour = starts.length ? Math.floor(Math.min(...starts) / 60) - 1 : 8;
    }
    el.scrollTop = Math.max(0, clamp(hour, 0, 23) * hh - 8);
  }

  // ----- list

  function listHTML() {
    const a = agenda(S.day);
    let h = '<div class="list" data-keep-scroll="list">';
    if (a.shifts.length || a.allDay.length) {
      h += '<div class="sec">班次与全天</div><div style="padding:0 12px;display:flex;flex-direction:column;gap:6px">' +
        a.shifts.map(shiftBannerHTML).join('') + '</div>' + a.allDay.map((e) => eventRowHTML(e, false)).join('');
    }
    if (a.overdue.length) h += '<div class="sec">逾期</div>' + a.overdue.map((t) => taskRowHTML(t, { overdue: true })).join('');
    if (a.untimed.length) h += '<div class="sec">待办</div>' + a.untimed.map((t) => taskRowHTML(t)).join('');
    h += '<div class="sec">时间表</div>';
    const entries = a.timed.map((e) => ({ start: e.start, end: e.end, html: eventRowHTML(e, true) }))
      .concat(a.timedTasks.map((t) => ({ start: t.due, end: t.end, html: taskRowHTML(t) })))
      .sort((x, y) => x.start - y.start);
    if (!entries.length) h += '<div class="empty">没有定时的日程</div>';
    const now = new Date();
    let nowPlaced = !C.sameDay(now, S.day);
    let cursor = null;
    for (const en of entries) {
      if (!nowPlaced && now < en.start) { h += `<div class="now-row">现在 ${C.fmt.hm(now)}</div>`; nowPlaced = true; }
      if (cursor) {
        const gap = Math.round((en.start - cursor) / 60e3);
        if (gap >= 30) h += `<div class="gap-row">☕︎ 空闲 ${C.fmt.duration(gap)}</div>`;
      }
      h += en.html;
      cursor = cursor && cursor > en.end ? cursor : en.end;
    }
    if (!nowPlaced && entries.length) h += `<div class="now-row">现在 ${C.fmt.hm(now)}</div>`;
    if (S.settings.showCompleted && a.completed.length) h += '<div class="sec">已完成</div>' + a.completed.map((t) => taskRowHTML(t)).join('');
    const ib = inbox();
    if (ib.length) {
      h += `<div class="sec" data-act="list-inbox">未排期 ${ib.length} ${S.listInbox ? '▴' : '▾'}</div>`;
      if (S.listInbox) h += ib.map((t) => taskRowHTML(t, { inbox: true })).join('');
    }
    return h + '</div>';
  }

  function eventRowHTML(e, showTime) {
    const detail = [e.location, e.calTitle].filter(Boolean).join(' · ');
    return `<div class="row" style="--c:${esc(e.shift ? e.shift.color : e.color)}" data-act="open-event" data-uid="${esc(e.uid)}">
      ${showTime ? `<div class="time">${C.fmt.hm(e.start)}<small>${C.fmt.hm(e.end)}</small></div>` : ''}
      <div class="bar"></div>
      <div class="body"><div class="t">${e.shift ? badge(e.shift) + ' ' : ''}${esc(e.title || '（无标题）')}</div>
      ${detail ? `<div class="d">${esc(detail)}</div>` : ''}</div>
      ${e.recurring ? '<span class="muted">↻</span>' : ''}</div>`;
  }

  function taskRowHTML(t, opt) {
    const o = opt || {};
    const d = [];
    if (t.due && t.hasTime) d.push(`${C.fmt.hm(t.due)} · ${C.fmt.duration(t.duration)}`);
    if (o.overdue && t.due) d.push(`原定 ${C.fmt.md(t.due)}`);
    d.push(t.listTitle);
    const pm = prioMark(t.priority);
    return `<div class="row ${t.completed ? 'done' : ''}" style="--c:${esc(t.color)}" data-act="open-task" data-task="${esc(t.id)}" data-drag="chip">
      <span class="check ${t.completed ? 'on' : ''}" data-act="toggle" data-task="${esc(t.id)}">${t.completed ? '✓' : ''}</span>
      <div class="body"><div class="t">${pm ? `<span class="prio">${pm}</span> ` : ''}${esc(t.title || '（无标题）')}</div>
      <div class="d" style="${o.overdue ? 'color:var(--red)' : ''}">${esc(d.filter(Boolean).join(' · '))}</div></div>
      <div class="acts">${o.inbox ? `<button data-act="task-today" data-task="${esc(t.id)}">今天</button>` : ''}
        <button data-act="task-menu" data-task="${esc(t.id)}" aria-label="更多">⋯</button></div></div>`;
  }

  // ----- week

  function weekHTML() {
    const days = C.weekDays(S.day, ws());
    const head = days.map((d) => `<div class="strip-day ${C.sameDay(d, new Date()) ? 'today' : ''}" data-act="goto-day" data-day="${+d}" data-drop-day="${+d}">
      <span class="wd">${C.fmt.weekdayLetter(d)}</span><span class="num">${d.getDate()}</span></div>`).join('');
    const allday = days.map((d) => {
      const a = agenda(d);
      const s = a.shifts[0] && a.shifts[0].shift;
      const pending = a.untimed.length + a.overdue.length;
      return `<div class="cell-ad" data-act="goto-day" data-day="${+d}" data-drop-day="${+d}">
        ${s ? badge(s, 9) : ''}
        ${a.allDay.slice(0, 2).map((e) => `<span class="mini" style="--c:${esc(e.color)}">${esc(e.title)}</span>`).join('')}
        ${a.allDay.length > 2 ? `<span class="cnt">+${a.allDay.length - 2}</span>` : ''}
        ${pending ? `<span class="cnt ${a.overdue.length ? 'red' : ''}">☑︎${pending}</span>` : ''}</div>`;
    }).join('');
    return `<div class="wk-head" data-swipe="week">${head}</div>
      <div class="wk-allday"><div class="lab">全天</div>${allday}</div>${gridHTML(days, true)}`;
  }

  // ----- month

  function monthHTML() {
    const grid = C.monthGrid(S.day, ws());
    const first = new Date(S.day.getFullYear(), S.day.getMonth(), 1);
    const next = C.addMonths(first, 1);
    const cells = grid.map((d) => {
      const a = agenda(d);
      const level = loadLevel(d);
      const sh = a.shifts[0];
      const ev = a.timed.filter((e) => !e.shift).length + a.allDay.length;
      const tasks = a.pending;
      const warn = sh && shortRest(sh) != null;
      return `<div class="cell ${C.sameMonth(d, S.day) ? '' : 'out'} ${C.sameDay(d, new Date()) ? 'today' : ''} ${C.sameDay(d, S.day) ? 'sel' : ''} ${level >= 4 ? 'hot' : ''}"
          style="--a:${[0, 0.16, 0.32, 0.52, 0.78][level]}" data-act="cell" data-day="${+d}" data-drop-day="${+d}">
        <span class="n">${d.getDate()}</span><span class="mk">${sh ? badge(sh.shift) : ''}</span>
        <span class="cnt">${ev ? ev : ''}${tasks ? ` <span class="${a.overdue.length ? 'red' : ''}">☑︎${tasks}</span>` : ''}</span>
        ${warn ? '<span class="warn">⚠︎</span>' : ''}</div>`;
    }).join('');
    const occ = S.events.filter((e) => e.shift).map((e) => ({ templateId: e.shift.id, start: e.start, end: e.end, isAllDay: e.allDay || e.shift.isAllDay }));
    const sum = C.shifts.summary(occ, first, next);
    const counts = S.settings.shiftTemplates.filter((t) => sum.counts[t.id]).map((t) => `${t.name} ${sum.counts[t.id]}`);
    const sumText = counts.length ? `${counts.join(' · ')} · 工时 ${Math.round(sum.minutes / 60)}h` : '本月未排班';
    const brushBar = S.brushOn ? `<div class="brushbar"><div class="hint">选好班次后点日期即可排班；再点一次同一班次可取消</div>
      <div class="opts">${S.settings.shiftTemplates.map((t) => `<button class="brush-opt ${S.brush === t.id ? 'on' : ''}" style="--c:${esc(t.color)}" data-act="brush" data-v="${esc(t.id)}">${badge(t)}${esc(t.name)}</button>`).join('')}
      <button class="brush-opt ${S.brush === 'eraser' ? 'on' : ''}" style="--c:#8e8e93" data-act="brush" data-v="eraser">⌫ 清除</button></div></div>` : '';
    return `<div class="month">
      <div class="mo-wd">${grid.slice(0, 7).map((d) => `<span>${C.fmt.weekdayLetter(d)}</span>`).join('')}</div>
      <div class="mo-grid" data-swipe="month">${cells}</div>
      <div class="mo-sum"><span class="legend">空${[0, 1, 2, 3, 4].map((l) => `<i style="background:${heat(l)}"></i>`).join('')}满</span>
        <span class="grow">${esc(sumText)}</span>
        <button class="brush-btn ${S.brushOn ? 'on' : ''}" data-act="brush-toggle">🖌 排班</button></div>
      ${brushBar}
      ${digestHTML()}
    </div>`;
  }

  function digestHTML() {
    const a = agenda(S.day);
    const empty = !a.shifts.length && !a.allDay.length && !a.timed.length && !a.pending && !a.completed.length;
    return `<div class="digest" data-keep-scroll="digest">
      <div class="head"><span>${esc(C.fmt.relativeDay(S.day))}</span><button class="pill-btn" data-act="mode" data-v="day">日视图 ›</button></div>
      ${empty ? '<div class="empty">这天没有安排</div>' : ''}
      ${a.shifts.map(shiftBannerHTML).join('')}
      ${a.timed.filter((e) => !e.shift).map((e) => eventRowHTML(e, true)).join('')}
      ${a.timedTasks.map((t) => taskRowHTML(t)).join('')}
      <div class="chips">${a.allDay.map(eventChipHTML).join('')}${a.overdue.map((t) => taskChipHTML(t, { overdue: true })).join('')}
        ${a.untimed.map((t) => taskChipHTML(t)).join('')}${S.settings.showCompleted ? a.completed.map((t) => taskChipHTML(t)).join('') : ''}</div>
    </div>`;
  }

  // ------------------------------------------------------------- quick add

  function renderQuickAdd() {
    $('#qa').innerHTML = `<div class="qa">
      <div class="preview" id="qa-preview"></div>
      <div class="qa-row" style="position:relative">
        <button class="plus" data-act="plus" aria-label="新建">＋</button>
        <input id="qa-input" type="text" enterkeyhint="done" autocomplete="off" placeholder="快速新增：明天下午3点 开会 1小时">
        <button class="send" data-act="qa-submit" aria-label="新增" disabled>↑</button>
        <div id="qa-menu"></div>
      </div></div>`;
    const input = $('#qa-input');
    input.addEventListener('input', () => {
      if (!input.value.trim()) S.override = 'automatic';
      renderPreview();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitQuickAdd(); }
    });
  }

  function parseInput() {
    const input = $('#qa-input');
    const text = input ? input.value.trim() : '';
    if (!text) return null;
    return C.parseQuickAdd(text, {
      now: new Date(), defaultDay: S.day, override: S.override,
      defaultEventMinutes: S.settings.defaultEventMinutes,
      shiftNames: S.settings.shiftTemplates.map((t) => t.name),
    });
  }

  function renderPreview() {
    const pv = $('#qa-preview');
    if (!pv) return;
    const r = parseInput();
    const send = $('[data-act="qa-submit"]');
    const plus = $('[data-act="plus"]');
    if (plus) plus.style.display = r ? 'none' : '';
    if (!r) { pv.innerHTML = ''; if (send) send.disabled = true; return; }
    const kinds = { event: '日程', allDayEvent: '全天日程', reminder: '待办', shift: '班次' };
    const chips = [`<button class="pv kind" data-act="qa-kind">${kinds[r.kind]} ⇄</button>`, `<span class="pv">📅 ${esc(C.fmt.relativeDay(r.day))}</span>`];
    if (r.kind === 'event' && r.start && r.end) chips.push(`<span class="pv mono">🕘 ${C.fmt.range(r.start, r.end)}</span>`);
    else if (r.kind === 'reminder' && r.start) chips.push(`<span class="pv mono">🕘 ${C.fmt.hm(r.start)}</span>`);
    else if (r.kind === 'shift') {
      const t = S.settings.shiftTemplates.find((x) => x.name === r.shiftName);
      if (t) chips.push(`<span class="pv mono">🕘 ${C.shifts.timeText(t)}</span>`);
    }
    if (r.kind === 'reminder' && r.durationMinutes) chips.push(`<span class="pv">⏳ 约${C.fmt.duration(r.durationMinutes)}</span>`);
    const target = r.kind === 'reminder'
      ? (byHint(r.calendarHint, editableLists()) || S.lists.find((l) => l.id === defaultListId()))
      : r.kind === 'shift' ? S.calendars.find((c) => c.id === shiftCalendarId())
        : (byHint(r.calendarHint, editableCalendars()) || S.calendars.find((c) => c.id === defaultCalendarId()));
    if (target) chips.push(`<span class="pv">🗂 ${esc(target.title)}</span>`);
    if (r.priority) chips.push(`<span class="pv">${{ 1: '高', 5: '中', 9: '低' }[r.priority]}优先</span>`);
    if (!r.title && r.kind !== 'shift') chips.push('<span class="pv muted">请输入标题</span>');
    pv.innerHTML = chips.join('');
    if (send) send.disabled = !r.title && r.kind !== 'shift';
  }

  async function submitQuickAdd() {
    const r = parseInput();
    if (!r || (!r.title && r.kind !== 'shift')) return;
    $('#qa-input').value = '';
    S.override = 'automatic';
    renderPreview();
    if (r.kind === 'shift') {
      const t = S.settings.shiftTemplates.find((x) => x.name === r.shiftName);
      if (t) { await applyShift(t, r.day); toast(`已排${t.name}：${C.fmt.relativeDay(r.day)}`); }
      return;
    }
    if (r.kind === 'event' || r.kind === 'allDayEvent') {
      const cal = byHint(r.calendarHint, editableCalendars());
      const allDay = r.kind === 'allDayEvent';
      await mutate('createEvent', {
        title: r.title, allDay, start: +(r.start || r.day), end: +(allDay ? r.day : r.end),
        calendarId: cal ? cal.id : defaultCalendarId(),
      }, `已新增日程「${r.title}」`, (res) => res && res.uid && mutate('deleteEvent', { uid: res.uid }));
      return;
    }
    const list = byHint(r.calendarHint, editableLists());
    await mutate('createReminder', {
      title: r.title, due: +(r.start || r.day), hasTime: r.hasTime, priority: r.priority,
      listId: list ? list.id : defaultListId(), duration: r.durationMinutes || S.settings.defaultTaskMinutes,
    }, `已新增待办「${r.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));
  }

  // ------------------------------------------------------------- sheets

  function askConfirm(message, yesLabel, onYes) {
    openSheet({ type: 'confirm', message, yesLabel, onYes });
  }

  function openSheet(sheet) {
    S.sheet = sheet;
    renderSheet();
  }

  function closeSheet() {
    S.sheet = null;
    renderSheet();
  }

  function renderSheet() {
    const root = $('#sheet-root');
    if (!S.sheet) { root.innerHTML = ''; return; }
    const s = S.sheet;
    let head = '', body = '';
    if (s.type === 'event') ({ head, body } = eventEditor(s));
    else if (s.type === 'task') ({ head, body } = taskEditor(s));
    else if (s.type === 'settings') ({ head, body } = settingsSheet());
    else if (s.type === 'task-menu') ({ head, body } = taskMenu(s));
    else if (s.type === 'confirm') {
      head = `<span style="width:60px"></span><h2>确认</h2><button class="text-btn" data-act="sheet-cancel">取消</button>`;
      body = `<div class="note" style="text-align:center;font-size:16px;padding:18px">${esc(s.message)}</div>
        <div class="form-sec"><button class="danger" data-act="confirm-yes">${esc(s.yesLabel)}</button></div>`;
    }
    root.innerHTML = `<div class="backdrop" data-act="sheet-bg"><div class="sheet" data-act="noop">
      <div class="sheet-head">${head}</div><div class="sheet-body">${body}</div></div></div>`;
    const title = $('#sheet-root input[name=title]');
    if (title && s.isNew) setTimeout(() => title.focus(), 50);
  }

  const sw = (name, on) => `<label class="switch"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span></span></label>`;
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;

  function eventEditor(s) {
    const d = s.draft;
    const ev = s.uid ? findEvent(s.uid) : null;
    const ro = ev && !ev.canEdit;
    const recurring = ev && ev.recurring;
    const head = `<button class="text-btn" data-act="sheet-cancel">取消</button><h2>${s.isNew ? '新建日程' : '编辑日程'}</h2>
      <button class="text-btn" data-act="event-save" style="font-weight:700" ${ro || recurring ? 'disabled' : ''}>保存</button>`;
    const cals = editableCalendars();
    const body = `
      <div class="form-sec"><div class="f"><input type="text" name="title" placeholder="标题" value="${esc(d.title)}"></div>
        ${ev && ev.shift ? `<div class="f">${badge(ev.shift)} 班次：${esc(ev.shift.name)}</div>` : ''}</div>
      <div class="form-sec" id="time-sec" data-allday="${d.allDay ? 1 : 0}">
        <div class="f"><label>全天</label>${sw('allDay', d.allDay)}</div>
        <div class="f"><label>开始</label><input type="date" name="sd" value="${dateValue(d.start)}"><input type="time" name="st" value="${timeValue(d.start)}" ${d.allDay ? 'hidden' : ''}></div>
        <div class="f"><label>结束</label><input type="date" name="ed" value="${dateValue(d.end)}"><input type="time" name="et" value="${timeValue(d.end)}" ${d.allDay ? 'hidden' : ''}></div>
        <div class="f" ${d.allDay ? 'hidden' : ''} id="dur-row"><div class="quick">${[15, 30, 60, 90, 120].map((m) =>
          `<button data-act="dur" data-v="${m}">${m < 60 ? m + '分' : m % 60 ? (m / 60) + '小时' : m / 60 + '小时'}</button>`).join('')}</div></div>
      </div>
      <div class="form-sec">
        <div class="f"><label>日历</label><select name="calendarId">${cals.map((c) => opt(c.id, c.title, c.id === d.calendarId)).join('')}
          ${ev && !ev.canEdit ? opt(ev.calendarId, ev.calTitle, true) : ''}</select></div>
        <div class="f"><input type="text" name="location" placeholder="地点" value="${esc(d.location)}"></div>
        <div class="f"><textarea name="notes" placeholder="备注">${esc(d.notes)}</textarea></div>
      </div>
      ${recurring ? `<div class="form-sec"><div class="note">这是重复日程。为免改到整个系列，请用系统编辑器修改（可选择“仅此次”或“所有将来的”）。</div>
        <div class="f"><button class="text-btn" data-act="event-native">在系统编辑器中打开</button></div></div>` : ''}
      ${ro ? '<div class="form-sec"><div class="note">这个日历是只读的（例如订阅或节假日日历），不能修改。</div></div>' : ''}
      ${ev && !ro && !recurring ? '<div class="form-sec"><button class="danger" data-act="event-delete">删除日程</button></div>' : ''}`;
    return { head, body };
  }

  function taskEditor(s) {
    const d = s.draft;
    const head = `<button class="text-btn" data-act="sheet-cancel">取消</button><h2>${s.isNew ? '新建待办' : '编辑待办'}</h2>
      <button class="text-btn" data-act="task-save" style="font-weight:700">保存</button>`;
    const durations = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];
    if (!durations.includes(d.duration)) durations.push(d.duration);
    durations.sort((a, b) => a - b);
    const body = `
      <div class="form-sec"><div class="f"><input type="text" name="title" placeholder="标题" value="${esc(d.title)}"></div>
        ${s.isNew ? '' : `<div class="f"><label>已完成</label>${sw('completed', d.completed)}</div>`}</div>
      <div class="form-sec" id="due-sec">
        <div class="f"><label>日期</label>${sw('hasDate', d.hasDate)}</div>
        <div class="f" data-need="date" ${d.hasDate ? '' : 'hidden'}><input type="date" name="dd" value="${dateValue(d.due)}" style="flex:1"></div>
        <div class="f" data-need="date" ${d.hasDate ? '' : 'hidden'}><div class="quick">
          <button data-act="qday" data-v="0">今天</button><button data-act="qday" data-v="1">明天</button>
          <button data-act="qday" data-v="2">后天</button><button data-act="qday" data-v="mon">下周一</button></div></div>
        <div class="f" data-need="date" ${d.hasDate ? '' : 'hidden'}><label>时间</label>${sw('hasTime', d.hasTime)}</div>
        <div class="f" data-need="time" ${d.hasDate && d.hasTime ? '' : 'hidden'}><input type="time" name="dt" value="${timeValue(d.due)}" style="flex:1"></div>
        <div class="f" data-need="time" ${d.hasDate && d.hasTime ? '' : 'hidden'}><label>预估时长</label>
          <select name="duration">${durations.map((m) => opt(m, C.fmt.duration(m), m === d.duration)).join('')}</select></div>
      </div>
      <div class="fsec-foot">预估时长决定它在时间轴上占多长（保存在本机）。</div>
      <div class="form-sec">
        <div class="f"><label>优先级</label><div class="segf" id="prio">${[[0, '无'], [9, '低'], [5, '中'], [1, '高']].map(([v, l]) =>
          `<button data-act="prio" data-v="${v}" class="${d.priority === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="f"><label>列表</label><select name="listId">${editableLists().map((l) => opt(l.id, l.title, l.id === d.listId)).join('')}</select></div>
        <div class="f"><textarea name="notes" placeholder="备注">${esc(d.notes)}</textarea></div>
      </div>
      ${s.isNew ? '' : '<div class="form-sec"><button class="danger" data-act="task-delete">删除待办</button></div>'}`;
    return { head, body };
  }

  function taskMenu(s) {
    const t = findTask(s.id);
    const head = `<span style="width:60px"></span><h2>${esc(t ? t.title : '')}</h2><button class="text-btn" data-act="sheet-cancel">完成</button>`;
    const items = [['menu-toggle', t && t.completed ? '标为未完成' : '完成'], ['menu-today', '今天'], ['menu-postpone', '推迟一天'],
      ['menu-nextweek', '下周一'], ['menu-inbox', '移到未排期'], ['menu-edit', '编辑…']];
    const body = `<div class="form-sec">${items.map(([a, l]) => `<div class="f"><button class="text-btn" style="width:100%;text-align:left" data-act="${a}">${l}</button></div>`).join('')}</div>
      <div class="form-sec"><button class="danger" data-act="task-delete">删除待办</button></div>`;
    return { head, body };
  }

  function settingsSheet() {
    const st = S.settings;
    const head = `<span style="width:60px"></span><h2>设置</h2><button class="text-btn" data-act="settings-save" style="font-weight:700">完成</button>`;
    const cals = editableCalendars();
    const tpl = st.shiftTemplates.map((t, i) => `
      <details data-tpl="${i}" class="form-sec" style="margin:8px 14px">
        <summary class="f" style="list-style:none">${badge(t)} <span style="flex:1">${esc(t.name)}</span><span class="muted mono">${C.shifts.timeText(t)}</span></summary>
        <div class="f"><label>名称</label><input type="text" name="tpl-name" value="${esc(t.name)}" style="text-align:right"></div>
        <div class="f"><label>简称（1–2 字）</label><input type="text" name="tpl-short" maxlength="2" value="${esc(t.shortName)}" style="text-align:right"></div>
        <div class="f"><label>颜色</label><input type="color" name="tpl-color" value="${esc(t.color)}"></div>
        <div class="f"><label>全天（休息、年假）</label>${sw('tpl-allday', t.isAllDay)}</div>
        <div class="f"><label>开始</label><input type="time" name="tpl-start" value="${C.fmt.clock(t.startMinute)}"></div>
        <div class="f"><label>时长（小时）</label><input type="number" name="tpl-hours" min="0.5" max="48" step="0.5" value="${t.durationMinutes / 60}" style="width:80px"></div>
        <div class="f"><button class="text-btn" style="color:var(--red)" data-act="tpl-delete" data-v="${i}">删除这个班次</button></div>
      </details>`).join('');
    const toggles = (items) => items.map((c) => `<div class="f"><span class="dot-sw" style="--c:${esc(c.color)}"></span><label>${esc(c.title)}</label>
      <label class="switch"><input type="checkbox" data-cal="${esc(c.id)}" ${st.hidden.includes(c.id) ? '' : 'checked'}><span></span></label></div>`).join('');
    const stepper = (name, value, unit) => `<div class="stepper"><button data-act="step" data-name="${name}" data-v="-1">−</button>
      <span class="mono" data-show="${name}" style="min-width:64px;text-align:center">${value}${unit}</span>
      <button data-act="step" data-name="${name}" data-v="1">＋</button></div>`;
    const body = `
      <div class="fsec-title">班次模板</div>${tpl}
      <div class="form-sec"><div class="f"><button class="text-btn" data-act="tpl-add">＋ 新增班次</button></div></div>
      <div class="fsec-foot">在月视图点「🖌 排班」，选班次后点日期即可排班；快速新增输入「周五 夜班」也可以。班次以标题辨认，所以请别重名。</div>
      <div class="fsec-title">排班</div>
      <div class="form-sec">
        <div class="f"><label>写入日历</label><select name="shiftCalendarId">${opt('', '默认日历', !st.shiftCalendarId)}${cals.map((c) => opt(c.id, c.title, c.id === st.shiftCalendarId)).join('')}</select></div>
        <div class="f"><label>两班最短间隔</label>${stepper('restHours', st.restHours, ' 小时')}</div>
      </div>
      <div class="fsec-foot">建议先在系统「日历」App 建一个「排班」日历，再在这里选择它。</div>
      <div class="fsec-title">负荷热力图</div>
      <div class="form-sec"><div class="f"><label>每天可用</label>${stepper('capacityHours', st.capacityHours, ' 小时')}</div></div>
      <div class="fsec-title">新建时默认</div>
      <div class="form-sec">
        <div class="f"><label>日程写入</label><select name="defaultEventCalendarId">${opt('', '系统默认', !st.defaultEventCalendarId)}${cals.map((c) => opt(c.id, c.title, c.id === st.defaultEventCalendarId)).join('')}</select></div>
        <div class="f"><label>待办写入</label><select name="defaultReminderListId">${opt('', '系统默认', !st.defaultReminderListId)}${editableLists().map((l) => opt(l.id, l.title, l.id === st.defaultReminderListId)).join('')}</select></div>
        <div class="f"><label>日程时长</label>${stepper('defaultEventMinutes', st.defaultEventMinutes, ' 分')}</div>
        <div class="f"><label>待办预估</label>${stepper('defaultTaskMinutes', st.defaultTaskMinutes, ' 分')}</div>
      </div>
      <div class="fsec-title">显示与通知</div>
      <div class="form-sec">
        <div class="f"><label>显示已完成的待办</label>${sw('showCompleted', st.showCompleted)}</div>
        <div class="f"><label>每周从</label><div class="segf" id="wstart">${[[1, '周一'], [0, '周日']].map(([v, l]) => `<button data-act="wstart" data-v="${v}" class="${st.weekStart === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="f"><label>定时待办到点通知</label>${sw('notifyTasks', st.notifyTasks)}</div>
      </div>
      <div class="fsec-foot">Scriptable 无法替待办设定系统闹钟，所以由 Scriptable 在待办时间发通知（未来 7 天内）。若同一待办在「提醒事项」里另有闹钟，会收到两次。</div>
      <div class="fsec-title">显示的日历</div><div class="form-sec">${toggles(S.calendars)}</div>
      <div class="fsec-title">显示的提醒事项列表</div><div class="form-sec">${toggles(S.lists)}</div>
      <div class="form-sec"><div class="f"><button class="text-btn" data-act="self-update">检查更新</button>
        <span class="muted mono" style="margin-left:auto;font-size:12px">${esc(S.version)}</span></div></div>
      <div class="fsec-foot">一览 · Scriptable 版 · 数据直接读写系统日历与提醒事项。「检查更新」会从 GitHub 下载最新版覆盖这个脚本。</div>`;
    return { head, body };
  }

  function readTemplates() {
    return $$('#sheet-root [data-tpl]').map((el) => {
      const old = S.settings.shiftTemplates[+el.dataset.tpl] || {};
      const [h, m] = ($('[name=tpl-start]', el).value || '08:00').split(':').map(Number);
      return {
        id: old.id || ('tpl-' + Date.now() + Math.random().toString(16).slice(2, 6)),
        name: $('[name=tpl-name]', el).value.trim() || '班次',
        shortName: $('[name=tpl-short]', el).value.trim(),
        color: $('[name=tpl-color]', el).value,
        isAllDay: $('[name=tpl-allday]', el).checked,
        startMinute: h * 60 + m,
        durationMinutes: Math.round(clamp(parseFloat($('[name=tpl-hours]', el).value) || 8, 0.5, 48) * 60),
      };
    });
  }

  function newEventDraft(start, end) {
    return { title: '', allDay: false, start, end, calendarId: defaultCalendarId(), location: '', notes: '' };
  }

  function openEvent(ev) {
    openSheet({ type: 'event', uid: ev.uid, draft: {
      title: ev.title, allDay: ev.allDay, start: ev.start, end: ev.allDay ? C.startOfDay(ev.end) : ev.end,
      calendarId: ev.calendarId, location: ev.location || '', notes: ev.notes || '' } });
  }

  function openTask(t) {
    openSheet({ type: 'task', id: t.id, draft: {
      title: t.title, notes: t.notes || '', hasDate: !!t.due, hasTime: !!t.hasTime, due: t.due || C.startOfDay(S.day),
      duration: t.duration, priority: t.priority || 0, listId: t.listId, completed: !!t.completed } });
  }

  function newTask(day) {
    openSheet({ type: 'task', isNew: true, draft: {
      title: '', notes: '', hasDate: true, hasTime: false, due: C.startOfDay(day), duration: S.settings.defaultTaskMinutes,
      priority: 0, listId: defaultListId(), completed: false } });
  }

  function readEventForm() {
    const root = $('#sheet-root');
    const allDay = $('[name=allDay]', root).checked;
    let start = fromInputs($('[name=sd]', root).value, allDay ? '00:00' : $('[name=st]', root).value);
    let end = fromInputs($('[name=ed]', root).value, allDay ? '00:00' : $('[name=et]', root).value);
    if (allDay) { start = C.startOfDay(start); end = C.startOfDay(end < start ? start : end); }
    else if (end <= start) end = new Date(start.getTime() + 15 * 60e3);
    return {
      title: $('[name=title]', root).value.trim() || '新日程', allDay, start: +start, end: +end,
      calendarId: $('[name=calendarId]', root).value,
      location: $('[name=location]', root).value.trim(), notes: $('[name=notes]', root).value,
    };
  }

  function readTaskForm() {
    const root = $('#sheet-root');
    const hasDate = $('[name=hasDate]', root).checked;
    const hasTime = hasDate && $('[name=hasTime]', root).checked;
    const due = hasDate ? fromInputs($('[name=dd]', root).value, hasTime ? $('[name=dt]', root).value : '00:00') : null;
    const prio = $('#prio .on', root);
    const done = $('[name=completed]', root);
    return {
      title: $('[name=title]', root).value.trim() || '新待办', notes: $('[name=notes]', root).value,
      due: due ? +due : null, hasTime, priority: prio ? +prio.dataset.v : 0,
      listId: $('[name=listId]', root).value, duration: +($('[name=duration]', root) || {}).value || S.settings.defaultTaskMinutes,
      completed: done ? done.checked : false,
    };
  }

  // ------------------------------------------------------------- actions

  function setDay(d, mode) {
    S.day = C.startOfDay(d);
    if (mode) S.mode = mode;
    render();
    load();
  }

  function step(dir) {
    if (S.mode === 'day') setDay(C.addDays(S.day, dir));
    else if (S.mode === 'week') setDay(C.addDays(S.day, 7 * dir));
    else setDay(C.addMonths(S.day, dir));
  }

  let lastSurfaceTap = null;
  const Actions = {
    noop() {},
    prev: () => step(-1),
    next: () => step(1),
    today: () => setDay(new Date()),
    reload: () => { lastDataJSON = ''; refresh(); },
    'open-settings-app': () => Bridge.call('openSettingsApp'),
    'self-update'() { closeSheet(); toast('正在检查更新…'); mutate('selfUpdate', {}); },
    settings: () => openSheet({ type: 'settings' }),
    mode(el) { S.mode = el.dataset.v; render(); },
    style() { saveSettings({ dayStyle: S.settings.dayStyle === 'timeline' ? 'list' : 'timeline' }); render(); },
    pick(el) { setDay(new Date(+el.dataset.day)); },
    'goto-day'(el) { setDay(new Date(+el.dataset.day), 'day'); },
    inbox() { S.showInbox = !S.showInbox; render(); },
    'list-inbox'() { S.listInbox = !S.listInbox; render(); },
    collapse() { S.trayCollapsed = !S.trayCollapsed; render(); },
    toggle(el) { const t = findTask(el.dataset.task); if (t) toggleTask(t); },
    'open-task'(el) { const t = findTask(el.dataset.task); if (t) openTask(t); },
    'open-event'(el) { const e = findEvent(el.dataset.uid); if (e) openEvent(e); },
    'open-block'(el) {
      const b = S.blocks[el.dataset.blk];
      if (!b) return;
      if (b.src === 'e') openEvent(b.ref); else openTask(b.ref);
    },
    surface(el, ev) {
      const now = Date.now();
      const y = ev.clientY, x = ev.clientX;
      if (lastSurfaceTap && now - lastSurfaceTap.t < 350 && Math.abs(lastSurfaceTap.y - y) < 30) {
        lastSurfaceTap = null;
        const g = gridGeometry(el.closest('.grid-scroll'));
        const p = g.at(x, y);
        const start = Math.max(0, Math.floor(p.minute / 15) * 15);
        openSheet({ type: 'event', isNew: true, draft: newEventDraft(C.dateOnDay(g.days[p.col], start),
          C.dateOnDay(g.days[p.col], start + S.settings.defaultEventMinutes)) });
      } else lastSurfaceTap = { t: now, y };
    },
    cell(el) {
      const day = new Date(+el.dataset.day);
      if (S.brushOn && S.brush) {
        if (S.brush === 'eraser') clearShifts(day);
        else {
          const t = S.settings.shiftTemplates.find((x) => x.id === S.brush);
          if (t) applyShift(t, day);
        }
      }
      S.day = C.startOfDay(day);
      render();
      load();
    },
    'brush-toggle'() {
      S.brushOn = !S.brushOn;
      if (S.brushOn && !S.brush) S.brush = (S.settings.shiftTemplates[0] || {}).id || 'eraser';
      render();
    },
    brush(el) { S.brush = el.dataset.v; render(); },
    plus(el) {
      const menu = $('#qa-menu');
      if (menu.innerHTML) { menu.innerHTML = ''; return; }
      menu.innerHTML = `<div class="menu"><button data-act="new-event">📅 新建日程</button><button data-act="new-task">☑︎ 新建待办</button></div>`;
    },
    'new-event'() {
      $('#qa-menu').innerHTML = '';
      const isToday = C.sameDay(S.day, new Date());
      const start = C.dateOnDay(S.day, Math.min(isToday ? new Date().getHours() + 1 : 9, 23) * 60);
      openSheet({ type: 'event', isNew: true, draft: newEventDraft(start, new Date(start.getTime() + S.settings.defaultEventMinutes * 60e3)) });
    },
    'new-task'() { $('#qa-menu').innerHTML = ''; newTask(S.day); },
    'qa-submit': () => submitQuickAdd(),
    'qa-kind'() {
      const r = parseInput();
      if (!r) return;
      S.override = r.kind === 'reminder' ? 'event' : 'reminder';
      renderPreview();
    },
    'toast-action'() {
      const a = S.toast && S.toast.action;
      S.toast = null;
      renderToast();
      if (a) a.fn();
    },
    'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },
    'sheet-cancel': () => closeSheet(),
    dur(el) {
      const root = $('#sheet-root');
      const start = fromInputs($('[name=sd]', root).value, $('[name=st]', root).value);
      const end = new Date(start.getTime() + +el.dataset.v * 60e3);
      $('[name=ed]', root).value = dateValue(end);
      $('[name=et]', root).value = timeValue(end);
    },
    async 'event-save'() {
      const s = S.sheet;
      const f = readEventForm();
      closeSheet();
      if (s.isNew) {
        await mutate('createEvent', f, `已新增日程「${f.title}」`, (res) => res && res.uid && mutate('deleteEvent', { uid: res.uid }));
      } else {
        await mutate('updateEvent', Object.assign({ uid: s.uid }, f));
      }
    },
    'event-delete'() {
      const uid = S.sheet.uid;
      const ev = findEvent(uid);
      if (ev) askConfirm(`删除「${ev.title}」？`, '删除日程', () => mutate('deleteEvent', { uid }, '已删除日程'));
    },
    'event-native'() {
      const uid = S.sheet.uid;
      closeSheet();
      mutate('editNative', { uid });
    },
    qday(el) {
      const root = $('#sheet-root');
      const today = C.startOfDay(new Date());
      const v = el.dataset.v;
      const d = v === 'mon' ? C.addDays(C.startOfWeek(today, 1), 7) : C.addDays(today, +v);
      $('[name=dd]', root).value = dateValue(d);
    },
    prio(el) { $$('#prio button').forEach((b) => b.classList.toggle('on', b === el)); },
    async 'task-save'() {
      const s = S.sheet;
      const f = readTaskForm();
      closeSheet();
      if (s.isNew) {
        await mutate('createReminder', f, `已新增待办「${f.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));
      } else {
        await mutate('updateReminder', Object.assign({ id: s.id }, f));
      }
    },
    'task-delete'() {
      const id = S.sheet.id;
      const t = findTask(id);
      if (t) askConfirm(`删除「${t.title}」？`, '删除待办', () => mutate('deleteReminder', { id }, '已删除待办'));
    },
    'confirm-yes'() {
      const fn = S.sheet && S.sheet.onYes;
      closeSheet();
      if (fn) fn();
    },
    'task-menu'(el) { openSheet({ type: 'task-menu', id: el.dataset.task }); },
    'task-today'(el) { const t = findTask(el.dataset.task); if (t) scheduleTask(t, C.startOfDay(new Date()), false); },
    'menu-toggle'() { const t = findTask(S.sheet.id); closeSheet(); if (t) toggleTask(t); },
    'menu-today'() { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, C.startOfDay(new Date()), false); },
    'menu-postpone'() { const t = findTask(S.sheet.id); closeSheet(); if (t) postpone(t, 1); },
    'menu-nextweek'() {
      const t = findTask(S.sheet.id);
      closeSheet();
      if (t) scheduleTask(t, C.addDays(C.startOfWeek(new Date(), 1), 7), false);
    },
    'menu-inbox'() { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, null, false); },
    'menu-edit'() { const t = findTask(S.sheet.id); if (t) openTask(t); },
    step(el) {
      const name = el.dataset.name;
      const steps = { restHours: [1, 0, 24], capacityHours: [1, 2, 16], defaultEventMinutes: [15, 15, 240], defaultTaskMinutes: [15, 15, 240] };
      const [inc, lo, hi] = steps[name];
      S.settings[name] = clamp((S.settings[name] || 0) + inc * +el.dataset.v, lo, hi);
      const unit = { restHours: ' 小时', capacityHours: ' 小时', defaultEventMinutes: ' 分', defaultTaskMinutes: ' 分' }[name];
      $(`[data-show="${name}"]`).textContent = S.settings[name] + unit;
    },
    wstart(el) { $$('#wstart button').forEach((b) => b.classList.toggle('on', b === el)); },
    'tpl-add'() {
      S.settings.shiftTemplates = readTemplates().concat([{ id: 'tpl-' + Date.now(), name: '新班次', shortName: '新', color: '#0EA5E9',
        startMinute: 540, durationMinutes: 480, isAllDay: false }]);
      renderSheet();
      const last = $$('#sheet-root [data-tpl]').pop();
      if (last) last.open = true;
    },
    'tpl-delete'(el) {
      const list = readTemplates();
      list.splice(+el.dataset.v, 1);
      S.settings.shiftTemplates = list;
      renderSheet();
    },
    async 'settings-save'() {
      const root = $('#sheet-root');
      const st = S.settings;
      st.shiftTemplates = readTemplates();
      st.shiftCalendarId = $('[name=shiftCalendarId]', root).value || null;
      st.defaultEventCalendarId = $('[name=defaultEventCalendarId]', root).value || null;
      st.defaultReminderListId = $('[name=defaultReminderListId]', root).value || null;
      st.showCompleted = $('[name=showCompleted]', root).checked;
      st.notifyTasks = $('[name=notifyTasks]', root).checked;
      const wsBtn = $('#wstart .on', root);
      st.weekStart = wsBtn ? +wsBtn.dataset.v : 1;
      st.hidden = $$('[data-cal]', root).filter((c) => !c.checked).map((c) => c.dataset.cal);
      closeSheet();
      S.range = null;
      lastDataJSON = '';
      await saveSettings({});
      await load(true);
    },
  };

  document.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) { const m = $('#qa-menu'); if (m && m.innerHTML) m.innerHTML = ''; return; }
    const fn = Actions[el.dataset.act];
    if (fn) fn(el, e);
  }, true);

  document.addEventListener('change', (e) => {
    const root = $('#sheet-root');
    if (!root.contains(e.target)) return;
    const name = e.target.name;
    if (name === 'allDay') {
      const on = e.target.checked;
      $$('[name=st],[name=et]', root).forEach((i) => { i.hidden = on; });
      const dr = $('#dur-row', root);
      if (dr) dr.hidden = on;
    } else if (name === 'sd' || name === 'st') {
      // keep the length when the start moves
      const s = S.sheet;
      const prev = s.lastStart || s.draft.start;
      const start = fromInputs($('[name=sd]', root).value, $('[name=st]', root).value);
      const end = fromInputs($('[name=ed]', root).value, $('[name=et]', root).value);
      const moved = new Date(end.getTime() + (start - prev));
      $('[name=ed]', root).value = dateValue(moved);
      $('[name=et]', root).value = timeValue(moved);
      s.lastStart = start;
    } else if (name === 'hasDate' || name === 'hasTime') {
      const hasDate = $('[name=hasDate]', root).checked;
      const hasTime = hasDate && $('[name=hasTime]', root).checked;
      $$('[data-need=date]', root).forEach((el) => { el.hidden = !hasDate; });
      $$('[data-need=time]', root).forEach((el) => { el.hidden = !hasTime; });
    }
  });

  // ------------------------------------------------------------- gestures

  const Gest = { pending: null, active: null, pinch: null, swipe: null };
  let suppressClickUntil = 0;

  function gridGeometry(scrollEl) {
    const grid = scrollEl.firstElementChild;
    const rect = grid.getBoundingClientRect();
    const days = scrollEl.dataset.days.split(',').map((x) => new Date(+x));
    const gutter = parseFloat(getComputedStyle(grid).getPropertyValue('--gutter')) || 46;
    const hh = parseFloat(getComputedStyle(grid).getPropertyValue('--hh')) || 56;
    const colW = (rect.width - gutter) / days.length;
    return {
      scrollEl, grid, days, gutter, hh, colW, compact: scrollEl.dataset.compact === '1',
      at(x, y) {
        const r = grid.getBoundingClientRect();
        return { col: clamp(Math.floor((x - r.left - gutter) / colW), 0, days.length - 1), minute: (y - r.top) / hh * 60 };
      },
    };
  }

  /** Scrolls the grid while the finger rests near its top or bottom edge (once it has moved). */
  function startAutoScroll(state) {
    state.x0 = state.x;
    state.y0 = state.y;
    const tick = () => {
      if (Gest.active !== state.handler) return;
      if (!state.armed) {
        state.armed = Math.hypot(state.x - state.x0, state.y - state.y0) > 12;
        requestAnimationFrame(tick);
        return;
      }
      const r = state.geo.scrollEl.getBoundingClientRect();
      let dy = 0;
      if (state.y < r.top + 44) dy = -Math.ceil((r.top + 44 - state.y) / 6);
      else if (state.y > r.bottom - 44) dy = Math.ceil((state.y - (r.bottom - 44)) / 6);
      if (dy) {
        state.geo.scrollEl.scrollTop += dy;
        state.handler.move(state.x, state.y);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Long-press drag of a block (move) or of its bottom edge (resize). */
  function dragBlock(p) {
    const el = p.el.closest('.blk');
    const b = S.blocks[el.dataset.blk];
    if (!b) return null;
    const geo = gridGeometry(el.closest('.grid-scroll'));
    const resize = p.kind === 'resize';
    const stepM = geo.hh >= 100 ? 5 : 15;
    const st = { geo, x: p.x, y: p.y, scroll0: geo.scrollEl.scrollTop, delta: 0, days: 0 };
    el.classList.add('dragging');
    const tip = document.createElement('div');
    tip.className = 'tip';
    el.appendChild(tip);
    const n = geo.days.length;
    const x0 = (b.dayIndex + b.slot.column / b.slot.columnCount) / n;
    const update = () => {
      const dy = (st.y - p.y0) + (geo.scrollEl.scrollTop - st.scroll0);
      const raw = dy / geo.hh * 60;
      if (resize) {
        const target = C.snap(b.end + raw, stepM);
        st.delta = Math.max(target, b.start + 15) - b.end;
        el.style.setProperty('--len', b.end + st.delta - b.start);
        tip.textContent = `${C.fmt.clock(b.start)}–${C.fmt.clock(b.end + st.delta)}`;
      } else {
        const target = clamp(C.snap(b.start + raw, stepM), 0, 1440 - stepM);
        st.delta = target - b.start;
        st.days = n > 1 ? clamp(Math.round((st.x - p.x0) / geo.colW), -b.dayIndex, n - 1 - b.dayIndex) : 0;
        el.style.setProperty('--s', b.start + st.delta);
        el.style.left = `calc(var(--gutter) + (100% - var(--gutter)) * ${x0 + st.days / n})`;
        tip.textContent = `${C.fmt.clock(b.start + st.delta)}–${C.fmt.clock(b.end + st.delta)}`;
      }
    };
    const handler = {
      move(x, y) { st.x = x; st.y = y; update(); },
      end() {
        el.classList.remove('dragging');
        tip.remove();
        if (resize) {
          if (!st.delta) return;
          if (b.src === 'e') moveEvent(b.ref, b.ref.start, new Date(b.ref.end.getTime() + st.delta * 60e3));
          else setTaskDuration(b.ref, b.ref.duration + Math.round(st.delta));
        } else {
          if (!st.delta && !st.days) return;
          const shift = (d) => {
            const m = new Date(d.getTime() + st.delta * 60e3);
            return st.days ? C.addDays(m, st.days) : m;
          };
          if (b.src === 'e') {
            const ns = shift(b.ref.start);
            moveEvent(b.ref, ns, new Date(ns.getTime() + (b.ref.end - b.ref.start)));
          } else scheduleTask(b.ref, shift(b.ref.due), true);
        }
      },
      cancel() { el.classList.remove('dragging'); tip.remove(); render(); },
    };
    st.handler = handler;
    update();
    startAutoScroll(st);
    return handler;
  }

  /** Long-press on empty grid, drag to choose the length, release to edit. */
  function dragCreate(p) {
    const geo = gridGeometry(p.el.closest('.grid-scroll'));
    const first = geo.at(p.x, p.y);
    const start = Math.max(0, Math.floor(first.minute / 15) * 15);
    const n = geo.days.length;
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    ghost.style.left = `calc(var(--gutter) + (100% - var(--gutter)) * ${first.col / n})`;
    ghost.style.width = `calc((100% - var(--gutter)) / ${n} - 2px)`;
    ghost.style.top = `${start / 60 * geo.hh}px`;
    geo.grid.appendChild(ghost);
    const st = { geo, x: p.x, y: p.y, end: start + S.settings.defaultEventMinutes };
    const update = () => {
      const m = C.snap(geo.at(st.x, st.y).minute, 15);
      st.end = clamp(m - start >= 15 ? m : start + S.settings.defaultEventMinutes, start + 15, 1440);
      ghost.style.height = `${(st.end - start) / 60 * geo.hh}px`;
      ghost.textContent = `${C.fmt.clock(start)}–${C.fmt.clock(st.end)}`;
    };
    const handler = {
      moved: false,
      move(x, y) { st.x = x; st.y = y; this.moved = true; update(); },
      end() {
        ghost.remove();
        const day = geo.days[first.col];
        openSheet({ type: 'event', isNew: true, draft: newEventDraft(C.dateOnDay(day, start), C.dateOnDay(day, st.end)) });
      },
      cancel() { ghost.remove(); },
    };
    st.handler = handler;
    update();
    startAutoScroll(st);
    return handler;
  }

  /** Long-press a task chip/row and drop it on the grid (timed) or on a date (all day). */
  function dragChip(p) {
    const t = findTask(p.el.dataset.task);
    if (!t) return null;
    const ghost = document.createElement('div');
    ghost.className = 'floating';
    ghost.textContent = t.title;
    document.body.appendChild(ghost);
    p.el.style.opacity = '0.4';
    let hot = null;
    const st = { x: p.x, y: p.y, target: null };
    const update = () => {
      ghost.style.left = st.x + 'px';
      ghost.style.top = st.y + 'px';
      const under = document.elementFromPoint(st.x, st.y);
      let target = null;
      const day = under && under.closest('[data-drop-day]');
      const grid = under && under.closest('.grid-scroll');
      if (day) target = { el: day, day: new Date(+day.dataset.dropDay) };
      else if (grid) {
        const g = gridGeometry(grid);
        const at = g.at(st.x, st.y);
        const minute = clamp(C.snap(at.minute, 15), 0, 1425);
        target = { el: grid, day: g.days[at.col], minute };
        ghost.textContent = `${t.title} → ${C.fmt.clock(minute)}`;
      }
      if (!target || target.minute == null) ghost.textContent = t.title + (target ? ` → ${C.fmt.md(target.day)}` : '');
      if (hot !== (target && target.el)) {
        if (hot) hot.classList.remove('drop-hot');
        hot = target && target.minute == null ? target.el : null;
        if (hot) hot.classList.add('drop-hot');
      }
      st.target = target;
    };
    const cleanup = () => { ghost.remove(); p.el.style.opacity = ''; if (hot) hot.classList.remove('drop-hot'); };
    const handler = {
      move(x, y) { st.x = x; st.y = y; update(); },
      end() {
        cleanup();
        const tg = st.target;
        if (!tg) return;
        if (tg.minute != null) scheduleTask(t, C.dateOnDay(tg.day, tg.minute), true);
        else if (t.hasTime && t.due) scheduleTask(t, C.dateOnDay(tg.day, C.minuteOfDay(t.due, t.due)), true);
        else scheduleTask(t, C.startOfDay(tg.day), false);
      },
      cancel() { cleanup(); },
    };
    update();
    return handler;
  }

  function activate() {
    const p = Gest.pending;
    Gest.pending = null;
    if (!p) return;
    if (p.kind === 'locked') {
      const b = S.blocks[p.el.closest('.blk').dataset.blk];
      toast(b && b.src === 'e' && b.ref.recurring ? '重复日程不能直接拖动：点开后用系统编辑器修改' : '这个日历是只读的');
      suppressClickUntil = Date.now() + 500;
      return;
    }
    const h = p.kind === 'chip' ? dragChip(p) : p.kind === 'create' ? dragCreate(p) : dragBlock(p);
    if (h) {
      Gest.active = h;
      suppressClickUntil = Date.now() + 100000;
    }
  }

  function begin(target, x, y) {
    const swipeEl = target.closest('[data-swipe]');
    Gest.swipe = swipeEl ? { x0: x, y0: y, kind: swipeEl.dataset.swipe } : null;
    const el = target.closest('[data-drag]');
    if (!el || el.closest('.sheet')) return;
    const kind = el.dataset.drag;
    Gest.pending = { el, kind, x0: x, y0: y, x, y, timer: setTimeout(activate, kind === 'resize' ? 220 : 380) };
  }

  function moveTo(x, y, e) {
    const p = Gest.pending;
    if (p) {
      p.x = x; p.y = y;
      if (Math.hypot(x - p.x0, y - p.y0) > 10) { clearTimeout(p.timer); Gest.pending = null; }
      return;
    }
    if (Gest.active) {
      if (e && e.cancelable) e.preventDefault();
      Gest.active.move(x, y);
    }
  }

  function finish(x, y, e) {
    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }
    if (Gest.active) {
      if (e && e.cancelable) e.preventDefault();
      const a = Gest.active;
      Gest.active = null;
      suppressClickUntil = Date.now() + 300;
      a.end();
      return;
    }
    const sw = Gest.swipe;
    Gest.swipe = null;
    if (sw && x != null) {
      const dx = x - sw.x0, dy = y - sw.y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        suppressClickUntil = Date.now() + 400;
        if (sw.kind === 'month') setDay(C.addMonths(S.day, dx < 0 ? 1 : -1));
        else setDay(C.addDays(S.day, dx < 0 ? 7 : -7));
      }
    }
  }

  function cancelGesture() {
    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }
    if (Gest.active) { const a = Gest.active; Gest.active = null; a.cancel(); suppressClickUntil = Date.now() + 400; }
    Gest.swipe = null;
  }

  // Pinch to zoom the day grid
  function pinchStart(e) {
    const scrollEl = e.target.closest && e.target.closest('.grid-scroll');
    if (!scrollEl || scrollEl.dataset.compact === '1') return;
    const [a, b] = e.touches;
    Gest.pinch = {
      scrollEl, grid: scrollEl.firstElementChild, base: hourHeight(false), hh: hourHeight(false),
      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      cy: (a.clientY + b.clientY) / 2 - scrollEl.getBoundingClientRect().top,
    };
  }

  function pinchMove(e) {
    const p = Gest.pinch;
    const [a, b] = e.touches;
    if (!b) return;
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const hh = clamp(p.base * d / p.d0, 28, 160);
    const top = (p.scrollEl.scrollTop + p.cy) * hh / p.hh - p.cy;
    p.hh = hh;
    p.grid.style.setProperty('--hh', hh);
    p.scrollEl.scrollTop = top;
  }

  function pinchEnd() {
    const p = Gest.pinch;
    Gest.pinch = null;
    S.settings.hourHeight = Math.round(p.hh);
    render();
    saveSettings({ hourHeight: S.settings.hourHeight });
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      cancelGesture();
      pinchStart(e);
      return;
    }
    if (e.touches.length !== 1 || Gest.active) return;
    const t = e.touches[0];
    begin(e.target, t.clientX, t.clientY);
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (Gest.pinch) { e.preventDefault(); pinchMove(e); return; }
    const t = e.touches[0];
    if (t) moveTo(t.clientX, t.clientY, e);
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (Gest.pinch) { if (e.touches.length < 2) pinchEnd(); return; }
    const t = e.changedTouches[0];
    finish(t ? t.clientX : null, t ? t.clientY : null, e);
  }, { passive: false });

  document.addEventListener('touchcancel', cancelGesture);

  // Mouse fallback for the desktop preview
  let mouseDown = false;
  let lastTouch = 0;
  ['touchstart', 'touchend'].forEach((t) => document.addEventListener(t, () => { lastTouch = Date.now(); }, { passive: true }));
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || Date.now() - lastTouch < 1000) return;
    mouseDown = true;
    begin(e.target, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => { if (mouseDown) moveTo(e.clientX, e.clientY, e); });
  document.addEventListener('mouseup', (e) => {
    if (!mouseDown) return;
    mouseDown = false;
    finish(e.clientX, e.clientY, e);
  });

  // ------------------------------------------------------------- startup

  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vh', h + 'px');
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  }

  function tickNow() {
    for (const el of $$('.now')) {
      const scroll = el.closest('.grid-scroll');
      const days = scroll.dataset.days.split(',').map((x) => new Date(+x));
      const day = days[+el.dataset.now];
      if (!C.sameDay(day, new Date())) { render(); return; }
      el.style.top = `calc(var(--hh) * ${C.minuteOfDay(new Date(), day) / 60} * 1px)`;
    }
  }

  function start() {
    renderQuickAdd();
    render();
    fitViewport();
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
    window.addEventListener('resize', fitViewport);
    load(true);
    setInterval(tickNow, 30e3);
    // Pick up changes made elsewhere (system Calendar, other devices)
    setInterval(() => {
      if (!document.hidden && !Gest.active && !Gest.pinch && !S.sheet && !S.loading) refresh();
    }, 30e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  window.OneGlance = { state: S, refresh, render, agenda };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
