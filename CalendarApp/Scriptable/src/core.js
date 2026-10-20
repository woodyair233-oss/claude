// GlanceCore: pure logic shared by the web UI, the Scriptable runtime and the
// Node tests. Everything works in whole days; times of day are never shown.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- dates

  const DAY_MS = 864e5;

  function startOfDay(d) {
    const x = new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate());
  }

  /** Same wall-clock time `n` days later (DST safe). */
  function addDays(d, n) {
    const x = new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n,
      x.getHours(), x.getMinutes(), x.getSeconds(), x.getMilliseconds());
  }

  function addMonths(d, n) {
    const x = new Date(d);
    const target = new Date(x.getFullYear(), x.getMonth() + n, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(x.getDate(), last),
      x.getHours(), x.getMinutes());
  }

  /** Whole days from `a` to `b` (calendar days, not 24 h blocks). */
  function daysBetween(a, b) {
    return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
  }

  function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function sameMonth(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();
  }

  /** 1 = Monday … 7 = Sunday. */
  function isoWeekday(d) {
    const w = new Date(d).getDay();
    return w === 0 ? 7 : w;
  }

  /** @param weekStart 1 = Monday, 0 = Sunday */
  function startOfWeek(date, weekStart) {
    const d = startOfDay(date);
    const back = (d.getDay() - (weekStart || 0) + 7) % 7;
    return addDays(d, -back);
  }

  function weekDays(date, weekStart) {
    const s = startOfWeek(date, weekStart);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }

  /** 42 days (6 weeks) covering the month of `date`. */
  function monthGrid(date, weekStart) {
    const d = new Date(date);
    const s = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1), weekStart);
    return Array.from({ length: 42 }, (_, i) => addDays(s, i));
  }

  /**
   * Days an event is listed on. Timed events (even overnight ones) show on
   * the day they start; all-day events on every day they cover.
   */
  function eventDays(start, end, allDay) {
    const s = startOfDay(start);
    if (!allDay) return [s];
    const last = startOfDay(new Date(Math.max(+start, +end - 1)));
    const days = [];
    for (let d = s; d <= last && days.length < 366; d = addDays(d, 1)) days.push(d);
    return days;
  }

  // ---------------------------------------------------------------- text

  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

  const fmt = {
    md: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日`; },
    mdw: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日 周${WEEKDAY[x.getDay()]}`; },
    ym: (d) => { const x = new Date(d); return `${x.getFullYear()}年${x.getMonth() + 1}月`; },
    weekdayLetter: (d) => WEEKDAY[new Date(d).getDay()],
    weekday: (d) => '周' + WEEKDAY[new Date(d).getDay()],
    /** "今天" / "明天" / "昨天" / "10月18日 周日" */
    relativeDay(d, now) {
      const diff = daysBetween(startOfDay(now || new Date()), d);
      if (diff === 0) return '今天';
      if (diff === 1) return '明天';
      if (diff === 2) return '后天';
      if (diff === -1) return '昨天';
      return fmt.mdw(d);
    },
  };

  /** 0 (nothing) … 4 (at or over the daily capacity). */
  function loadLevel(count, capacity) {
    if (count <= 0) return 0;
    const r = count / Math.max(capacity || 1, 1);
    if (r < 0.25) return 1;
    if (r < 0.5) return 2;
    if (r < 0.85) return 3;
    return 4;
  }

  // ---------------------------------------------------------------- parser

  const CN_NUM = '[零〇一二两兩三四五六七八九十]{1,3}';
  const ANY_NUM = '\\d{1,2}|' + CN_NUM;

  /** "12" → 12, "十二" → 12, "二十三" → 23, "两" → 2. */
  function chineseNumber(text) {
    if (text == null || text === '') return null;
    if (/^\d+$/.test(text)) return parseInt(text, 10);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0, current = 0, sawTen = false;
    for (const ch of text) {
      if (ch in digits) current = digits[ch];
      else if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; sawTen = true; }
      else return null;
    }
    const value = total + current;
    return (value > 0 || sawTen || /[零〇]/.test(text)) ? value : null;
  }

  const reCache = new Map();
  function firstMatch(pattern, text) {
    let re = reCache.get(pattern);
    if (!re) { re = new RegExp(pattern, 'i'); reCache.set(pattern, re); }
    const m = re.exec(text);
    return m && m[0].length ? m : null;
  }
  const cut = (text, m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);

  function weekdayIndex(s) {
    return { 一: 1, 1: 1, 二: 2, 2: 2, 三: 3, 3: 3, 四: 4, 4: 4, 五: 5, 5: 5, 六: 6, 6: 6, 日: 7, 天: 7, 7: 7 }[s] || null;
  }

  function englishWeekday(s) {
    return { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[(s || '').toLowerCase().slice(0, 3)] || null;
  }

  function weekdayDate(target, prefix, today) {
    const cur = isoWeekday(today);
    let delta;
    switch (prefix || '') {
      case '本': case '这': case '这个': delta = target - cur; break;
      case '下': case '下个': delta = 7 - cur + target; break;
      case '下下': case '下下个': delta = 14 - cur + target; break;
      case '上': case '上个': delta = target - cur - 7; break;
      default: delta = (target - cur + 7) % 7;
    }
    return addDays(today, delta);
  }

  /** The month/day this year, or next year (or next month with rollMonth) if it passed. */
  function nearestFuture(month, day, year, today, rollMonth) {
    const d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    if (d >= today) return d;
    return rollMonth ? addMonths(d, 1) : new Date(year + 1, month - 1, day);
  }

  /** Finds a date expression, removes it from state.text and returns the day. */
  function parseDate(state, today) {
    const year = today.getFullYear();
    let m;

    if ((m = firstMatch('(\\d{4})\\s*[-/.年]\\s*(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*[日号號]?', state.text))) {
      state.text = cut(state.text, m);
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if ((m = firstMatch('(' + ANY_NUM + ')\\s*月\\s*(' + ANY_NUM + ')\\s*[日号號]', state.text))) {
      const mo = chineseNumber(m[1]), d = chineseNumber(m[2]);
      const date = mo && d ? nearestFuture(mo, d, year, today) : null;
      if (date) { state.text = cut(state.text, m); return date; }
    }
    if ((m = firstMatch('(?<![\\d:/])(\\d{1,2})/(\\d{1,2})(?![\\d/])', state.text))) {
      const mo = +m[1], d = +m[2];
      const date = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? nearestFuture(mo, d, year, today) : null;
      if (date) { state.text = cut(state.text, m); return date; }
    }
    const words = [
      ['大后天', 3], ['后天', 2], ['明早', 1], ['明晨', 1], ['明晚', 1], ['明天', 1], ['明日', 1],
      ['今早', 0], ['今晨', 0], ['今晚', 0], ['今天', 0], ['今日', 0], ['昨天', -1],
      ['tomorrow', 1], ['tmr', 1], ['tonight', 0], ['today', 0],
    ];
    if ((m = firstMatch('(?<![a-z])(' + words.map((w) => w[0]).join('|') + ')(?![a-z])', state.text))) {
      const w = words.find((x) => x[0] === m[1].toLowerCase());
      if (w) { state.text = cut(state.text, m); return addDays(today, w[1]); }
    }
    if ((m = firstMatch('(' + ANY_NUM + ')\\s*天[以之]?后', state.text))) {
      const n = chineseNumber(m[1]);
      if (n != null) { state.text = cut(state.text, m); return addDays(today, n); }
    }
    if ((m = firstMatch('(下下个?|下个?|这个?|本|上个?)?\\s*(?:周|星期|礼拜|週)\\s*([一二三四五六日天1-7])', state.text))) {
      const target = weekdayIndex(m[2]);
      if (target) { state.text = cut(state.text, m); return weekdayDate(target, m[1], today); }
    }
    if ((m = firstMatch('(?<![a-z])(next\\s+|this\\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?(?![a-z])', state.text))) {
      const target = englishWeekday(m[2]);
      if (target) {
        state.text = cut(state.text, m);
        const p = (m[1] || '').trim().toLowerCase();
        return weekdayDate(target, p === 'next' ? '下' : p === 'this' ? '本' : null, today);
      }
    }
    // 16号 / 16日 (not "12号床", "一日三餐")
    for (const pattern of [
      '(?<![\\d月/])(' + ANY_NUM + ')\\s*[号號](?![床房楼樓病诊診室线線窗口])',
      '(?<![\\d月/])(\\d{1,2})\\s*日(?![程历曆])',
    ]) {
      m = firstMatch(pattern, state.text);
      if (!m) continue;
      const d = chineseNumber(m[1]);
      if (d >= 1 && d <= 31) {
        const date = nearestFuture(today.getMonth() + 1, d, year, today, true);
        if (date) { state.text = cut(state.text, m); return date; }
      }
    }
    return null;
  }

  function cleanTitle(text) {
    return text.split(/\s+/).filter(Boolean).join(' ')
      .replace(/^[\s,，、;；:：\-–—~～.。]+|[\s,，、;；:：\-–—~～.。]+$/g, '');
  }

  /**
   * Parses one quick-add line into a task: "明天 交报告 #工作 !!".
   * Without a date the task goes to the to-do area (day = null).
   * Clock times are not interpreted; they stay in the title.
   */
  function parseTask(input, opts) {
    const now = opts && opts.now ? new Date(opts.now) : new Date();
    const state = { text: ' ' + String(input).replace(/\u3000/g, ' ') + ' ' };
    let m;
    if ((m = firstMatch('^\\s*(待办|提醒我?|任务|todo|task)\\s*[:：]?\\s*', state.text))) state.text = cut(state.text, m);
    let listHint = null;
    if ((m = firstMatch('[#＃]([^\\s#＃]+)', state.text))) {
      listHint = m[1];
      state.text = cut(state.text, m);
    }
    let priority = 0;
    if ((m = firstMatch('(?:^|\\s)([!！]{1,3})(?=\\s|$)', state.text))) {
      priority = m[1].length === 3 ? 1 : m[1].length === 2 ? 5 : 9;
      state.text = cut(state.text, m);
    }
    const day = parseDate(state, startOfDay(now));
    return { title: cleanTitle(state.text), day: day ? startOfDay(day) : null, priority, listHint };
  }

  const GlanceCore = {
    startOfDay, addDays, addMonths, daysBetween, sameDay, sameMonth, isoWeekday,
    startOfWeek, weekDays, monthGrid, eventDays, fmt, loadLevel, chineseNumber, parseTask,
  };
  root.GlanceCore = GlanceCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
