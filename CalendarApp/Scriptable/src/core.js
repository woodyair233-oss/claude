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
