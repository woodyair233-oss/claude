process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';

// core.js is a plain browser/Scriptable script that sets globalThis.GlanceCore
await import('../src/core.js');
const C = globalThis.GlanceCore;

const date = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const NOW = date(2026, 10, 16, 9, 0); // Friday
const parse = (text) => C.parseTask(text, { now: NOW });
const same = (a, b) => assert.equal(a && a.getTime(), b && b.getTime(), `${a} vs ${b}`);

test('a task without a date goes to the to-do area', () => {
  const r = parse('买药');
  assert.equal(r.title, '买药');
  assert.equal(r.day, null);
  assert.equal(r.priority, 0);
});

test('relative days', () => {
  same(parse('明天 交报告').day, date(2026, 10, 17));
  same(parse('后天 a').day, date(2026, 10, 18));
  same(parse('大后天 a').day, date(2026, 10, 19));
  same(parse('今天 a').day, date(2026, 10, 16));
  same(parse('今晚 看书').day, date(2026, 10, 16));
  same(parse('3天后 复诊').day, date(2026, 10, 19));
  same(parse('tomorrow call').day, date(2026, 10, 17));
  assert.equal(parse('明天 交报告').title, '交报告');
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
});

test('bed numbers are not dates', () => {
  const r = parse('查12号床 病人');
  assert.equal(r.day, null);
  assert.equal(r.title, '查12号床 病人');
});

test('clock times are left in the title', () => {
  const r = parse('明天下午3点 开会');
  same(r.day, date(2026, 10, 17));
  assert.equal(r.title, '下午3点 开会');
});

test('list hint, priority and prefix', () => {
  const r = parse('待办：周三 组会 #工作 !!!');
  assert.equal(r.title, '组会');
  assert.equal(r.listHint, '工作');
  assert.equal(r.priority, 1);
  same(r.day, date(2026, 10, 21));
  assert.equal(parse('写总结 !!').priority, 5);
  assert.equal(parse('写总结 !').priority, 9);
});

test('chinese numbers', () => {
  assert.equal(C.chineseNumber('十'), 10);
  assert.equal(C.chineseNumber('十二'), 12);
  assert.equal(C.chineseNumber('二十三'), 23);
  assert.equal(C.chineseNumber('两'), 2);
  assert.equal(C.chineseNumber('个'), null);
});

test('event days: timed events on their start day, all-day events on each day', () => {
  const night = C.eventDays(date(2026, 10, 16, 20), date(2026, 10, 17, 8), false);
  assert.deepEqual(night.map(Number), [+date(2026, 10, 16)]);
  const conf = C.eventDays(date(2026, 10, 16), date(2026, 10, 18, 23, 59, 59), true);
  assert.deepEqual(conf.map(Number), [+date(2026, 10, 16), +date(2026, 10, 17), +date(2026, 10, 18)]);
  const one = C.eventDays(date(2026, 10, 16), date(2026, 10, 17), true);
  assert.deepEqual(one.map(Number), [+date(2026, 10, 16)]);
});

test('load level by item count', () => {
  assert.equal(C.loadLevel(0, 6), 0);
  assert.equal(C.loadLevel(1, 6), 1);
  assert.equal(C.loadLevel(2, 6), 2);
  assert.equal(C.loadLevel(4, 6), 3);
  assert.equal(C.loadLevel(6, 6), 4);
  assert.equal(C.loadLevel(9, 6), 4);
});

test('day math and text', () => {
  const fri = date(2026, 10, 16, 15, 30);
  same(C.weekDays(fri, 1)[0], date(2026, 10, 12));
  same(C.weekDays(fri, 0)[0], date(2026, 10, 11));
  same(C.monthGrid(fri, 1)[0], date(2026, 9, 28));
  assert.equal(C.monthGrid(fri, 1).length, 42);
  same(C.addDays(fri, 2), date(2026, 10, 18, 15, 30));
  assert.equal(C.daysBetween(fri, date(2026, 10, 18, 1)), 2);
  assert.equal(C.fmt.mdw(fri), '10月16日 周五');
  assert.equal(C.fmt.relativeDay(date(2026, 10, 17), fri), '明天');
  assert.equal(C.fmt.relativeDay(date(2026, 10, 20), fri), '10月20日 周二');
});
