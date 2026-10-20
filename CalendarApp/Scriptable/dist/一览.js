// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;
// 一览 · 日历与任务排程（Scriptable 版）。由 CalendarApp/Scriptable/build.mjs 生成，请勿手动修改。
// @version b8bde426

// GlanceCore: pure logic shared by the web UI, the Scriptable runtime and the
// Node tests. JavaScript port of Packages/GlanceCore (Swift).
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

  function daysBetween(a, b) {
    return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
  }

  /** Minutes since midnight of `day` on the clock face; later days continue past 1440. */
  function minuteOfDay(date, day) {
    const d = new Date(date);
    return daysBetween(day, d) * 1440 + d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  /** The date at `minute` (may exceed 1440 or be negative) on `day`'s clock. */
  function dateOnDay(day, minute) {
    const m = Math.round(minute);
    const shift = Math.floor(m / 1440);
    const within = m - shift * 1440;
    const d = startOfDay(day);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift, Math.floor(within / 60), within % 60);
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

  function snap(value, step) {
    const s = Math.max(step || 1, 1);
    return Math.round(value / s) * s;
  }

  // ---------------------------------------------------------------- text

  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n) => String(n).padStart(2, '0');

  const fmt = {
    hm: (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; },
    md: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日`; },
    mdw: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日 周${WEEKDAY[x.getDay()]}`; },
    ym: (d) => { const x = new Date(d); return `${x.getFullYear()}年${x.getMonth() + 1}月`; },
    weekdayLetter: (d) => WEEKDAY[new Date(d).getDay()],
    clock: (minute) => { const m = ((Math.round(minute) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; },
    /** "09:00–10:30", "20:00–次日08:00", "09:00–10月20日 18:00" */
    range(start, end) {
      const s = new Date(start), e = new Date(end);
      const endRef = (e.getTime() === startOfDay(e).getTime() && e > s) ? new Date(e - 1) : e;
      if (sameDay(s, endRef)) return `${fmt.hm(s)}–${fmt.hm(e)}`;
      if (sameDay(addDays(s, 1), endRef)) return `${fmt.hm(s)}–次日${fmt.hm(e)}`;
      return `${fmt.hm(s)}–${fmt.md(e)} ${fmt.hm(e)}`;
    },
    relativeDay(d, now) {
      const t = startOfDay(now || new Date());
      const diff = daysBetween(t, d);
      if (diff === 0) return '今天';
      if (diff === 1) return '明天';
      if (diff === -1) return '昨天';
      return fmt.mdw(d);
    },
    /** "45分钟", "2小时", "1小时30分" */
    duration(minutes) {
      const m = Math.max(0, Math.round(minutes));
      const h = Math.floor(m / 60), r = m % 60;
      if (h === 0) return `${r}分钟`;
      if (r === 0) return `${h}小时`;
      return `${h}小时${r}分`;
    },
  };

  // ---------------------------------------------------------------- layout

  /**
   * Side-by-side layout for overlapping blocks in one column.
   * @param items [{id, start, end}] in minutes
   * @returns {[id]: {column, columnCount, span}}
   */
  function layoutTimeline(items, minimumLength) {
    const minLen = minimumLength == null ? 20 : minimumLength;
    const visualEnd = (it) => Math.max(it.end, it.start + minLen);
    const sorted = items.slice().sort((a, b) =>
      a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const result = {};
    let cluster = [];
    let columnEnds = [];
    let clusterEnd = -Infinity;

    const flush = () => {
      const count = columnEnds.length;
      for (const { item, column } of cluster) {
        let span = 1;
        for (let next = column + 1; next < count; next++) {
          const blocked = cluster.some((o) => o.column === next &&
            o.item.start < visualEnd(item) && visualEnd(o.item) > item.start);
          if (blocked) break;
          span++;
        }
        result[item.id] = { column, columnCount: count, span };
      }
      cluster = [];
      columnEnds = [];
    };

    for (const item of sorted) {
      if (item.start >= clusterEnd && cluster.length) flush();
      let column = columnEnds.findIndex((e) => e <= item.start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(visualEnd(item));
      } else {
        columnEnds[column] = visualEnd(item);
      }
      cluster.push({ item, column });
      clusterEnd = Math.max(clusterEnd, visualEnd(item));
    }
    flush();
    return result;
  }

  /** Union length of [start, end] intervals (minutes), clipped to [lower, upper]. */
  function busyMinutes(intervals, lower, upper) {
    const lo = lower == null ? 0 : lower, hi = upper == null ? 1440 : upper;
    const clipped = intervals
      .map((i) => [Math.max(i.start, lo), Math.min(i.end, hi)])
      .filter((i) => i[1] > i[0])
      .sort((a, b) => a[0] - b[0]);
    let total = 0, cur = null;
    for (const i of clipped) {
      if (cur && i[0] <= cur[1]) cur[1] = Math.max(cur[1], i[1]);
      else { if (cur) total += cur[1] - cur[0]; cur = i.slice(); }
    }
    if (cur) total += cur[1] - cur[0];
    return total;
  }

  /** 0 (empty) … 4 (full or over capacity). */
  function loadLevel(busy, capacity) {
    if (busy <= 0) return 0;
    const r = busy / Math.max(capacity, 1);
    if (r < 0.25) return 1;
    if (r < 0.5) return 2;
    if (r < 0.85) return 3;
    return 4;
  }

  /** Gaps of at least `minimumGap` minutes between busy intervals. */
  function freeGaps(intervals, minimumGap) {
    const min = minimumGap == null ? 15 : minimumGap;
    const sorted = intervals.slice().sort((a, b) => a.start - b.start);
    const gaps = [];
    let cursor = null;
    for (const i of sorted) {
      if (cursor != null && i.start - cursor >= min) gaps.push({ start: cursor, end: i.start });
      cursor = cursor == null ? i.end : Math.max(cursor, i.end);
    }
    return gaps;
  }

  // ---------------------------------------------------------------- shifts

  const DEFAULT_SHIFTS = [
    { id: '5A1F0C2E-0001-4C1A-9E0B-000000000001', name: '白班', shortName: '白', color: '#F59E0B', startMinute: 480, durationMinutes: 540, isAllDay: false },
    { id: '5A1F0C2E-0002-4C1A-9E0B-000000000002', name: '夜班', shortName: '夜', color: '#6366F1', startMinute: 1200, durationMinutes: 720, isAllDay: false },
    { id: '5A1F0C2E-0003-4C1A-9E0B-000000000003', name: '值班', shortName: '值', color: '#EF4444', startMinute: 480, durationMinutes: 1440, isAllDay: false },
    { id: '5A1F0C2E-0004-4C1A-9E0B-000000000004', name: '休息', shortName: '休', color: '#10B981', startMinute: 0, durationMinutes: 1440, isAllDay: true },
  ];

  const shifts = {
    defaults: () => DEFAULT_SHIFTS.map((t) => Object.assign({}, t)),

    interval(t, day) {
      if (t.isAllDay) {
        const s = startOfDay(day);
        return { start: s, end: addDays(s, 1) };
      }
      return { start: dateOnDay(day, t.startMinute), end: dateOnDay(day, t.startMinute + t.durationMinutes) };
    },

    /** "08:00–17:00", "20:00–次日08:00", "全天" */
    timeText(t) {
      if (t.isAllDay) return '全天';
      const end = t.startMinute + t.durationMinutes;
      return `${fmt.clock(t.startMinute)}–${end >= 1440 ? '次日' : ''}${fmt.clock(end)}`;
    },

    /** Template whose name equals the event title, if any. */
    match(templates, title) {
      const t = (title || '').trim();
      return templates.find((x) => x.name === t) || null;
    },

    /** Hours of rest before each timed shift (sorted by start); null when unknown. */
    restBefore(list) {
      let prevEnd = null;
      return list.slice().sort((a, b) => a.start - b.start).map((s) => {
        if (s.isAllDay) return null;
        const rest = prevEnd == null ? null : (new Date(s.start) - prevEnd) / 3600e3;
        prevEnd = prevEnd == null ? new Date(s.end) : new Date(Math.max(prevEnd, new Date(s.end)));
        return rest;
      });
    },

    /** Counts per template id and total timed minutes for shifts starting in [from, to). */
    summary(list, from, to) {
      const counts = {};
      let minutes = 0;
      for (const s of list) {
        const st = new Date(s.start);
        if (st < from || st >= to) continue;
        if (s.templateId) counts[s.templateId] = (counts[s.templateId] || 0) + 1;
        if (!s.isAllDay) minutes += (new Date(s.end) - st) / 60e3;
      }
      return { counts, minutes: Math.round(minutes) };
    },
  };

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
  function allMatches(pattern, text) {
    let re = reCache.get(pattern);
    if (!re) { re = new RegExp(pattern, 'gi'); reCache.set(pattern, re); }
    re.lastIndex = 0;
    return Array.from(text.matchAll(re)).filter((m) => m[0].length > 0);
  }
  const firstMatch = (pattern, text) => allMatches(pattern, text)[0] || null;
  const cut = (text, m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);

  // Groups per time: 1 period, 2 hour, 3 colon, 4 colon minutes, 5 点,
  // 6 Chinese minute word, 7 Chinese minute number, 8 am/pm.
  const G = 8;
  const TIME =
    '(?:(上午|早上|早晨|清晨|中午|下午|午后|傍晚|晚上|夜里|夜间|深夜|凌晨)\\s*)?' +
    '(\\d{1,2}|' + CN_NUM + ')' +
    '(?:\\s*([:：])\\s*(\\d{2})|\\s*([点點])(?:\\s*(半|一刻|三刻|(\\d{1,2}|' + CN_NUM + ')\\s*分?))?)?' +
    '(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?![a-z]))?';

  function clockTime(m, off) {
    const hourText = m[off + 2];
    const hour = chineseNumber(hourText);
    if (hour == null) return null;
    const colonMinute = m[off + 4], cnWord = m[off + 6], cnNumber = m[off + 7];
    const ampm = m[off + 8] ? m[off + 8].toLowerCase().replace(/\./g, '') : null;
    let minute = 0;
    if (colonMinute != null) minute = parseInt(colonMinute, 10);
    else if (cnNumber != null) minute = chineseNumber(cnNumber) || 0;
    else if (cnWord === '半') minute = 30;
    else if (cnWord === '一刻') minute = 15;
    else if (cnWord === '三刻') minute = 45;
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
    // "一点" alone usually means "a little" (早一点到), not 1 o'clock
    if (hourText === '一' && m[off + 1] == null && cnWord == null && cnNumber == null && ampm == null) return null;
    return {
      hour, minute, period: m[off + 1] || null, ampm,
      isColon: colonMinute != null,
      hasMarker: colonMinute != null || m[off + 5] != null || ampm != null,
      is24Hour: hour >= 13 || (hourText.length === 2 && hourText[0] === '0'),
    };
  }

  /** Minutes after midnight; `guessAfternoon` reads a bare 1–6 o'clock as p.m. */
  function resolveTime(t, hint, guessAfternoon) {
    let h = t.hour;
    if (t.ampm) {
      if (t.ampm === 'pm' && h < 12) h += 12;
      if (t.ampm === 'am' && h === 12) h = 0;
    } else if (t.period) {
      if (['下午', '午后', '傍晚', '晚上', '夜里', '夜间', '深夜'].includes(t.period)) {
        if (h < 12) h += 12; else if (h === 12) h = 24;
      } else if (t.period === '中午') {
        if (h < 6) h += 12;
      } else if (t.period === '凌晨') {
        if (h === 12) h = 0;
      }
    } else if (hint === 'evening' && h < 12) {
      h += 12;
    } else if (guessAfternoon && hint == null && h >= 1 && h <= 6 && !t.is24Hour) {
      h += 12;
    }
    return h * 60 + t.minute;
  }

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

  function parseDate(state, today) {
    const year = today.getFullYear();
    let m;

    if ((m = firstMatch('(\\d{4})\\s*[-/.年]\\s*(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*[日号號]?', state.text))) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      state.text = cut(state.text, m);
      return { day: d, part: null };
    }
    if ((m = firstMatch('(' + ANY_NUM + ')\\s*月\\s*(' + ANY_NUM + ')\\s*[日号號]', state.text))) {
      const mo = chineseNumber(m[1]), d = chineseNumber(m[2]);
      const date = mo && d ? nearestFuture(mo, d, year, today) : null;
      if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }
    }
    if ((m = firstMatch('(?<![\\d:/])(\\d{1,2})/(\\d{1,2})(?![\\d/])', state.text))) {
      const mo = +m[1], d = +m[2];
      const date = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? nearestFuture(mo, d, year, today) : null;
      if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }
    }

    const words = [
      ['大后天', 3, null], ['后天', 2, null],
      ['明早', 1, 'morning'], ['明晨', 1, 'morning'], ['明晚', 1, 'evening'],
      ['明天', 1, null], ['明日', 1, null],
      ['今早', 0, 'morning'], ['今晨', 0, 'morning'], ['今晚', 0, 'evening'],
      ['今天', 0, null], ['今日', 0, null],
      ['昨天', -1, null],
      ['tomorrow', 1, null], ['tmr', 1, null], ['tonight', 0, 'evening'], ['today', 0, null],
    ];
    const alt = words.map((w) => w[0]).join('|');
    if ((m = firstMatch('(?<![a-z])(' + alt + ')(?![a-z])', state.text))) {
      const w = words.find((x) => x[0] === m[1].toLowerCase());
      if (w) { state.text = cut(state.text, m); return { day: addDays(today, w[1]), part: w[2] }; }
    }
    if ((m = firstMatch('(' + ANY_NUM + ')\\s*天[以之]?后', state.text))) {
      const n = chineseNumber(m[1]);
      if (n != null) { state.text = cut(state.text, m); return { day: addDays(today, n), part: null }; }
    }
    if ((m = firstMatch('(下下个?|下个?|这个?|本|上个?)?\\s*(?:周|星期|礼拜|週)\\s*([一二三四五六日天1-7])', state.text))) {
      const target = weekdayIndex(m[2]);
      if (target) { state.text = cut(state.text, m); return { day: weekdayDate(target, m[1], today), part: null }; }
    }
    if ((m = firstMatch('(?<![a-z])(next\\s+|this\\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?(?![a-z])', state.text))) {
      const target = englishWeekday(m[2]);
      if (target) {
        state.text = cut(state.text, m);
        const p = (m[1] || '').trim().toLowerCase();
        return { day: weekdayDate(target, p === 'next' ? '下' : p === 'this' ? '本' : null, today), part: null };
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
        if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }
      }
    }
    return null;
  }

  function parseDuration(state) {
    let m;
    if ((m = firstMatch('(' + ANY_NUM + ')\\s*个半\\s*(?:小时|钟头|鐘頭)', state.text))) {
      const h = chineseNumber(m[1]);
      if (h != null) { state.text = cut(state.text, m); return h * 60 + 30; }
    }
    if ((m = firstMatch('半\\s*个?\\s*(?:小时|钟头|鐘頭)', state.text))) {
      state.text = cut(state.text, m);
      return 30;
    }
    const hourPattern = '(\\d+(?:\\.\\d+)?|' + CN_NUM + ')\\s*个?\\s*(?:小时|钟头|鐘頭|hours?|hrs?|h)(?![a-z])' +
      '(?:\\s*(\\d+|' + CN_NUM + ')\\s*(?:分钟|分鐘|分|minutes?|mins?|m)(?![a-z]))?';
    if ((m = firstMatch(hourPattern, state.text))) {
      const hours = /^\d/.test(m[1]) ? parseFloat(m[1]) : chineseNumber(m[1]);
      if (hours != null && !isNaN(hours)) {
        state.text = cut(state.text, m);
        const extra = m[2] ? (chineseNumber(m[2]) || 0) : 0;
        return Math.round(hours * 60) + extra;
      }
    }
    // A bare "分" is left alone: "3点15分" is a time
    if ((m = firstMatch('(\\d+|' + CN_NUM + ')\\s*(?:分钟|分鐘|minutes?|mins?|m)(?![a-z])', state.text))) {
      const minutes = chineseNumber(m[1]);
      if (minutes > 0) { state.text = cut(state.text, m); return minutes; }
    }
    return null;
  }

  function parseTimeRange(state, hint) {
    const pattern = TIME + '\\s*(?:-|–|—|~|～|〜|到|至|to)\\s*' + TIME;
    for (const m of allMatches(pattern, state.text)) {
      const a = clockTime(m, 0), b = clockTime(m, G);
      if (!a || !b || !(a.hasMarker || b.hasMarker)) continue;
      // "3-5pm": the first time borrows the second's am/pm
      if (!a.ampm && !a.period && b.ampm) a.ampm = b.ampm;
      let start = resolveTime(a, hint, true);
      let end;
      if (b.ampm || b.period || b.is24Hour) {
        const explicit = resolveTime(b, hint, false);
        // "6:00-14:00" is a morning start, not 18:00
        const plain = resolveTime(a, hint, false);
        if (plain < explicit && start >= explicit) start = plain;
        end = explicit > start ? explicit : explicit + 1440;
      } else if (hint === 'evening') {
        const e = resolveTime(b, hint, false);
        end = e > start ? e : e + 1440;
      } else {
        // Earliest reading after the start: "3点-5点" → 17:00, "22:00-6:00" → next day 06:00
        const raw = b.hour * 60 + b.minute;
        const candidates = [raw];
        if (b.hour < 12) candidates.push(raw + 720);
        candidates.push(raw + 1440);
        end = candidates.find((c) => c > start);
        if (end == null) end = raw + 1440;
      }
      state.text = cut(state.text, m);
      return [start, end];
    }
    return null;
  }

  function parseSingleTime(state, hint) {
    for (const m of allMatches(TIME, state.text)) {
      const t = clockTime(m, 0);
      if (!t || !t.hasMarker) continue;
      state.text = cut(state.text, m);
      return resolveTime(t, hint, true);
    }
    return null;
  }

  function cleanTitle(text) {
    return text.split(/\s+/).filter(Boolean).join(' ')
      .replace(/^[\s,，、;；:：\-–—~～.。]+|[\s,，、;；:：\-–—~～.。]+$/g, '');
  }

  /**
   * Parses one quick-add line.
   * @param opts {now, defaultDay, override: 'automatic'|'event'|'reminder', defaultEventMinutes, shiftNames}
   */
  function parseQuickAdd(input, opts) {
    const o = opts || {};
    const now = o.now ? new Date(o.now) : new Date();
    const today = startOfDay(now);
    const state = { text: ' ' + String(input).replace(/\u3000/g, ' ') + ' ' };
    let m;

    let forcedReminder = false;
    if ((m = firstMatch('^\\s*(待办|提醒我?|任务|todo|task)\\s*[:：]?\\s*', state.text))) {
      forcedReminder = true;
      state.text = cut(state.text, m);
    }
    let calendarHint = null;
    if ((m = firstMatch('[#＃]([^\\s#＃]+)', state.text))) {
      calendarHint = m[1];
      state.text = cut(state.text, m);
    }
    let priority = 0;
    if ((m = firstMatch('(?:^|\\s)([!！]{1,3})(?=\\s|$)', state.text))) {
      priority = m[1].length === 3 ? 1 : m[1].length === 2 ? 5 : 9;
      state.text = cut(state.text, m);
    }
    let allDay = false;
    if ((m = firstMatch('全天|整天|all[\\s-]?day', state.text))) {
      allDay = true;
      state.text = cut(state.text, m);
    }
    const date = parseDate(state, today);
    const duration = parseDuration(state);
    let startMinute = null, endMinute = null;
    const range = parseTimeRange(state, date && date.part);
    if (range) { startMinute = range[0]; endMinute = range[1]; }
    else startMinute = parseSingleTime(state, date && date.part);

    const title = cleanTitle(state.text);
    const day = date ? startOfDay(date.day) : startOfDay(o.defaultDay || now);
    const hasTime = startMinute != null;

    let kind, shiftName = null;
    const override = o.override || 'automatic';
    if (override === 'reminder') kind = 'reminder';
    else if (override === 'event') kind = hasTime ? 'event' : 'allDayEvent';
    else if (forcedReminder) kind = 'reminder';
    else if (allDay) kind = 'allDayEvent';
    else if (!hasTime && (shiftName = (o.shiftNames || []).find((n) => n.toLowerCase() === title.toLowerCase()) || null)) kind = 'shift';
    else kind = hasTime ? 'event' : 'reminder';

    let start = null, end = null;
    if (hasTime) {
      start = dateOnDay(day, startMinute);
      if (kind === 'event') {
        end = dateOnDay(day, endMinute != null ? endMinute : startMinute + (duration || o.defaultEventMinutes || 60));
      }
    }
    if (kind === 'allDayEvent') { start = day; end = addDays(day, 1); }

    return {
      kind, title, day, start, end,
      hasExplicitDate: !!date,
      hasTime: hasTime && kind !== 'allDayEvent',
      durationMinutes: endMinute != null && startMinute != null ? endMinute - startMinute : duration,
      priority, calendarHint, shiftName,
    };
  }

  const GlanceCore = {
    startOfDay, addDays, addMonths, daysBetween, minuteOfDay, dateOnDay, sameDay, sameMonth,
    isoWeekday, startOfWeek, weekDays, monthGrid, snap, fmt,
    layoutTimeline, busyMinutes, loadLevel, freeGaps,
    shifts, chineseNumber, parseQuickAdd,
  };
  root.GlanceCore = GlanceCore;
  if (typeof module !== 'undefined' && module && module.exports && typeof window === 'undefined' && typeof Script === 'undefined') {
    module.exports = GlanceCore;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Scriptable runtime for 一览. The build prepends core.js and fills in APP_HTML.
//
// Run from the app or a Home Screen icon → full-screen UI in a WebView.
// Run as a widget → today's shift, events and tasks.
// Run from Shortcuts/Siri with text, or scriptable:///run/一览?add=… → quick add without UI.

const C = globalThis.GlanceCore;
const APP_HTML = "<!doctype html>\n<html lang=\"zh-Hans\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover\">\n<title>一览</title>\n<style>\n:root {\n  --bg: #ffffff;\n  --surface: #f2f2f7;\n  --surface2: #e5e5ea;\n  --text: #1c1c1e;\n  --text2: #6c6c70;\n  --text3: #aeaeb2;\n  --sep: rgba(60, 60, 67, 0.18);\n  --accent: #286be6;\n  --accent-soft: rgba(40, 107, 230, 0.14);\n  --red: #e5383b;\n  --orange: #f08c00;\n  --heat: 249, 115, 22;\n  --sheet: #ffffff;\n  --shadow: 0 6px 20px rgba(0, 0, 0, 0.18);\n  --gutter: 46px;\n  --hh: 56;\n  --vh: 100dvh;\n  color-scheme: light dark;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #000000;\n    --surface: #1c1c1e;\n    --surface2: #2c2c2e;\n    --text: #f2f2f7;\n    --text2: #98989f;\n    --text3: #5a5a5f;\n    --sep: rgba(84, 84, 88, 0.6);\n    --accent: #5a92ff;\n    --accent-soft: rgba(90, 146, 255, 0.2);\n    --red: #ff5a5f;\n    --orange: #ffa53a;\n    --sheet: #1c1c1e;\n    --shadow: 0 6px 20px rgba(0, 0, 0, 0.6);\n  }\n}\n\n* { box-sizing: border-box; margin: 0; padding: 0; }\nhtml, body {\n  height: 100%;\n  background: var(--bg);\n  color: var(--text);\n  font: 15px/1.35 -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Noto Sans CJK SC\", sans-serif;\n  -webkit-text-size-adjust: 100%;\n  -webkit-tap-highlight-color: transparent;\n  overscroll-behavior: none;\n  touch-action: manipulation;\n}\nbody { overflow: hidden; }\nbutton { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }\ninput, select, textarea { font: inherit; color: inherit; }\n.mono { font-variant-numeric: tabular-nums; }\n.muted { color: var(--text2); }\n.noselect, .blk, .chip, .surface, .cell, .strip-day {\n  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;\n}\n\n#app {\n  height: var(--vh);\n  display: flex;\n  flex-direction: column;\n  padding-top: env(safe-area-inset-top);\n}\n#main { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }\n\n/* ------------------------------------------------------------ header */\n.hdr { padding: 6px 12px 6px; display: flex; flex-direction: column; gap: 7px; }\n.hdr-row { display: flex; align-items: center; gap: 2px; }\n.hdr-title { flex: 1; min-width: 0; }\n.hdr-title h1 { font-size: 20px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.hdr-title p { font-size: 12px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.icon-btn { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); font-size: 18px; }\n.icon-btn:active { background: var(--surface); }\n.text-btn { color: var(--accent); font-weight: 500; padding: 6px 8px; border-radius: 8px; }\n.text-btn:disabled { color: var(--text3); }\n.seg-row { display: flex; gap: 8px; align-items: center; }\n.seg { flex: 1; display: flex; background: var(--surface); border-radius: 9px; padding: 2px; }\n.seg button { flex: 1; padding: 5px 0; border-radius: 7px; font-size: 14px; font-weight: 500; color: var(--text); }\n.seg button.on { background: var(--bg); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }\n@media (prefers-color-scheme: dark) { .seg button.on { background: #636366; } }\n.style-btn { height: 32px; padding: 0 10px; border-radius: 9px; background: var(--surface); color: var(--accent); font-size: 13px; font-weight: 600; }\n\n.strip { display: flex; gap: 2px; touch-action: pan-y; }\n.strip-day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 2px 0; border-radius: 10px; }\n.strip-day .wd { font-size: 11px; color: var(--text2); }\n.strip-day .num { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; font-size: 16px; font-variant-numeric: tabular-nums; }\n.strip-day.today .num { color: var(--accent); font-weight: 700; }\n.strip-day.sel .num { background: var(--accent); color: #fff; font-weight: 700; }\n.strip-day .mark { height: 14px; display: grid; place-items: center; }\n.loadbar { width: 18px; height: 4px; border-radius: 2px; }\n.drop-hot { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--accent-soft); }\n\n.badge {\n  display: inline-grid; place-items: center; min-width: 16px; height: 15px; padding: 0 3px;\n  border-radius: 3px; font-size: 10px; font-weight: 700; color: #fff; line-height: 1;\n}\n\n/* ------------------------------------------------------------ tray */\n.tray { padding: 4px 12px 6px; display: flex; flex-direction: column; gap: 6px; border-bottom: 0.5px solid var(--sep); }\n.tray-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text2); }\n.tray-head .grow { flex: 1; }\n.pill-btn { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 12px; background: var(--surface); color: var(--accent); }\n.tray-body { max-height: 190px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }\n.inbox { padding: 8px; border-radius: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 4px; }\n.inbox .chips { max-height: 140px; overflow-y: auto; }\n.hint { font-size: 11px; color: var(--text2); }\n.chips { display: flex; flex-wrap: wrap; gap: 6px; }\n.chip {\n  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;\n  padding: 4px 10px 4px 7px; border-radius: 16px; font-size: 14px;\n  background: color-mix(in srgb, var(--c) 14%, transparent);\n}\n.chip .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }\n.chip.done { opacity: 0.55; }\n.chip.done .t { text-decoration: line-through; }\n.chip.overdue { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--red) 60%, transparent); }\n.chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); flex: none; margin-left: 2px; }\n.chip .sub { font-size: 11px; color: var(--text2); flex: none; }\n.chip .sub.red { color: var(--red); }\n.check {\n  width: 19px; height: 19px; border-radius: 50%; border: 1.6px solid var(--c); flex: none;\n  display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700;\n}\n.check.on { background: var(--c); }\n.prio { color: var(--red); font-weight: 700; font-size: 12px; }\n.shift-banner {\n  display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 9px;\n  background: color-mix(in srgb, var(--c) 15%, transparent); font-size: 14px;\n}\n.shift-banner .name { font-weight: 600; }\n.shift-banner .warn { margin-left: auto; color: var(--orange); font-size: 12px; white-space: nowrap; }\n\n/* ------------------------------------------------------------ time grid */\n.grid-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; position: relative; overscroll-behavior: contain; }\n.grid { position: relative; height: calc(var(--hh) * 24px); }\n.hour { position: absolute; left: 0; right: 0; height: 0; }\n.hour::after { content: \"\"; position: absolute; left: var(--gutter); right: 0; top: 0; border-top: 0.5px solid var(--sep); }\n.hour.half::after { border-top-style: dotted; opacity: 0.6; }\n.hour span { position: absolute; left: 0; width: calc(var(--gutter) - 6px); text-align: right; top: -7px; font-size: 11px; color: var(--text2); font-variant-numeric: tabular-nums; }\n.surface { position: absolute; top: 0; bottom: 0; left: var(--gutter); right: 0; }\n.colbg { position: absolute; top: 0; bottom: 0; border-left: 0.5px solid var(--sep); pointer-events: none; }\n.colbg.today { background: var(--accent-soft); opacity: 0.5; }\n.blk {\n  position: absolute;\n  top: calc(var(--s) * var(--hh) * 1px / 60);\n  height: max(var(--minh, 22px), calc(var(--len) * var(--hh) * 1px / 60 - 1px));\n  border-radius: 5px; overflow: hidden;\n  background: color-mix(in srgb, var(--c) 24%, var(--bg));\n  border-left: 3px solid var(--c);\n  padding: 2px 3px 2px 5px; font-size: 12px; line-height: 1.25;\n  transition: box-shadow 0.15s, transform 0.15s;\n}\n.blk.task { background: color-mix(in srgb, var(--c) 10%, var(--bg)); border: 1px dashed var(--c); }\n@media (prefers-color-scheme: dark) {\n  .blk { background: color-mix(in srgb, var(--c) 36%, var(--bg)); }\n  .blk.task { background: color-mix(in srgb, var(--c) 16%, var(--bg)); }\n}\n.blk.ro { opacity: 0.85; }\n.blk .bt { font-weight: 600; display: flex; gap: 3px; align-items: flex-start; }\n.blk .bt .tt { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--lines, 2); }\n.blk .bs { color: var(--text2); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }\n.blk .check { width: 15px; height: 15px; font-size: 10px; margin-top: 1px; }\n.blk .handle { position: absolute; left: 0; right: 0; bottom: 0; height: 14px; display: grid; place-items: end center; padding-bottom: 2px; }\n.blk .handle::after { content: \"\"; width: 22px; height: 4px; border-radius: 2px; background: var(--c); opacity: 0.75; }\n.blk.short .handle::after { opacity: 0; }\n.blk.compact { font-size: 10px; padding: 1px 2px 1px 3px; border-left-width: 2px; }\n.blk.dragging { z-index: 10; box-shadow: var(--shadow); transform: scale(1.02); }\n.blk .tip {\n  position: absolute; top: 2px; right: 3px; font-size: 11px; font-weight: 700; padding: 1px 5px;\n  border-radius: 8px; background: var(--sheet); box-shadow: var(--shadow);\n}\n.now { position: absolute; height: 0; border-top: 1.5px solid var(--red); pointer-events: none; z-index: 5; }\n.now::before { content: \"\"; position: absolute; left: -4px; top: -4.5px; width: 7px; height: 7px; border-radius: 50%; background: var(--red); }\n.ghost {\n  position: absolute; border-radius: 6px; background: var(--accent-soft); border: 1.5px dashed var(--accent);\n  font-size: 11px; font-weight: 700; padding: 3px 5px; pointer-events: none; z-index: 8; font-variant-numeric: tabular-nums;\n}\n.floating {\n  position: fixed; z-index: 100; pointer-events: none; padding: 6px 12px; border-radius: 16px;\n  background: var(--sheet); box-shadow: var(--shadow); font-size: 14px; transform: translate(-50%, -130%);\n}\n\n/* week */\n.wk-head { display: flex; padding-left: 30px; }\n.wk-head .strip-day { padding: 2px 0 4px; }\n.wk-head .num { width: 26px; height: 26px; font-size: 14px; }\n.wk-head .strip-day.today .num { background: var(--accent); color: #fff; }\n.wk-allday { display: flex; border-bottom: 0.5px solid var(--sep); padding-bottom: 4px; }\n.wk-allday .lab { width: 30px; font-size: 9px; color: var(--text2); text-align: center; }\n.wk-allday .cell-ad { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; align-items: center; padding: 0 1px; }\n.mini { font-size: 9px; font-weight: 500; padding: 0 2px; border-radius: 3px; width: 100%; text-align: center;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: color-mix(in srgb, var(--c) 25%, transparent); }\n.cnt { font-size: 9px; font-weight: 600; color: var(--text2); }\n.cnt.red { color: var(--red); }\n\n/* ------------------------------------------------------------ list */\n.list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 20px; }\n.sec { padding: 10px 14px 4px; font-size: 13px; font-weight: 600; color: var(--text2); display: flex; align-items: center; gap: 6px; }\n.row { display: flex; align-items: center; gap: 10px; padding: 7px 14px; min-height: 40px; border-bottom: 0.5px solid var(--sep); }\n.row .time { width: 44px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }\n.row .time small { display: block; color: var(--text2); font-size: 12px; }\n.row .bar { width: 4px; align-self: stretch; border-radius: 2px; background: var(--c); flex: none; }\n.row .body { flex: 1; min-width: 0; }\n.row .body .t { font-size: 15px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }\n.row .body .d { font-size: 12px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.row.done .t { text-decoration: line-through; color: var(--text2); }\n.row .check { width: 22px; height: 22px; font-size: 13px; }\n.row .acts { display: flex; gap: 4px; flex: none; }\n.row .acts button { font-size: 12px; padding: 4px 8px; border-radius: 8px; background: var(--surface); color: var(--accent); }\n.gap-row { padding: 4px 14px 4px 68px; font-size: 12px; color: var(--text2); }\n.now-row { display: flex; align-items: center; gap: 6px; padding: 2px 14px; color: var(--red); font-size: 12px; font-weight: 700; }\n.now-row::after { content: \"\"; flex: 1; border-top: 1px solid var(--red); }\n.empty { padding: 10px 14px; color: var(--text2); font-size: 14px; }\n\n/* ------------------------------------------------------------ month */\n.month { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px; gap: 6px; }\n.mo-wd { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; padding-top: 4px; }\n.mo-wd span { text-align: center; font-size: 11px; color: var(--text2); }\n.mo-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; touch-action: pan-y; }\n.cell {\n  position: relative; min-height: 50px; border-radius: 8px; display: flex; flex-direction: column;\n  align-items: center; gap: 1px; padding-top: 3px; background: rgba(var(--heat), var(--a, 0));\n}\n.cell .n { font-size: 15px; font-variant-numeric: tabular-nums; }\n.cell.today .n { color: var(--accent); font-weight: 700; }\n.cell.hot .n, .cell.hot .cnt { color: #fff; }\n.cell.out { opacity: 0.35; }\n.cell.sel { box-shadow: inset 0 0 0 2px var(--accent); }\n.cell .mk { height: 14px; display: grid; place-items: center; }\n.cell .warn { position: absolute; top: 2px; right: 3px; font-size: 9px; color: var(--orange); }\n.mo-sum { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text2); }\n.legend { display: flex; align-items: center; gap: 2px; }\n.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }\n.mo-sum .grow { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.brush-btn { padding: 4px 10px; border-radius: 14px; background: var(--surface); font-size: 12px; font-weight: 600; color: var(--text2); white-space: nowrap; }\n.brush-btn.on { background: var(--accent); color: #fff; }\n.brushbar { padding: 8px; border-radius: 10px; background: var(--surface); display: flex; flex-direction: column; gap: 6px; }\n.brushbar .opts { display: flex; gap: 6px; overflow-x: auto; }\n.brush-opt { display: inline-flex; gap: 4px; align-items: center; padding: 4px 9px; border-radius: 14px; white-space: nowrap; font-size: 14px;\n  background: color-mix(in srgb, var(--c) 10%, transparent); }\n.brush-opt.on { background: color-mix(in srgb, var(--c) 28%, transparent); box-shadow: inset 0 0 0 1.5px var(--c); }\n.digest { flex: 1; min-height: 0; overflow-y: auto; border-top: 0.5px solid var(--sep); padding: 6px 2px 16px; display: flex; flex-direction: column; gap: 6px; }\n.digest .head { display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 15px; padding: 0 4px; }\n.digest .row { padding: 6px 4px; }\n\n/* ------------------------------------------------------------ quick add */\n.qa { padding: 7px 12px calc(7px + env(safe-area-inset-bottom)); border-top: 0.5px solid var(--sep); background: var(--bg); display: flex; flex-direction: column; gap: 6px; }\n.qa-row { display: flex; align-items: center; gap: 8px; }\n.qa input {\n  flex: 1; min-width: 0; border: 0; outline: 0; border-radius: 18px; padding: 9px 14px;\n  background: var(--surface); font-size: 16px;\n}\n.qa .send { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 18px; font-weight: 700; display: grid; place-items: center; }\n.qa .send:disabled { background: var(--text3); }\n.qa .plus { width: 34px; height: 34px; border-radius: 50%; color: var(--accent); font-size: 26px; display: grid; place-items: center; }\n.preview { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }\n.preview::-webkit-scrollbar { display: none; }\n.pv { white-space: nowrap; font-size: 12px; padding: 3px 9px; border-radius: 12px; background: var(--surface); }\n.pv.kind { background: var(--accent-soft); color: var(--accent); font-weight: 700; }\n.menu { position: absolute; bottom: calc(100% + 6px); left: 10px; background: var(--sheet); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; z-index: 30; }\n.menu button { display: block; width: 100%; text-align: left; padding: 11px 16px; font-size: 15px; border-bottom: 0.5px solid var(--sep); }\n\n/* ------------------------------------------------------------ toast */\n.toast {\n  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 40;\n  display: flex; gap: 12px; align-items: center; padding: 9px 16px; border-radius: 20px;\n  background: var(--sheet); box-shadow: var(--shadow); font-size: 14px; max-width: 92%;\n}\n.toast button { color: var(--accent); font-weight: 700; }\n\n/* ------------------------------------------------------------ sheet */\n.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 50; display: flex; align-items: flex-end; }\n.sheet {\n  width: 100%; max-height: 92%; background: var(--sheet); border-radius: 14px 14px 0 0;\n  display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom);\n  animation: up 0.2s ease-out;\n}\n@keyframes up { from { transform: translateY(40%); opacity: 0.5; } to { transform: none; opacity: 1; } }\n.sheet-head { display: flex; align-items: center; padding: 8px 8px; border-bottom: 0.5px solid var(--sep); }\n.sheet-head h2 { flex: 1; text-align: center; font-size: 16px; font-weight: 600; }\n.sheet-body { overflow-y: auto; padding: 8px 0 24px; -webkit-overflow-scrolling: touch; }\n.form-sec { margin: 10px 14px; background: var(--surface); border-radius: 11px; overflow: hidden; }\n.form-sec > .label { padding: 10px 14px 4px; font-size: 12px; color: var(--text2); background: var(--sheet); margin: -0px; }\n.fsec-title { margin: 14px 28px 4px; font-size: 12px; color: var(--text2); }\n.fsec-foot { margin: 4px 28px 0; font-size: 12px; color: var(--text2); }\n.f { display: flex; align-items: center; gap: 10px; padding: 10px 14px; min-height: 44px; border-bottom: 0.5px solid var(--sep); }\n.f:last-child { border-bottom: 0; }\n.f > label { flex: 1; }\n.f input[type=text], .f textarea { flex: 1; border: 0; outline: 0; background: transparent; font-size: 16px; min-width: 0; }\n.f textarea { resize: none; min-height: 60px; }\n.f input[type=date], .f input[type=time], .f select, .f input[type=number] {\n  border: 0; border-radius: 7px; padding: 5px 8px; background: var(--surface2); font-size: 15px; min-width: 0;\n}\n.f input[type=color] { width: 36px; height: 28px; border: 0; padding: 0; background: none; }\n.switch { position: relative; width: 50px; height: 30px; flex: none; }\n.switch input { opacity: 0; width: 0; height: 0; position: absolute; }\n.switch span { position: absolute; inset: 0; border-radius: 15px; background: var(--surface2); transition: 0.2s; }\n.switch span::after { content: \"\"; position: absolute; left: 2px; top: 2px; width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: 0.2s; }\n.switch input:checked + span { background: #34c759; }\n.switch input:checked + span::after { transform: translateX(20px); }\n.quick { display: flex; gap: 6px; flex-wrap: wrap; }\n.quick button { font-size: 13px; padding: 4px 10px; border-radius: 12px; background: var(--surface2); color: var(--accent); }\n.segf { display: flex; background: var(--surface2); border-radius: 8px; padding: 2px; flex: 1; }\n.segf button { flex: 1; padding: 5px 0; border-radius: 6px; font-size: 14px; }\n.segf button.on { background: var(--sheet); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); font-weight: 600; }\n.danger { color: var(--red); width: 100%; text-align: center; padding: 12px; font-size: 16px; }\n.note { padding: 10px 14px; font-size: 13px; color: var(--text2); }\n.tpl-head { display: flex; align-items: center; gap: 8px; }\n.stepper { display: flex; align-items: center; gap: 4px; }\n.stepper button { width: 32px; height: 28px; border-radius: 7px; background: var(--surface2); font-size: 18px; color: var(--accent); }\n.dot-sw { width: 11px; height: 11px; border-radius: 50%; background: var(--c); display: inline-block; flex: none; }\n\n/* permission / error */\n.center-msg { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 30px; text-align: center; color: var(--text2); }\n.center-msg h2 { color: var(--text); font-size: 22px; }\n.center-msg .primary { background: var(--accent); color: #fff; padding: 10px 20px; border-radius: 12px; font-weight: 600; }\n\n</style>\n</head>\n<body>\n<div id=\"app\"><header id=\"hdr\"></header><main id=\"main\"></main><footer id=\"qa\"></footer></div>\n<div id=\"sheet-root\"></div>\n<script>\n// GlanceCore: pure logic shared by the web UI, the Scriptable runtime and the\n// Node tests. JavaScript port of Packages/GlanceCore (Swift).\n(function (root) {\n  'use strict';\n\n  // ---------------------------------------------------------------- dates\n\n  const DAY_MS = 864e5;\n\n  function startOfDay(d) {\n    const x = new Date(d);\n    return new Date(x.getFullYear(), x.getMonth(), x.getDate());\n  }\n\n  /** Same wall-clock time `n` days later (DST safe). */\n  function addDays(d, n) {\n    const x = new Date(d);\n    return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n,\n      x.getHours(), x.getMinutes(), x.getSeconds(), x.getMilliseconds());\n  }\n\n  function addMonths(d, n) {\n    const x = new Date(d);\n    const target = new Date(x.getFullYear(), x.getMonth() + n, 1);\n    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();\n    return new Date(target.getFullYear(), target.getMonth(), Math.min(x.getDate(), last),\n      x.getHours(), x.getMinutes());\n  }\n\n  function daysBetween(a, b) {\n    return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);\n  }\n\n  /** Minutes since midnight of `day` on the clock face; later days continue past 1440. */\n  function minuteOfDay(date, day) {\n    const d = new Date(date);\n    return daysBetween(day, d) * 1440 + d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;\n  }\n\n  /** The date at `minute` (may exceed 1440 or be negative) on `day`'s clock. */\n  function dateOnDay(day, minute) {\n    const m = Math.round(minute);\n    const shift = Math.floor(m / 1440);\n    const within = m - shift * 1440;\n    const d = startOfDay(day);\n    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + shift, Math.floor(within / 60), within % 60);\n  }\n\n  function sameDay(a, b) {\n    const x = new Date(a), y = new Date(b);\n    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();\n  }\n\n  function sameMonth(a, b) {\n    const x = new Date(a), y = new Date(b);\n    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();\n  }\n\n  /** 1 = Monday … 7 = Sunday. */\n  function isoWeekday(d) {\n    const w = new Date(d).getDay();\n    return w === 0 ? 7 : w;\n  }\n\n  /** @param weekStart 1 = Monday, 0 = Sunday */\n  function startOfWeek(date, weekStart) {\n    const d = startOfDay(date);\n    const back = (d.getDay() - (weekStart || 0) + 7) % 7;\n    return addDays(d, -back);\n  }\n\n  function weekDays(date, weekStart) {\n    const s = startOfWeek(date, weekStart);\n    return Array.from({ length: 7 }, (_, i) => addDays(s, i));\n  }\n\n  /** 42 days (6 weeks) covering the month of `date`. */\n  function monthGrid(date, weekStart) {\n    const d = new Date(date);\n    const s = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1), weekStart);\n    return Array.from({ length: 42 }, (_, i) => addDays(s, i));\n  }\n\n  function snap(value, step) {\n    const s = Math.max(step || 1, 1);\n    return Math.round(value / s) * s;\n  }\n\n  // ---------------------------------------------------------------- text\n\n  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];\n  const pad = (n) => String(n).padStart(2, '0');\n\n  const fmt = {\n    hm: (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; },\n    md: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日`; },\n    mdw: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日 周${WEEKDAY[x.getDay()]}`; },\n    ym: (d) => { const x = new Date(d); return `${x.getFullYear()}年${x.getMonth() + 1}月`; },\n    weekdayLetter: (d) => WEEKDAY[new Date(d).getDay()],\n    clock: (minute) => { const m = ((Math.round(minute) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; },\n    /** \"09:00–10:30\", \"20:00–次日08:00\", \"09:00–10月20日 18:00\" */\n    range(start, end) {\n      const s = new Date(start), e = new Date(end);\n      const endRef = (e.getTime() === startOfDay(e).getTime() && e > s) ? new Date(e - 1) : e;\n      if (sameDay(s, endRef)) return `${fmt.hm(s)}–${fmt.hm(e)}`;\n      if (sameDay(addDays(s, 1), endRef)) return `${fmt.hm(s)}–次日${fmt.hm(e)}`;\n      return `${fmt.hm(s)}–${fmt.md(e)} ${fmt.hm(e)}`;\n    },\n    relativeDay(d, now) {\n      const t = startOfDay(now || new Date());\n      const diff = daysBetween(t, d);\n      if (diff === 0) return '今天';\n      if (diff === 1) return '明天';\n      if (diff === -1) return '昨天';\n      return fmt.mdw(d);\n    },\n    /** \"45分钟\", \"2小时\", \"1小时30分\" */\n    duration(minutes) {\n      const m = Math.max(0, Math.round(minutes));\n      const h = Math.floor(m / 60), r = m % 60;\n      if (h === 0) return `${r}分钟`;\n      if (r === 0) return `${h}小时`;\n      return `${h}小时${r}分`;\n    },\n  };\n\n  // ---------------------------------------------------------------- layout\n\n  /**\n   * Side-by-side layout for overlapping blocks in one column.\n   * @param items [{id, start, end}] in minutes\n   * @returns {[id]: {column, columnCount, span}}\n   */\n  function layoutTimeline(items, minimumLength) {\n    const minLen = minimumLength == null ? 20 : minimumLength;\n    const visualEnd = (it) => Math.max(it.end, it.start + minLen);\n    const sorted = items.slice().sort((a, b) =>\n      a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));\n    const result = {};\n    let cluster = [];\n    let columnEnds = [];\n    let clusterEnd = -Infinity;\n\n    const flush = () => {\n      const count = columnEnds.length;\n      for (const { item, column } of cluster) {\n        let span = 1;\n        for (let next = column + 1; next < count; next++) {\n          const blocked = cluster.some((o) => o.column === next &&\n            o.item.start < visualEnd(item) && visualEnd(o.item) > item.start);\n          if (blocked) break;\n          span++;\n        }\n        result[item.id] = { column, columnCount: count, span };\n      }\n      cluster = [];\n      columnEnds = [];\n    };\n\n    for (const item of sorted) {\n      if (item.start >= clusterEnd && cluster.length) flush();\n      let column = columnEnds.findIndex((e) => e <= item.start);\n      if (column === -1) {\n        column = columnEnds.length;\n        columnEnds.push(visualEnd(item));\n      } else {\n        columnEnds[column] = visualEnd(item);\n      }\n      cluster.push({ item, column });\n      clusterEnd = Math.max(clusterEnd, visualEnd(item));\n    }\n    flush();\n    return result;\n  }\n\n  /** Union length of [start, end] intervals (minutes), clipped to [lower, upper]. */\n  function busyMinutes(intervals, lower, upper) {\n    const lo = lower == null ? 0 : lower, hi = upper == null ? 1440 : upper;\n    const clipped = intervals\n      .map((i) => [Math.max(i.start, lo), Math.min(i.end, hi)])\n      .filter((i) => i[1] > i[0])\n      .sort((a, b) => a[0] - b[0]);\n    let total = 0, cur = null;\n    for (const i of clipped) {\n      if (cur && i[0] <= cur[1]) cur[1] = Math.max(cur[1], i[1]);\n      else { if (cur) total += cur[1] - cur[0]; cur = i.slice(); }\n    }\n    if (cur) total += cur[1] - cur[0];\n    return total;\n  }\n\n  /** 0 (empty) … 4 (full or over capacity). */\n  function loadLevel(busy, capacity) {\n    if (busy <= 0) return 0;\n    const r = busy / Math.max(capacity, 1);\n    if (r < 0.25) return 1;\n    if (r < 0.5) return 2;\n    if (r < 0.85) return 3;\n    return 4;\n  }\n\n  /** Gaps of at least `minimumGap` minutes between busy intervals. */\n  function freeGaps(intervals, minimumGap) {\n    const min = minimumGap == null ? 15 : minimumGap;\n    const sorted = intervals.slice().sort((a, b) => a.start - b.start);\n    const gaps = [];\n    let cursor = null;\n    for (const i of sorted) {\n      if (cursor != null && i.start - cursor >= min) gaps.push({ start: cursor, end: i.start });\n      cursor = cursor == null ? i.end : Math.max(cursor, i.end);\n    }\n    return gaps;\n  }\n\n  // ---------------------------------------------------------------- shifts\n\n  const DEFAULT_SHIFTS = [\n    { id: '5A1F0C2E-0001-4C1A-9E0B-000000000001', name: '白班', shortName: '白', color: '#F59E0B', startMinute: 480, durationMinutes: 540, isAllDay: false },\n    { id: '5A1F0C2E-0002-4C1A-9E0B-000000000002', name: '夜班', shortName: '夜', color: '#6366F1', startMinute: 1200, durationMinutes: 720, isAllDay: false },\n    { id: '5A1F0C2E-0003-4C1A-9E0B-000000000003', name: '值班', shortName: '值', color: '#EF4444', startMinute: 480, durationMinutes: 1440, isAllDay: false },\n    { id: '5A1F0C2E-0004-4C1A-9E0B-000000000004', name: '休息', shortName: '休', color: '#10B981', startMinute: 0, durationMinutes: 1440, isAllDay: true },\n  ];\n\n  const shifts = {\n    defaults: () => DEFAULT_SHIFTS.map((t) => Object.assign({}, t)),\n\n    interval(t, day) {\n      if (t.isAllDay) {\n        const s = startOfDay(day);\n        return { start: s, end: addDays(s, 1) };\n      }\n      return { start: dateOnDay(day, t.startMinute), end: dateOnDay(day, t.startMinute + t.durationMinutes) };\n    },\n\n    /** \"08:00–17:00\", \"20:00–次日08:00\", \"全天\" */\n    timeText(t) {\n      if (t.isAllDay) return '全天';\n      const end = t.startMinute + t.durationMinutes;\n      return `${fmt.clock(t.startMinute)}–${end >= 1440 ? '次日' : ''}${fmt.clock(end)}`;\n    },\n\n    /** Template whose name equals the event title, if any. */\n    match(templates, title) {\n      const t = (title || '').trim();\n      return templates.find((x) => x.name === t) || null;\n    },\n\n    /** Hours of rest before each timed shift (sorted by start); null when unknown. */\n    restBefore(list) {\n      let prevEnd = null;\n      return list.slice().sort((a, b) => a.start - b.start).map((s) => {\n        if (s.isAllDay) return null;\n        const rest = prevEnd == null ? null : (new Date(s.start) - prevEnd) / 3600e3;\n        prevEnd = prevEnd == null ? new Date(s.end) : new Date(Math.max(prevEnd, new Date(s.end)));\n        return rest;\n      });\n    },\n\n    /** Counts per template id and total timed minutes for shifts starting in [from, to). */\n    summary(list, from, to) {\n      const counts = {};\n      let minutes = 0;\n      for (const s of list) {\n        const st = new Date(s.start);\n        if (st < from || st >= to) continue;\n        if (s.templateId) counts[s.templateId] = (counts[s.templateId] || 0) + 1;\n        if (!s.isAllDay) minutes += (new Date(s.end) - st) / 60e3;\n      }\n      return { counts, minutes: Math.round(minutes) };\n    },\n  };\n\n  // ---------------------------------------------------------------- parser\n\n  const CN_NUM = '[零〇一二两兩三四五六七八九十]{1,3}';\n  const ANY_NUM = '\\\\d{1,2}|' + CN_NUM;\n\n  /** \"12\" → 12, \"十二\" → 12, \"二十三\" → 23, \"两\" → 2. */\n  function chineseNumber(text) {\n    if (text == null || text === '') return null;\n    if (/^\\d+$/.test(text)) return parseInt(text, 10);\n    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };\n    let total = 0, current = 0, sawTen = false;\n    for (const ch of text) {\n      if (ch in digits) current = digits[ch];\n      else if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; sawTen = true; }\n      else return null;\n    }\n    const value = total + current;\n    return (value > 0 || sawTen || /[零〇]/.test(text)) ? value : null;\n  }\n\n  const reCache = new Map();\n  function allMatches(pattern, text) {\n    let re = reCache.get(pattern);\n    if (!re) { re = new RegExp(pattern, 'gi'); reCache.set(pattern, re); }\n    re.lastIndex = 0;\n    return Array.from(text.matchAll(re)).filter((m) => m[0].length > 0);\n  }\n  const firstMatch = (pattern, text) => allMatches(pattern, text)[0] || null;\n  const cut = (text, m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);\n\n  // Groups per time: 1 period, 2 hour, 3 colon, 4 colon minutes, 5 点,\n  // 6 Chinese minute word, 7 Chinese minute number, 8 am/pm.\n  const G = 8;\n  const TIME =\n    '(?:(上午|早上|早晨|清晨|中午|下午|午后|傍晚|晚上|夜里|夜间|深夜|凌晨)\\\\s*)?' +\n    '(\\\\d{1,2}|' + CN_NUM + ')' +\n    '(?:\\\\s*([:：])\\\\s*(\\\\d{2})|\\\\s*([点點])(?:\\\\s*(半|一刻|三刻|(\\\\d{1,2}|' + CN_NUM + ')\\\\s*分?))?)?' +\n    '(?:\\\\s*(am|pm|a\\\\.m\\\\.|p\\\\.m\\\\.)(?![a-z]))?';\n\n  function clockTime(m, off) {\n    const hourText = m[off + 2];\n    const hour = chineseNumber(hourText);\n    if (hour == null) return null;\n    const colonMinute = m[off + 4], cnWord = m[off + 6], cnNumber = m[off + 7];\n    const ampm = m[off + 8] ? m[off + 8].toLowerCase().replace(/\\./g, '') : null;\n    let minute = 0;\n    if (colonMinute != null) minute = parseInt(colonMinute, 10);\n    else if (cnNumber != null) minute = chineseNumber(cnNumber) || 0;\n    else if (cnWord === '半') minute = 30;\n    else if (cnWord === '一刻') minute = 15;\n    else if (cnWord === '三刻') minute = 45;\n    if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;\n    // \"一点\" alone usually means \"a little\" (早一点到), not 1 o'clock\n    if (hourText === '一' && m[off + 1] == null && cnWord == null && cnNumber == null && ampm == null) return null;\n    return {\n      hour, minute, period: m[off + 1] || null, ampm,\n      isColon: colonMinute != null,\n      hasMarker: colonMinute != null || m[off + 5] != null || ampm != null,\n      is24Hour: hour >= 13 || (hourText.length === 2 && hourText[0] === '0'),\n    };\n  }\n\n  /** Minutes after midnight; `guessAfternoon` reads a bare 1–6 o'clock as p.m. */\n  function resolveTime(t, hint, guessAfternoon) {\n    let h = t.hour;\n    if (t.ampm) {\n      if (t.ampm === 'pm' && h < 12) h += 12;\n      if (t.ampm === 'am' && h === 12) h = 0;\n    } else if (t.period) {\n      if (['下午', '午后', '傍晚', '晚上', '夜里', '夜间', '深夜'].includes(t.period)) {\n        if (h < 12) h += 12; else if (h === 12) h = 24;\n      } else if (t.period === '中午') {\n        if (h < 6) h += 12;\n      } else if (t.period === '凌晨') {\n        if (h === 12) h = 0;\n      }\n    } else if (hint === 'evening' && h < 12) {\n      h += 12;\n    } else if (guessAfternoon && hint == null && h >= 1 && h <= 6 && !t.is24Hour) {\n      h += 12;\n    }\n    return h * 60 + t.minute;\n  }\n\n  function weekdayIndex(s) {\n    return { 一: 1, 1: 1, 二: 2, 2: 2, 三: 3, 3: 3, 四: 4, 4: 4, 五: 5, 5: 5, 六: 6, 6: 6, 日: 7, 天: 7, 7: 7 }[s] || null;\n  }\n\n  function englishWeekday(s) {\n    return { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[(s || '').toLowerCase().slice(0, 3)] || null;\n  }\n\n  function weekdayDate(target, prefix, today) {\n    const cur = isoWeekday(today);\n    let delta;\n    switch (prefix || '') {\n      case '本': case '这': case '这个': delta = target - cur; break;\n      case '下': case '下个': delta = 7 - cur + target; break;\n      case '下下': case '下下个': delta = 14 - cur + target; break;\n      case '上': case '上个': delta = target - cur - 7; break;\n      default: delta = (target - cur + 7) % 7;\n    }\n    return addDays(today, delta);\n  }\n\n  /** The month/day this year, or next year (or next month with rollMonth) if it passed. */\n  function nearestFuture(month, day, year, today, rollMonth) {\n    const d = new Date(year, month - 1, day);\n    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;\n    if (d >= today) return d;\n    return rollMonth ? addMonths(d, 1) : new Date(year + 1, month - 1, day);\n  }\n\n  function parseDate(state, today) {\n    const year = today.getFullYear();\n    let m;\n\n    if ((m = firstMatch('(\\\\d{4})\\\\s*[-/.年]\\\\s*(\\\\d{1,2})\\\\s*[-/.月]\\\\s*(\\\\d{1,2})\\\\s*[日号號]?', state.text))) {\n      const d = new Date(+m[1], +m[2] - 1, +m[3]);\n      state.text = cut(state.text, m);\n      return { day: d, part: null };\n    }\n    if ((m = firstMatch('(' + ANY_NUM + ')\\\\s*月\\\\s*(' + ANY_NUM + ')\\\\s*[日号號]', state.text))) {\n      const mo = chineseNumber(m[1]), d = chineseNumber(m[2]);\n      const date = mo && d ? nearestFuture(mo, d, year, today) : null;\n      if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }\n    }\n    if ((m = firstMatch('(?<![\\\\d:/])(\\\\d{1,2})/(\\\\d{1,2})(?![\\\\d/])', state.text))) {\n      const mo = +m[1], d = +m[2];\n      const date = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? nearestFuture(mo, d, year, today) : null;\n      if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }\n    }\n\n    const words = [\n      ['大后天', 3, null], ['后天', 2, null],\n      ['明早', 1, 'morning'], ['明晨', 1, 'morning'], ['明晚', 1, 'evening'],\n      ['明天', 1, null], ['明日', 1, null],\n      ['今早', 0, 'morning'], ['今晨', 0, 'morning'], ['今晚', 0, 'evening'],\n      ['今天', 0, null], ['今日', 0, null],\n      ['昨天', -1, null],\n      ['tomorrow', 1, null], ['tmr', 1, null], ['tonight', 0, 'evening'], ['today', 0, null],\n    ];\n    const alt = words.map((w) => w[0]).join('|');\n    if ((m = firstMatch('(?<![a-z])(' + alt + ')(?![a-z])', state.text))) {\n      const w = words.find((x) => x[0] === m[1].toLowerCase());\n      if (w) { state.text = cut(state.text, m); return { day: addDays(today, w[1]), part: w[2] }; }\n    }\n    if ((m = firstMatch('(' + ANY_NUM + ')\\\\s*天[以之]?后', state.text))) {\n      const n = chineseNumber(m[1]);\n      if (n != null) { state.text = cut(state.text, m); return { day: addDays(today, n), part: null }; }\n    }\n    if ((m = firstMatch('(下下个?|下个?|这个?|本|上个?)?\\\\s*(?:周|星期|礼拜|週)\\\\s*([一二三四五六日天1-7])', state.text))) {\n      const target = weekdayIndex(m[2]);\n      if (target) { state.text = cut(state.text, m); return { day: weekdayDate(target, m[1], today), part: null }; }\n    }\n    if ((m = firstMatch('(?<![a-z])(next\\\\s+|this\\\\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?(?![a-z])', state.text))) {\n      const target = englishWeekday(m[2]);\n      if (target) {\n        state.text = cut(state.text, m);\n        const p = (m[1] || '').trim().toLowerCase();\n        return { day: weekdayDate(target, p === 'next' ? '下' : p === 'this' ? '本' : null, today), part: null };\n      }\n    }\n    // 16号 / 16日 (not \"12号床\", \"一日三餐\")\n    for (const pattern of [\n      '(?<![\\\\d月/])(' + ANY_NUM + ')\\\\s*[号號](?![床房楼樓病诊診室线線窗口])',\n      '(?<![\\\\d月/])(\\\\d{1,2})\\\\s*日(?![程历曆])',\n    ]) {\n      m = firstMatch(pattern, state.text);\n      if (!m) continue;\n      const d = chineseNumber(m[1]);\n      if (d >= 1 && d <= 31) {\n        const date = nearestFuture(today.getMonth() + 1, d, year, today, true);\n        if (date) { state.text = cut(state.text, m); return { day: date, part: null }; }\n      }\n    }\n    return null;\n  }\n\n  function parseDuration(state) {\n    let m;\n    if ((m = firstMatch('(' + ANY_NUM + ')\\\\s*个半\\\\s*(?:小时|钟头|鐘頭)', state.text))) {\n      const h = chineseNumber(m[1]);\n      if (h != null) { state.text = cut(state.text, m); return h * 60 + 30; }\n    }\n    if ((m = firstMatch('半\\\\s*个?\\\\s*(?:小时|钟头|鐘頭)', state.text))) {\n      state.text = cut(state.text, m);\n      return 30;\n    }\n    const hourPattern = '(\\\\d+(?:\\\\.\\\\d+)?|' + CN_NUM + ')\\\\s*个?\\\\s*(?:小时|钟头|鐘頭|hours?|hrs?|h)(?![a-z])' +\n      '(?:\\\\s*(\\\\d+|' + CN_NUM + ')\\\\s*(?:分钟|分鐘|分|minutes?|mins?|m)(?![a-z]))?';\n    if ((m = firstMatch(hourPattern, state.text))) {\n      const hours = /^\\d/.test(m[1]) ? parseFloat(m[1]) : chineseNumber(m[1]);\n      if (hours != null && !isNaN(hours)) {\n        state.text = cut(state.text, m);\n        const extra = m[2] ? (chineseNumber(m[2]) || 0) : 0;\n        return Math.round(hours * 60) + extra;\n      }\n    }\n    // A bare \"分\" is left alone: \"3点15分\" is a time\n    if ((m = firstMatch('(\\\\d+|' + CN_NUM + ')\\\\s*(?:分钟|分鐘|minutes?|mins?|m)(?![a-z])', state.text))) {\n      const minutes = chineseNumber(m[1]);\n      if (minutes > 0) { state.text = cut(state.text, m); return minutes; }\n    }\n    return null;\n  }\n\n  function parseTimeRange(state, hint) {\n    const pattern = TIME + '\\\\s*(?:-|–|—|~|～|〜|到|至|to)\\\\s*' + TIME;\n    for (const m of allMatches(pattern, state.text)) {\n      const a = clockTime(m, 0), b = clockTime(m, G);\n      if (!a || !b || !(a.hasMarker || b.hasMarker)) continue;\n      // \"3-5pm\": the first time borrows the second's am/pm\n      if (!a.ampm && !a.period && b.ampm) a.ampm = b.ampm;\n      let start = resolveTime(a, hint, true);\n      let end;\n      if (b.ampm || b.period || b.is24Hour) {\n        const explicit = resolveTime(b, hint, false);\n        // \"6:00-14:00\" is a morning start, not 18:00\n        const plain = resolveTime(a, hint, false);\n        if (plain < explicit && start >= explicit) start = plain;\n        end = explicit > start ? explicit : explicit + 1440;\n      } else if (hint === 'evening') {\n        const e = resolveTime(b, hint, false);\n        end = e > start ? e : e + 1440;\n      } else {\n        // Earliest reading after the start: \"3点-5点\" → 17:00, \"22:00-6:00\" → next day 06:00\n        const raw = b.hour * 60 + b.minute;\n        const candidates = [raw];\n        if (b.hour < 12) candidates.push(raw + 720);\n        candidates.push(raw + 1440);\n        end = candidates.find((c) => c > start);\n        if (end == null) end = raw + 1440;\n      }\n      state.text = cut(state.text, m);\n      return [start, end];\n    }\n    return null;\n  }\n\n  function parseSingleTime(state, hint) {\n    for (const m of allMatches(TIME, state.text)) {\n      const t = clockTime(m, 0);\n      if (!t || !t.hasMarker) continue;\n      state.text = cut(state.text, m);\n      return resolveTime(t, hint, true);\n    }\n    return null;\n  }\n\n  function cleanTitle(text) {\n    return text.split(/\\s+/).filter(Boolean).join(' ')\n      .replace(/^[\\s,，、;；:：\\-–—~～.。]+|[\\s,，、;；:：\\-–—~～.。]+$/g, '');\n  }\n\n  /**\n   * Parses one quick-add line.\n   * @param opts {now, defaultDay, override: 'automatic'|'event'|'reminder', defaultEventMinutes, shiftNames}\n   */\n  function parseQuickAdd(input, opts) {\n    const o = opts || {};\n    const now = o.now ? new Date(o.now) : new Date();\n    const today = startOfDay(now);\n    const state = { text: ' ' + String(input).replace(/\\u3000/g, ' ') + ' ' };\n    let m;\n\n    let forcedReminder = false;\n    if ((m = firstMatch('^\\\\s*(待办|提醒我?|任务|todo|task)\\\\s*[:：]?\\\\s*', state.text))) {\n      forcedReminder = true;\n      state.text = cut(state.text, m);\n    }\n    let calendarHint = null;\n    if ((m = firstMatch('[#＃]([^\\\\s#＃]+)', state.text))) {\n      calendarHint = m[1];\n      state.text = cut(state.text, m);\n    }\n    let priority = 0;\n    if ((m = firstMatch('(?:^|\\\\s)([!！]{1,3})(?=\\\\s|$)', state.text))) {\n      priority = m[1].length === 3 ? 1 : m[1].length === 2 ? 5 : 9;\n      state.text = cut(state.text, m);\n    }\n    let allDay = false;\n    if ((m = firstMatch('全天|整天|all[\\\\s-]?day', state.text))) {\n      allDay = true;\n      state.text = cut(state.text, m);\n    }\n    const date = parseDate(state, today);\n    const duration = parseDuration(state);\n    let startMinute = null, endMinute = null;\n    const range = parseTimeRange(state, date && date.part);\n    if (range) { startMinute = range[0]; endMinute = range[1]; }\n    else startMinute = parseSingleTime(state, date && date.part);\n\n    const title = cleanTitle(state.text);\n    const day = date ? startOfDay(date.day) : startOfDay(o.defaultDay || now);\n    const hasTime = startMinute != null;\n\n    let kind, shiftName = null;\n    const override = o.override || 'automatic';\n    if (override === 'reminder') kind = 'reminder';\n    else if (override === 'event') kind = hasTime ? 'event' : 'allDayEvent';\n    else if (forcedReminder) kind = 'reminder';\n    else if (allDay) kind = 'allDayEvent';\n    else if (!hasTime && (shiftName = (o.shiftNames || []).find((n) => n.toLowerCase() === title.toLowerCase()) || null)) kind = 'shift';\n    else kind = hasTime ? 'event' : 'reminder';\n\n    let start = null, end = null;\n    if (hasTime) {\n      start = dateOnDay(day, startMinute);\n      if (kind === 'event') {\n        end = dateOnDay(day, endMinute != null ? endMinute : startMinute + (duration || o.defaultEventMinutes || 60));\n      }\n    }\n    if (kind === 'allDayEvent') { start = day; end = addDays(day, 1); }\n\n    return {\n      kind, title, day, start, end,\n      hasExplicitDate: !!date,\n      hasTime: hasTime && kind !== 'allDayEvent',\n      durationMinutes: endMinute != null && startMinute != null ? endMinute - startMinute : duration,\n      priority, calendarHint, shiftName,\n    };\n  }\n\n  const GlanceCore = {\n    startOfDay, addDays, addMonths, daysBetween, minuteOfDay, dateOnDay, sameDay, sameMonth,\n    isoWeekday, startOfWeek, weekDays, monthGrid, snap, fmt,\n    layoutTimeline, busyMinutes, loadLevel, freeGaps,\n    shifts, chineseNumber, parseQuickAdd,\n  };\n  root.GlanceCore = GlanceCore;\n  if (typeof module !== 'undefined' && module && module.exports && typeof window === 'undefined' && typeof Script === 'undefined') {\n    module.exports = GlanceCore;\n  }\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n\n</script>\n<script>\n// 一览 web UI. Runs inside Scriptable's WebView (data via the Scriptable\n// bridge) or in a desktop browser with the mock bridge (preview / tests).\n(function () {\n  'use strict';\n  const C = window.GlanceCore;\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));\n  const esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) =>\n    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);\n  const pad = (n) => String(n).padStart(2, '0');\n  const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;\n  const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;\n  const fromInputs = (dv, tv) => {\n    const [y, m, d] = (dv || '').split('-').map(Number);\n    const [h, mi] = (tv || '00:00').split(':').map(Number);\n    return new Date(y, (m || 1) - 1, d || 1, h || 0, mi || 0);\n  };\n\n  const DEFAULT_SETTINGS = {\n    hidden: [], weekStart: 1, capacityHours: 8, defaultEventMinutes: 60, defaultTaskMinutes: 30,\n    restHours: 11, showCompleted: true, hourHeight: 56, dayStyle: 'timeline',\n    shiftCalendarId: null, defaultEventCalendarId: null, defaultReminderListId: null,\n    shiftTemplates: C.shifts.defaults(), taskDurations: {}, notifyTasks: true,\n  };\n\n  const S = {\n    ready: false, error: null,\n    calendars: [], lists: [], events: [], reminders: [], defaults: {},\n    settings: Object.assign({}, DEFAULT_SETTINGS),\n    mode: 'day', day: C.startOfDay(new Date()), range: null,\n    trayCollapsed: false, showInbox: false, listInbox: false,\n    brushOn: false, brush: null, menu: false,\n    sheet: null, toast: null, override: 'automatic',\n    viewKey: '', blocks: {}, loading: false,\n  };\n  const ws = () => S.settings.weekStart;\n\n  // ------------------------------------------------------------- bridge\n\n  const Bridge = (() => {\n    let seq = 0;\n    const pending = new Map();\n    let queue = [];\n    let waiter = null;\n    let timer = null;\n    const flush = () => {\n      if (waiter && queue.length) {\n        const w = waiter;\n        waiter = null;\n        clearTimeout(timer);\n        w(queue.splice(0));\n      }\n    };\n    // Scriptable calls `__nextMessages(completion)` with evaluateJavaScript(…, true)\n    // and gets the queued messages back through `completion` (long poll).\n    window.__nextMessages = function (completion) {\n      const done = completion || window.completion;\n      if (queue.length) { done(queue.splice(0)); return; }\n      waiter = done;\n      timer = setTimeout(() => { if (waiter === done) { waiter = null; done([]); } }, 2000);\n    };\n    window.__reply = (id, ok, result) => {\n      const p = pending.get(id);\n      if (!p) return;\n      pending.delete(id);\n      if (ok) p.resolve(result); else p.reject(new Error(result));\n    };\n    return {\n      call(type, payload) {\n        if (window.__MOCK__) return window.__MOCK__.handle(type, JSON.parse(JSON.stringify(payload || {})));\n        return new Promise((resolve, reject) => {\n          const id = ++seq;\n          pending.set(id, { resolve, reject });\n          queue.push({ id, type, payload: payload || {} });\n          flush();\n        });\n      },\n    };\n  })();\n\n  // ------------------------------------------------------------- data\n\n  function rangeAround(day) {\n    const grid = C.monthGrid(day, ws());\n    return { start: C.addDays(grid[0], -7).getTime(), end: C.addDays(grid[41], 8).getTime() };\n  }\n\n  async function load(force) {\n    const need = rangeAround(S.day);\n    if (!force && S.range && need.start >= S.range.start && need.end <= S.range.end) return;\n    S.range = need;\n    await refresh();\n  }\n\n  async function refresh() {\n    if (!S.range) S.range = rangeAround(S.day);\n    S.loading = true;\n    try {\n      apply(await Bridge.call('load', S.range));\n    } catch (err) {\n      toast('读取失败：' + err.message);\n    } finally {\n      S.loading = false;\n    }\n  }\n\n  let lastDataJSON = '';\n  function apply(res) {\n    if (!res) return;\n    if (res.data) res = res.data;\n    if (res.error) {\n      S.error = res.error;\n      S.ready = true;\n      render();\n      return;\n    }\n    const json = JSON.stringify(res);\n    if (json === lastDataJSON && S.ready && !S.error) return;\n    lastDataJSON = json;\n    S.error = null;\n    S.calendars = res.calendars || [];\n    S.lists = res.lists || [];\n    S.defaults = res.defaults || {};\n    S.version = res.version || '';\n    S.settings = Object.assign({}, DEFAULT_SETTINGS, res.settings || {});\n    if (!S.settings.shiftTemplates || !S.settings.shiftTemplates.length) S.settings.shiftTemplates = C.shifts.defaults();\n    enrich(res.events || [], res.reminders || []);\n    S.ready = true;\n    if (!Gest.active) render();\n  }\n\n  function enrich(events, reminders) {\n    const cal = Object.fromEntries(S.calendars.map((c) => [c.id, c]));\n    const list = Object.fromEntries(S.lists.map((l) => [l.id, l]));\n    const count = {};\n    for (const e of events) count[e.id] = (count[e.id] || 0) + 1;\n    const tpls = S.settings.shiftTemplates;\n    S.events = events.map((e) => {\n      const c = cal[e.calendarId] || {};\n      return Object.assign({}, e, {\n        start: new Date(e.start), end: new Date(e.end),\n        color: c.color || '#8e8e93', calTitle: c.title || '',\n        canEdit: c.editable !== false,\n        recurring: !!e.recurring || count[e.id] > 1,\n        shift: C.shifts.match(tpls, e.title),\n      });\n    }).sort((a, b) => a.start - b.start || a.end - b.end);\n    S.reminders = reminders.map((r) => {\n      const l = list[r.listId] || {};\n      const due = r.due != null ? new Date(r.due) : null;\n      const duration = S.settings.taskDurations[r.id] || S.settings.defaultTaskMinutes;\n      return Object.assign({}, r, {\n        due, completionDate: r.completionDate != null ? new Date(r.completionDate) : null,\n        color: l.color || '#f08c00', listTitle: l.title || '', duration,\n        end: due ? new Date(due.getTime() + duration * 60e3) : null,\n      });\n    });\n    agendaCache.clear();\n  }\n\n  const agendaCache = new Map();\n  function agenda(day) {\n    const start = C.startOfDay(day);\n    const key = start.getTime();\n    if (agendaCache.has(key)) return agendaCache.get(key);\n    const end = C.addDays(start, 1);\n    const isToday = C.sameDay(start, new Date());\n    const a = { day: start, shifts: [], allDay: [], timed: [], overdue: [], untimed: [], timedTasks: [], completed: [] };\n    for (const e of S.events) {\n      if (!(e.start < end && (e.end > start || (+e.end === +e.start && e.start >= start)))) continue;\n      if (e.shift) {\n        if (C.sameDay(e.start, start)) a.shifts.push(e);\n        if (!e.shift.isAllDay && !e.allDay) a.timed.push(e);\n      } else if (e.allDay) a.allDay.push(e);\n      else a.timed.push(e);\n    }\n    for (const r of S.reminders) {\n      if (r.completed) {\n        const d = r.completionDate || r.due;\n        if (d && C.sameDay(d, start)) a.completed.push(r);\n      } else if (r.due) {\n        if (C.sameDay(r.due, start)) (r.hasTime ? a.timedTasks : a.untimed).push(r);\n        else if (isToday && r.due < start) a.overdue.push(r);\n      }\n    }\n    const pr = (p) => (p === 0 ? 10 : p);\n    a.untimed.sort((x, y) => pr(x.priority) - pr(y.priority) || x.title.localeCompare(y.title));\n    a.timedTasks.sort((x, y) => x.due - y.due);\n    a.pending = a.overdue.length + a.untimed.length + a.timedTasks.length;\n    agendaCache.set(key, a);\n    return a;\n  }\n\n  const inbox = () => S.reminders.filter((r) => !r.completed && !r.due);\n\n  function loadLevel(day) {\n    const a = agenda(day);\n    const iv = a.timed.map((e) => ({ start: C.minuteOfDay(e.start, day), end: C.minuteOfDay(e.end, day) }));\n    for (const t of a.timedTasks) {\n      const s = C.minuteOfDay(t.due, day);\n      iv.push({ start: s, end: s + t.duration });\n    }\n    return C.loadLevel(C.busyMinutes(iv) + a.untimed.length * 15, S.settings.capacityHours * 60);\n  }\n\n  function shortRest(ev) {\n    if (!ev.shift || ev.shift.isAllDay || ev.allDay) return null;\n    let prev = null;\n    for (const e of S.events) {\n      if (e === ev || !e.shift || e.shift.isAllDay || e.allDay || e.start >= ev.start) continue;\n      if (!prev || e.end > prev.end) prev = e;\n    }\n    if (!prev) return null;\n    const h = (ev.start - prev.end) / 3600e3;\n    return h < S.settings.restHours ? Math.max(h, 0) : null;\n  }\n\n  const findEvent = (uid) => S.events.find((e) => e.uid === uid);\n  const findTask = (id) => S.reminders.find((r) => r.id === id);\n  const editableCalendars = () => S.calendars.filter((c) => c.editable);\n  const editableLists = () => S.lists.filter((l) => l.editable !== false);\n  const defaultCalendarId = () => S.settings.defaultEventCalendarId || S.defaults.eventCalendarId || (editableCalendars()[0] || {}).id;\n  const defaultListId = () => S.settings.defaultReminderListId || S.defaults.reminderListId || (editableLists()[0] || {}).id;\n  const shiftCalendarId = () => S.settings.shiftCalendarId || defaultCalendarId();\n  const byHint = (hint, items) => {\n    if (!hint) return null;\n    const h = hint.toLowerCase();\n    return items.find((c) => c.title.toLowerCase() === h) || items.find((c) => c.title.toLowerCase().startsWith(h)) ||\n      items.find((c) => c.title.toLowerCase().includes(h)) || null;\n  };\n\n  // ------------------------------------------------------------- mutations\n\n  async function mutate(type, payload, okMessage, undo) {\n    try {\n      const res = await Bridge.call(type, payload);\n      if (res && res.recurring) {\n        toast('这是重复日程：为免改到整个系列，请用系统编辑器修改', {\n          label: '打开', fn: () => mutate('editNative', { uid: payload.uid }),\n        });\n        await refresh();\n        return null;\n      }\n      if (res && res.error) {\n        toast('操作失败：' + res.error);\n        await refresh();\n        return null;\n      }\n      if (res && res.data) apply(res.data);\n      else if (!(res && res.message)) await refresh();\n      if (res && res.message) toast(res.message);\n      if (okMessage) toast(okMessage, undo ? { label: '撤销', fn: () => undo(res) } : null);\n      return res;\n    } catch (err) {\n      toast('操作失败：' + err.message);\n      await refresh();\n      return null;\n    }\n  }\n\n  function optimistic(fn) {\n    fn();\n    lastDataJSON = '';\n    agendaCache.clear();\n    render();\n  }\n\n  function moveEvent(ev, newStart, newEnd) {\n    optimistic(() => { ev.start = newStart; ev.end = newEnd; });\n    return mutate('updateEvent', { uid: ev.uid, start: +newStart, end: +newEnd, allDay: ev.allDay });\n  }\n\n  function scheduleTask(task, due, hasTime) {\n    optimistic(() => {\n      task.due = due;\n      task.hasTime = !!(due && hasTime);\n      task.end = due ? new Date(due.getTime() + task.duration * 60e3) : null;\n    });\n    return mutate('updateReminder', { id: task.id, due: due ? +due : null, hasTime: !!(due && hasTime) });\n  }\n\n  function toggleTask(task) {\n    optimistic(() => {\n      task.completed = !task.completed;\n      task.completionDate = task.completed ? new Date() : null;\n    });\n    return mutate('updateReminder', { id: task.id, completed: task.completed });\n  }\n\n  function setTaskDuration(task, minutes) {\n    optimistic(() => {\n      task.duration = Math.max(15, minutes);\n      task.end = task.due ? new Date(task.due.getTime() + task.duration * 60e3) : null;\n    });\n    return mutate('updateReminder', { id: task.id, duration: task.duration });\n  }\n\n  function postpone(task, days) {\n    const today = C.startOfDay(new Date());\n    const base = task.due && task.due > today ? task.due : (task.hasTime && task.due ? new Date(today.getTime() + C.minuteOfDay(task.due, task.due) * 60e3) : today);\n    return scheduleTask(task, C.addDays(base, days), task.hasTime);\n  }\n\n  /** Brush: the same shift again removes it, another one replaces it. */\n  function applyShift(template, day) {\n    const existing = agenda(day).shifts;\n    const same = existing.some((e) => e.shift && e.shift.id === template.id);\n    const ops = existing.map((e) => ({ type: 'deleteEvent', uid: e.uid }));\n    if (!same) {\n      const iv = C.shifts.interval(template, day);\n      ops.push({\n        type: 'createEvent', title: template.name, allDay: !!template.isAllDay,\n        start: +iv.start, end: +(template.isAllDay ? iv.start : iv.end), calendarId: shiftCalendarId(),\n      });\n    }\n    return mutate('batch', { ops });\n  }\n\n  function clearShifts(day) {\n    const ops = agenda(day).shifts.map((e) => ({ type: 'deleteEvent', uid: e.uid }));\n    if (ops.length) return mutate('batch', { ops });\n  }\n\n  function saveSettings(patch) {\n    Object.assign(S.settings, patch);\n    return mutate('saveSettings', { settings: S.settings });\n  }\n\n  // ------------------------------------------------------------- toast\n\n  let toastTimer = null;\n  function toast(message, action) {\n    S.toast = { message, action, id: Date.now() };\n    renderToast();\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => { S.toast = null; renderToast(); }, action ? 5000 : 3000);\n  }\n\n  function renderToast() {\n    let el = $('#toast');\n    if (!S.toast) { if (el) el.remove(); return; }\n    if (!el) {\n      el = document.createElement('div');\n      el.id = 'toast';\n      el.className = 'toast';\n      $('#main').appendChild(el);\n    }\n    el.innerHTML = `<span>${esc(S.toast.message)}</span>` +\n      (S.toast.action ? `<button data-act=\"toast-action\">${esc(S.toast.action.label)}</button>` : '');\n  }\n\n  // ------------------------------------------------------------- render\n\n  function render() {\n    renderHeader();\n    renderMain();\n    renderPreview();\n    renderToast();\n  }\n\n  function renderHeader() {\n    const hdr = $('#hdr');\n    if (!S.ready || S.error) { hdr.innerHTML = ''; return; }\n    const day = S.day;\n    let title;\n    if (S.mode === 'day') title = C.fmt.mdw(day);\n    else if (S.mode === 'week') {\n      const d = C.weekDays(day, ws());\n      title = `${C.fmt.md(d[0])}–${C.sameMonth(d[0], d[6]) ? d[6].getDate() + '日' : C.fmt.md(d[6])}`;\n    } else title = C.fmt.ym(day);\n\n    const a = agenda(day);\n    const parts = [];\n    if (S.mode !== 'day') parts.push(C.fmt.relativeDay(day));\n    else if (C.sameDay(day, new Date())) parts.push('今天');\n    for (const s of a.shifts) parts.push(s.shift.name);\n    const evCount = a.timed.filter((e) => !e.shift).length + a.allDay.length;\n    if (evCount) parts.push(`${evCount}个日程`);\n    if (a.pending) parts.push(`${a.pending}个待办`);\n    if (a.overdue.length) parts.push(`逾期${a.overdue.length}`);\n    if (!parts.length || (parts.length === 1 && parts[0] === '今天')) parts.push('没有安排');\n\n    const isToday = C.sameDay(day, new Date()) && S.mode === 'day';\n    hdr.innerHTML = `\n      <div class=\"hdr\">\n        <div class=\"hdr-row\">\n          <div class=\"hdr-title\"><h1>${esc(title)}</h1><p>${esc(parts.join(' · '))}</p></div>\n          <button class=\"icon-btn\" data-act=\"prev\" aria-label=\"上一页\">‹</button>\n          <button class=\"text-btn\" data-act=\"today\" ${isToday ? 'disabled' : ''}>今天</button>\n          <button class=\"icon-btn\" data-act=\"next\" aria-label=\"下一页\">›</button>\n          <button class=\"icon-btn\" data-act=\"settings\" aria-label=\"设置\">⚙︎</button>\n        </div>\n        <div class=\"seg-row\">\n          <div class=\"seg\">${['day', 'week', 'month'].map((m) =>\n            `<button data-act=\"mode\" data-v=\"${m}\" class=\"${S.mode === m ? 'on' : ''}\">${{ day: '日', week: '周', month: '月' }[m]}</button>`).join('')}</div>\n          ${S.mode === 'day' ? `<button class=\"style-btn\" data-act=\"style\" aria-label=\"${S.settings.dayStyle === 'timeline' ? '切换到清单' : '切换到时间轴'}\">${S.settings.dayStyle === 'timeline' ? '清单' : '时间轴'}</button>` : ''}\n        </div>\n        ${S.mode === 'day' ? stripHTML() : ''}\n      </div>`;\n  }\n\n  function stripHTML() {\n    return `<div class=\"strip\" data-swipe=\"week\">${C.weekDays(S.day, ws()).map((d) => {\n      const a = agenda(d);\n      const shift = a.shifts[0] && a.shifts[0].shift;\n      const mark = shift ? badge(shift) : `<span class=\"loadbar\" style=\"background:${heat(loadLevel(d))}\"></span>`;\n      return `<div class=\"strip-day ${C.sameDay(d, S.day) ? 'sel' : ''} ${C.sameDay(d, new Date()) ? 'today' : ''}\"\n        data-act=\"pick\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n        <span class=\"wd\">${C.fmt.weekdayLetter(d)}</span><span class=\"num\">${d.getDate()}</span>\n        <span class=\"mark\">${mark}</span></div>`;\n    }).join('')}</div>`;\n  }\n\n  const heat = (level) => level ? `rgba(var(--heat), ${[0, 0.16, 0.32, 0.52, 0.78][level]})` : 'var(--surface2)';\n  const badge = (t, size) => `<span class=\"badge\" style=\"background:${esc(t.color)};${size ? `font-size:${size}px;` : ''}\">${esc(t.shortName || t.name.slice(0, 1))}</span>`;\n\n  function viewKey() {\n    if (S.mode === 'day') return `day:${+S.day}:${S.settings.dayStyle}`;\n    if (S.mode === 'week') return `week:${+C.startOfWeek(S.day, ws())}`;\n    return `month:${S.day.getFullYear()}-${S.day.getMonth()}`;\n  }\n\n  function renderMain() {\n    const main = $('#main');\n    if (!S.ready) {\n      main.innerHTML = `<div class=\"center-msg\"><p>正在读取日历…</p></div>`;\n      return;\n    }\n    if (S.error) {\n      main.innerHTML = errorHTML();\n      return;\n    }\n    const key = viewKey();\n    const keep = key === S.viewKey;\n    const scrollers = {};\n    if (keep) for (const el of $$('[data-keep-scroll]', main)) scrollers[el.dataset.keepScroll] = el.scrollTop;\n    S.blocks = {};\n    let html;\n    if (S.mode === 'day') html = S.settings.dayStyle === 'timeline' ? trayHTML() + gridHTML([S.day], false) : listHTML();\n    else if (S.mode === 'week') html = weekHTML();\n    else html = monthHTML();\n    main.innerHTML = html;\n    if (keep) {\n      for (const el of $$('[data-keep-scroll]', main)) {\n        if (scrollers[el.dataset.keepScroll] != null) el.scrollTop = scrollers[el.dataset.keepScroll];\n      }\n    } else {\n      scrollGridToFocus();\n    }\n    S.viewKey = key;\n  }\n\n  function errorHTML() {\n    if (S.error === 'permission') {\n      return `<div class=\"center-msg\"><h2>需要日历权限</h2>\n        <p>「一览」通过 Scriptable 读写系统的日历与提醒事项。请到「设置 → Scriptable」打开「日历」与「提醒事项」（选择完全访问）。</p>\n        <button class=\"primary\" data-act=\"open-settings-app\">打开设置</button>\n        <button class=\"text-btn\" data-act=\"reload\">我已开启，重新读取</button></div>`;\n    }\n    return `<div class=\"center-msg\"><h2>读取失败</h2><p>${esc(S.error)}</p><button class=\"primary\" data-act=\"reload\">重试</button></div>`;\n  }\n\n  // ----- tray\n\n  function trayHTML() {\n    const a = agenda(S.day);\n    const ib = inbox();\n    const showDone = S.settings.showCompleted;\n    const has = a.shifts.length || a.allDay.length || a.pending || (showDone && a.completed.length);\n    const sum = [];\n    if (a.allDay.length) sum.push(`全天 ${a.allDay.length}`);\n    if (a.untimed.length + a.timedTasks.length) sum.push(`待办 ${a.untimed.length + a.timedTasks.length}`);\n    if (a.overdue.length) sum.push(`逾期 ${a.overdue.length}`);\n    if (a.completed.length) sum.push(`已完成 ${a.completed.length}`);\n    return `<div class=\"tray\">\n      <div class=\"tray-head\"><span class=\"grow\">${sum.length ? sum.join(' · ') : '没有全天事项或待办'}</span>\n        ${ib.length ? `<button class=\"pill-btn\" data-act=\"inbox\">未排期 ${ib.length} ${S.showInbox ? '▴' : '▾'}</button>` : ''}\n        ${has ? `<button class=\"pill-btn\" data-act=\"collapse\">${S.trayCollapsed ? '展开' : '收起'}</button>` : ''}\n      </div>\n      ${has && !S.trayCollapsed ? `<div class=\"tray-body\" data-keep-scroll=\"tray\">\n        ${a.shifts.map(shiftBannerHTML).join('')}\n        <div class=\"chips\">\n          ${a.allDay.map(eventChipHTML).join('')}\n          ${a.overdue.map((t) => taskChipHTML(t, { overdue: true })).join('')}\n          ${a.untimed.map((t) => taskChipHTML(t)).join('')}\n          ${a.timedTasks.map((t) => taskChipHTML(t, { time: true })).join('')}\n          ${showDone ? a.completed.map((t) => taskChipHTML(t)).join('') : ''}\n        </div></div>` : ''}\n      ${S.showInbox && ib.length ? `<div class=\"inbox\"><div class=\"hint\">长按拖到时间轴即排进当天；也可拖到上方日期</div>\n        <div class=\"chips\" data-keep-scroll=\"inbox\">${ib.map((t) => taskChipHTML(t)).join('')}</div></div>` : ''}\n    </div>`;\n  }\n\n  function shiftBannerHTML(e) {\n    const t = e.shift;\n    const rest = shortRest(e);\n    return `<div class=\"shift-banner\" style=\"--c:${esc(t.color)}\" data-act=\"open-event\" data-uid=\"${esc(e.uid)}\">\n      ${badge(t)}<span class=\"name\">${esc(t.name)}</span>\n      <span class=\"muted mono\">${e.allDay || t.isAllDay ? '全天' : C.fmt.range(e.start, e.end)}</span>\n      ${rest != null ? `<span class=\"warn\">⚠︎ 距上一班 ${rest.toFixed(1)} 小时</span>` : ''}</div>`;\n  }\n\n  function eventChipHTML(e) {\n    return `<div class=\"chip\" style=\"--c:${esc(e.color)}\" data-act=\"open-event\" data-uid=\"${esc(e.uid)}\">\n      <span class=\"dot\"></span><span class=\"t\">${esc(e.title || '（无标题）')}</span></div>`;\n  }\n\n  const prioMark = (p) => (p >= 1 && p <= 4 ? '!!!' : p === 5 ? '!!' : p >= 6 && p <= 9 ? '!' : '');\n\n  function taskChipHTML(t, opt) {\n    const o = opt || {};\n    const pm = prioMark(t.priority);\n    return `<div class=\"chip ${t.completed ? 'done' : ''} ${o.overdue ? 'overdue' : ''}\" style=\"--c:${esc(t.color)}\"\n        data-act=\"open-task\" data-task=\"${esc(t.id)}\" data-drag=\"chip\">\n      <span class=\"check ${t.completed ? 'on' : ''}\" data-act=\"toggle\" data-task=\"${esc(t.id)}\">${t.completed ? '✓' : ''}</span>\n      ${pm ? `<span class=\"prio\">${pm}</span>` : ''}<span class=\"t\">${esc(t.title || '（无标题）')}</span>\n      ${o.time && t.due ? `<span class=\"sub mono\">${C.fmt.hm(t.due)}</span>` : ''}\n      ${o.overdue && t.due ? `<span class=\"sub red\">${C.fmt.md(t.due)}</span>` : ''}</div>`;\n  }\n\n  // ----- time grid\n\n  function hourHeight(compact) {\n    return compact ? 44 : clamp(S.settings.hourHeight || 56, 28, 160);\n  }\n\n  function makeBlocks(days) {\n    const out = [];\n    days.forEach((day, i) => {\n      const a = agenda(day);\n      for (const e of a.timed) {\n        const s = Math.max(0, C.minuteOfDay(e.start, day));\n        const en = Math.min(1440, C.minuteOfDay(e.end, day));\n        if (!(en > s || +e.end === +e.start)) continue;\n        out.push({ id: `${i}|e|${e.uid}`, dayIndex: i, src: 'e', ref: e, start: s, end: Math.max(en, s),\n          title: e.title || '（无标题）', color: e.shift ? e.shift.color : e.color, canEdit: e.canEdit, task: false,\n          detail: e.location || '' });\n      }\n      for (const t of a.timedTasks) {\n        const s = C.minuteOfDay(t.due, day);\n        out.push({ id: `${i}|t|${t.id}`, dayIndex: i, src: 't', ref: t, start: s, end: Math.min(1440, s + t.duration),\n          title: t.title || '（无标题）', color: t.color, canEdit: true, task: true, detail: t.listTitle });\n      }\n    });\n    return out;\n  }\n\n  function gridHTML(days, compact) {\n    const hh = hourHeight(compact);\n    const n = days.length;\n    const gutter = compact ? 30 : 46;\n    const minH = compact ? 16 : 22;\n    const blocks = makeBlocks(days);\n    let blocksHTML = '';\n    days.forEach((day, i) => {\n      const col = blocks.filter((b) => b.dayIndex === i);\n      const slots = C.layoutTimeline(col.map((b) => ({ id: b.id, start: b.start, end: b.end })), minH / hh * 60);\n      for (const b of col) {\n        b.slot = slots[b.id] || { column: 0, columnCount: 1, span: 1 };\n        S.blocks[b.id] = b;\n        blocksHTML += blockHTML(b, n, compact, minH, hh);\n      }\n    });\n    let hours = '';\n    for (let h = 0; h < 24; h++) {\n      hours += `<div class=\"hour\" style=\"top:calc(var(--hh) * ${h} * 1px)\">${h ? `<span>${compact ? h : pad(h) + ':00'}</span>` : ''}</div>`;\n      if (!compact && hh >= 80) hours += `<div class=\"hour half\" style=\"top:calc(var(--hh) * ${h + 0.5} * 1px)\"></div>`;\n    }\n    let cols = '';\n    if (n > 1) days.forEach((d, i) => {\n      cols += `<div class=\"colbg ${C.sameDay(d, new Date()) ? 'today' : ''}\" style=\"left:calc(var(--gutter) + (100% - var(--gutter)) * ${i / n});width:calc((100% - var(--gutter)) / ${n})\"></div>`;\n    });\n    const ti = days.findIndex((d) => C.sameDay(d, new Date()));\n    const now = ti >= 0 ? `<div class=\"now\" data-now=\"${ti}\" style=\"top:calc(var(--hh) * ${C.minuteOfDay(new Date(), days[ti]) / 60} * 1px);left:calc(var(--gutter) + (100% - var(--gutter)) * ${ti / n});width:calc((100% - var(--gutter)) / ${n})\"></div>` : '';\n    return `<div class=\"grid-scroll\" data-grid data-keep-scroll=\"grid\" data-days=\"${days.map((d) => +d).join(',')}\" data-compact=\"${compact ? 1 : 0}\">\n      <div class=\"grid\" style=\"--hh:${hh};--gutter:${gutter}px\">\n        ${hours}${cols}<div class=\"surface\" data-drag=\"create\" data-act=\"surface\"></div>${blocksHTML}${now}\n      </div></div>`;\n  }\n\n  function blockHTML(b, n, compact, minH, hh) {\n    const x = (b.dayIndex + b.slot.column / b.slot.columnCount) / n;\n    const w = b.slot.span / b.slot.columnCount / n;\n    const len = b.end - b.start;\n    const px = Math.max(len / 60 * hh - 1, minH);\n    const lines = compact ? Math.max(1, Math.floor(px / 12)) : (px > 44 ? 2 : 1);\n    const time = `${C.fmt.clock(b.start)}–${C.fmt.clock(b.end)}`;\n    const editable = b.canEdit && !(b.src === 'e' && b.ref.recurring);\n    const check = b.task && !compact ? `<span class=\"check\" style=\"--c:${esc(b.color)}\" data-act=\"toggle\" data-task=\"${esc(b.ref.id)}\"></span>` : '';\n    return `<div class=\"blk ${b.task ? 'task' : ''} ${b.canEdit ? '' : 'ro'} ${compact ? 'compact' : ''} ${px < 34 ? 'short' : ''}\"\n        data-blk=\"${esc(b.id)}\" data-act=\"open-block\" ${editable ? 'data-drag=\"move\"' : 'data-drag=\"locked\"'}\n        style=\"--c:${esc(b.color)};--s:${b.start};--len:${len};--minh:${minH}px;--lines:${lines};left:calc(var(--gutter) + (100% - var(--gutter)) * ${x});width:calc((100% - var(--gutter)) * ${w} - 2px)\">\n      <div class=\"bt\">${check}<span class=\"tt\">${esc(b.title)}</span></div>\n      ${!compact && px >= 34 ? `<div class=\"bs\">${[time, b.detail].filter(Boolean).map(esc).join(' · ')}</div>` : ''}\n      ${editable && !compact ? '<div class=\"handle\" data-drag=\"resize\"></div>' : ''}\n    </div>`;\n  }\n\n  function scrollGridToFocus() {\n    const el = $('.grid-scroll');\n    if (!el) return;\n    const days = el.dataset.days.split(',').map((x) => new Date(+x));\n    const hh = +getComputedStyle(el.firstElementChild).getPropertyValue('--hh') || 56;\n    let hour;\n    if (days.some((d) => C.sameDay(d, new Date()))) hour = new Date().getHours() - 1;\n    else {\n      const starts = Object.values(S.blocks).map((b) => b.start);\n      hour = starts.length ? Math.floor(Math.min(...starts) / 60) - 1 : 8;\n    }\n    el.scrollTop = Math.max(0, clamp(hour, 0, 23) * hh - 8);\n  }\n\n  // ----- list\n\n  function listHTML() {\n    const a = agenda(S.day);\n    let h = '<div class=\"list\" data-keep-scroll=\"list\">';\n    if (a.shifts.length || a.allDay.length) {\n      h += '<div class=\"sec\">班次与全天</div><div style=\"padding:0 12px;display:flex;flex-direction:column;gap:6px\">' +\n        a.shifts.map(shiftBannerHTML).join('') + '</div>' + a.allDay.map((e) => eventRowHTML(e, false)).join('');\n    }\n    if (a.overdue.length) h += '<div class=\"sec\">逾期</div>' + a.overdue.map((t) => taskRowHTML(t, { overdue: true })).join('');\n    if (a.untimed.length) h += '<div class=\"sec\">待办</div>' + a.untimed.map((t) => taskRowHTML(t)).join('');\n    h += '<div class=\"sec\">时间表</div>';\n    const entries = a.timed.map((e) => ({ start: e.start, end: e.end, html: eventRowHTML(e, true) }))\n      .concat(a.timedTasks.map((t) => ({ start: t.due, end: t.end, html: taskRowHTML(t) })))\n      .sort((x, y) => x.start - y.start);\n    if (!entries.length) h += '<div class=\"empty\">没有定时的日程</div>';\n    const now = new Date();\n    let nowPlaced = !C.sameDay(now, S.day);\n    let cursor = null;\n    for (const en of entries) {\n      if (!nowPlaced && now < en.start) { h += `<div class=\"now-row\">现在 ${C.fmt.hm(now)}</div>`; nowPlaced = true; }\n      if (cursor) {\n        const gap = Math.round((en.start - cursor) / 60e3);\n        if (gap >= 30) h += `<div class=\"gap-row\">☕︎ 空闲 ${C.fmt.duration(gap)}</div>`;\n      }\n      h += en.html;\n      cursor = cursor && cursor > en.end ? cursor : en.end;\n    }\n    if (!nowPlaced && entries.length) h += `<div class=\"now-row\">现在 ${C.fmt.hm(now)}</div>`;\n    if (S.settings.showCompleted && a.completed.length) h += '<div class=\"sec\">已完成</div>' + a.completed.map((t) => taskRowHTML(t)).join('');\n    const ib = inbox();\n    if (ib.length) {\n      h += `<div class=\"sec\" data-act=\"list-inbox\">未排期 ${ib.length} ${S.listInbox ? '▴' : '▾'}</div>`;\n      if (S.listInbox) h += ib.map((t) => taskRowHTML(t, { inbox: true })).join('');\n    }\n    return h + '</div>';\n  }\n\n  function eventRowHTML(e, showTime) {\n    const detail = [e.location, e.calTitle].filter(Boolean).join(' · ');\n    return `<div class=\"row\" style=\"--c:${esc(e.shift ? e.shift.color : e.color)}\" data-act=\"open-event\" data-uid=\"${esc(e.uid)}\">\n      ${showTime ? `<div class=\"time\">${C.fmt.hm(e.start)}<small>${C.fmt.hm(e.end)}</small></div>` : ''}\n      <div class=\"bar\"></div>\n      <div class=\"body\"><div class=\"t\">${e.shift ? badge(e.shift) + ' ' : ''}${esc(e.title || '（无标题）')}</div>\n      ${detail ? `<div class=\"d\">${esc(detail)}</div>` : ''}</div>\n      ${e.recurring ? '<span class=\"muted\">↻</span>' : ''}</div>`;\n  }\n\n  function taskRowHTML(t, opt) {\n    const o = opt || {};\n    const d = [];\n    if (t.due && t.hasTime) d.push(`${C.fmt.hm(t.due)} · ${C.fmt.duration(t.duration)}`);\n    if (o.overdue && t.due) d.push(`原定 ${C.fmt.md(t.due)}`);\n    d.push(t.listTitle);\n    const pm = prioMark(t.priority);\n    return `<div class=\"row ${t.completed ? 'done' : ''}\" style=\"--c:${esc(t.color)}\" data-act=\"open-task\" data-task=\"${esc(t.id)}\" data-drag=\"chip\">\n      <span class=\"check ${t.completed ? 'on' : ''}\" data-act=\"toggle\" data-task=\"${esc(t.id)}\">${t.completed ? '✓' : ''}</span>\n      <div class=\"body\"><div class=\"t\">${pm ? `<span class=\"prio\">${pm}</span> ` : ''}${esc(t.title || '（无标题）')}</div>\n      <div class=\"d\" style=\"${o.overdue ? 'color:var(--red)' : ''}\">${esc(d.filter(Boolean).join(' · '))}</div></div>\n      <div class=\"acts\">${o.inbox ? `<button data-act=\"task-today\" data-task=\"${esc(t.id)}\">今天</button>` : ''}\n        <button data-act=\"task-menu\" data-task=\"${esc(t.id)}\" aria-label=\"更多\">⋯</button></div></div>`;\n  }\n\n  // ----- week\n\n  function weekHTML() {\n    const days = C.weekDays(S.day, ws());\n    const head = days.map((d) => `<div class=\"strip-day ${C.sameDay(d, new Date()) ? 'today' : ''}\" data-act=\"goto-day\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n      <span class=\"wd\">${C.fmt.weekdayLetter(d)}</span><span class=\"num\">${d.getDate()}</span></div>`).join('');\n    const allday = days.map((d) => {\n      const a = agenda(d);\n      const s = a.shifts[0] && a.shifts[0].shift;\n      const pending = a.untimed.length + a.overdue.length;\n      return `<div class=\"cell-ad\" data-act=\"goto-day\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n        ${s ? badge(s, 9) : ''}\n        ${a.allDay.slice(0, 2).map((e) => `<span class=\"mini\" style=\"--c:${esc(e.color)}\">${esc(e.title)}</span>`).join('')}\n        ${a.allDay.length > 2 ? `<span class=\"cnt\">+${a.allDay.length - 2}</span>` : ''}\n        ${pending ? `<span class=\"cnt ${a.overdue.length ? 'red' : ''}\">☑︎${pending}</span>` : ''}</div>`;\n    }).join('');\n    return `<div class=\"wk-head\" data-swipe=\"week\">${head}</div>\n      <div class=\"wk-allday\"><div class=\"lab\">全天</div>${allday}</div>${gridHTML(days, true)}`;\n  }\n\n  // ----- month\n\n  function monthHTML() {\n    const grid = C.monthGrid(S.day, ws());\n    const first = new Date(S.day.getFullYear(), S.day.getMonth(), 1);\n    const next = C.addMonths(first, 1);\n    const cells = grid.map((d) => {\n      const a = agenda(d);\n      const level = loadLevel(d);\n      const sh = a.shifts[0];\n      const ev = a.timed.filter((e) => !e.shift).length + a.allDay.length;\n      const tasks = a.pending;\n      const warn = sh && shortRest(sh) != null;\n      return `<div class=\"cell ${C.sameMonth(d, S.day) ? '' : 'out'} ${C.sameDay(d, new Date()) ? 'today' : ''} ${C.sameDay(d, S.day) ? 'sel' : ''} ${level >= 4 ? 'hot' : ''}\"\n          style=\"--a:${[0, 0.16, 0.32, 0.52, 0.78][level]}\" data-act=\"cell\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n        <span class=\"n\">${d.getDate()}</span><span class=\"mk\">${sh ? badge(sh.shift) : ''}</span>\n        <span class=\"cnt\">${ev ? ev : ''}${tasks ? ` <span class=\"${a.overdue.length ? 'red' : ''}\">☑︎${tasks}</span>` : ''}</span>\n        ${warn ? '<span class=\"warn\">⚠︎</span>' : ''}</div>`;\n    }).join('');\n    const occ = S.events.filter((e) => e.shift).map((e) => ({ templateId: e.shift.id, start: e.start, end: e.end, isAllDay: e.allDay || e.shift.isAllDay }));\n    const sum = C.shifts.summary(occ, first, next);\n    const counts = S.settings.shiftTemplates.filter((t) => sum.counts[t.id]).map((t) => `${t.name} ${sum.counts[t.id]}`);\n    const sumText = counts.length ? `${counts.join(' · ')} · 工时 ${Math.round(sum.minutes / 60)}h` : '本月未排班';\n    const brushBar = S.brushOn ? `<div class=\"brushbar\"><div class=\"hint\">选好班次后点日期即可排班；再点一次同一班次可取消</div>\n      <div class=\"opts\">${S.settings.shiftTemplates.map((t) => `<button class=\"brush-opt ${S.brush === t.id ? 'on' : ''}\" style=\"--c:${esc(t.color)}\" data-act=\"brush\" data-v=\"${esc(t.id)}\">${badge(t)}${esc(t.name)}</button>`).join('')}\n      <button class=\"brush-opt ${S.brush === 'eraser' ? 'on' : ''}\" style=\"--c:#8e8e93\" data-act=\"brush\" data-v=\"eraser\">⌫ 清除</button></div></div>` : '';\n    return `<div class=\"month\">\n      <div class=\"mo-wd\">${grid.slice(0, 7).map((d) => `<span>${C.fmt.weekdayLetter(d)}</span>`).join('')}</div>\n      <div class=\"mo-grid\" data-swipe=\"month\">${cells}</div>\n      <div class=\"mo-sum\"><span class=\"legend\">空${[0, 1, 2, 3, 4].map((l) => `<i style=\"background:${heat(l)}\"></i>`).join('')}满</span>\n        <span class=\"grow\">${esc(sumText)}</span>\n        <button class=\"brush-btn ${S.brushOn ? 'on' : ''}\" data-act=\"brush-toggle\">🖌 排班</button></div>\n      ${brushBar}\n      ${digestHTML()}\n    </div>`;\n  }\n\n  function digestHTML() {\n    const a = agenda(S.day);\n    const empty = !a.shifts.length && !a.allDay.length && !a.timed.length && !a.pending && !a.completed.length;\n    return `<div class=\"digest\" data-keep-scroll=\"digest\">\n      <div class=\"head\"><span>${esc(C.fmt.relativeDay(S.day))}</span><button class=\"pill-btn\" data-act=\"mode\" data-v=\"day\">日视图 ›</button></div>\n      ${empty ? '<div class=\"empty\">这天没有安排</div>' : ''}\n      ${a.shifts.map(shiftBannerHTML).join('')}\n      ${a.timed.filter((e) => !e.shift).map((e) => eventRowHTML(e, true)).join('')}\n      ${a.timedTasks.map((t) => taskRowHTML(t)).join('')}\n      <div class=\"chips\">${a.allDay.map(eventChipHTML).join('')}${a.overdue.map((t) => taskChipHTML(t, { overdue: true })).join('')}\n        ${a.untimed.map((t) => taskChipHTML(t)).join('')}${S.settings.showCompleted ? a.completed.map((t) => taskChipHTML(t)).join('') : ''}</div>\n    </div>`;\n  }\n\n  // ------------------------------------------------------------- quick add\n\n  function renderQuickAdd() {\n    $('#qa').innerHTML = `<div class=\"qa\">\n      <div class=\"preview\" id=\"qa-preview\"></div>\n      <div class=\"qa-row\" style=\"position:relative\">\n        <button class=\"plus\" data-act=\"plus\" aria-label=\"新建\">＋</button>\n        <input id=\"qa-input\" type=\"text\" enterkeyhint=\"done\" autocomplete=\"off\" placeholder=\"快速新增：明天下午3点 开会 1小时\">\n        <button class=\"send\" data-act=\"qa-submit\" aria-label=\"新增\" disabled>↑</button>\n        <div id=\"qa-menu\"></div>\n      </div></div>`;\n    const input = $('#qa-input');\n    input.addEventListener('input', () => {\n      if (!input.value.trim()) S.override = 'automatic';\n      renderPreview();\n    });\n    input.addEventListener('keydown', (e) => {\n      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitQuickAdd(); }\n    });\n  }\n\n  function parseInput() {\n    const input = $('#qa-input');\n    const text = input ? input.value.trim() : '';\n    if (!text) return null;\n    return C.parseQuickAdd(text, {\n      now: new Date(), defaultDay: S.day, override: S.override,\n      defaultEventMinutes: S.settings.defaultEventMinutes,\n      shiftNames: S.settings.shiftTemplates.map((t) => t.name),\n    });\n  }\n\n  function renderPreview() {\n    const pv = $('#qa-preview');\n    if (!pv) return;\n    const r = parseInput();\n    const send = $('[data-act=\"qa-submit\"]');\n    const plus = $('[data-act=\"plus\"]');\n    if (plus) plus.style.display = r ? 'none' : '';\n    if (!r) { pv.innerHTML = ''; if (send) send.disabled = true; return; }\n    const kinds = { event: '日程', allDayEvent: '全天日程', reminder: '待办', shift: '班次' };\n    const chips = [`<button class=\"pv kind\" data-act=\"qa-kind\">${kinds[r.kind]} ⇄</button>`, `<span class=\"pv\">📅 ${esc(C.fmt.relativeDay(r.day))}</span>`];\n    if (r.kind === 'event' && r.start && r.end) chips.push(`<span class=\"pv mono\">🕘 ${C.fmt.range(r.start, r.end)}</span>`);\n    else if (r.kind === 'reminder' && r.start) chips.push(`<span class=\"pv mono\">🕘 ${C.fmt.hm(r.start)}</span>`);\n    else if (r.kind === 'shift') {\n      const t = S.settings.shiftTemplates.find((x) => x.name === r.shiftName);\n      if (t) chips.push(`<span class=\"pv mono\">🕘 ${C.shifts.timeText(t)}</span>`);\n    }\n    if (r.kind === 'reminder' && r.durationMinutes) chips.push(`<span class=\"pv\">⏳ 约${C.fmt.duration(r.durationMinutes)}</span>`);\n    const target = r.kind === 'reminder'\n      ? (byHint(r.calendarHint, editableLists()) || S.lists.find((l) => l.id === defaultListId()))\n      : r.kind === 'shift' ? S.calendars.find((c) => c.id === shiftCalendarId())\n        : (byHint(r.calendarHint, editableCalendars()) || S.calendars.find((c) => c.id === defaultCalendarId()));\n    if (target) chips.push(`<span class=\"pv\">🗂 ${esc(target.title)}</span>`);\n    if (r.priority) chips.push(`<span class=\"pv\">${{ 1: '高', 5: '中', 9: '低' }[r.priority]}优先</span>`);\n    if (!r.title && r.kind !== 'shift') chips.push('<span class=\"pv muted\">请输入标题</span>');\n    pv.innerHTML = chips.join('');\n    if (send) send.disabled = !r.title && r.kind !== 'shift';\n  }\n\n  async function submitQuickAdd() {\n    const r = parseInput();\n    if (!r || (!r.title && r.kind !== 'shift')) return;\n    $('#qa-input').value = '';\n    S.override = 'automatic';\n    renderPreview();\n    if (r.kind === 'shift') {\n      const t = S.settings.shiftTemplates.find((x) => x.name === r.shiftName);\n      if (t) { await applyShift(t, r.day); toast(`已排${t.name}：${C.fmt.relativeDay(r.day)}`); }\n      return;\n    }\n    if (r.kind === 'event' || r.kind === 'allDayEvent') {\n      const cal = byHint(r.calendarHint, editableCalendars());\n      const allDay = r.kind === 'allDayEvent';\n      await mutate('createEvent', {\n        title: r.title, allDay, start: +(r.start || r.day), end: +(allDay ? r.day : r.end),\n        calendarId: cal ? cal.id : defaultCalendarId(),\n      }, `已新增日程「${r.title}」`, (res) => res && res.uid && mutate('deleteEvent', { uid: res.uid }));\n      return;\n    }\n    const list = byHint(r.calendarHint, editableLists());\n    await mutate('createReminder', {\n      title: r.title, due: +(r.start || r.day), hasTime: r.hasTime, priority: r.priority,\n      listId: list ? list.id : defaultListId(), duration: r.durationMinutes || S.settings.defaultTaskMinutes,\n    }, `已新增待办「${r.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));\n  }\n\n  // ------------------------------------------------------------- sheets\n\n  function askConfirm(message, yesLabel, onYes) {\n    openSheet({ type: 'confirm', message, yesLabel, onYes });\n  }\n\n  function openSheet(sheet) {\n    S.sheet = sheet;\n    renderSheet();\n  }\n\n  function closeSheet() {\n    S.sheet = null;\n    renderSheet();\n  }\n\n  function renderSheet() {\n    const root = $('#sheet-root');\n    if (!S.sheet) { root.innerHTML = ''; return; }\n    const s = S.sheet;\n    let head = '', body = '';\n    if (s.type === 'event') ({ head, body } = eventEditor(s));\n    else if (s.type === 'task') ({ head, body } = taskEditor(s));\n    else if (s.type === 'settings') ({ head, body } = settingsSheet());\n    else if (s.type === 'task-menu') ({ head, body } = taskMenu(s));\n    else if (s.type === 'confirm') {\n      head = `<span style=\"width:60px\"></span><h2>确认</h2><button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button>`;\n      body = `<div class=\"note\" style=\"text-align:center;font-size:16px;padding:18px\">${esc(s.message)}</div>\n        <div class=\"form-sec\"><button class=\"danger\" data-act=\"confirm-yes\">${esc(s.yesLabel)}</button></div>`;\n    }\n    root.innerHTML = `<div class=\"backdrop\" data-act=\"sheet-bg\"><div class=\"sheet\" data-act=\"noop\">\n      <div class=\"sheet-head\">${head}</div><div class=\"sheet-body\">${body}</div></div></div>`;\n    const title = $('#sheet-root input[name=title]');\n    if (title && s.isNew) setTimeout(() => title.focus(), 50);\n  }\n\n  const sw = (name, on) => `<label class=\"switch\"><input type=\"checkbox\" name=\"${name}\" ${on ? 'checked' : ''}><span></span></label>`;\n  const opt = (v, label, sel) => `<option value=\"${esc(v)}\" ${sel ? 'selected' : ''}>${esc(label)}</option>`;\n\n  function eventEditor(s) {\n    const d = s.draft;\n    const ev = s.uid ? findEvent(s.uid) : null;\n    const ro = ev && !ev.canEdit;\n    const recurring = ev && ev.recurring;\n    const head = `<button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button><h2>${s.isNew ? '新建日程' : '编辑日程'}</h2>\n      <button class=\"text-btn\" data-act=\"event-save\" style=\"font-weight:700\" ${ro || recurring ? 'disabled' : ''}>保存</button>`;\n    const cals = editableCalendars();\n    const body = `\n      <div class=\"form-sec\"><div class=\"f\"><input type=\"text\" name=\"title\" placeholder=\"标题\" value=\"${esc(d.title)}\"></div>\n        ${ev && ev.shift ? `<div class=\"f\">${badge(ev.shift)} 班次：${esc(ev.shift.name)}</div>` : ''}</div>\n      <div class=\"form-sec\" id=\"time-sec\" data-allday=\"${d.allDay ? 1 : 0}\">\n        <div class=\"f\"><label>全天</label>${sw('allDay', d.allDay)}</div>\n        <div class=\"f\"><label>开始</label><input type=\"date\" name=\"sd\" value=\"${dateValue(d.start)}\"><input type=\"time\" name=\"st\" value=\"${timeValue(d.start)}\" ${d.allDay ? 'hidden' : ''}></div>\n        <div class=\"f\"><label>结束</label><input type=\"date\" name=\"ed\" value=\"${dateValue(d.end)}\"><input type=\"time\" name=\"et\" value=\"${timeValue(d.end)}\" ${d.allDay ? 'hidden' : ''}></div>\n        <div class=\"f\" ${d.allDay ? 'hidden' : ''} id=\"dur-row\"><div class=\"quick\">${[15, 30, 60, 90, 120].map((m) =>\n          `<button data-act=\"dur\" data-v=\"${m}\">${m < 60 ? m + '分' : m % 60 ? (m / 60) + '小时' : m / 60 + '小时'}</button>`).join('')}</div></div>\n      </div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>日历</label><select name=\"calendarId\">${cals.map((c) => opt(c.id, c.title, c.id === d.calendarId)).join('')}\n          ${ev && !ev.canEdit ? opt(ev.calendarId, ev.calTitle, true) : ''}</select></div>\n        <div class=\"f\"><input type=\"text\" name=\"location\" placeholder=\"地点\" value=\"${esc(d.location)}\"></div>\n        <div class=\"f\"><textarea name=\"notes\" placeholder=\"备注\">${esc(d.notes)}</textarea></div>\n      </div>\n      ${recurring ? `<div class=\"form-sec\"><div class=\"note\">这是重复日程。为免改到整个系列，请用系统编辑器修改（可选择“仅此次”或“所有将来的”）。</div>\n        <div class=\"f\"><button class=\"text-btn\" data-act=\"event-native\">在系统编辑器中打开</button></div></div>` : ''}\n      ${ro ? '<div class=\"form-sec\"><div class=\"note\">这个日历是只读的（例如订阅或节假日日历），不能修改。</div></div>' : ''}\n      ${ev && !ro && !recurring ? '<div class=\"form-sec\"><button class=\"danger\" data-act=\"event-delete\">删除日程</button></div>' : ''}`;\n    return { head, body };\n  }\n\n  function taskEditor(s) {\n    const d = s.draft;\n    const head = `<button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button><h2>${s.isNew ? '新建待办' : '编辑待办'}</h2>\n      <button class=\"text-btn\" data-act=\"task-save\" style=\"font-weight:700\">保存</button>`;\n    const durations = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];\n    if (!durations.includes(d.duration)) durations.push(d.duration);\n    durations.sort((a, b) => a - b);\n    const body = `\n      <div class=\"form-sec\"><div class=\"f\"><input type=\"text\" name=\"title\" placeholder=\"标题\" value=\"${esc(d.title)}\"></div>\n        ${s.isNew ? '' : `<div class=\"f\"><label>已完成</label>${sw('completed', d.completed)}</div>`}</div>\n      <div class=\"form-sec\" id=\"due-sec\">\n        <div class=\"f\"><label>日期</label>${sw('hasDate', d.hasDate)}</div>\n        <div class=\"f\" data-need=\"date\" ${d.hasDate ? '' : 'hidden'}><input type=\"date\" name=\"dd\" value=\"${dateValue(d.due)}\" style=\"flex:1\"></div>\n        <div class=\"f\" data-need=\"date\" ${d.hasDate ? '' : 'hidden'}><div class=\"quick\">\n          <button data-act=\"qday\" data-v=\"0\">今天</button><button data-act=\"qday\" data-v=\"1\">明天</button>\n          <button data-act=\"qday\" data-v=\"2\">后天</button><button data-act=\"qday\" data-v=\"mon\">下周一</button></div></div>\n        <div class=\"f\" data-need=\"date\" ${d.hasDate ? '' : 'hidden'}><label>时间</label>${sw('hasTime', d.hasTime)}</div>\n        <div class=\"f\" data-need=\"time\" ${d.hasDate && d.hasTime ? '' : 'hidden'}><input type=\"time\" name=\"dt\" value=\"${timeValue(d.due)}\" style=\"flex:1\"></div>\n        <div class=\"f\" data-need=\"time\" ${d.hasDate && d.hasTime ? '' : 'hidden'}><label>预估时长</label>\n          <select name=\"duration\">${durations.map((m) => opt(m, C.fmt.duration(m), m === d.duration)).join('')}</select></div>\n      </div>\n      <div class=\"fsec-foot\">预估时长决定它在时间轴上占多长（保存在本机）。</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>优先级</label><div class=\"segf\" id=\"prio\">${[[0, '无'], [9, '低'], [5, '中'], [1, '高']].map(([v, l]) =>\n          `<button data-act=\"prio\" data-v=\"${v}\" class=\"${d.priority === v ? 'on' : ''}\">${l}</button>`).join('')}</div></div>\n        <div class=\"f\"><label>列表</label><select name=\"listId\">${editableLists().map((l) => opt(l.id, l.title, l.id === d.listId)).join('')}</select></div>\n        <div class=\"f\"><textarea name=\"notes\" placeholder=\"备注\">${esc(d.notes)}</textarea></div>\n      </div>\n      ${s.isNew ? '' : '<div class=\"form-sec\"><button class=\"danger\" data-act=\"task-delete\">删除待办</button></div>'}`;\n    return { head, body };\n  }\n\n  function taskMenu(s) {\n    const t = findTask(s.id);\n    const head = `<span style=\"width:60px\"></span><h2>${esc(t ? t.title : '')}</h2><button class=\"text-btn\" data-act=\"sheet-cancel\">完成</button>`;\n    const items = [['menu-toggle', t && t.completed ? '标为未完成' : '完成'], ['menu-today', '今天'], ['menu-postpone', '推迟一天'],\n      ['menu-nextweek', '下周一'], ['menu-inbox', '移到未排期'], ['menu-edit', '编辑…']];\n    const body = `<div class=\"form-sec\">${items.map(([a, l]) => `<div class=\"f\"><button class=\"text-btn\" style=\"width:100%;text-align:left\" data-act=\"${a}\">${l}</button></div>`).join('')}</div>\n      <div class=\"form-sec\"><button class=\"danger\" data-act=\"task-delete\">删除待办</button></div>`;\n    return { head, body };\n  }\n\n  function settingsSheet() {\n    const st = S.settings;\n    const head = `<span style=\"width:60px\"></span><h2>设置</h2><button class=\"text-btn\" data-act=\"settings-save\" style=\"font-weight:700\">完成</button>`;\n    const cals = editableCalendars();\n    const tpl = st.shiftTemplates.map((t, i) => `\n      <details data-tpl=\"${i}\" class=\"form-sec\" style=\"margin:8px 14px\">\n        <summary class=\"f\" style=\"list-style:none\">${badge(t)} <span style=\"flex:1\">${esc(t.name)}</span><span class=\"muted mono\">${C.shifts.timeText(t)}</span></summary>\n        <div class=\"f\"><label>名称</label><input type=\"text\" name=\"tpl-name\" value=\"${esc(t.name)}\" style=\"text-align:right\"></div>\n        <div class=\"f\"><label>简称（1–2 字）</label><input type=\"text\" name=\"tpl-short\" maxlength=\"2\" value=\"${esc(t.shortName)}\" style=\"text-align:right\"></div>\n        <div class=\"f\"><label>颜色</label><input type=\"color\" name=\"tpl-color\" value=\"${esc(t.color)}\"></div>\n        <div class=\"f\"><label>全天（休息、年假）</label>${sw('tpl-allday', t.isAllDay)}</div>\n        <div class=\"f\"><label>开始</label><input type=\"time\" name=\"tpl-start\" value=\"${C.fmt.clock(t.startMinute)}\"></div>\n        <div class=\"f\"><label>时长（小时）</label><input type=\"number\" name=\"tpl-hours\" min=\"0.5\" max=\"48\" step=\"0.5\" value=\"${t.durationMinutes / 60}\" style=\"width:80px\"></div>\n        <div class=\"f\"><button class=\"text-btn\" style=\"color:var(--red)\" data-act=\"tpl-delete\" data-v=\"${i}\">删除这个班次</button></div>\n      </details>`).join('');\n    const toggles = (items) => items.map((c) => `<div class=\"f\"><span class=\"dot-sw\" style=\"--c:${esc(c.color)}\"></span><label>${esc(c.title)}</label>\n      <label class=\"switch\"><input type=\"checkbox\" data-cal=\"${esc(c.id)}\" ${st.hidden.includes(c.id) ? '' : 'checked'}><span></span></label></div>`).join('');\n    const stepper = (name, value, unit) => `<div class=\"stepper\"><button data-act=\"step\" data-name=\"${name}\" data-v=\"-1\">−</button>\n      <span class=\"mono\" data-show=\"${name}\" style=\"min-width:64px;text-align:center\">${value}${unit}</span>\n      <button data-act=\"step\" data-name=\"${name}\" data-v=\"1\">＋</button></div>`;\n    const body = `\n      <div class=\"fsec-title\">班次模板</div>${tpl}\n      <div class=\"form-sec\"><div class=\"f\"><button class=\"text-btn\" data-act=\"tpl-add\">＋ 新增班次</button></div></div>\n      <div class=\"fsec-foot\">在月视图点「🖌 排班」，选班次后点日期即可排班；快速新增输入「周五 夜班」也可以。班次以标题辨认，所以请别重名。</div>\n      <div class=\"fsec-title\">排班</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>写入日历</label><select name=\"shiftCalendarId\">${opt('', '默认日历', !st.shiftCalendarId)}${cals.map((c) => opt(c.id, c.title, c.id === st.shiftCalendarId)).join('')}</select></div>\n        <div class=\"f\"><label>两班最短间隔</label>${stepper('restHours', st.restHours, ' 小时')}</div>\n      </div>\n      <div class=\"fsec-foot\">建议先在系统「日历」App 建一个「排班」日历，再在这里选择它。</div>\n      <div class=\"fsec-title\">负荷热力图</div>\n      <div class=\"form-sec\"><div class=\"f\"><label>每天可用</label>${stepper('capacityHours', st.capacityHours, ' 小时')}</div></div>\n      <div class=\"fsec-title\">新建时默认</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>日程写入</label><select name=\"defaultEventCalendarId\">${opt('', '系统默认', !st.defaultEventCalendarId)}${cals.map((c) => opt(c.id, c.title, c.id === st.defaultEventCalendarId)).join('')}</select></div>\n        <div class=\"f\"><label>待办写入</label><select name=\"defaultReminderListId\">${opt('', '系统默认', !st.defaultReminderListId)}${editableLists().map((l) => opt(l.id, l.title, l.id === st.defaultReminderListId)).join('')}</select></div>\n        <div class=\"f\"><label>日程时长</label>${stepper('defaultEventMinutes', st.defaultEventMinutes, ' 分')}</div>\n        <div class=\"f\"><label>待办预估</label>${stepper('defaultTaskMinutes', st.defaultTaskMinutes, ' 分')}</div>\n      </div>\n      <div class=\"fsec-title\">显示与通知</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>显示已完成的待办</label>${sw('showCompleted', st.showCompleted)}</div>\n        <div class=\"f\"><label>每周从</label><div class=\"segf\" id=\"wstart\">${[[1, '周一'], [0, '周日']].map(([v, l]) => `<button data-act=\"wstart\" data-v=\"${v}\" class=\"${st.weekStart === v ? 'on' : ''}\">${l}</button>`).join('')}</div></div>\n        <div class=\"f\"><label>定时待办到点通知</label>${sw('notifyTasks', st.notifyTasks)}</div>\n      </div>\n      <div class=\"fsec-foot\">Scriptable 无法替待办设定系统闹钟，所以由 Scriptable 在待办时间发通知（未来 7 天内）。若同一待办在「提醒事项」里另有闹钟，会收到两次。</div>\n      <div class=\"fsec-title\">显示的日历</div><div class=\"form-sec\">${toggles(S.calendars)}</div>\n      <div class=\"fsec-title\">显示的提醒事项列表</div><div class=\"form-sec\">${toggles(S.lists)}</div>\n      <div class=\"form-sec\"><div class=\"f\"><button class=\"text-btn\" data-act=\"self-update\">检查更新</button>\n        <span class=\"muted mono\" style=\"margin-left:auto;font-size:12px\">${esc(S.version)}</span></div></div>\n      <div class=\"fsec-foot\">一览 · Scriptable 版 · 数据直接读写系统日历与提醒事项。「检查更新」会从 GitHub 下载最新版覆盖这个脚本。</div>`;\n    return { head, body };\n  }\n\n  function readTemplates() {\n    return $$('#sheet-root [data-tpl]').map((el) => {\n      const old = S.settings.shiftTemplates[+el.dataset.tpl] || {};\n      const [h, m] = ($('[name=tpl-start]', el).value || '08:00').split(':').map(Number);\n      return {\n        id: old.id || ('tpl-' + Date.now() + Math.random().toString(16).slice(2, 6)),\n        name: $('[name=tpl-name]', el).value.trim() || '班次',\n        shortName: $('[name=tpl-short]', el).value.trim(),\n        color: $('[name=tpl-color]', el).value,\n        isAllDay: $('[name=tpl-allday]', el).checked,\n        startMinute: h * 60 + m,\n        durationMinutes: Math.round(clamp(parseFloat($('[name=tpl-hours]', el).value) || 8, 0.5, 48) * 60),\n      };\n    });\n  }\n\n  function newEventDraft(start, end) {\n    return { title: '', allDay: false, start, end, calendarId: defaultCalendarId(), location: '', notes: '' };\n  }\n\n  function openEvent(ev) {\n    openSheet({ type: 'event', uid: ev.uid, draft: {\n      title: ev.title, allDay: ev.allDay, start: ev.start, end: ev.allDay ? C.startOfDay(ev.end) : ev.end,\n      calendarId: ev.calendarId, location: ev.location || '', notes: ev.notes || '' } });\n  }\n\n  function openTask(t) {\n    openSheet({ type: 'task', id: t.id, draft: {\n      title: t.title, notes: t.notes || '', hasDate: !!t.due, hasTime: !!t.hasTime, due: t.due || C.startOfDay(S.day),\n      duration: t.duration, priority: t.priority || 0, listId: t.listId, completed: !!t.completed } });\n  }\n\n  function newTask(day) {\n    openSheet({ type: 'task', isNew: true, draft: {\n      title: '', notes: '', hasDate: true, hasTime: false, due: C.startOfDay(day), duration: S.settings.defaultTaskMinutes,\n      priority: 0, listId: defaultListId(), completed: false } });\n  }\n\n  function readEventForm() {\n    const root = $('#sheet-root');\n    const allDay = $('[name=allDay]', root).checked;\n    let start = fromInputs($('[name=sd]', root).value, allDay ? '00:00' : $('[name=st]', root).value);\n    let end = fromInputs($('[name=ed]', root).value, allDay ? '00:00' : $('[name=et]', root).value);\n    if (allDay) { start = C.startOfDay(start); end = C.startOfDay(end < start ? start : end); }\n    else if (end <= start) end = new Date(start.getTime() + 15 * 60e3);\n    return {\n      title: $('[name=title]', root).value.trim() || '新日程', allDay, start: +start, end: +end,\n      calendarId: $('[name=calendarId]', root).value,\n      location: $('[name=location]', root).value.trim(), notes: $('[name=notes]', root).value,\n    };\n  }\n\n  function readTaskForm() {\n    const root = $('#sheet-root');\n    const hasDate = $('[name=hasDate]', root).checked;\n    const hasTime = hasDate && $('[name=hasTime]', root).checked;\n    const due = hasDate ? fromInputs($('[name=dd]', root).value, hasTime ? $('[name=dt]', root).value : '00:00') : null;\n    const prio = $('#prio .on', root);\n    const done = $('[name=completed]', root);\n    return {\n      title: $('[name=title]', root).value.trim() || '新待办', notes: $('[name=notes]', root).value,\n      due: due ? +due : null, hasTime, priority: prio ? +prio.dataset.v : 0,\n      listId: $('[name=listId]', root).value, duration: +($('[name=duration]', root) || {}).value || S.settings.defaultTaskMinutes,\n      completed: done ? done.checked : false,\n    };\n  }\n\n  // ------------------------------------------------------------- actions\n\n  function setDay(d, mode) {\n    S.day = C.startOfDay(d);\n    if (mode) S.mode = mode;\n    render();\n    load();\n  }\n\n  function step(dir) {\n    if (S.mode === 'day') setDay(C.addDays(S.day, dir));\n    else if (S.mode === 'week') setDay(C.addDays(S.day, 7 * dir));\n    else setDay(C.addMonths(S.day, dir));\n  }\n\n  let lastSurfaceTap = null;\n  const Actions = {\n    noop() {},\n    prev: () => step(-1),\n    next: () => step(1),\n    today: () => setDay(new Date()),\n    reload: () => { lastDataJSON = ''; refresh(); },\n    'open-settings-app': () => Bridge.call('openSettingsApp'),\n    'self-update'() { closeSheet(); toast('正在检查更新…'); mutate('selfUpdate', {}); },\n    settings: () => openSheet({ type: 'settings' }),\n    mode(el) { S.mode = el.dataset.v; render(); },\n    style() { saveSettings({ dayStyle: S.settings.dayStyle === 'timeline' ? 'list' : 'timeline' }); render(); },\n    pick(el) { setDay(new Date(+el.dataset.day)); },\n    'goto-day'(el) { setDay(new Date(+el.dataset.day), 'day'); },\n    inbox() { S.showInbox = !S.showInbox; render(); },\n    'list-inbox'() { S.listInbox = !S.listInbox; render(); },\n    collapse() { S.trayCollapsed = !S.trayCollapsed; render(); },\n    toggle(el) { const t = findTask(el.dataset.task); if (t) toggleTask(t); },\n    'open-task'(el) { const t = findTask(el.dataset.task); if (t) openTask(t); },\n    'open-event'(el) { const e = findEvent(el.dataset.uid); if (e) openEvent(e); },\n    'open-block'(el) {\n      const b = S.blocks[el.dataset.blk];\n      if (!b) return;\n      if (b.src === 'e') openEvent(b.ref); else openTask(b.ref);\n    },\n    surface(el, ev) {\n      const now = Date.now();\n      const y = ev.clientY, x = ev.clientX;\n      if (lastSurfaceTap && now - lastSurfaceTap.t < 350 && Math.abs(lastSurfaceTap.y - y) < 30) {\n        lastSurfaceTap = null;\n        const g = gridGeometry(el.closest('.grid-scroll'));\n        const p = g.at(x, y);\n        const start = Math.max(0, Math.floor(p.minute / 15) * 15);\n        openSheet({ type: 'event', isNew: true, draft: newEventDraft(C.dateOnDay(g.days[p.col], start),\n          C.dateOnDay(g.days[p.col], start + S.settings.defaultEventMinutes)) });\n      } else lastSurfaceTap = { t: now, y };\n    },\n    cell(el) {\n      const day = new Date(+el.dataset.day);\n      if (S.brushOn && S.brush) {\n        if (S.brush === 'eraser') clearShifts(day);\n        else {\n          const t = S.settings.shiftTemplates.find((x) => x.id === S.brush);\n          if (t) applyShift(t, day);\n        }\n      }\n      S.day = C.startOfDay(day);\n      render();\n      load();\n    },\n    'brush-toggle'() {\n      S.brushOn = !S.brushOn;\n      if (S.brushOn && !S.brush) S.brush = (S.settings.shiftTemplates[0] || {}).id || 'eraser';\n      render();\n    },\n    brush(el) { S.brush = el.dataset.v; render(); },\n    plus(el) {\n      const menu = $('#qa-menu');\n      if (menu.innerHTML) { menu.innerHTML = ''; return; }\n      menu.innerHTML = `<div class=\"menu\"><button data-act=\"new-event\">📅 新建日程</button><button data-act=\"new-task\">☑︎ 新建待办</button></div>`;\n    },\n    'new-event'() {\n      $('#qa-menu').innerHTML = '';\n      const isToday = C.sameDay(S.day, new Date());\n      const start = C.dateOnDay(S.day, Math.min(isToday ? new Date().getHours() + 1 : 9, 23) * 60);\n      openSheet({ type: 'event', isNew: true, draft: newEventDraft(start, new Date(start.getTime() + S.settings.defaultEventMinutes * 60e3)) });\n    },\n    'new-task'() { $('#qa-menu').innerHTML = ''; newTask(S.day); },\n    'qa-submit': () => submitQuickAdd(),\n    'qa-kind'() {\n      const r = parseInput();\n      if (!r) return;\n      S.override = r.kind === 'reminder' ? 'event' : 'reminder';\n      renderPreview();\n    },\n    'toast-action'() {\n      const a = S.toast && S.toast.action;\n      S.toast = null;\n      renderToast();\n      if (a) a.fn();\n    },\n    'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },\n    'sheet-cancel': () => closeSheet(),\n    dur(el) {\n      const root = $('#sheet-root');\n      const start = fromInputs($('[name=sd]', root).value, $('[name=st]', root).value);\n      const end = new Date(start.getTime() + +el.dataset.v * 60e3);\n      $('[name=ed]', root).value = dateValue(end);\n      $('[name=et]', root).value = timeValue(end);\n    },\n    async 'event-save'() {\n      const s = S.sheet;\n      const f = readEventForm();\n      closeSheet();\n      if (s.isNew) {\n        await mutate('createEvent', f, `已新增日程「${f.title}」`, (res) => res && res.uid && mutate('deleteEvent', { uid: res.uid }));\n      } else {\n        await mutate('updateEvent', Object.assign({ uid: s.uid }, f));\n      }\n    },\n    'event-delete'() {\n      const uid = S.sheet.uid;\n      const ev = findEvent(uid);\n      if (ev) askConfirm(`删除「${ev.title}」？`, '删除日程', () => mutate('deleteEvent', { uid }, '已删除日程'));\n    },\n    'event-native'() {\n      const uid = S.sheet.uid;\n      closeSheet();\n      mutate('editNative', { uid });\n    },\n    qday(el) {\n      const root = $('#sheet-root');\n      const today = C.startOfDay(new Date());\n      const v = el.dataset.v;\n      const d = v === 'mon' ? C.addDays(C.startOfWeek(today, 1), 7) : C.addDays(today, +v);\n      $('[name=dd]', root).value = dateValue(d);\n    },\n    prio(el) { $$('#prio button').forEach((b) => b.classList.toggle('on', b === el)); },\n    async 'task-save'() {\n      const s = S.sheet;\n      const f = readTaskForm();\n      closeSheet();\n      if (s.isNew) {\n        await mutate('createReminder', f, `已新增待办「${f.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));\n      } else {\n        await mutate('updateReminder', Object.assign({ id: s.id }, f));\n      }\n    },\n    'task-delete'() {\n      const id = S.sheet.id;\n      const t = findTask(id);\n      if (t) askConfirm(`删除「${t.title}」？`, '删除待办', () => mutate('deleteReminder', { id }, '已删除待办'));\n    },\n    'confirm-yes'() {\n      const fn = S.sheet && S.sheet.onYes;\n      closeSheet();\n      if (fn) fn();\n    },\n    'task-menu'(el) { openSheet({ type: 'task-menu', id: el.dataset.task }); },\n    'task-today'(el) { const t = findTask(el.dataset.task); if (t) scheduleTask(t, C.startOfDay(new Date()), false); },\n    'menu-toggle'() { const t = findTask(S.sheet.id); closeSheet(); if (t) toggleTask(t); },\n    'menu-today'() { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, C.startOfDay(new Date()), false); },\n    'menu-postpone'() { const t = findTask(S.sheet.id); closeSheet(); if (t) postpone(t, 1); },\n    'menu-nextweek'() {\n      const t = findTask(S.sheet.id);\n      closeSheet();\n      if (t) scheduleTask(t, C.addDays(C.startOfWeek(new Date(), 1), 7), false);\n    },\n    'menu-inbox'() { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, null, false); },\n    'menu-edit'() { const t = findTask(S.sheet.id); if (t) openTask(t); },\n    step(el) {\n      const name = el.dataset.name;\n      const steps = { restHours: [1, 0, 24], capacityHours: [1, 2, 16], defaultEventMinutes: [15, 15, 240], defaultTaskMinutes: [15, 15, 240] };\n      const [inc, lo, hi] = steps[name];\n      S.settings[name] = clamp((S.settings[name] || 0) + inc * +el.dataset.v, lo, hi);\n      const unit = { restHours: ' 小时', capacityHours: ' 小时', defaultEventMinutes: ' 分', defaultTaskMinutes: ' 分' }[name];\n      $(`[data-show=\"${name}\"]`).textContent = S.settings[name] + unit;\n    },\n    wstart(el) { $$('#wstart button').forEach((b) => b.classList.toggle('on', b === el)); },\n    'tpl-add'() {\n      S.settings.shiftTemplates = readTemplates().concat([{ id: 'tpl-' + Date.now(), name: '新班次', shortName: '新', color: '#0EA5E9',\n        startMinute: 540, durationMinutes: 480, isAllDay: false }]);\n      renderSheet();\n      const last = $$('#sheet-root [data-tpl]').pop();\n      if (last) last.open = true;\n    },\n    'tpl-delete'(el) {\n      const list = readTemplates();\n      list.splice(+el.dataset.v, 1);\n      S.settings.shiftTemplates = list;\n      renderSheet();\n    },\n    async 'settings-save'() {\n      const root = $('#sheet-root');\n      const st = S.settings;\n      st.shiftTemplates = readTemplates();\n      st.shiftCalendarId = $('[name=shiftCalendarId]', root).value || null;\n      st.defaultEventCalendarId = $('[name=defaultEventCalendarId]', root).value || null;\n      st.defaultReminderListId = $('[name=defaultReminderListId]', root).value || null;\n      st.showCompleted = $('[name=showCompleted]', root).checked;\n      st.notifyTasks = $('[name=notifyTasks]', root).checked;\n      const wsBtn = $('#wstart .on', root);\n      st.weekStart = wsBtn ? +wsBtn.dataset.v : 1;\n      st.hidden = $$('[data-cal]', root).filter((c) => !c.checked).map((c) => c.dataset.cal);\n      closeSheet();\n      S.range = null;\n      lastDataJSON = '';\n      await saveSettings({});\n      await load(true);\n    },\n  };\n\n  document.addEventListener('click', (e) => {\n    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }\n    const el = e.target.closest('[data-act]');\n    if (!el) { const m = $('#qa-menu'); if (m && m.innerHTML) m.innerHTML = ''; return; }\n    const fn = Actions[el.dataset.act];\n    if (fn) fn(el, e);\n  }, true);\n\n  document.addEventListener('change', (e) => {\n    const root = $('#sheet-root');\n    if (!root.contains(e.target)) return;\n    const name = e.target.name;\n    if (name === 'allDay') {\n      const on = e.target.checked;\n      $$('[name=st],[name=et]', root).forEach((i) => { i.hidden = on; });\n      const dr = $('#dur-row', root);\n      if (dr) dr.hidden = on;\n    } else if (name === 'sd' || name === 'st') {\n      // keep the length when the start moves\n      const s = S.sheet;\n      const prev = s.lastStart || s.draft.start;\n      const start = fromInputs($('[name=sd]', root).value, $('[name=st]', root).value);\n      const end = fromInputs($('[name=ed]', root).value, $('[name=et]', root).value);\n      const moved = new Date(end.getTime() + (start - prev));\n      $('[name=ed]', root).value = dateValue(moved);\n      $('[name=et]', root).value = timeValue(moved);\n      s.lastStart = start;\n    } else if (name === 'hasDate' || name === 'hasTime') {\n      const hasDate = $('[name=hasDate]', root).checked;\n      const hasTime = hasDate && $('[name=hasTime]', root).checked;\n      $$('[data-need=date]', root).forEach((el) => { el.hidden = !hasDate; });\n      $$('[data-need=time]', root).forEach((el) => { el.hidden = !hasTime; });\n    }\n  });\n\n  // ------------------------------------------------------------- gestures\n\n  const Gest = { pending: null, active: null, pinch: null, swipe: null };\n  let suppressClickUntil = 0;\n\n  function gridGeometry(scrollEl) {\n    const grid = scrollEl.firstElementChild;\n    const rect = grid.getBoundingClientRect();\n    const days = scrollEl.dataset.days.split(',').map((x) => new Date(+x));\n    const gutter = parseFloat(getComputedStyle(grid).getPropertyValue('--gutter')) || 46;\n    const hh = parseFloat(getComputedStyle(grid).getPropertyValue('--hh')) || 56;\n    const colW = (rect.width - gutter) / days.length;\n    return {\n      scrollEl, grid, days, gutter, hh, colW, compact: scrollEl.dataset.compact === '1',\n      at(x, y) {\n        const r = grid.getBoundingClientRect();\n        return { col: clamp(Math.floor((x - r.left - gutter) / colW), 0, days.length - 1), minute: (y - r.top) / hh * 60 };\n      },\n    };\n  }\n\n  /** Scrolls the grid while the finger rests near its top or bottom edge (once it has moved). */\n  function startAutoScroll(state) {\n    state.x0 = state.x;\n    state.y0 = state.y;\n    const tick = () => {\n      if (Gest.active !== state.handler) return;\n      if (!state.armed) {\n        state.armed = Math.hypot(state.x - state.x0, state.y - state.y0) > 12;\n        requestAnimationFrame(tick);\n        return;\n      }\n      const r = state.geo.scrollEl.getBoundingClientRect();\n      let dy = 0;\n      if (state.y < r.top + 44) dy = -Math.ceil((r.top + 44 - state.y) / 6);\n      else if (state.y > r.bottom - 44) dy = Math.ceil((state.y - (r.bottom - 44)) / 6);\n      if (dy) {\n        state.geo.scrollEl.scrollTop += dy;\n        state.handler.move(state.x, state.y);\n      }\n      requestAnimationFrame(tick);\n    };\n    requestAnimationFrame(tick);\n  }\n\n  /** Long-press drag of a block (move) or of its bottom edge (resize). */\n  function dragBlock(p) {\n    const el = p.el.closest('.blk');\n    const b = S.blocks[el.dataset.blk];\n    if (!b) return null;\n    const geo = gridGeometry(el.closest('.grid-scroll'));\n    const resize = p.kind === 'resize';\n    const stepM = geo.hh >= 100 ? 5 : 15;\n    const st = { geo, x: p.x, y: p.y, scroll0: geo.scrollEl.scrollTop, delta: 0, days: 0 };\n    el.classList.add('dragging');\n    const tip = document.createElement('div');\n    tip.className = 'tip';\n    el.appendChild(tip);\n    const n = geo.days.length;\n    const x0 = (b.dayIndex + b.slot.column / b.slot.columnCount) / n;\n    const update = () => {\n      const dy = (st.y - p.y0) + (geo.scrollEl.scrollTop - st.scroll0);\n      const raw = dy / geo.hh * 60;\n      if (resize) {\n        const target = C.snap(b.end + raw, stepM);\n        st.delta = Math.max(target, b.start + 15) - b.end;\n        el.style.setProperty('--len', b.end + st.delta - b.start);\n        tip.textContent = `${C.fmt.clock(b.start)}–${C.fmt.clock(b.end + st.delta)}`;\n      } else {\n        const target = clamp(C.snap(b.start + raw, stepM), 0, 1440 - stepM);\n        st.delta = target - b.start;\n        st.days = n > 1 ? clamp(Math.round((st.x - p.x0) / geo.colW), -b.dayIndex, n - 1 - b.dayIndex) : 0;\n        el.style.setProperty('--s', b.start + st.delta);\n        el.style.left = `calc(var(--gutter) + (100% - var(--gutter)) * ${x0 + st.days / n})`;\n        tip.textContent = `${C.fmt.clock(b.start + st.delta)}–${C.fmt.clock(b.end + st.delta)}`;\n      }\n    };\n    const handler = {\n      move(x, y) { st.x = x; st.y = y; update(); },\n      end() {\n        el.classList.remove('dragging');\n        tip.remove();\n        if (resize) {\n          if (!st.delta) return;\n          if (b.src === 'e') moveEvent(b.ref, b.ref.start, new Date(b.ref.end.getTime() + st.delta * 60e3));\n          else setTaskDuration(b.ref, b.ref.duration + Math.round(st.delta));\n        } else {\n          if (!st.delta && !st.days) return;\n          const shift = (d) => {\n            const m = new Date(d.getTime() + st.delta * 60e3);\n            return st.days ? C.addDays(m, st.days) : m;\n          };\n          if (b.src === 'e') {\n            const ns = shift(b.ref.start);\n            moveEvent(b.ref, ns, new Date(ns.getTime() + (b.ref.end - b.ref.start)));\n          } else scheduleTask(b.ref, shift(b.ref.due), true);\n        }\n      },\n      cancel() { el.classList.remove('dragging'); tip.remove(); render(); },\n    };\n    st.handler = handler;\n    update();\n    startAutoScroll(st);\n    return handler;\n  }\n\n  /** Long-press on empty grid, drag to choose the length, release to edit. */\n  function dragCreate(p) {\n    const geo = gridGeometry(p.el.closest('.grid-scroll'));\n    const first = geo.at(p.x, p.y);\n    const start = Math.max(0, Math.floor(first.minute / 15) * 15);\n    const n = geo.days.length;\n    const ghost = document.createElement('div');\n    ghost.className = 'ghost';\n    ghost.style.left = `calc(var(--gutter) + (100% - var(--gutter)) * ${first.col / n})`;\n    ghost.style.width = `calc((100% - var(--gutter)) / ${n} - 2px)`;\n    ghost.style.top = `${start / 60 * geo.hh}px`;\n    geo.grid.appendChild(ghost);\n    const st = { geo, x: p.x, y: p.y, end: start + S.settings.defaultEventMinutes };\n    const update = () => {\n      const m = C.snap(geo.at(st.x, st.y).minute, 15);\n      st.end = clamp(m - start >= 15 ? m : start + S.settings.defaultEventMinutes, start + 15, 1440);\n      ghost.style.height = `${(st.end - start) / 60 * geo.hh}px`;\n      ghost.textContent = `${C.fmt.clock(start)}–${C.fmt.clock(st.end)}`;\n    };\n    const handler = {\n      moved: false,\n      move(x, y) { st.x = x; st.y = y; this.moved = true; update(); },\n      end() {\n        ghost.remove();\n        const day = geo.days[first.col];\n        openSheet({ type: 'event', isNew: true, draft: newEventDraft(C.dateOnDay(day, start), C.dateOnDay(day, st.end)) });\n      },\n      cancel() { ghost.remove(); },\n    };\n    st.handler = handler;\n    update();\n    startAutoScroll(st);\n    return handler;\n  }\n\n  /** Long-press a task chip/row and drop it on the grid (timed) or on a date (all day). */\n  function dragChip(p) {\n    const t = findTask(p.el.dataset.task);\n    if (!t) return null;\n    const ghost = document.createElement('div');\n    ghost.className = 'floating';\n    ghost.textContent = t.title;\n    document.body.appendChild(ghost);\n    p.el.style.opacity = '0.4';\n    let hot = null;\n    const st = { x: p.x, y: p.y, target: null };\n    const update = () => {\n      ghost.style.left = st.x + 'px';\n      ghost.style.top = st.y + 'px';\n      const under = document.elementFromPoint(st.x, st.y);\n      let target = null;\n      const day = under && under.closest('[data-drop-day]');\n      const grid = under && under.closest('.grid-scroll');\n      if (day) target = { el: day, day: new Date(+day.dataset.dropDay) };\n      else if (grid) {\n        const g = gridGeometry(grid);\n        const at = g.at(st.x, st.y);\n        const minute = clamp(C.snap(at.minute, 15), 0, 1425);\n        target = { el: grid, day: g.days[at.col], minute };\n        ghost.textContent = `${t.title} → ${C.fmt.clock(minute)}`;\n      }\n      if (!target || target.minute == null) ghost.textContent = t.title + (target ? ` → ${C.fmt.md(target.day)}` : '');\n      if (hot !== (target && target.el)) {\n        if (hot) hot.classList.remove('drop-hot');\n        hot = target && target.minute == null ? target.el : null;\n        if (hot) hot.classList.add('drop-hot');\n      }\n      st.target = target;\n    };\n    const cleanup = () => { ghost.remove(); p.el.style.opacity = ''; if (hot) hot.classList.remove('drop-hot'); };\n    const handler = {\n      move(x, y) { st.x = x; st.y = y; update(); },\n      end() {\n        cleanup();\n        const tg = st.target;\n        if (!tg) return;\n        if (tg.minute != null) scheduleTask(t, C.dateOnDay(tg.day, tg.minute), true);\n        else if (t.hasTime && t.due) scheduleTask(t, C.dateOnDay(tg.day, C.minuteOfDay(t.due, t.due)), true);\n        else scheduleTask(t, C.startOfDay(tg.day), false);\n      },\n      cancel() { cleanup(); },\n    };\n    update();\n    return handler;\n  }\n\n  function activate() {\n    const p = Gest.pending;\n    Gest.pending = null;\n    if (!p) return;\n    if (p.kind === 'locked') {\n      const b = S.blocks[p.el.closest('.blk').dataset.blk];\n      toast(b && b.src === 'e' && b.ref.recurring ? '重复日程不能直接拖动：点开后用系统编辑器修改' : '这个日历是只读的');\n      suppressClickUntil = Date.now() + 500;\n      return;\n    }\n    const h = p.kind === 'chip' ? dragChip(p) : p.kind === 'create' ? dragCreate(p) : dragBlock(p);\n    if (h) {\n      Gest.active = h;\n      suppressClickUntil = Date.now() + 100000;\n    }\n  }\n\n  function begin(target, x, y) {\n    const swipeEl = target.closest('[data-swipe]');\n    Gest.swipe = swipeEl ? { x0: x, y0: y, kind: swipeEl.dataset.swipe } : null;\n    const el = target.closest('[data-drag]');\n    if (!el || el.closest('.sheet')) return;\n    const kind = el.dataset.drag;\n    Gest.pending = { el, kind, x0: x, y0: y, x, y, timer: setTimeout(activate, kind === 'resize' ? 220 : 380) };\n  }\n\n  function moveTo(x, y, e) {\n    const p = Gest.pending;\n    if (p) {\n      p.x = x; p.y = y;\n      if (Math.hypot(x - p.x0, y - p.y0) > 10) { clearTimeout(p.timer); Gest.pending = null; }\n      return;\n    }\n    if (Gest.active) {\n      if (e && e.cancelable) e.preventDefault();\n      Gest.active.move(x, y);\n    }\n  }\n\n  function finish(x, y, e) {\n    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }\n    if (Gest.active) {\n      if (e && e.cancelable) e.preventDefault();\n      const a = Gest.active;\n      Gest.active = null;\n      suppressClickUntil = Date.now() + 300;\n      a.end();\n      return;\n    }\n    const sw = Gest.swipe;\n    Gest.swipe = null;\n    if (sw && x != null) {\n      const dx = x - sw.x0, dy = y - sw.y0;\n      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {\n        suppressClickUntil = Date.now() + 400;\n        if (sw.kind === 'month') setDay(C.addMonths(S.day, dx < 0 ? 1 : -1));\n        else setDay(C.addDays(S.day, dx < 0 ? 7 : -7));\n      }\n    }\n  }\n\n  function cancelGesture() {\n    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }\n    if (Gest.active) { const a = Gest.active; Gest.active = null; a.cancel(); suppressClickUntil = Date.now() + 400; }\n    Gest.swipe = null;\n  }\n\n  // Pinch to zoom the day grid\n  function pinchStart(e) {\n    const scrollEl = e.target.closest && e.target.closest('.grid-scroll');\n    if (!scrollEl || scrollEl.dataset.compact === '1') return;\n    const [a, b] = e.touches;\n    Gest.pinch = {\n      scrollEl, grid: scrollEl.firstElementChild, base: hourHeight(false), hh: hourHeight(false),\n      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),\n      cy: (a.clientY + b.clientY) / 2 - scrollEl.getBoundingClientRect().top,\n    };\n  }\n\n  function pinchMove(e) {\n    const p = Gest.pinch;\n    const [a, b] = e.touches;\n    if (!b) return;\n    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);\n    const hh = clamp(p.base * d / p.d0, 28, 160);\n    const top = (p.scrollEl.scrollTop + p.cy) * hh / p.hh - p.cy;\n    p.hh = hh;\n    p.grid.style.setProperty('--hh', hh);\n    p.scrollEl.scrollTop = top;\n  }\n\n  function pinchEnd() {\n    const p = Gest.pinch;\n    Gest.pinch = null;\n    S.settings.hourHeight = Math.round(p.hh);\n    render();\n    saveSettings({ hourHeight: S.settings.hourHeight });\n  }\n\n  document.addEventListener('touchstart', (e) => {\n    if (e.touches.length === 2) {\n      cancelGesture();\n      pinchStart(e);\n      return;\n    }\n    if (e.touches.length !== 1 || Gest.active) return;\n    const t = e.touches[0];\n    begin(e.target, t.clientX, t.clientY);\n  }, { passive: false });\n\n  document.addEventListener('touchmove', (e) => {\n    if (Gest.pinch) { e.preventDefault(); pinchMove(e); return; }\n    const t = e.touches[0];\n    if (t) moveTo(t.clientX, t.clientY, e);\n  }, { passive: false });\n\n  document.addEventListener('touchend', (e) => {\n    if (Gest.pinch) { if (e.touches.length < 2) pinchEnd(); return; }\n    const t = e.changedTouches[0];\n    finish(t ? t.clientX : null, t ? t.clientY : null, e);\n  }, { passive: false });\n\n  document.addEventListener('touchcancel', cancelGesture);\n\n  // Mouse fallback for the desktop preview\n  let mouseDown = false;\n  let lastTouch = 0;\n  ['touchstart', 'touchend'].forEach((t) => document.addEventListener(t, () => { lastTouch = Date.now(); }, { passive: true }));\n  document.addEventListener('mousedown', (e) => {\n    if (e.button !== 0 || Date.now() - lastTouch < 1000) return;\n    mouseDown = true;\n    begin(e.target, e.clientX, e.clientY);\n  });\n  document.addEventListener('mousemove', (e) => { if (mouseDown) moveTo(e.clientX, e.clientY, e); });\n  document.addEventListener('mouseup', (e) => {\n    if (!mouseDown) return;\n    mouseDown = false;\n    finish(e.clientX, e.clientY, e);\n  });\n\n  // ------------------------------------------------------------- startup\n\n  function fitViewport() {\n    const vv = window.visualViewport;\n    const h = vv ? vv.height : window.innerHeight;\n    document.documentElement.style.setProperty('--vh', h + 'px');\n    if (vv && vv.offsetTop) window.scrollTo(0, 0);\n  }\n\n  function tickNow() {\n    for (const el of $$('.now')) {\n      const scroll = el.closest('.grid-scroll');\n      const days = scroll.dataset.days.split(',').map((x) => new Date(+x));\n      const day = days[+el.dataset.now];\n      if (!C.sameDay(day, new Date())) { render(); return; }\n      el.style.top = `calc(var(--hh) * ${C.minuteOfDay(new Date(), day) / 60} * 1px)`;\n    }\n  }\n\n  function start() {\n    renderQuickAdd();\n    render();\n    fitViewport();\n    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);\n    window.addEventListener('resize', fitViewport);\n    load(true);\n    setInterval(tickNow, 30e3);\n    // Pick up changes made elsewhere (system Calendar, other devices)\n    setInterval(() => {\n      if (!document.hidden && !Gest.active && !Gest.pinch && !S.sheet && !S.loading) refresh();\n    }, 30e3);\n    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });\n  }\n\n  window.OneGlance = { state: S, refresh, render, agenda };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);\n  else start();\n})();\n\n</script>\n</body>\n</html>\n";
const VERSION = 'b8bde426';
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
