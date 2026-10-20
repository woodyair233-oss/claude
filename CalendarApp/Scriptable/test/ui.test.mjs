// Drives dist/preview.html (real UI + mock data) in Chromium with real touch
// events, at iPhone size, with the clock fixed to Friday 2026-10-16 09:30.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const URL = new globalThis.URL('../dist/preview.html?today=2026-10-16T09:30:00', import.meta.url).href;
const NOW = '2026-10-16T09:30:00';
let browser, ctx, page, cdp;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

beforeEach(async () => {
  ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'Asia/Tokyo', locale: 'zh-CN',
  });
  await ctx.addInitScript((now) => {
    const D = Date;
    const offset = new D(now).getTime() - D.now();
    class FixedDate extends D {
      constructor(...a) { if (a.length) super(...a); else super(D.now() + offset); }
      static now() { return D.now() + offset; }
    }
    globalThis.Date = FixedDate;
  }, NOW);
  page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  cdp = await ctx.newCDPSession(page);
  await page.goto(URL);
  await page.waitForSelector('.list .row');
});

afterEach(async () => {
  assert.deepEqual(page.errors, [], 'page errors');
  await ctx.close();
});

// ------------------------------------------------------------------ helpers

const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
const wait = (ms) => page.waitForTimeout(ms);

async function longPressDrag(from, to, { hold = 550, steps = 12 } = {}) {
  await touch('touchStart', [from]);
  await wait(hold);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
    await wait(16);
  }
  await touch('touchEnd', []);
  await wait(350); // the app ignores taps for a moment after a drag
}

async function swipe(from, to) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 }]);
  await touch('touchEnd', []);
  await wait(150);
}

const events = () => page.evaluate(() => window.__MOCK__.events());
const reminders = () => page.evaluate(() => window.__MOCK__.reminders());
const task = async (title) => (await reminders()).find((x) => x.title === title);
const local = (ms) => (ms == null ? null : new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16));
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const box = async (locator) => {
  await locator.first().scrollIntoViewIfNeeded();
  return locator.first().boundingBox();
};
const stripDay = (i) => box(page.locator('.strip-day').nth(i)); // Monday = 0

// ------------------------------------------------------------------ tests

test('day view lists everything for the day without clock times', async () => {
  assert.match(await page.textContent('#hdr h1'), /10月16日 周五/);
  const list = await page.textContent('.list');
  for (const t of ['续开处方', '晨会', '门诊', '文献阅读', '回复会诊意见', '交病历', '查看化验结果']) assert.match(list, new RegExp(t));
  assert.doesNotMatch(list, /\d{1,2}:\d{2}/, 'no clock times');
  assert.match(await page.textContent('.inbox'), /待办区\s*4/);
});

test('an overnight event is listed only on the day it starts', async () => {
  await page.click('[data-act=next]');
  assert.match(await page.textContent('.list'), /夜间值班/);
  await page.click('[data-act=next]');
  assert.doesNotMatch(await page.textContent('.list'), /夜间值班/);
});

test('a multi-day all-day event shows on each day', async () => {
  for (let i = 0; i < 3; i++) await page.click('[data-act=next]');
  assert.match(await page.textContent('.list'), /学术会议/);
  await page.click('[data-act=next]');
  assert.match(await page.textContent('.list'), /学术会议/);
});

test('quick add without a date goes to the to-do area, with a date onto that day', async () => {
  await page.fill('#qa-input', '写随访总结 #工作 !!');
  assert.match(await page.textContent('#qa-preview'), /待办区.*工作待办.*中优先/);
  await page.press('#qa-input', 'Enter');
  await page.waitForSelector('.toast');
  let r = await task('写随访总结');
  assert.equal(r.due, null);
  assert.equal(r.listId, 'list-work');
  assert.equal(r.priority, 5);
  assert.ok(await page.locator('.inbox .chip', { hasText: '写随访总结' }).count());

  await page.fill('#qa-input', '明天 交报告');
  assert.match(await page.textContent('#qa-preview'), /明天（10月17日）/);
  await page.press('#qa-input', 'Enter');
  await wait(100);
  r = await task('交报告');
  assert.equal(local(r.due), '2026-10-17 00:00');
  assert.equal(r.hasTime, false);
});

test('undo removes a quick-added task', async () => {
  await page.fill('#qa-input', '买药');
  await page.press('#qa-input', 'Enter');
  await page.click('[data-act=toast-action]');
  await wait(100);
  assert.equal(await task('买药'), undefined);
});

test('drag a task from the to-do area onto a day in the date strip', async () => {
  const chip = await box(page.locator('.inbox .chip', { hasText: '买牛奶' }));
  await longPressDrag(center(chip), center(await stripDay(5)), { steps: 15 });
  const r = await task('买牛奶');
  assert.equal(local(r.due), '2026-10-17 00:00');
  assert.equal(await page.locator('.inbox .chip', { hasText: '买牛奶' }).count(), 0);
});

test('drag a task from the to-do area onto the day list', async () => {
  const chip = await box(page.locator('.inbox .chip', { hasText: '更新简历' }));
  const list = await box(page.locator('.list'));
  await longPressDrag(center(chip), { x: list.x + 200, y: list.y + 120 }, { steps: 15 });
  assert.equal(local((await task('更新简历')).due), '2026-10-16 00:00');
  assert.ok(await page.locator('.list .row', { hasText: '更新简历' }).count());
});

test('drag a scheduled task back to the to-do area', async () => {
  const row = await box(page.locator('.list .row', { hasText: '交病历' }));
  const inbox = await box(page.locator('.inbox'));
  await longPressDrag({ x: row.x + 120, y: row.y + 20 }, { x: inbox.x + 200, y: inbox.y + 20 });
  assert.equal((await task('交病历')).due, null);
  assert.ok(await page.locator('.inbox .chip', { hasText: '交病历' }).count());
});

test('drag an event to another day keeps its time of day', async () => {
  const row = await box(page.locator('.list .row', { hasText: '文献阅读' }));
  await longPressDrag({ x: row.x + 120, y: row.y + 20 }, center(await stripDay(6)));
  const ev = (await events()).find((e) => e.title === '文献阅读');
  assert.equal(local(ev.start), '2026-10-18 15:00');
  assert.equal(local(ev.end), '2026-10-18 16:30');
});

test('events cannot go into the to-do area', async () => {
  const row = await box(page.locator('.list .row', { hasText: '晨会' }));
  const inbox = await box(page.locator('.inbox'));
  await longPressDrag({ x: row.x + 120, y: row.y + 20 }, { x: inbox.x + 200, y: inbox.y + 20 });
  assert.match(await page.textContent('.toast'), /日程需要日期/);
  assert.equal(local((await events()).find((e) => e.title === '晨会').start), '2026-10-16 08:00');
});

test('recurring events are not dragged', async () => {
  await page.click('[data-act=mode][data-v=week]');
  await page.click('[data-act=prev]');
  await page.click('[data-act=next]');
  const row = await box(page.locator('.wday .row', { hasText: '科室例会' }));
  await longPressDrag({ x: row.x + 100, y: row.y + 10 }, { x: row.x + 100, y: row.y + 200 });
  assert.match(await page.textContent('.toast'), /重复日程/);
  assert.ok((await events()).filter((e) => e.title === '科室例会').every((e) => /07:30$/.test(local(e.start))));
});

test('week view: seven days stacked, drag a task to another day', async () => {
  await page.click('[data-act=mode][data-v=week]');
  assert.equal(await page.locator('.wday').count(), 7);
  const row = await box(page.locator('.wday .row', { hasText: '回复会诊意见' }));
  const sat = await box(page.locator('.wday').nth(5).locator('.wday-head'));
  await longPressDrag({ x: row.x + 120, y: row.y + 10 }, center(sat));
  assert.equal(local((await task('回复会诊意见')).due), '2026-10-17 00:00');
  assert.match(await page.locator('.wday').nth(5).textContent(), /回复会诊意见/);
});

test('month view: counts per day and dropping onto a cell', async () => {
  await page.click('[data-act=mode][data-v=month]');
  const cell = page.locator('.cell:not(.out)', { has: page.locator('.n', { hasText: /^22$/ }) });
  const chip = await box(page.locator('.inbox .chip', { hasText: '预约体检' }));
  await longPressDrag(center(chip), center(await box(cell)), { steps: 15 });
  assert.equal(local((await task('预约体检')).due), '2026-10-22 00:00');
  assert.match(await cell.locator('.cnt').textContent(), /1/);
  const today = page.locator('.cell.today');
  assert.match(await today.locator('.cnt').textContent(), /5/);
});

test('swipe the day list to the next day and the strip to the next week', async () => {
  const list = await box(page.locator('.list'));
  await swipe({ x: list.x + 320, y: list.y + 200 }, { x: list.x + 40, y: list.y + 205 });
  assert.match(await page.textContent('#hdr h1'), /10月17日/);
  const s = await box(page.locator('.strip'));
  await swipe({ x: s.x + 300, y: s.y + 30 }, { x: s.x + 40, y: s.y + 35 });
  assert.match(await page.textContent('#hdr h1'), /10月24日/);
});

test('tick a task and move overdue tasks to today', async () => {
  await page.locator('.list .row', { hasText: '交病历' }).locator('.check').click();
  await wait(100);
  assert.equal((await task('交病历')).completed, true);
  await page.click('[data-act=overdue-today]');
  await wait(150);
  assert.equal(local((await task('续开处方')).due), '2026-10-16 00:00');
  assert.equal(await page.locator('.sec.red').count(), 0);
});

test('task menu: tomorrow, then back to the to-do area', async () => {
  await page.locator('.list .row', { hasText: '回复会诊意见' }).locator('[data-act=task-menu]').click();
  await page.click('[data-act=menu-day][data-v="1"]');
  await wait(100);
  assert.equal(local((await task('回复会诊意见')).due), '2026-10-17 00:00');
  await page.click('[data-act=next]');
  await page.locator('.list .row', { hasText: '回复会诊意见' }).locator('[data-act=task-menu]').click();
  await page.click('[data-act=menu-inbox]');
  await wait(100);
  assert.equal((await task('回复会诊意见')).due, null);
});

test('task editor: schedule an inbox task with a quick day', async () => {
  await page.locator('.inbox .chip', { hasText: '准备病例讨论' }).locator('.t').click();
  await page.click('[data-act=where][data-v=day]');
  await page.click('[data-act=qday][data-v=mon]');
  await page.click('[data-act=task-save]');
  await wait(100);
  assert.equal(local((await task('准备病例讨论 PPT')).due), '2026-10-19 00:00');
});

test('new task from + goes to the to-do area by default', async () => {
  await page.click('[data-act=new-task]');
  await page.fill('.sheet [name=title]', '复印资料');
  await page.click('[data-act=task-save]');
  await wait(100);
  assert.equal((await task('复印资料')).due, null);
});

test('event editor moves the date and deletes after confirming', async () => {
  await page.locator('.list .row', { hasText: '门诊' }).click();
  assert.equal(await page.inputValue('.sheet [name=day]'), '2026-10-16');
  await page.click('[data-act=qday][data-v="1"]');
  await page.click('[data-act=event-save]');
  await wait(100);
  const ev = (await events()).find((e) => e.title === '门诊');
  assert.equal(local(ev.start), '2026-10-17 09:00');
  await page.click('[data-act=next]');
  await page.locator('.list .row', { hasText: '门诊' }).click();
  await page.click('[data-act=event-delete]');
  await page.click('[data-act=confirm-yes]');
  await wait(100);
  assert.ok(!(await events()).some((e) => e.title === '门诊'));
});

test('read-only events cannot be edited', async () => {
  for (let i = 0; i < 5; i++) await page.click('[data-act=next]');
  await page.locator('.list .row', { hasText: '纪念日' }).click();
  assert.ok(await page.locator('[data-act=event-save][disabled]').count());
  assert.match(await page.textContent('.sheet'), /只读/);
});

test('settings: capacity, hidden calendar, collapse the to-do area', async () => {
  await page.click('[data-act=settings]');
  await page.locator('.f', { hasText: '个人' }).locator('.switch').click();
  await page.locator('[data-act=cap][data-v="1"]').click();
  await page.click('[data-act=settings-save]');
  await wait(150);
  const settings = await page.evaluate(() => window.__MOCK__.handle('load', {}).then((d) => d.settings));
  assert.equal(settings.capacity, 7);
  assert.deepEqual(settings.hidden, ['cal-home']);
  assert.equal(await page.locator('.list .row', { hasText: '文献阅读' }).count(), 0);
  await page.click('.inbox-head');
  await wait(100);
  assert.equal(await page.locator('.inbox-body').count(), 0);
});
