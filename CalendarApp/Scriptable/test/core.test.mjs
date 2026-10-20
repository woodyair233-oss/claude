// Port of Packages/GlanceCore/Tests (Swift) for the JavaScript core.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

// core.js is a plain browser/Scriptable script that sets globalThis.GlanceCore
await import('../src/core.js');
const C = globalThis.GlanceCore;

const date = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const NOW = date(2026, 10, 16, 9, 0); // Friday
const parse = (text, opts = {}) => C.parseQuickAdd(text, { now: NOW, defaultDay: NOW, defaultEventMinutes: 60, ...opts });
const same = (a, b) => assert.equal(a && a.getTime(), b && b.getTime(), `${a} vs ${b}`);

test('tomorrow afternoon with duration', () => {
  const r = parse('明天下午3点 开会 1小时');
  assert.equal(r.kind, 'event');
  assert.equal(r.title, '开会');
  same(r.start, date(2026, 10, 17, 15));
  same(r.end, date(2026, 10, 17, 16));
  assert.equal(r.durationMinutes, 60);
});

test('colon range', () => {
  const r = parse('周五 10:30-12:00 门诊');
  assert.equal(r.kind, 'event');
  assert.equal(r.title, '门诊');
  same(r.start, date(2026, 10, 16, 10, 30));
  same(r.end, date(2026, 10, 16, 12));
});

test('overnight range', () => {
  const r = parse('下周一 20:00-08:00 夜班支援');
  same(r.start, date(2026, 10, 19, 20));
  same(r.end, date(2026, 10, 20, 8));
  const r2 = parse('22:00-6:00 急诊');
  same(r2.start, date(2026, 10, 16, 22));
  same(r2.end, date(2026, 10, 17, 6));
});

test('chinese range inherits afternoon', () => {
  let r = parse('下午3点到5点 写病历');
  same(r.start, date(2026, 10, 16, 15)); same(r.end, date(2026, 10, 16, 17));
  r = parse('3点-5点 讨论');
  same(r.start, date(2026, 10, 16, 15)); same(r.end, date(2026, 10, 16, 17));
  r = parse('11点-1点 午会');
  same(r.start, date(2026, 10, 16, 11)); same(r.end, date(2026, 10, 16, 13));
});

test('morning range is not shifted', () => {
  const r = parse('6:00-14:00 早班');
  same(r.start, date(2026, 10, 16, 6)); same(r.end, date(2026, 10, 16, 14));
});

test('english am/pm', () => {
  const r = parse('3-5pm review');
  same(r.start, date(2026, 10, 16, 15)); same(r.end, date(2026, 10, 16, 17));
  const r2 = parse('tomorrow 9:30am standup 15m');
  same(r2.start, date(2026, 10, 17, 9, 30)); same(r2.end, date(2026, 10, 17, 9, 45));
  assert.equal(r2.title, 'standup');
});

test('half and quarter', () => {
  same(parse('8点半 查房').start, date(2026, 10, 16, 8, 30));
  same(parse('晚上七点一刻 跑步').start, date(2026, 10, 16, 19, 15));
  same(parse('十点三刻 电话').start, date(2026, 10, 16, 10, 45));
  same(parse('下午2点15分 会诊').start, date(2026, 10, 16, 14, 15));
});

test('bare hour guesses afternoon', () => {
  same(parse('3点开会').start, date(2026, 10, 16, 15));
  same(parse('9点开会').start, date(2026, 10, 16, 9));
  same(parse('06:30 起床').start, date(2026, 10, 16, 6, 30));
  same(parse('明早6点 起床').start, date(2026, 10, 17, 6));
  same(parse('今晚8点 看书').start, date(2026, 10, 16, 20));
});

test('reminder without time', () => {
  const r = parse('买药');
  assert.equal(r.kind, 'reminder');
  assert.equal(r.title, '买药');
  same(r.day, date(2026, 10, 16));
  assert.equal(r.start, null);
  assert.equal(r.hasExplicitDate, false);
});

test('reminder prefix keeps time', () => {
  const r = parse('待办：明天下午3点 交报告 !!');
  assert.equal(r.kind, 'reminder');
  assert.equal(r.title, '交报告');
  same(r.start, date(2026, 10, 17, 15));
  assert.equal(r.end, null);
  assert.equal(r.priority, 5);
});

test('duration only is a task estimate', () => {
  const r = parse('写论文 2小时');
  assert.equal(r.kind, 'reminder');
  assert.equal(r.durationMinutes, 120);
  assert.equal(r.title, '写论文');
  assert.equal(parse('复习 一个半小时').durationMinutes, 90);
  assert.equal(parse('复习 半小时').durationMinutes, 30);
  assert.equal(parse('复习 1.5h').durationMinutes, 90);
  assert.equal(parse('复习 1小时30分钟').durationMinutes, 90);
  assert.equal(parse('复习 45分钟').durationMinutes, 45);
});

test('calendar hint and priority', () => {
  const r = parse('周三 9点 组会 #工作 !!!');
  assert.equal(r.calendarHint, '工作');
  assert.equal(r.priority, 1);
  assert.equal(r.title, '组会');
  same(r.start, date(2026, 10, 21, 9));
});

test('weekdays', () => {
  same(parse('周五 a').day, date(2026, 10, 16));
  same(parse('周一 a').day, date(2026, 10, 19));
  same(parse('下周三 a').day, date(2026, 10, 21));
  same(parse('本周三 a').day, date(2026, 10, 14));
  same(parse('下下周一 a').day, date(2026, 10, 26));
  same(parse('星期天 a').day, date(2026, 10, 18));
  same(parse('礼拜六 a').day, date(2026, 10, 17));
  same(parse('next mon a').day, date(2026, 10, 19));
  same(parse('wednesday a').day, date(2026, 10, 21));
});

test('absolute dates', () => {
  same(parse('10月20日 体检').day, date(2026, 10, 20));
  same(parse('十月二十号 体检').day, date(2026, 10, 20));
  same(parse('1/5 年假').day, date(2027, 1, 5));
  same(parse('2026-12-24 平安夜').day, date(2026, 12, 24));
  same(parse('20号 交房租').day, date(2026, 10, 20));
  same(parse('3号 交房租').day, date(2026, 11, 3));
  same(parse('后天 a').day, date(2026, 10, 18));
  same(parse('大后天 a').day, date(2026, 10, 19));
  same(parse('3天后 复诊').day, date(2026, 10, 19));
});

test('bed numbers are not dates', () => {
  const r = parse('查12号床 病人');
  assert.equal(r.hasExplicitDate, false);
  assert.equal(r.title, '查12号床 病人');
});

test('一点 is not a time', () => {
  const r = parse('早一点到');
  assert.equal(r.start, null);
  assert.equal(r.kind, 'reminder');
});

test('all day', () => {
  const r = parse('明天 全天 学术会议');
  assert.equal(r.kind, 'allDayEvent');
  same(r.start, date(2026, 10, 17)); same(r.end, date(2026, 10, 18));
  assert.equal(r.title, '学术会议');
});

test('shift by name', () => {
  const r = parse('周六 夜班', { shiftNames: ['白班', '夜班'] });
  assert.equal(r.kind, 'shift');
  assert.equal(r.shiftName, '夜班');
  same(r.day, date(2026, 10, 17));
  assert.equal(parse('周六 8点 夜班', { shiftNames: ['夜班'] }).kind, 'event');
});

test('overrides', () => {
  assert.equal(parse('3点 交报告', { override: 'reminder' }).kind, 'reminder');
  assert.equal(parse('体检', { override: 'event' }).kind, 'allDayEvent');
});

test('midnight evening', () => {
  same(parse('晚上12点 发药').start, date(2026, 10, 17, 0));
});

test('chinese numbers', () => {
  assert.equal(C.chineseNumber('十'), 10);
  assert.equal(C.chineseNumber('十二'), 12);
  assert.equal(C.chineseNumber('二十三'), 23);
  assert.equal(C.chineseNumber('两'), 2);
  assert.equal(C.chineseNumber('零'), 0);
  assert.equal(C.chineseNumber('个'), null);
});

// ---------------------------------------------------------------- layout

test('non-overlapping items use full width', () => {
  const s = C.layoutTimeline([{ id: 'a', start: 60, end: 120 }, { id: 'b', start: 120, end: 180 }]);
  assert.deepEqual(s.a, { column: 0, columnCount: 1, span: 1 });
  assert.deepEqual(s.b, { column: 0, columnCount: 1, span: 1 });
});

test('overlap splits columns', () => {
  const s = C.layoutTimeline([{ id: 'a', start: 60, end: 180 }, { id: 'b', start: 90, end: 120 }, { id: 'c', start: 130, end: 170 }]);
  assert.equal(s.a.column, 0); assert.equal(s.b.column, 1); assert.equal(s.c.column, 1);
  assert.equal(s.a.columnCount, 2);
});

test('span expands into free columns', () => {
  const s = C.layoutTimeline([
    { id: 'a', start: 0, end: 60 }, { id: 'b', start: 0, end: 30 },
    { id: 'c', start: 0, end: 30 }, { id: 'd', start: 40, end: 60 },
  ]);
  assert.equal(s.a.columnCount, 3);
  assert.equal(s.d.column, 1);
  assert.equal(s.d.span, 2);
});

test('tiny items get minimum height for overlap', () => {
  const s = C.layoutTimeline([{ id: 'a', start: 0, end: 5 }, { id: 'b', start: 10, end: 15 }], 20);
  assert.equal(s.a.columnCount, 2);
});

test('busy minutes merge overlaps', () => {
  assert.equal(C.busyMinutes([{ start: 60, end: 120 }, { start: 90, end: 150 }, { start: 300, end: 360 }]), 150);
  assert.equal(C.busyMinutes([{ start: -60, end: 30 }, { start: 1400, end: 1600 }]), 70);
  assert.equal(C.loadLevel(0, 480), 0);
  assert.equal(C.loadLevel(60, 480), 1);
  assert.equal(C.loadLevel(480, 480), 4);
});

test('free gaps', () => {
  const g = C.freeGaps([{ start: 480, end: 540 }, { start: 600, end: 660 }, { start: 650, end: 700 }, { start: 705, end: 720 }], 15);
  assert.deepEqual(g, [{ start: 540, end: 600 }]);
});

// ---------------------------------------------------------------- shifts & dates

test('night shift crosses midnight', () => {
  const [day, night, , off] = C.shifts.defaults();
  const i = C.shifts.interval(night, date(2026, 10, 16));
  same(i.start, date(2026, 10, 16, 20)); same(i.end, date(2026, 10, 17, 8));
  assert.equal(C.shifts.timeText(night), '20:00–次日08:00');
  assert.equal(C.shifts.timeText(day), '08:00–17:00');
  assert.equal(C.shifts.timeText(off), '全天');
});

test('rest before shifts', () => {
  const rest = C.shifts.restBefore([
    { start: date(2026, 10, 1, 20), end: date(2026, 10, 2, 8), isAllDay: false },
    { start: date(2026, 10, 2), end: date(2026, 10, 3), isAllDay: true },
    { start: date(2026, 10, 2, 16), end: date(2026, 10, 2, 23), isAllDay: false },
  ]);
  assert.deepEqual(rest, [null, null, 8]);
});

test('shift summary', () => {
  const [day, , , off] = C.shifts.defaults();
  const list = [
    { templateId: day.id, start: date(2026, 10, 1, 8), end: date(2026, 10, 1, 17), isAllDay: false },
    { templateId: day.id, start: date(2026, 10, 2, 8), end: date(2026, 10, 2, 17), isAllDay: false },
    { templateId: off.id, start: date(2026, 10, 3), end: date(2026, 10, 4), isAllDay: true },
    { templateId: day.id, start: date(2026, 11, 1, 8), end: date(2026, 11, 1, 17), isAllDay: false },
  ];
  const s = C.shifts.summary(list, date(2026, 10, 1), date(2026, 11, 1));
  assert.equal(s.counts[day.id], 2);
  assert.equal(s.counts[off.id], 1);
  assert.equal(s.minutes, 18 * 60);
});

test('day math', () => {
  const fri = date(2026, 10, 16, 15, 30);
  assert.equal(C.minuteOfDay(fri, fri), 930);
  assert.equal(C.minuteOfDay(date(2026, 10, 17, 2), fri), 1440 + 120);
  same(C.dateOnDay(fri, 1500), date(2026, 10, 17, 1));
  same(C.weekDays(fri, 1)[0], date(2026, 10, 12));
  same(C.monthGrid(fri, 1)[0], date(2026, 9, 28));
  assert.equal(C.monthGrid(fri, 1).length, 42);
  same(C.weekDays(fri, 0)[0], date(2026, 10, 11));
  assert.equal(C.isoWeekday(fri), 5);
  assert.equal(C.snap(52, 15), 45);
  assert.equal(C.snap(53, 15), 60);
  assert.equal(C.fmt.duration(90), '1小时30分');
  assert.equal(C.fmt.range(date(2026, 10, 16, 20), date(2026, 10, 17, 8)), '20:00–次日08:00');
  assert.equal(C.fmt.mdw(fri), '10月16日 周五');
});
