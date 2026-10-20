// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;
// 一览 · 日历与任务排程（Scriptable 版）。由 CalendarApp/Scriptable/build.mjs 生成，请勿手动修改。
// @version cf59c20a

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

// Scriptable runtime for 一览. The build prepends core.js and fills in APP_HTML.
//
// Run from the app or a Home Screen icon → full-screen UI in a WebView.
// Run as a widget → today's events and tasks.
// Run from Shortcuts/Siri with text, or scriptable:///run/一览?add=… → adds a task without UI.

const C = globalThis.GlanceCore;
const APP_HTML = "<!doctype html>\n<html lang=\"zh-Hans\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover\">\n<title>一览</title>\n<style>\n:root {\n  --bg: #ffffff;\n  --surface: #f2f2f7;\n  --surface2: #e5e5ea;\n  --text: #1c1c1e;\n  --text2: #6c6c70;\n  --text3: #aeaeb2;\n  --sep: rgba(60, 60, 67, 0.18);\n  --accent: #286be6;\n  --accent-soft: rgba(40, 107, 230, 0.14);\n  --red: #e5383b;\n  --heat: 249, 115, 22;\n  --sheet: #ffffff;\n  --inbox: #fff8ec;\n  --shadow: 0 6px 20px rgba(0, 0, 0, 0.18);\n  --vh: 100dvh;\n  color-scheme: light dark;\n}\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #000000;\n    --surface: #1c1c1e;\n    --surface2: #2c2c2e;\n    --text: #f2f2f7;\n    --text2: #98989f;\n    --text3: #5a5a5f;\n    --sep: rgba(84, 84, 88, 0.6);\n    --accent: #5a92ff;\n    --accent-soft: rgba(90, 146, 255, 0.2);\n    --red: #ff5a5f;\n    --sheet: #1c1c1e;\n    --inbox: #1f1a12;\n    --shadow: 0 6px 20px rgba(0, 0, 0, 0.6);\n  }\n}\n\n* { box-sizing: border-box; margin: 0; padding: 0; }\nhtml, body {\n  height: 100%;\n  background: var(--bg);\n  color: var(--text);\n  font: 15px/1.35 -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Noto Sans CJK SC\", sans-serif;\n  -webkit-text-size-adjust: 100%;\n  -webkit-tap-highlight-color: transparent;\n  overscroll-behavior: none;\n  touch-action: manipulation;\n}\nbody { overflow: hidden; }\nbutton { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }\ninput, select, textarea { font: inherit; color: inherit; }\n.mono { font-variant-numeric: tabular-nums; }\n.muted { color: var(--text2); }\n.row, .chip, .cell, .strip-day, .wday-head {\n  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;\n}\n\n#app {\n  height: var(--vh);\n  display: flex;\n  flex-direction: column;\n  padding-top: env(safe-area-inset-top);\n}\n#main { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }\n\n/* ------------------------------------------------------------ header */\n.hdr { padding: 6px 12px 6px; display: flex; flex-direction: column; gap: 7px; border-bottom: 0.5px solid var(--sep); }\n.hdr-row { display: flex; align-items: center; gap: 2px; }\n.hdr-title { flex: 1; min-width: 0; }\n.hdr-title h1 { font-size: 20px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.hdr-title p { font-size: 12px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.icon-btn { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; color: var(--accent); font-size: 20px; }\n.icon-btn:active { background: var(--surface); }\n.text-btn { color: var(--accent); font-weight: 500; padding: 6px 8px; border-radius: 8px; }\n.text-btn:disabled { color: var(--text3); }\n.text-btn.strong { font-weight: 700; }\n.text-btn.wide { width: 100%; text-align: left; }\n.seg { display: flex; background: var(--surface); border-radius: 9px; padding: 2px; }\n.seg button { flex: 1; padding: 5px 0; border-radius: 7px; font-size: 14px; font-weight: 500; }\n.seg button.on { background: var(--bg); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }\n@media (prefers-color-scheme: dark) { .seg button.on { background: #636366; } }\n\n.strip { display: flex; gap: 2px; touch-action: pan-y; }\n.strip-day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 2px 0 4px; border-radius: 10px; }\n.strip-day .wd { font-size: 11px; color: var(--text2); }\n.strip-day .num { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; font-size: 16px; font-variant-numeric: tabular-nums; }\n.strip-day.today .num { color: var(--accent); font-weight: 700; }\n.strip-day.sel .num { background: var(--accent); color: #fff; font-weight: 700; }\n.loadbar { width: 18px; height: 4px; border-radius: 2px; flex: none; }\n.drop-hot { outline: 2px solid var(--accent); outline-offset: -2px; background-color: var(--accent-soft) !important; }\n\n/* ------------------------------------------------------------ rows */\n.list, .week, .digest { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }\n.list { padding-bottom: 12px; touch-action: pan-y; }\n.list-end { height: 24px; }\n.sec { padding: 12px 14px 4px; font-size: 13px; font-weight: 600; color: var(--text2); display: flex; align-items: center; gap: 8px; }\n.sec.red { color: var(--red); }\n.sec .pill-btn { margin-left: auto; }\n.pill-btn { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 12px; background: var(--surface); color: var(--accent); }\n.row { display: flex; align-items: center; gap: 10px; padding: 9px 14px; min-height: 44px; border-bottom: 0.5px solid var(--sep); background: var(--bg); }\n.row .bar { width: 4px; align-self: stretch; border-radius: 2px; background: var(--c); flex: none; }\n.row .body { flex: 1; min-width: 0; }\n.row .t { font-size: 16px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }\n.row .d { font-size: 12px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.row.done .t { text-decoration: line-through; color: var(--text2); }\n.row.compact { min-height: 34px; padding: 5px 12px; gap: 8px; }\n.row.compact .t { font-size: 15px; -webkit-line-clamp: 2; }\n.row.compact .check { width: 19px; height: 19px; font-size: 11px; }\n.row .more { font-size: 18px; color: var(--text2); width: 34px; height: 30px; border-radius: 8px; flex: none; }\n.row.lifted, .chip.lifted { opacity: 0.35; }\n.check {\n  width: 22px; height: 22px; border-radius: 50%; border: 1.6px solid var(--c); flex: none;\n  display: grid; place-items: center; color: #fff; font-size: 13px; font-weight: 700;\n}\n.check.on { background: var(--c); }\n.prio { color: var(--red); font-weight: 700; font-size: 13px; }\n.empty { padding: 10px 14px; color: var(--text2); font-size: 14px; }\n.empty.small { font-size: 13px; padding: 6px 12px; }\n.floating {\n  position: fixed; z-index: 100; pointer-events: none; padding: 7px 13px; border-radius: 16px; max-width: 80vw;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n  background: var(--sheet); box-shadow: var(--shadow); font-size: 14px; transform: translate(-50%, -140%);\n}\n\n/* week: seven days stacked */\n.week { padding-bottom: 12px; }\n.wday { border-bottom: 6px solid var(--surface); }\n.wday-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 4px; position: sticky; top: 0; background: var(--bg); z-index: 1; }\n.wday-head .wd { font-weight: 700; font-size: 15px; }\n.wday-head .dn { color: var(--text2); font-size: 13px; font-variant-numeric: tabular-nums; }\n.wday-head .grow { flex: 1; }\n.wday-head .cnt { font-size: 12px; color: var(--text2); }\n.wday.today .wd { color: var(--accent); }\n.wday.sel .wday-head { background: linear-gradient(var(--accent-soft), var(--accent-soft)), var(--bg); }\n.wday-items .row { border-bottom: 0; }\n\n/* month */\n.month { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 8px; gap: 6px; }\n.mo-wd { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; padding-top: 6px; }\n.mo-wd span { text-align: center; font-size: 11px; color: var(--text2); }\n.mo-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; touch-action: pan-y; }\n.cell {\n  position: relative; min-height: 44px; border-radius: 8px; display: flex; flex-direction: column;\n  align-items: center; justify-content: center; gap: 1px; background: rgba(var(--heat), var(--a, 0));\n}\n.cell .n { font-size: 15px; font-variant-numeric: tabular-nums; }\n.cell .cnt { font-size: 10px; font-weight: 600; color: var(--text2); min-height: 12px; }\n.cell.today .n { color: var(--accent); font-weight: 700; }\n.cell.hot .n, .cell.hot .cnt { color: #fff; }\n.cell.out { opacity: 0.35; }\n.cell.sel { box-shadow: inset 0 0 0 2px var(--accent); }\n.dot-red { position: absolute; top: 4px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--red); }\n.mo-sum { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text2); }\n.legend { display: flex; align-items: center; gap: 2px; }\n.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }\n.mo-sum .grow { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.digest { border-top: 0.5px solid var(--sep); padding: 6px 0 12px; margin: 0 -8px; }\n.digest .head { display: flex; align-items: center; justify-content: space-between; font-weight: 700; font-size: 15px; padding: 2px 12px 4px; }\n\n/* ------------------------------------------------------------ to-do area */\n.inbox { background: var(--inbox); border-top: 0.5px solid var(--sep); }\n.inbox-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; }\n.inbox-head .title { font-weight: 700; font-size: 15px; }\n.inbox-head .count { font-size: 12px; font-weight: 700; color: #fff; background: #f08c00; border-radius: 10px; padding: 1px 7px; }\n.inbox-head .hint { flex: 1; font-size: 11px; color: var(--text2); text-align: right; }\n.inbox-head .chev { color: var(--text2); font-size: 12px; }\n.inbox-body { max-height: 24vh; overflow-y: auto; padding: 0 12px 10px; -webkit-overflow-scrolling: touch; }\n.chips { display: flex; flex-wrap: wrap; gap: 7px; }\n.chip {\n  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;\n  padding: 6px 12px 6px 8px; border-radius: 18px; font-size: 15px;\n  background: var(--bg); box-shadow: 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent);\n}\n.chip .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }\n.chip .check { width: 18px; height: 18px; }\n\n/* ------------------------------------------------------------ quick add */\n.qa { padding: 7px 12px calc(7px + env(safe-area-inset-bottom)); border-top: 0.5px solid var(--sep); background: var(--bg); display: flex; flex-direction: column; gap: 6px; }\n.qa-row { display: flex; align-items: center; gap: 8px; }\n.qa input { flex: 1; min-width: 0; border: 0; outline: 0; border-radius: 18px; padding: 9px 14px; background: var(--surface); font-size: 16px; }\n.qa .send { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 18px; font-weight: 700; display: grid; place-items: center; }\n.qa .send:disabled { background: var(--text3); }\n.qa .plus { width: 34px; height: 34px; border-radius: 50%; color: var(--accent); font-size: 26px; display: grid; place-items: center; }\n.preview { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }\n.preview:empty { display: none; }\n.preview::-webkit-scrollbar { display: none; }\n.pv { white-space: nowrap; font-size: 12px; padding: 3px 9px; border-radius: 12px; background: var(--surface); }\n.pv.kind { background: var(--accent-soft); color: var(--accent); font-weight: 700; }\n\n/* ------------------------------------------------------------ toast */\n.toast {\n  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 40;\n  display: flex; gap: 12px; align-items: center; padding: 9px 16px; border-radius: 20px;\n  background: var(--sheet); box-shadow: var(--shadow); font-size: 14px; max-width: 92%;\n}\n.toast button { color: var(--accent); font-weight: 700; white-space: nowrap; }\n\n/* ------------------------------------------------------------ sheet */\n.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 50; display: flex; align-items: flex-end; }\n.sheet {\n  width: 100%; max-height: 92%; background: var(--sheet); border-radius: 14px 14px 0 0;\n  display: flex; flex-direction: column; padding-bottom: env(safe-area-inset-bottom);\n  animation: up 0.2s ease-out;\n}\n@keyframes up { from { transform: translateY(40%); opacity: 0.5; } to { transform: none; opacity: 1; } }\n.sheet-head { display: flex; align-items: center; padding: 8px; border-bottom: 0.5px solid var(--sep); }\n.sheet-head h2 { flex: 1; text-align: center; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.sheet-head .spacer { width: 60px; }\n.sheet-body { overflow-y: auto; padding: 8px 0 24px; -webkit-overflow-scrolling: touch; }\n.form-sec { margin: 10px 14px; background: var(--surface); border-radius: 11px; overflow: hidden; }\n.fsec-title { margin: 14px 28px 4px; font-size: 12px; color: var(--text2); }\n.fsec-foot { margin: 4px 28px 0; font-size: 12px; color: var(--text2); }\n.f { display: flex; align-items: center; gap: 10px; padding: 10px 14px; min-height: 44px; border-bottom: 0.5px solid var(--sep); }\n.f:last-child { border-bottom: 0; }\n.f[hidden] { display: none; }\n.f > label { flex: 1; }\n.f input[type=text], .f textarea { flex: 1; border: 0; outline: 0; background: transparent; font-size: 16px; min-width: 0; }\n.f textarea { resize: none; min-height: 60px; }\n.f input[type=date], .f select { border: 0; border-radius: 7px; padding: 5px 8px; background: var(--surface2); font-size: 15px; min-width: 0; }\n.switch { position: relative; width: 50px; height: 30px; flex: none; }\n.switch input { opacity: 0; width: 0; height: 0; position: absolute; }\n.switch span { position: absolute; inset: 0; border-radius: 15px; background: var(--surface2); transition: 0.2s; }\n.switch span::after { content: \"\"; position: absolute; left: 2px; top: 2px; width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: 0.2s; }\n.switch input:checked + span { background: #34c759; }\n.switch input:checked + span::after { transform: translateX(20px); }\n.quick { display: flex; gap: 6px; flex-wrap: wrap; }\n.quick button { font-size: 14px; padding: 5px 12px; border-radius: 14px; background: var(--surface2); color: var(--accent); }\n.segf { display: flex; background: var(--surface2); border-radius: 8px; padding: 2px; flex: 1; }\n.segf button { flex: 1; padding: 5px 0; border-radius: 6px; font-size: 14px; }\n.segf button.on { background: var(--sheet); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); font-weight: 600; }\n.danger { color: var(--red); width: 100%; text-align: center; padding: 12px; font-size: 16px; }\n.note { padding: 10px 14px; font-size: 13px; color: var(--text2); }\n.note.big { text-align: center; font-size: 16px; padding: 18px; color: var(--text); }\n.stepper { display: flex; align-items: center; gap: 8px; }\n.stepper button { width: 32px; height: 28px; border-radius: 7px; background: var(--surface2); font-size: 18px; color: var(--accent); }\n.stepper span { min-width: 24px; text-align: center; }\n.dot-sw { width: 11px; height: 11px; border-radius: 50%; background: var(--c); display: inline-block; flex: none; }\n.version { margin-left: auto; font-size: 12px; }\n\n/* permission / error */\n.center-msg { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 30px; text-align: center; color: var(--text2); }\n.center-msg h2 { color: var(--text); font-size: 22px; }\n.center-msg .primary { background: var(--accent); color: #fff; padding: 10px 20px; border-radius: 12px; font-weight: 600; }\n\n</style>\n</head>\n<body>\n<div id=\"app\"><header id=\"hdr\"></header><main id=\"main\"></main><section id=\"inbox\"></section><footer id=\"qa\"></footer></div>\n<div id=\"sheet-root\"></div>\n<script>\n// GlanceCore: pure logic shared by the web UI, the Scriptable runtime and the\n// Node tests. Everything works in whole days; times of day are never shown.\n(function (root) {\n  'use strict';\n\n  // ---------------------------------------------------------------- dates\n\n  const DAY_MS = 864e5;\n\n  function startOfDay(d) {\n    const x = new Date(d);\n    return new Date(x.getFullYear(), x.getMonth(), x.getDate());\n  }\n\n  /** Same wall-clock time `n` days later (DST safe). */\n  function addDays(d, n) {\n    const x = new Date(d);\n    return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n,\n      x.getHours(), x.getMinutes(), x.getSeconds(), x.getMilliseconds());\n  }\n\n  function addMonths(d, n) {\n    const x = new Date(d);\n    const target = new Date(x.getFullYear(), x.getMonth() + n, 1);\n    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();\n    return new Date(target.getFullYear(), target.getMonth(), Math.min(x.getDate(), last),\n      x.getHours(), x.getMinutes());\n  }\n\n  /** Whole days from `a` to `b` (calendar days, not 24 h blocks). */\n  function daysBetween(a, b) {\n    return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);\n  }\n\n  function sameDay(a, b) {\n    const x = new Date(a), y = new Date(b);\n    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();\n  }\n\n  function sameMonth(a, b) {\n    const x = new Date(a), y = new Date(b);\n    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth();\n  }\n\n  /** 1 = Monday … 7 = Sunday. */\n  function isoWeekday(d) {\n    const w = new Date(d).getDay();\n    return w === 0 ? 7 : w;\n  }\n\n  /** @param weekStart 1 = Monday, 0 = Sunday */\n  function startOfWeek(date, weekStart) {\n    const d = startOfDay(date);\n    const back = (d.getDay() - (weekStart || 0) + 7) % 7;\n    return addDays(d, -back);\n  }\n\n  function weekDays(date, weekStart) {\n    const s = startOfWeek(date, weekStart);\n    return Array.from({ length: 7 }, (_, i) => addDays(s, i));\n  }\n\n  /** 42 days (6 weeks) covering the month of `date`. */\n  function monthGrid(date, weekStart) {\n    const d = new Date(date);\n    const s = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1), weekStart);\n    return Array.from({ length: 42 }, (_, i) => addDays(s, i));\n  }\n\n  /**\n   * Days an event is listed on. Timed events (even overnight ones) show on\n   * the day they start; all-day events on every day they cover.\n   */\n  function eventDays(start, end, allDay) {\n    const s = startOfDay(start);\n    if (!allDay) return [s];\n    const last = startOfDay(new Date(Math.max(+start, +end - 1)));\n    const days = [];\n    for (let d = s; d <= last && days.length < 366; d = addDays(d, 1)) days.push(d);\n    return days;\n  }\n\n  // ---------------------------------------------------------------- text\n\n  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];\n\n  const fmt = {\n    md: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日`; },\n    mdw: (d) => { const x = new Date(d); return `${x.getMonth() + 1}月${x.getDate()}日 周${WEEKDAY[x.getDay()]}`; },\n    ym: (d) => { const x = new Date(d); return `${x.getFullYear()}年${x.getMonth() + 1}月`; },\n    weekdayLetter: (d) => WEEKDAY[new Date(d).getDay()],\n    weekday: (d) => '周' + WEEKDAY[new Date(d).getDay()],\n    /** \"今天\" / \"明天\" / \"昨天\" / \"10月18日 周日\" */\n    relativeDay(d, now) {\n      const diff = daysBetween(startOfDay(now || new Date()), d);\n      if (diff === 0) return '今天';\n      if (diff === 1) return '明天';\n      if (diff === 2) return '后天';\n      if (diff === -1) return '昨天';\n      return fmt.mdw(d);\n    },\n  };\n\n  /** 0 (nothing) … 4 (at or over the daily capacity). */\n  function loadLevel(count, capacity) {\n    if (count <= 0) return 0;\n    const r = count / Math.max(capacity || 1, 1);\n    if (r < 0.25) return 1;\n    if (r < 0.5) return 2;\n    if (r < 0.85) return 3;\n    return 4;\n  }\n\n  // ---------------------------------------------------------------- parser\n\n  const CN_NUM = '[零〇一二两兩三四五六七八九十]{1,3}';\n  const ANY_NUM = '\\\\d{1,2}|' + CN_NUM;\n\n  /** \"12\" → 12, \"十二\" → 12, \"二十三\" → 23, \"两\" → 2. */\n  function chineseNumber(text) {\n    if (text == null || text === '') return null;\n    if (/^\\d+$/.test(text)) return parseInt(text, 10);\n    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };\n    let total = 0, current = 0, sawTen = false;\n    for (const ch of text) {\n      if (ch in digits) current = digits[ch];\n      else if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0; sawTen = true; }\n      else return null;\n    }\n    const value = total + current;\n    return (value > 0 || sawTen || /[零〇]/.test(text)) ? value : null;\n  }\n\n  const reCache = new Map();\n  function firstMatch(pattern, text) {\n    let re = reCache.get(pattern);\n    if (!re) { re = new RegExp(pattern, 'i'); reCache.set(pattern, re); }\n    const m = re.exec(text);\n    return m && m[0].length ? m : null;\n  }\n  const cut = (text, m) => text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);\n\n  function weekdayIndex(s) {\n    return { 一: 1, 1: 1, 二: 2, 2: 2, 三: 3, 3: 3, 四: 4, 4: 4, 五: 5, 5: 5, 六: 6, 6: 6, 日: 7, 天: 7, 7: 7 }[s] || null;\n  }\n\n  function englishWeekday(s) {\n    return { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[(s || '').toLowerCase().slice(0, 3)] || null;\n  }\n\n  function weekdayDate(target, prefix, today) {\n    const cur = isoWeekday(today);\n    let delta;\n    switch (prefix || '') {\n      case '本': case '这': case '这个': delta = target - cur; break;\n      case '下': case '下个': delta = 7 - cur + target; break;\n      case '下下': case '下下个': delta = 14 - cur + target; break;\n      case '上': case '上个': delta = target - cur - 7; break;\n      default: delta = (target - cur + 7) % 7;\n    }\n    return addDays(today, delta);\n  }\n\n  /** The month/day this year, or next year (or next month with rollMonth) if it passed. */\n  function nearestFuture(month, day, year, today, rollMonth) {\n    const d = new Date(year, month - 1, day);\n    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;\n    if (d >= today) return d;\n    return rollMonth ? addMonths(d, 1) : new Date(year + 1, month - 1, day);\n  }\n\n  /** Finds a date expression, removes it from state.text and returns the day. */\n  function parseDate(state, today) {\n    const year = today.getFullYear();\n    let m;\n\n    if ((m = firstMatch('(\\\\d{4})\\\\s*[-/.年]\\\\s*(\\\\d{1,2})\\\\s*[-/.月]\\\\s*(\\\\d{1,2})\\\\s*[日号號]?', state.text))) {\n      state.text = cut(state.text, m);\n      return new Date(+m[1], +m[2] - 1, +m[3]);\n    }\n    if ((m = firstMatch('(' + ANY_NUM + ')\\\\s*月\\\\s*(' + ANY_NUM + ')\\\\s*[日号號]', state.text))) {\n      const mo = chineseNumber(m[1]), d = chineseNumber(m[2]);\n      const date = mo && d ? nearestFuture(mo, d, year, today) : null;\n      if (date) { state.text = cut(state.text, m); return date; }\n    }\n    if ((m = firstMatch('(?<![\\\\d:/])(\\\\d{1,2})/(\\\\d{1,2})(?![\\\\d/])', state.text))) {\n      const mo = +m[1], d = +m[2];\n      const date = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? nearestFuture(mo, d, year, today) : null;\n      if (date) { state.text = cut(state.text, m); return date; }\n    }\n    const words = [\n      ['大后天', 3], ['后天', 2], ['明早', 1], ['明晨', 1], ['明晚', 1], ['明天', 1], ['明日', 1],\n      ['今早', 0], ['今晨', 0], ['今晚', 0], ['今天', 0], ['今日', 0], ['昨天', -1],\n      ['tomorrow', 1], ['tmr', 1], ['tonight', 0], ['today', 0],\n    ];\n    if ((m = firstMatch('(?<![a-z])(' + words.map((w) => w[0]).join('|') + ')(?![a-z])', state.text))) {\n      const w = words.find((x) => x[0] === m[1].toLowerCase());\n      if (w) { state.text = cut(state.text, m); return addDays(today, w[1]); }\n    }\n    if ((m = firstMatch('(' + ANY_NUM + ')\\\\s*天[以之]?后', state.text))) {\n      const n = chineseNumber(m[1]);\n      if (n != null) { state.text = cut(state.text, m); return addDays(today, n); }\n    }\n    if ((m = firstMatch('(下下个?|下个?|这个?|本|上个?)?\\\\s*(?:周|星期|礼拜|週)\\\\s*([一二三四五六日天1-7])', state.text))) {\n      const target = weekdayIndex(m[2]);\n      if (target) { state.text = cut(state.text, m); return weekdayDate(target, m[1], today); }\n    }\n    if ((m = firstMatch('(?<![a-z])(next\\\\s+|this\\\\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?(?![a-z])', state.text))) {\n      const target = englishWeekday(m[2]);\n      if (target) {\n        state.text = cut(state.text, m);\n        const p = (m[1] || '').trim().toLowerCase();\n        return weekdayDate(target, p === 'next' ? '下' : p === 'this' ? '本' : null, today);\n      }\n    }\n    // 16号 / 16日 (not \"12号床\", \"一日三餐\")\n    for (const pattern of [\n      '(?<![\\\\d月/])(' + ANY_NUM + ')\\\\s*[号號](?![床房楼樓病诊診室线線窗口])',\n      '(?<![\\\\d月/])(\\\\d{1,2})\\\\s*日(?![程历曆])',\n    ]) {\n      m = firstMatch(pattern, state.text);\n      if (!m) continue;\n      const d = chineseNumber(m[1]);\n      if (d >= 1 && d <= 31) {\n        const date = nearestFuture(today.getMonth() + 1, d, year, today, true);\n        if (date) { state.text = cut(state.text, m); return date; }\n      }\n    }\n    return null;\n  }\n\n  function cleanTitle(text) {\n    return text.split(/\\s+/).filter(Boolean).join(' ')\n      .replace(/^[\\s,，、;；:：\\-–—~～.。]+|[\\s,，、;；:：\\-–—~～.。]+$/g, '');\n  }\n\n  /**\n   * Parses one quick-add line into a task: \"明天 交报告 #工作 !!\".\n   * Without a date the task goes to the to-do area (day = null).\n   * Clock times are not interpreted; they stay in the title.\n   */\n  function parseTask(input, opts) {\n    const now = opts && opts.now ? new Date(opts.now) : new Date();\n    const state = { text: ' ' + String(input).replace(/\\u3000/g, ' ') + ' ' };\n    let m;\n    if ((m = firstMatch('^\\\\s*(待办|提醒我?|任务|todo|task)\\\\s*[:：]?\\\\s*', state.text))) state.text = cut(state.text, m);\n    let listHint = null;\n    if ((m = firstMatch('[#＃]([^\\\\s#＃]+)', state.text))) {\n      listHint = m[1];\n      state.text = cut(state.text, m);\n    }\n    let priority = 0;\n    if ((m = firstMatch('(?:^|\\\\s)([!！]{1,3})(?=\\\\s|$)', state.text))) {\n      priority = m[1].length === 3 ? 1 : m[1].length === 2 ? 5 : 9;\n      state.text = cut(state.text, m);\n    }\n    const day = parseDate(state, startOfDay(now));\n    return { title: cleanTitle(state.text), day: day ? startOfDay(day) : null, priority, listHint };\n  }\n\n  const GlanceCore = {\n    startOfDay, addDays, addMonths, daysBetween, sameDay, sameMonth, isoWeekday,\n    startOfWeek, weekDays, monthGrid, eventDays, fmt, loadLevel, chineseNumber, parseTask,\n  };\n  root.GlanceCore = GlanceCore;\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n\n</script>\n<script>\n// 一览 web UI (day-level). Runs inside Scriptable's WebView (data via the\n// Scriptable bridge) or in a desktop browser with the mock bridge.\n(function () {\n  'use strict';\n  const C = window.GlanceCore;\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));\n  const esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) =>\n    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);\n  const pad = (n) => String(n).padStart(2, '0');\n  const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;\n  const fromDateValue = (v) => {\n    const [y, m, d] = (v || '').split('-').map(Number);\n    return new Date(y, (m || 1) - 1, d || 1);\n  };\n\n  const DEFAULT_SETTINGS = {\n    hidden: [], weekStart: 1, capacity: 6, showCompleted: true, defaultReminderListId: null, inboxOpen: true,\n  };\n\n  const S = {\n    ready: false, error: null,\n    calendars: [], lists: [], events: [], reminders: [], defaults: {}, version: '',\n    settings: Object.assign({}, DEFAULT_SETTINGS),\n    mode: 'day', day: C.startOfDay(new Date()), range: null,\n    sheet: null, toast: null, viewKey: '', loading: false,\n  };\n  const ws = () => S.settings.weekStart;\n  const today = () => C.startOfDay(new Date());\n\n  // ------------------------------------------------------------- bridge\n\n  const Bridge = (() => {\n    let seq = 0;\n    const pending = new Map();\n    let queue = [];\n    let waiter = null;\n    let timer = null;\n    const flush = () => {\n      if (waiter && queue.length) {\n        const w = waiter;\n        waiter = null;\n        clearTimeout(timer);\n        w(queue.splice(0));\n      }\n    };\n    // Scriptable calls `__nextMessages(completion)` with evaluateJavaScript(…, true)\n    // and gets the queued messages back through `completion` (long poll).\n    window.__nextMessages = function (completion) {\n      const done = completion || window.completion;\n      if (queue.length) { done(queue.splice(0)); return; }\n      waiter = done;\n      timer = setTimeout(() => { if (waiter === done) { waiter = null; done([]); } }, 2000);\n    };\n    window.__reply = (id, ok, result) => {\n      const p = pending.get(id);\n      if (!p) return;\n      pending.delete(id);\n      if (ok) p.resolve(result); else p.reject(new Error(result));\n    };\n    return {\n      call(type, payload) {\n        if (window.__MOCK__) return window.__MOCK__.handle(type, JSON.parse(JSON.stringify(payload || {})));\n        return new Promise((resolve, reject) => {\n          const id = ++seq;\n          pending.set(id, { resolve, reject });\n          queue.push({ id, type, payload: payload || {} });\n          flush();\n        });\n      },\n    };\n  })();\n\n  // ------------------------------------------------------------- data\n\n  function rangeAround(day) {\n    const grid = C.monthGrid(day, ws());\n    return { start: C.addDays(grid[0], -7).getTime(), end: C.addDays(grid[41], 8).getTime() };\n  }\n\n  async function load(force) {\n    const need = rangeAround(S.day);\n    if (!force && S.range && need.start >= S.range.start && need.end <= S.range.end) return;\n    S.range = need;\n    await refresh();\n  }\n\n  async function refresh() {\n    if (!S.range) S.range = rangeAround(S.day);\n    S.loading = true;\n    try {\n      apply(await Bridge.call('load', S.range));\n    } catch (err) {\n      toast('读取失败：' + err.message);\n    } finally {\n      S.loading = false;\n    }\n  }\n\n  let lastDataJSON = '';\n  function apply(res) {\n    if (!res) return;\n    if (res.data) res = res.data;\n    if (res.error) {\n      S.error = res.error;\n      S.ready = true;\n      render();\n      return;\n    }\n    const json = JSON.stringify(res);\n    if (json === lastDataJSON && S.ready && !S.error) return;\n    lastDataJSON = json;\n    S.error = null;\n    S.calendars = res.calendars || [];\n    S.lists = res.lists || [];\n    S.defaults = res.defaults || {};\n    S.version = res.version || '';\n    S.settings = Object.assign({}, DEFAULT_SETTINGS, res.settings || {});\n    enrich(res.events || [], res.reminders || []);\n    S.ready = true;\n    if (!Gest.active) render();\n  }\n\n  function enrich(events, reminders) {\n    const cal = Object.fromEntries(S.calendars.map((c) => [c.id, c]));\n    const list = Object.fromEntries(S.lists.map((l) => [l.id, l]));\n    const count = {};\n    for (const e of events) count[e.id] = (count[e.id] || 0) + 1;\n    S.events = events.map((e) => {\n      const c = cal[e.calendarId] || {};\n      const start = new Date(e.start), end = new Date(e.end);\n      return Object.assign({}, e, {\n        start, end, color: c.color || '#8e8e93', calTitle: c.title || '',\n        canEdit: c.editable !== false, recurring: !!e.recurring || count[e.id] > 1,\n        days: C.eventDays(start, end, e.allDay).map(Number),\n      });\n    }).sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title));\n    S.reminders = reminders.map((r) => {\n      const l = list[r.listId] || {};\n      return Object.assign({}, r, {\n        due: r.due != null ? new Date(r.due) : null,\n        completionDate: r.completionDate != null ? new Date(r.completionDate) : null,\n        color: l.color || '#f08c00', listTitle: l.title || '',\n      });\n    });\n    agendaCache.clear();\n  }\n\n  const byPriority = (a, b) => {\n    const p = (x) => (x.priority === 0 ? 10 : x.priority);\n    return p(a) - p(b) || a.title.localeCompare(b.title);\n  };\n\n  const agendaCache = new Map();\n  /** Everything listed on one day. */\n  function agenda(day) {\n    const start = C.startOfDay(day);\n    const key = start.getTime();\n    if (agendaCache.has(key)) return agendaCache.get(key);\n    const isToday = C.sameDay(start, new Date());\n    const a = { day: start, events: [], tasks: [], done: [], overdue: [] };\n    for (const e of S.events) if (e.days.includes(key)) a.events.push(e);\n    for (const r of S.reminders) {\n      if (r.completed) {\n        const d = r.completionDate || r.due;\n        if (d && C.sameDay(d, start)) a.done.push(r);\n      } else if (r.due) {\n        if (C.sameDay(r.due, start)) a.tasks.push(r);\n        else if (isToday && r.due < start) a.overdue.push(r);\n      }\n    }\n    a.tasks.sort(byPriority);\n    a.overdue.sort((x, y) => x.due - y.due);\n    a.count = a.events.length + a.tasks.length;\n    agendaCache.set(key, a);\n    return a;\n  }\n\n  const inbox = () => S.reminders.filter((r) => !r.completed && !r.due).sort(byPriority);\n  const level = (day) => C.loadLevel(agenda(day).count, S.settings.capacity);\n  const findEvent = (uid) => S.events.find((e) => e.uid === uid);\n  const findTask = (id) => S.reminders.find((r) => r.id === id);\n  const editableCalendars = () => S.calendars.filter((c) => c.editable);\n  const editableLists = () => S.lists.filter((l) => l.editable !== false);\n  const defaultListId = () => S.settings.defaultReminderListId || S.defaults.reminderListId || (editableLists()[0] || {}).id;\n  const byHint = (hint, items) => {\n    if (!hint) return null;\n    const h = hint.toLowerCase();\n    return items.find((c) => c.title.toLowerCase() === h) || items.find((c) => c.title.toLowerCase().startsWith(h)) ||\n      items.find((c) => c.title.toLowerCase().includes(h)) || null;\n  };\n\n  // ------------------------------------------------------------- mutations\n\n  async function mutate(type, payload, okMessage, undo) {\n    try {\n      const res = await Bridge.call(type, payload);\n      if (res && res.recurring) {\n        toast('这是重复日程：为免改到整个系列，请用系统编辑器修改', {\n          label: '打开', fn: () => mutate('editNative', { uid: payload.uid }),\n        });\n        await refresh();\n        return null;\n      }\n      if (res && res.error) {\n        toast('操作失败：' + res.error);\n        await refresh();\n        return null;\n      }\n      if (res && res.data) apply(res.data);\n      else if (!(res && res.message)) await refresh();\n      if (res && res.message) toast(res.message);\n      if (okMessage) toast(okMessage, undo ? { label: '撤销', fn: () => undo(res) } : null);\n      return res;\n    } catch (err) {\n      toast('操作失败：' + err.message);\n      await refresh();\n      return null;\n    }\n  }\n\n  function optimistic(fn) {\n    fn();\n    lastDataJSON = '';\n    agendaCache.clear();\n    render();\n  }\n\n  /** Moves a task to `day` (null = back to the to-do area), keeping any time it had. */\n  function scheduleTask(task, day) {\n    let due = null;\n    if (day) {\n      due = C.startOfDay(day);\n      if (task.hasTime && task.due) due = new Date(due.getFullYear(), due.getMonth(), due.getDate(), task.due.getHours(), task.due.getMinutes());\n    }\n    const hasTime = !!(due && task.hasTime);\n    optimistic(() => { task.due = due; task.hasTime = hasTime; });\n    return mutate('updateReminder', { id: task.id, due: due ? +due : null, hasTime });\n  }\n\n  /** Moves an event by whole days so it starts on `day`; its time of day is kept. */\n  function moveEventToDay(ev, day) {\n    const delta = C.daysBetween(ev.start, day);\n    if (!delta) return null;\n    const start = C.addDays(ev.start, delta);\n    const end = C.addDays(ev.end, delta);\n    optimistic(() => {\n      ev.start = start;\n      ev.end = end;\n      ev.days = C.eventDays(start, end, ev.allDay).map(Number);\n    });\n    return mutate('updateEvent', { uid: ev.uid, start: +start, end: +end });\n  }\n\n  function toggleTask(task) {\n    optimistic(() => {\n      task.completed = !task.completed;\n      task.completionDate = task.completed ? new Date() : null;\n    });\n    return mutate('updateReminder', { id: task.id, completed: task.completed });\n  }\n\n  function saveSettings(patch) {\n    Object.assign(S.settings, patch);\n    return mutate('saveSettings', { settings: S.settings });\n  }\n\n  // ------------------------------------------------------------- toast\n\n  let toastTimer = null;\n  function toast(message, action) {\n    S.toast = { message, action };\n    renderToast();\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(() => { S.toast = null; renderToast(); }, action ? 5000 : 3000);\n  }\n\n  function renderToast() {\n    let el = $('#toast');\n    if (!S.toast) { if (el) el.remove(); return; }\n    if (!el) {\n      el = document.createElement('div');\n      el.id = 'toast';\n      el.className = 'toast';\n      $('#main').appendChild(el);\n    }\n    el.innerHTML = `<span>${esc(S.toast.message)}</span>` +\n      (S.toast.action ? `<button data-act=\"toast-action\">${esc(S.toast.action.label)}</button>` : '');\n  }\n\n  // ------------------------------------------------------------- render\n\n  function render() {\n    renderHeader();\n    renderMain();\n    renderInbox();\n    renderPreview();\n    renderToast();\n  }\n\n  const heat = (lv) => lv ? `rgba(var(--heat), ${[0, 0.16, 0.32, 0.52, 0.78][lv]})` : 'var(--surface2)';\n  const prioMark = (p) => (p >= 1 && p <= 4 ? '!!!' : p === 5 ? '!!' : p >= 6 && p <= 9 ? '!' : '');\n\n  function renderHeader() {\n    const hdr = $('#hdr');\n    if (!S.ready || S.error) { hdr.innerHTML = ''; return; }\n    const day = S.day;\n    let title;\n    if (S.mode === 'day') title = C.fmt.mdw(day);\n    else if (S.mode === 'week') {\n      const d = C.weekDays(day, ws());\n      title = `${C.fmt.md(d[0])}–${C.sameMonth(d[0], d[6]) ? d[6].getDate() + '日' : C.fmt.md(d[6])}`;\n    } else title = C.fmt.ym(day);\n\n    const a = agenda(day);\n    const parts = [];\n    if (S.mode !== 'day') parts.push(C.fmt.relativeDay(day));\n    else if (C.sameDay(day, new Date())) parts.push('今天');\n    if (a.events.length) parts.push(`${a.events.length}个日程`);\n    if (a.tasks.length) parts.push(`${a.tasks.length}个待办`);\n    if (a.overdue.length) parts.push(`逾期${a.overdue.length}`);\n    if (!parts.length || (parts.length === 1 && parts[0] === '今天')) parts.push('没有安排');\n\n    const onToday = C.sameDay(day, new Date()) && S.mode === 'day';\n    hdr.innerHTML = `\n      <div class=\"hdr\">\n        <div class=\"hdr-row\">\n          <div class=\"hdr-title\"><h1>${esc(title)}</h1><p>${esc(parts.join(' · '))}</p></div>\n          <button class=\"icon-btn\" data-act=\"prev\" aria-label=\"上一页\">‹</button>\n          <button class=\"text-btn\" data-act=\"today\" ${onToday ? 'disabled' : ''}>今天</button>\n          <button class=\"icon-btn\" data-act=\"next\" aria-label=\"下一页\">›</button>\n          <button class=\"icon-btn\" data-act=\"settings\" aria-label=\"设置\">⚙︎</button>\n        </div>\n        <div class=\"seg\">${['day', 'week', 'month'].map((m) =>\n          `<button data-act=\"mode\" data-v=\"${m}\" class=\"${S.mode === m ? 'on' : ''}\">${{ day: '日', week: '周', month: '月' }[m]}</button>`).join('')}</div>\n        ${S.mode === 'day' ? stripHTML() : ''}\n      </div>`;\n  }\n\n  function stripHTML() {\n    return `<div class=\"strip\" data-swipe=\"week\">${C.weekDays(S.day, ws()).map((d) => `\n      <div class=\"strip-day ${C.sameDay(d, S.day) ? 'sel' : ''} ${C.sameDay(d, new Date()) ? 'today' : ''}\"\n           data-act=\"pick\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n        <span class=\"wd\">${C.fmt.weekdayLetter(d)}</span><span class=\"num\">${d.getDate()}</span>\n        <span class=\"loadbar\" style=\"background:${heat(level(d))}\"></span></div>`).join('')}</div>`;\n  }\n\n  function viewKey() {\n    if (S.mode === 'day') return `day:${+S.day}`;\n    if (S.mode === 'week') return `week:${+C.startOfWeek(S.day, ws())}`;\n    return `month:${S.day.getFullYear()}-${S.day.getMonth()}`;\n  }\n\n  function renderMain() {\n    const main = $('#main');\n    if (!S.ready) { main.innerHTML = '<div class=\"center-msg\"><p>正在读取日历…</p></div>'; return; }\n    if (S.error) { main.innerHTML = errorHTML(); return; }\n    const key = viewKey();\n    const keep = key === S.viewKey;\n    const scrolls = {};\n    if (keep) for (const el of $$('[data-keep-scroll]', main)) scrolls[el.dataset.keepScroll] = el.scrollTop;\n    main.innerHTML = S.mode === 'day' ? dayHTML() : S.mode === 'week' ? weekHTML() : monthHTML();\n    for (const el of $$('[data-keep-scroll]', main)) {\n      if (keep && scrolls[el.dataset.keepScroll] != null) el.scrollTop = scrolls[el.dataset.keepScroll];\n    }\n    if (!keep && S.mode === 'week') {\n      const sel = $('.wday.sel', main);\n      const list = $('.week', main);\n      if (sel && list) list.scrollTop += sel.getBoundingClientRect().top - list.getBoundingClientRect().top;\n    }\n    S.viewKey = key;\n  }\n\n  function errorHTML() {\n    if (S.error === 'permission') {\n      return `<div class=\"center-msg\"><h2>需要日历权限</h2>\n        <p>「一览」通过 Scriptable 读写系统的日历与提醒事项。请到「设置 → Scriptable」打开「日历」与「提醒事项」（选择完全访问）。</p>\n        <button class=\"primary\" data-act=\"open-settings-app\">打开设置</button>\n        <button class=\"text-btn\" data-act=\"reload\">我已开启，重新读取</button></div>`;\n    }\n    return `<div class=\"center-msg\"><h2>读取失败</h2><p>${esc(S.error)}</p><button class=\"primary\" data-act=\"reload\">重试</button></div>`;\n  }\n\n  // ----- rows\n\n  function eventRowHTML(e, compact) {\n    const detail = [e.calTitle, e.location].filter(Boolean).join(' · ');\n    return `<div class=\"row ev ${compact ? 'compact' : ''}\" style=\"--c:${esc(e.color)}\" data-act=\"open-event\" data-uid=\"${esc(e.uid)}\" data-drag=\"event\">\n      <div class=\"bar\"></div>\n      <div class=\"body\"><div class=\"t\">${esc(e.title || '（无标题）')}</div>\n        ${!compact && detail ? `<div class=\"d\">${esc(detail)}</div>` : ''}</div>\n      ${e.recurring ? '<span class=\"muted\" title=\"重复日程\">↻</span>' : ''}${e.canEdit ? '' : '<span class=\"muted\" title=\"只读\">🔒</span>'}</div>`;\n  }\n\n  function taskRowHTML(t, opt) {\n    const o = opt || {};\n    const pm = prioMark(t.priority);\n    const sub = [o.overdue && t.due ? `原定 ${C.fmt.md(t.due)}` : '', t.listTitle].filter(Boolean).join(' · ');\n    return `<div class=\"row task ${t.completed ? 'done' : ''} ${o.compact ? 'compact' : ''}\" style=\"--c:${esc(t.color)}\" data-act=\"open-task\" data-task=\"${esc(t.id)}\" data-drag=\"task\">\n      <span class=\"check ${t.completed ? 'on' : ''}\" data-act=\"toggle\" data-task=\"${esc(t.id)}\">${t.completed ? '✓' : ''}</span>\n      <div class=\"body\"><div class=\"t\">${pm ? `<span class=\"prio\">${pm}</span> ` : ''}${esc(t.title || '（无标题）')}</div>\n        ${!o.compact && sub ? `<div class=\"d\" style=\"${o.overdue ? 'color:var(--red)' : ''}\">${esc(sub)}</div>` : ''}</div>\n      ${o.compact ? '' : `<button class=\"more\" data-act=\"task-menu\" data-task=\"${esc(t.id)}\" aria-label=\"更多\">⋯</button>`}</div>`;\n  }\n\n  function taskChipHTML(t) {\n    const pm = prioMark(t.priority);\n    return `<div class=\"chip\" style=\"--c:${esc(t.color)}\" data-act=\"open-task\" data-task=\"${esc(t.id)}\" data-drag=\"task\">\n      <span class=\"check\" data-act=\"toggle\" data-task=\"${esc(t.id)}\"></span>\n      ${pm ? `<span class=\"prio\">${pm}</span>` : ''}<span class=\"t\">${esc(t.title || '（无标题）')}</span></div>`;\n  }\n\n  // ----- day\n\n  function dayHTML() {\n    const a = agenda(S.day);\n    const showDone = S.settings.showCompleted;\n    let h = `<div class=\"list\" data-keep-scroll=\"day\" data-swipe=\"day\" data-drop-day=\"${+S.day}\">`;\n    if (a.overdue.length) {\n      h += `<div class=\"sec red\">逾期 ${a.overdue.length}<button class=\"pill-btn\" data-act=\"overdue-today\">全部移到今天</button></div>` +\n        a.overdue.map((t) => taskRowHTML(t, { overdue: true })).join('');\n    }\n    h += `<div class=\"sec\">日程 ${a.events.length || ''}</div>`;\n    h += a.events.length ? a.events.map((e) => eventRowHTML(e)).join('') : '<div class=\"empty\">没有日程</div>';\n    h += `<div class=\"sec\">待办 ${a.tasks.length || ''}</div>`;\n    h += a.tasks.length ? a.tasks.map((t) => taskRowHTML(t)).join('') : '<div class=\"empty\">没有待办，可以从下方待办区拖进来</div>';\n    if (showDone && a.done.length) h += `<div class=\"sec\">已完成 ${a.done.length}</div>` + a.done.map((t) => taskRowHTML(t)).join('');\n    return h + '<div class=\"list-end\"></div></div>';\n  }\n\n  // ----- week (seven days stacked)\n\n  function weekHTML() {\n    const showDone = S.settings.showCompleted;\n    return `<div class=\"week\" data-keep-scroll=\"week\" data-swipe=\"week\">${C.weekDays(S.day, ws()).map((d) => {\n      const a = agenda(d);\n      const items = a.events.map((e) => eventRowHTML(e, true)).join('') +\n        a.tasks.map((t) => taskRowHTML(t, { compact: true })).join('') +\n        (showDone ? a.done.map((t) => taskRowHTML(t, { compact: true })).join('') : '');\n      return `<section class=\"wday ${C.sameDay(d, new Date()) ? 'today' : ''} ${C.sameDay(d, S.day) ? 'sel' : ''}\" data-drop-day=\"${+d}\">\n        <div class=\"wday-head\" data-act=\"goto-day\" data-day=\"${+d}\">\n          <span class=\"wd\">${C.fmt.weekday(d)}</span><span class=\"dn\">${C.fmt.md(d)}</span>\n          <span class=\"grow\"></span><span class=\"cnt\">${a.count ? a.count + ' 项' : ''}</span>\n          <span class=\"loadbar\" style=\"background:${heat(level(d))}\"></span></div>\n        <div class=\"wday-items\">${items || '<div class=\"empty small\">—</div>'}</div></section>`;\n    }).join('')}</div>`;\n  }\n\n  // ----- month\n\n  function monthHTML() {\n    const grid = C.monthGrid(S.day, ws());\n    const cells = grid.map((d) => {\n      const a = agenda(d);\n      const lv = level(d);\n      return `<div class=\"cell ${C.sameMonth(d, S.day) ? '' : 'out'} ${C.sameDay(d, new Date()) ? 'today' : ''} ${C.sameDay(d, S.day) ? 'sel' : ''} ${lv >= 4 ? 'hot' : ''}\"\n          style=\"--a:${[0, 0.16, 0.32, 0.52, 0.78][lv]}\" data-act=\"cell\" data-day=\"${+d}\" data-drop-day=\"${+d}\">\n        <span class=\"n\">${d.getDate()}</span><span class=\"cnt\">${a.count || ''}</span>\n        ${a.overdue.length ? '<span class=\"dot-red\"></span>' : ''}</div>`;\n    }).join('');\n    const a = agenda(S.day);\n    const showDone = S.settings.showCompleted;\n    return `<div class=\"month\">\n      <div class=\"mo-wd\">${grid.slice(0, 7).map((d) => `<span>${C.fmt.weekdayLetter(d)}</span>`).join('')}</div>\n      <div class=\"mo-grid\" data-swipe=\"month\">${cells}</div>\n      <div class=\"mo-sum\"><span class=\"legend\">少${[0, 1, 2, 3, 4].map((l) => `<i style=\"background:${heat(l)}\"></i>`).join('')}多</span>\n        <span class=\"grow\">每天 ${S.settings.capacity} 项以上为最深色</span></div>\n      <div class=\"digest\" data-keep-scroll=\"digest\" data-drop-day=\"${+S.day}\">\n        <div class=\"head\"><span>${esc(C.fmt.relativeDay(S.day))}</span><button class=\"pill-btn\" data-act=\"mode\" data-v=\"day\">日视图 ›</button></div>\n        ${a.count || (showDone && a.done.length) ? '' : '<div class=\"empty\">这天没有安排</div>'}\n        ${a.events.map((e) => eventRowHTML(e, true)).join('')}\n        ${a.tasks.map((t) => taskRowHTML(t, { compact: true })).join('')}\n        ${showDone ? a.done.map((t) => taskRowHTML(t, { compact: true })).join('') : ''}\n      </div></div>`;\n  }\n\n  // ----- to-do area\n\n  function renderInbox() {\n    const el = $('#inbox');\n    if (!S.ready || S.error) { el.innerHTML = ''; return; }\n    const items = inbox();\n    const open = S.settings.inboxOpen !== false;\n    el.innerHTML = `<div class=\"inbox ${open ? '' : 'closed'}\" data-drop-inbox=\"1\">\n      <div class=\"inbox-head\" data-act=\"inbox-toggle\">\n        <span class=\"title\">待办区</span><span class=\"count\">${items.length}</span>\n        <span class=\"hint\">${items.length ? '长按拖到日期即安排' : ''}</span><span class=\"chev\">${open ? '▾' : '▴'}</span></div>\n      ${open ? `<div class=\"inbox-body\" data-keep-scroll=\"inbox\">${items.length\n        ? `<div class=\"chips\">${items.map(taskChipHTML).join('')}</div>`\n        : '<div class=\"empty small\">没有未安排的待办。在下方输入新事项，或把日历里的待办拖回这里。</div>'}</div>` : ''}\n    </div>`;\n  }\n\n  // ------------------------------------------------------------- quick add\n\n  function renderQuickAdd() {\n    $('#qa').innerHTML = `<div class=\"qa\">\n      <div class=\"preview\" id=\"qa-preview\"></div>\n      <div class=\"qa-row\">\n        <button class=\"plus\" data-act=\"new-task\" aria-label=\"新建待办\">＋</button>\n        <input id=\"qa-input\" type=\"text\" enterkeyhint=\"done\" autocomplete=\"off\" placeholder=\"新增待办，例如：明天 交报告\">\n        <button class=\"send\" data-act=\"qa-submit\" aria-label=\"新增\" disabled>↑</button>\n      </div></div>`;\n    const input = $('#qa-input');\n    input.addEventListener('input', renderPreview);\n    input.addEventListener('keydown', (e) => {\n      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitQuickAdd(); }\n    });\n  }\n\n  function parseInput() {\n    const input = $('#qa-input');\n    const text = input ? input.value.trim() : '';\n    return text ? C.parseTask(text, { now: new Date() }) : null;\n  }\n\n  function renderPreview() {\n    const pv = $('#qa-preview');\n    if (!pv) return;\n    const r = parseInput();\n    const send = $('[data-act=\"qa-submit\"]');\n    if (!r) { pv.innerHTML = ''; if (send) send.disabled = true; return; }\n    let where = '待办区';\n    if (r.day) {\n      const rel = C.fmt.relativeDay(r.day);\n      where = /日 周/.test(rel) ? rel : `${rel}（${C.fmt.md(r.day)}）`;\n    }\n    const chips = [`<span class=\"pv kind\">→ ${esc(where)}</span>`];\n    const list = byHint(r.listHint, editableLists()) || S.lists.find((l) => l.id === defaultListId());\n    if (list) chips.push(`<span class=\"pv\">🗂 ${esc(list.title)}</span>`);\n    if (r.priority) chips.push(`<span class=\"pv\">${{ 1: '高', 5: '中', 9: '低' }[r.priority]}优先</span>`);\n    if (!r.title) chips.push('<span class=\"pv muted\">请输入内容</span>');\n    pv.innerHTML = chips.join('');\n    if (send) send.disabled = !r.title;\n  }\n\n  async function submitQuickAdd() {\n    const r = parseInput();\n    if (!r || !r.title) return;\n    $('#qa-input').value = '';\n    renderPreview();\n    const list = byHint(r.listHint, editableLists());\n    const where = r.day ? C.fmt.relativeDay(r.day) : '待办区';\n    await mutate('createReminder', {\n      title: r.title, due: r.day ? +r.day : null, hasTime: false, priority: r.priority,\n      listId: list ? list.id : defaultListId(),\n    }, `已加入${where}：「${r.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));\n  }\n\n  // ------------------------------------------------------------- sheets\n\n  function openSheet(sheet) { S.sheet = sheet; renderSheet(); }\n  function closeSheet() { S.sheet = null; renderSheet(); }\n  function askConfirm(message, yesLabel, onYes) { openSheet({ type: 'confirm', message, yesLabel, onYes }); }\n\n  function renderSheet() {\n    const root = $('#sheet-root');\n    if (!S.sheet) { root.innerHTML = ''; return; }\n    const s = S.sheet;\n    let head = '', body = '';\n    if (s.type === 'event') ({ head, body } = eventEditor(s));\n    else if (s.type === 'task') ({ head, body } = taskEditor(s));\n    else if (s.type === 'settings') ({ head, body } = settingsSheet());\n    else if (s.type === 'task-menu') ({ head, body } = taskMenu(s));\n    else if (s.type === 'confirm') {\n      head = `<span class=\"spacer\"></span><h2>确认</h2><button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button>`;\n      body = `<div class=\"note big\">${esc(s.message)}</div>\n        <div class=\"form-sec\"><button class=\"danger\" data-act=\"confirm-yes\">${esc(s.yesLabel)}</button></div>`;\n    }\n    root.innerHTML = `<div class=\"backdrop\" data-act=\"sheet-bg\"><div class=\"sheet\" data-act=\"noop\">\n      <div class=\"sheet-head\">${head}</div><div class=\"sheet-body\">${body}</div></div></div>`;\n    const title = $('#sheet-root input[name=title]');\n    if (title && s.isNew) setTimeout(() => title.focus(), 50);\n  }\n\n  const sw = (name, on) => `<label class=\"switch\"><input type=\"checkbox\" name=\"${name}\" ${on ? 'checked' : ''}><span></span></label>`;\n  const opt = (v, label, sel) => `<option value=\"${esc(v)}\" ${sel ? 'selected' : ''}>${esc(label)}</option>`;\n  const quickDays = () => `<div class=\"quick\"><button data-act=\"qday\" data-v=\"0\">今天</button><button data-act=\"qday\" data-v=\"1\">明天</button>\n    <button data-act=\"qday\" data-v=\"2\">后天</button><button data-act=\"qday\" data-v=\"mon\">下周一</button></div>`;\n\n  function eventEditor(s) {\n    const ev = findEvent(s.uid);\n    const ro = !ev.canEdit;\n    const locked = ro || ev.recurring;\n    const multi = ev.allDay && ev.days.length > 1;\n    const dis = locked ? 'disabled' : '';\n    const head = `<button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button><h2>日程</h2>\n      <button class=\"text-btn strong\" data-act=\"event-save\" ${dis}>保存</button>`;\n    const cals = editableCalendars();\n    const body = `\n      <div class=\"form-sec\"><div class=\"f\"><input type=\"text\" name=\"title\" placeholder=\"标题\" value=\"${esc(ev.title)}\" ${dis}></div></div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>${multi ? '开始日期' : '日期'}</label><input type=\"date\" name=\"day\" value=\"${dateValue(ev.start)}\" ${dis}></div>\n        ${multi ? `<div class=\"f\"><label>结束日期</label><input type=\"date\" name=\"endDay\" value=\"${dateValue(new Date(ev.days[ev.days.length - 1]))}\" ${dis}></div>` : ''}\n        ${locked ? '' : `<div class=\"f\">${quickDays()}</div>`}\n      </div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>日历</label><select name=\"calendarId\" ${dis}>${ro ? opt(ev.calendarId, ev.calTitle, true) : cals.map((c) => opt(c.id, c.title, c.id === ev.calendarId)).join('')}</select></div>\n        <div class=\"f\"><input type=\"text\" name=\"location\" placeholder=\"地点\" value=\"${esc(ev.location)}\" ${dis}></div>\n        <div class=\"f\"><textarea name=\"notes\" placeholder=\"备注\" ${dis}>${esc(ev.notes)}</textarea></div>\n      </div>\n      ${ev.recurring && !ro ? `<div class=\"form-sec\"><div class=\"note\">这是重复日程。为免改到整个系列，请用系统编辑器修改（可选择“仅此次”或“所有将来的”）。</div>\n        <div class=\"f\"><button class=\"text-btn\" data-act=\"event-native\">在系统编辑器中打开</button></div></div>` : ''}\n      ${ro ? '<div class=\"form-sec\"><div class=\"note\">这个日历是只读的（例如订阅或节假日日历），不能修改。</div></div>' : ''}\n      ${locked ? '' : '<div class=\"form-sec\"><button class=\"danger\" data-act=\"event-delete\">删除日程</button></div>'}`;\n    return { head, body };\n  }\n\n  function taskEditor(s) {\n    const d = s.draft;\n    const head = `<button class=\"text-btn\" data-act=\"sheet-cancel\">取消</button><h2>${s.isNew ? '新建待办' : '待办'}</h2>\n      <button class=\"text-btn strong\" data-act=\"task-save\">保存</button>`;\n    const body = `\n      <div class=\"form-sec\"><div class=\"f\"><input type=\"text\" name=\"title\" placeholder=\"标题\" value=\"${esc(d.title)}\"></div>\n        ${s.isNew ? '' : `<div class=\"f\"><label>已完成</label>${sw('completed', d.completed)}</div>`}</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>安排</label><div class=\"segf\" id=\"where\">\n          <button data-act=\"where\" data-v=\"inbox\" class=\"${d.day ? '' : 'on'}\">待办区</button>\n          <button data-act=\"where\" data-v=\"day\" class=\"${d.day ? 'on' : ''}\">指定日期</button></div></div>\n        <div class=\"f\" data-need=\"day\" ${d.day ? '' : 'hidden'}><input type=\"date\" name=\"day\" value=\"${dateValue(d.day || S.day)}\" style=\"flex:1\"></div>\n        <div class=\"f\" data-need=\"day\" ${d.day ? '' : 'hidden'}>${quickDays()}</div>\n      </div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>优先级</label><div class=\"segf\" id=\"prio\">${[[0, '无'], [9, '低'], [5, '中'], [1, '高']].map(([v, l]) =>\n          `<button data-act=\"prio\" data-v=\"${v}\" class=\"${d.priority === v ? 'on' : ''}\">${l}</button>`).join('')}</div></div>\n        <div class=\"f\"><label>列表</label><select name=\"listId\">${editableLists().map((l) => opt(l.id, l.title, l.id === d.listId)).join('')}</select></div>\n        <div class=\"f\"><textarea name=\"notes\" placeholder=\"备注\">${esc(d.notes)}</textarea></div>\n      </div>\n      ${s.isNew ? '' : '<div class=\"form-sec\"><button class=\"danger\" data-act=\"task-delete\">删除待办</button></div>'}`;\n    return { head, body };\n  }\n\n  function taskMenu(s) {\n    const t = findTask(s.id);\n    const head = `<span class=\"spacer\"></span><h2>${esc(t ? t.title : '')}</h2><button class=\"text-btn\" data-act=\"sheet-cancel\">完成</button>`;\n    const items = [['menu-day', '0', '今天'], ['menu-day', '1', '明天'], ['menu-day', '2', '后天'], ['menu-day', 'mon', '下周一'],\n      ['menu-inbox', '', '放回待办区'], ['menu-edit', '', '编辑…']];\n    const body = `<div class=\"form-sec\">${items.map(([a, v, l]) =>\n      `<div class=\"f\"><button class=\"text-btn wide\" data-act=\"${a}\" data-v=\"${v}\">${l}</button></div>`).join('')}</div>\n      <div class=\"form-sec\"><button class=\"danger\" data-act=\"task-delete\">删除待办</button></div>`;\n    return { head, body };\n  }\n\n  function settingsSheet() {\n    const st = S.settings;\n    const head = `<span class=\"spacer\"></span><h2>设置</h2><button class=\"text-btn strong\" data-act=\"settings-save\">完成</button>`;\n    const toggles = (items) => items.map((c) => `<div class=\"f\"><span class=\"dot-sw\" style=\"--c:${esc(c.color)}\"></span><label>${esc(c.title)}</label>\n      <label class=\"switch\"><input type=\"checkbox\" data-cal=\"${esc(c.id)}\" ${st.hidden.includes(c.id) ? '' : 'checked'}><span></span></label></div>`).join('');\n    const body = `\n      <div class=\"fsec-title\">新增</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>待办写入</label><select name=\"defaultReminderListId\">${opt('', '系统默认', !st.defaultReminderListId)}${editableLists().map((l) => opt(l.id, l.title, l.id === st.defaultReminderListId)).join('')}</select></div>\n      </div>\n      <div class=\"fsec-title\">显示</div>\n      <div class=\"form-sec\">\n        <div class=\"f\"><label>每天几项算“满”</label><div class=\"stepper\"><button data-act=\"cap\" data-v=\"-1\">−</button>\n          <span class=\"mono\" id=\"cap\">${st.capacity}</span><button data-act=\"cap\" data-v=\"1\">＋</button></div></div>\n        <div class=\"f\"><label>显示已完成的待办</label>${sw('showCompleted', st.showCompleted)}</div>\n        <div class=\"f\"><label>每周从</label><div class=\"segf\" id=\"wstart\">${[[1, '周一'], [0, '周日']].map(([v, l]) =>\n          `<button data-act=\"wstart\" data-v=\"${v}\" class=\"${st.weekStart === v ? 'on' : ''}\">${l}</button>`).join('')}</div></div>\n      </div>\n      <div class=\"fsec-foot\">月视图与日期条的颜色深浅 = 当天日程与待办的件数。</div>\n      <div class=\"fsec-title\">显示的日历</div><div class=\"form-sec\">${toggles(S.calendars)}</div>\n      <div class=\"fsec-title\">显示的提醒事项列表</div><div class=\"form-sec\">${toggles(S.lists)}</div>\n      <div class=\"form-sec\"><div class=\"f\"><button class=\"text-btn\" data-act=\"self-update\">检查更新</button>\n        <span class=\"muted mono version\">${esc(S.version)}</span></div></div>\n      <div class=\"fsec-foot\">一览 · Scriptable 版 · 直接读写系统日历与提醒事项。「检查更新」会从 GitHub 下载最新版覆盖这个脚本。</div>`;\n    return { head, body };\n  }\n\n  function quickDay(v) {\n    return v === 'mon' ? C.addDays(C.startOfWeek(today(), 1), 7) : C.addDays(today(), +v);\n  }\n\n  // ------------------------------------------------------------- actions\n\n  function setDay(d, mode) {\n    S.day = C.startOfDay(d);\n    if (mode) S.mode = mode;\n    render();\n    load();\n  }\n\n  function step(dir) {\n    if (S.mode === 'day') setDay(C.addDays(S.day, dir));\n    else if (S.mode === 'week') setDay(C.addDays(S.day, 7 * dir));\n    else setDay(C.addMonths(S.day, dir));\n  }\n\n  function openTask(t) {\n    openSheet({ type: 'task', id: t.id, draft: {\n      title: t.title, notes: t.notes || '', day: t.due ? C.startOfDay(t.due) : null,\n      priority: t.priority || 0, listId: t.listId, completed: !!t.completed } });\n  }\n\n  const Actions = {\n    noop() {},\n    prev: () => step(-1),\n    next: () => step(1),\n    today: () => setDay(new Date()),\n    reload: () => { lastDataJSON = ''; refresh(); },\n    'open-settings-app': () => Bridge.call('openSettingsApp'),\n    'self-update'() { closeSheet(); toast('正在检查更新…'); mutate('selfUpdate', {}); },\n    settings: () => openSheet({ type: 'settings' }),\n    mode(el) { S.mode = el.dataset.v; render(); },\n    pick(el) { setDay(new Date(+el.dataset.day)); },\n    'goto-day'(el) { setDay(new Date(+el.dataset.day), 'day'); },\n    cell(el) { setDay(new Date(+el.dataset.day)); },\n    'inbox-toggle'() { saveSettings({ inboxOpen: S.settings.inboxOpen === false }); renderInbox(); },\n    toggle(el) { const t = findTask(el.dataset.task); if (t) toggleTask(t); },\n    'open-task'(el) { const t = findTask(el.dataset.task); if (t) openTask(t); },\n    'open-event'(el) { if (findEvent(el.dataset.uid)) openSheet({ type: 'event', uid: el.dataset.uid }); },\n    async 'overdue-today'() {\n      for (const t of agenda(today()).overdue.slice()) await scheduleTask(t, today());\n    },\n    'new-task'() {\n      openSheet({ type: 'task', isNew: true, draft: { title: '', notes: '', day: null, priority: 0, listId: defaultListId(), completed: false } });\n    },\n    'qa-submit': () => submitQuickAdd(),\n    'toast-action'() {\n      const a = S.toast && S.toast.action;\n      S.toast = null;\n      renderToast();\n      if (a) a.fn();\n    },\n    'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },\n    'sheet-cancel': () => closeSheet(),\n    'confirm-yes'() {\n      const fn = S.sheet && S.sheet.onYes;\n      closeSheet();\n      if (fn) fn();\n    },\n    qday(el) {\n      $('#sheet-root [name=day]').value = dateValue(quickDay(el.dataset.v));\n    },\n    where(el) {\n      $$('#where button').forEach((b) => b.classList.toggle('on', b === el));\n      $$('#sheet-root [data-need=day]').forEach((x) => { x.hidden = el.dataset.v !== 'day'; });\n    },\n    prio(el) { $$('#prio button').forEach((b) => b.classList.toggle('on', b === el)); },\n    async 'task-save'() {\n      const s = S.sheet;\n      const root = $('#sheet-root');\n      const onDay = $('#where .on', root).dataset.v === 'day';\n      const day = onDay ? fromDateValue($('[name=day]', root).value) : null;\n      const prio = $('#prio .on', root);\n      const done = $('[name=completed]', root);\n      const f = {\n        title: $('[name=title]', root).value.trim() || '新待办', notes: $('[name=notes]', root).value,\n        priority: prio ? +prio.dataset.v : 0, listId: $('[name=listId]', root).value,\n      };\n      closeSheet();\n      if (s.isNew) {\n        await mutate('createReminder', Object.assign(f, { due: day ? +day : null, hasTime: false }),\n          `已加入${day ? C.fmt.relativeDay(day) : '待办区'}：「${f.title}」`, (res) => res && res.id && mutate('deleteReminder', { id: res.id }));\n        return;\n      }\n      const t = findTask(s.id);\n      if (!t) return;\n      // keep a time the reminder already had when only the day changes\n      let due = day;\n      if (day && t.hasTime && t.due) due = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.due.getHours(), t.due.getMinutes());\n      await mutate('updateReminder', Object.assign(f, {\n        id: s.id, due: due ? +due : null, hasTime: !!(due && t.hasTime), completed: done ? done.checked : t.completed,\n      }));\n    },\n    'task-delete'() {\n      const id = S.sheet.id;\n      const t = findTask(id);\n      if (t) askConfirm(`删除「${t.title}」？`, '删除待办', () => mutate('deleteReminder', { id }, '已删除待办'));\n    },\n    async 'event-save'() {\n      const ev = findEvent(S.sheet.uid);\n      const root = $('#sheet-root');\n      const day = fromDateValue($('[name=day]', root).value);\n      const delta = C.daysBetween(ev.start, day);\n      const start = C.addDays(ev.start, delta);\n      let end = C.addDays(ev.end, delta);\n      const endInput = $('[name=endDay]', root);\n      if (endInput) {\n        // all-day events end at 23:59:59 of their last day\n        const last = fromDateValue(endInput.value);\n        end = new Date(+C.addDays(C.startOfDay(last < day ? day : last), 1) - 1000);\n      }\n      const payload = {\n        uid: ev.uid, title: $('[name=title]', root).value.trim() || ev.title, start: +start, end: +end,\n        calendarId: $('[name=calendarId]', root).value, location: $('[name=location]', root).value.trim(),\n        notes: $('[name=notes]', root).value,\n      };\n      closeSheet();\n      await mutate('updateEvent', payload);\n    },\n    'event-delete'() {\n      const uid = S.sheet.uid;\n      const ev = findEvent(uid);\n      if (ev) askConfirm(`删除「${ev.title}」？`, '删除日程', () => mutate('deleteEvent', { uid }, '已删除日程'));\n    },\n    'event-native'() {\n      const uid = S.sheet.uid;\n      closeSheet();\n      mutate('editNative', { uid });\n    },\n    'task-menu'(el) { openSheet({ type: 'task-menu', id: el.dataset.task }); },\n    'menu-day'(el) { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, quickDay(el.dataset.v)); },\n    'menu-inbox'() { const t = findTask(S.sheet.id); closeSheet(); if (t) scheduleTask(t, null); },\n    'menu-edit'() { const t = findTask(S.sheet.id); if (t) openTask(t); },\n    cap(el) {\n      S.settings.capacity = clamp(S.settings.capacity + +el.dataset.v, 1, 30);\n      $('#cap').textContent = S.settings.capacity;\n    },\n    wstart(el) { $$('#wstart button').forEach((b) => b.classList.toggle('on', b === el)); },\n    async 'settings-save'() {\n      const root = $('#sheet-root');\n      const st = S.settings;\n      st.defaultReminderListId = $('[name=defaultReminderListId]', root).value || null;\n      st.showCompleted = $('[name=showCompleted]', root).checked;\n      const wsBtn = $('#wstart .on', root);\n      st.weekStart = wsBtn ? +wsBtn.dataset.v : 1;\n      st.hidden = $$('[data-cal]', root).filter((c) => !c.checked).map((c) => c.dataset.cal);\n      closeSheet();\n      S.range = null;\n      lastDataJSON = '';\n      await saveSettings({});\n      await load(true);\n    },\n  };\n\n  let suppressClickUntil = 0;\n  document.addEventListener('click', (e) => {\n    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }\n    const el = e.target.closest('[data-act]');\n    if (!el) return;\n    const fn = Actions[el.dataset.act];\n    if (fn) fn(el, e);\n  }, true);\n\n  // ------------------------------------------------------------- gestures\n  // Long-press an item, then drag it onto a day (date strip, week section,\n  // month cell, day list) or onto the to-do area. Horizontal swipes page.\n\n  const Gest = { pending: null, active: null, swipe: null };\n\n  function dropTarget(x, y) {\n    const under = document.elementFromPoint(x, y);\n    if (!under) return null;\n    const inboxEl = under.closest('[data-drop-inbox]');\n    if (inboxEl) return { el: inboxEl, inbox: true };\n    const dayEl = under.closest('[data-drop-day]');\n    if (dayEl) return { el: dayEl, day: new Date(+dayEl.dataset.dropDay) };\n    return null;\n  }\n\n  function dragItem(p) {\n    const isEvent = p.kind === 'event';\n    const item = isEvent ? findEvent(p.el.dataset.uid) : findTask(p.el.dataset.task);\n    if (!item) return null;\n    if (isEvent && (!item.canEdit || item.recurring)) {\n      toast(item.recurring ? '重复日程不能直接拖动：点开后用系统编辑器修改' : '这个日历是只读的，不能移动');\n      return null;\n    }\n    const ghost = document.createElement('div');\n    ghost.className = 'floating';\n    document.body.appendChild(ghost);\n    p.el.classList.add('lifted');\n    const st = { x: p.x, y: p.y, target: null, hot: null };\n    const update = () => {\n      ghost.style.left = st.x + 'px';\n      ghost.style.top = st.y + 'px';\n      const t = dropTarget(st.x, st.y);\n      st.target = t;\n      let label = item.title || '（无标题）';\n      if (t && t.inbox) label += isEvent ? ' ✕ 日程不能放进待办区' : ' → 待办区';\n      else if (t) label += ` → ${C.fmt.relativeDay(t.day)}`;\n      ghost.textContent = label;\n      const hot = t ? t.el : null;\n      if (hot !== st.hot) {\n        if (st.hot) st.hot.classList.remove('drop-hot');\n        if (hot) hot.classList.add('drop-hot');\n        st.hot = hot;\n      }\n    };\n    const cleanup = () => {\n      ghost.remove();\n      p.el.classList.remove('lifted');\n      if (st.hot) st.hot.classList.remove('drop-hot');\n    };\n    const handler = {\n      move(x, y) { st.x = x; st.y = y; update(); },\n      end() {\n        cleanup();\n        const t = st.target;\n        if (!t) return;\n        if (t.inbox) {\n          if (isEvent) toast('日程需要日期，不能放进待办区');\n          else if (item.due) scheduleTask(item, null);\n          return;\n        }\n        if (isEvent) moveEventToDay(item, t.day);\n        else if (!item.due || !C.sameDay(item.due, t.day)) scheduleTask(item, t.day);\n      },\n      cancel() { cleanup(); },\n    };\n    st.handler = handler;\n    update();\n    autoScroll(st);\n    return handler;\n  }\n\n  /** Scrolls the list under the finger when it rests near the list's top or bottom edge. */\n  function autoScroll(st) {\n    const tick = () => {\n      if (Gest.active !== st.handler) return;\n      const under = document.elementFromPoint(st.x, st.y);\n      const scroller = under && under.closest('[data-keep-scroll]');\n      if (scroller) {\n        const r = scroller.getBoundingClientRect();\n        let dy = 0;\n        if (st.y < r.top + 36) dy = -Math.ceil((r.top + 36 - st.y) / 5);\n        else if (st.y > r.bottom - 36) dy = Math.ceil((st.y - (r.bottom - 36)) / 5);\n        if (dy) { scroller.scrollTop += dy; st.handler.move(st.x, st.y); }\n      }\n      requestAnimationFrame(tick);\n    };\n    requestAnimationFrame(tick);\n  }\n\n  function activate() {\n    const p = Gest.pending;\n    Gest.pending = null;\n    if (!p) return;\n    const h = dragItem(p);\n    if (h) {\n      Gest.active = h;\n      suppressClickUntil = Date.now() + 100000;\n    } else {\n      suppressClickUntil = Date.now() + 500;\n    }\n  }\n\n  function begin(target, x, y) {\n    const swipeEl = target.closest('[data-swipe]');\n    Gest.swipe = swipeEl ? { x0: x, y0: y, kind: swipeEl.dataset.swipe } : null;\n    const el = target.closest('[data-drag]');\n    if (!el || el.closest('.sheet')) return;\n    Gest.pending = { el, kind: el.dataset.drag, x0: x, y0: y, x, y, timer: setTimeout(activate, 380) };\n  }\n\n  function moveTo(x, y, e) {\n    const p = Gest.pending;\n    if (p) {\n      p.x = x; p.y = y;\n      if (Math.hypot(x - p.x0, y - p.y0) > 10) { clearTimeout(p.timer); Gest.pending = null; }\n      return;\n    }\n    if (Gest.active) {\n      if (e && e.cancelable) e.preventDefault();\n      Gest.active.move(x, y);\n    }\n  }\n\n  function finish(x, y, e) {\n    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }\n    if (Gest.active) {\n      if (e && e.cancelable) e.preventDefault();\n      const a = Gest.active;\n      Gest.active = null;\n      suppressClickUntil = Date.now() + 300;\n      a.end();\n      return;\n    }\n    const s = Gest.swipe;\n    Gest.swipe = null;\n    if (s && x != null) {\n      const dx = x - s.x0, dy = y - s.y0;\n      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {\n        suppressClickUntil = Date.now() + 300;\n        const dir = dx < 0 ? 1 : -1;\n        if (s.kind === 'month') setDay(C.addMonths(S.day, dir));\n        else if (s.kind === 'week') setDay(C.addDays(S.day, 7 * dir));\n        else setDay(C.addDays(S.day, dir));\n      }\n    }\n  }\n\n  function cancelGesture() {\n    if (Gest.pending) { clearTimeout(Gest.pending.timer); Gest.pending = null; }\n    if (Gest.active) { const a = Gest.active; Gest.active = null; a.cancel(); suppressClickUntil = Date.now() + 300; }\n    Gest.swipe = null;\n  }\n\n  let lastTouch = 0;\n  document.addEventListener('touchstart', (e) => {\n    lastTouch = Date.now();\n    if (e.touches.length !== 1) { cancelGesture(); return; }\n    if (Gest.active) return;\n    const t = e.touches[0];\n    begin(e.target, t.clientX, t.clientY);\n  }, { passive: false });\n  document.addEventListener('touchmove', (e) => {\n    const t = e.touches[0];\n    if (t) moveTo(t.clientX, t.clientY, e);\n  }, { passive: false });\n  document.addEventListener('touchend', (e) => {\n    lastTouch = Date.now();\n    const t = e.changedTouches[0];\n    finish(t ? t.clientX : null, t ? t.clientY : null, e);\n  }, { passive: false });\n  document.addEventListener('touchcancel', cancelGesture);\n\n  // Mouse fallback for the desktop preview (ignores the mouse events iOS emulates after a touch)\n  let mouseDown = false;\n  document.addEventListener('mousedown', (e) => {\n    if (e.button !== 0 || Date.now() - lastTouch < 1000) return;\n    mouseDown = true;\n    begin(e.target, e.clientX, e.clientY);\n  });\n  document.addEventListener('mousemove', (e) => { if (mouseDown) moveTo(e.clientX, e.clientY, e); });\n  document.addEventListener('mouseup', (e) => {\n    if (!mouseDown) return;\n    mouseDown = false;\n    finish(e.clientX, e.clientY, e);\n  });\n\n  // ------------------------------------------------------------- startup\n\n  function fitViewport() {\n    const vv = window.visualViewport;\n    document.documentElement.style.setProperty('--vh', (vv ? vv.height : window.innerHeight) + 'px');\n    if (vv && vv.offsetTop) window.scrollTo(0, 0);\n  }\n\n  let shownDay = +today();\n  function start() {\n    renderQuickAdd();\n    render();\n    fitViewport();\n    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);\n    window.addEventListener('resize', fitViewport);\n    load(true);\n    // Pick up changes made elsewhere (system Calendar, Reminders, other devices)\n    setInterval(() => {\n      if (+today() !== shownDay) { shownDay = +today(); agendaCache.clear(); render(); }\n      if (!document.hidden && !Gest.active && !S.sheet && !S.loading) refresh();\n    }, 30e3);\n    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });\n  }\n\n  window.OneGlance = { state: S, refresh, render, agenda };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);\n  else start();\n})();\n\n</script>\n</body>\n</html>\n";
const VERSION = 'cf59c20a';
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
