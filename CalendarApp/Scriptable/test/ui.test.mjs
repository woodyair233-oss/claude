// Drives dist/preview.html (real UI + mock data) in Chromium with real touch
// events, at iPhone size, with the clock fixed to Friday 2026-10-16 09:30.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
  await page.waitForSelector('.grid .blk');
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

const mock = (fn) => page.evaluate(fn);
const events = () => mock(() => window.__MOCK__.events());
const reminders = () => mock(() => window.__MOCK__.reminders());
const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16);

/** Box of a grid block, scrolled to the middle of the grid. */
async function blockBox(title) {
  const el = page.locator('.blk', { hasText: title }).first();
  await el.evaluate((node) => {
    const scroll = node.closest('.grid-scroll');
    scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3;
  });
  return el.boundingBox();
}

/** Screen point for a time on the day/week grid (scrolls it into view). */
async function gridPoint(hour, column = 0) {
  return page.evaluate(([h, col]) => {
    const scroll = document.querySelector('.grid-scroll');
    const grid = scroll.firstElementChild;
    const hh = parseFloat(getComputedStyle(grid).getPropertyValue('--hh'));
    const gutter = parseFloat(getComputedStyle(grid).getPropertyValue('--gutter'));
    const n = scroll.dataset.days.split(',').length;
    scroll.scrollTop = Math.max(0, (h - 2) * hh);
    const r = grid.getBoundingClientRect();
    const colW = (r.width - gutter) / n;
    return { x: r.left + gutter + colW * (col + 0.5), y: r.top + h * hh + 2 };
  }, [hour, column]);
}

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// ------------------------------------------------------------------ tests

test('day view shows today with tray, grid and now line', async () => {
  assert.match(await page.textContent('#hdr h1'), /10月16日 周五/);
  assert.ok(await page.locator('.blk', { hasText: '门诊' }).count());
  assert.ok(await page.locator('.chip', { hasText: '续开处方' }).count(), 'overdue task in tray');
  assert.ok(await page.locator('.now').count());
});

test('long-press drag moves an event by one hour', async () => {
  const b = await blockBox('门诊');
  await longPressDrag({ x: b.x + 40, y: b.y + 15 }, { x: b.x + 40, y: b.y + 15 + 56 });
  const ev = (await events()).find((e) => e.title === '门诊');
  assert.equal(local(ev.start), '2026-10-16 10:00');
  assert.equal(local(ev.end), '2026-10-16 13:00');
  assert.ok(await page.locator('.blk', { hasText: '10:00–13:00' }).count());
});

test('dragging the bottom edge resizes an event', async () => {
  const b = await blockBox('文献阅读');
  const edge = { x: b.x + b.width / 2, y: b.y + b.height - 5 };
  await longPressDrag(edge, { x: edge.x, y: edge.y + 28 });
  const ev = (await events()).find((e) => e.title === '文献阅读');
  assert.equal(local(ev.end), '2026-10-16 17:00');
});

test('quick taps scroll instead of dragging', async () => {
  const b = await blockBox('门诊');
  await swipe({ x: b.x + 40, y: b.y + 80 }, { x: b.x + 40, y: b.y - 60 });
  const ev = (await events()).find((e) => e.title === '门诊');
  assert.equal(local(ev.start), '2026-10-16 09:00');
});

test('long-press on empty time creates an event there', async () => {
  const p = await gridPoint(13);
  await longPressDrag(p, { x: p.x, y: p.y + 56 });
  await page.waitForSelector('.sheet input[name=title]');
  assert.equal(await page.inputValue('[name=st]'), '13:00');
  assert.equal(await page.inputValue('[name=et]'), '14:00');
  await page.fill('[name=title]', '病例讨论');
  await page.click('[data-act=event-save]');
  await wait(100);
  const ev = (await events()).find((e) => e.title === '病例讨论');
  assert.ok(ev);
  assert.equal(local(ev.start), '2026-10-16 13:00');
  assert.equal(ev.calendarId, 'cal-work');
});

test('double-tap on empty time opens a one-hour event', async () => {
  const p = await gridPoint(14);
  await page.mouse.click(p.x, p.y + 10);
  await page.mouse.click(p.x, p.y + 10);
  await page.waitForSelector('.sheet input[name=title]');
  assert.equal(await page.inputValue('[name=st]'), '14:00');
  assert.equal(await page.inputValue('[name=et]'), '15:00');
});

test('tap an event to edit it', async () => {
  await page.locator('.blk', { hasText: '晨会' }).click();
  await page.waitForSelector('.sheet');
  assert.equal(await page.inputValue('[name=title]'), '晨会');
  await page.fill('[name=title]', '晨会（改）');
  await page.click('[data-act=event-save]');
  await wait(100);
  assert.ok((await events()).some((e) => e.title === '晨会（改）'));
});

test('drag a task from the inbox onto the timeline', async () => {
  await page.click('[data-act=inbox]');
  const chip = await page.locator('.inbox .chip', { hasText: '买牛奶' }).boundingBox();
  const target = await gridPoint(14);
  // gridPoint scrolled the grid; the chip stays in place in the tray
  await longPressDrag(center(chip), target, { steps: 15 });
  const r = (await reminders()).find((x) => x.title === '买牛奶');
  assert.equal(local(r.due), '2026-10-16 14:00');
  assert.equal(r.hasTime, true);
  assert.ok(await page.locator('.blk.task', { hasText: '买牛奶' }).count());
});

test('drag a task onto another day in the week strip', async () => {
  const chip = await page.locator('.tray .chip', { hasText: '回复会诊意见' }).boundingBox();
  const sat = await page.locator('.strip-day').nth(5).boundingBox();
  await longPressDrag(center(chip), center(sat));
  const r = (await reminders()).find((x) => x.title === '回复会诊意见');
  assert.equal(local(r.due), '2026-10-17 00:00');
  assert.equal(r.hasTime, false);
});

test('tick a task as done', async () => {
  await page.locator('.chip', { hasText: '续开处方' }).locator('.check').click();
  await wait(100);
  assert.equal((await reminders()).find((x) => x.title === '续开处方').completed, true);
});

test('quick add an event, then undo', async () => {
  await page.fill('#qa-input', '明天下午3点 开会 1小时');
  assert.match(await page.textContent('#qa-preview'), /日程.*明天.*15:00–16:00/);
  await page.press('#qa-input', 'Enter');
  await page.waitForSelector('.toast');
  const ev = (await events()).find((e) => e.title === '开会');
  assert.equal(local(ev.start), '2026-10-17 15:00');
  assert.equal(local(ev.end), '2026-10-17 16:00');
  await page.click('[data-act=toast-action]');
  await wait(100);
  assert.ok(!(await events()).some((e) => e.title === '开会'));
});

test('quick add a task with priority and the kind toggle', async () => {
  await page.fill('#qa-input', '3点 写总结');
  assert.match(await page.textContent('.pv.kind'), /日程/);
  await page.click('.pv.kind');
  assert.match(await page.textContent('.pv.kind'), /待办/);
  await page.press('#qa-input', 'Enter');
  await wait(100);
  const r = (await reminders()).find((x) => x.title === '写总结');
  assert.equal(local(r.due), '2026-10-16 15:00');
  assert.equal(r.hasTime, true);
  await page.fill('#qa-input', '待办 买药 !!');
  await page.press('#qa-input', 'Enter');
  await wait(100);
  assert.equal((await reminders()).find((x) => x.title === '买药').priority, 5);
});

test('shift brush paints and removes a night shift', async () => {
  await page.click('[data-act=mode][data-v=month]');
  await page.click('[data-act=brush-toggle]');
  await page.locator('[data-act=brush]', { hasText: '夜班' }).click();
  const cell = page.locator('.cell:not(.out)', { has: page.locator('.n', { hasText: /^22$/ }) });
  await cell.click();
  await wait(100);
  let night = (await events()).filter((e) => e.title === '夜班' && local(e.start).startsWith('2026-10-22'));
  assert.equal(night.length, 1);
  assert.equal(local(night[0].end), '2026-10-23 08:00');
  assert.ok(await cell.locator('.badge').count());
  await cell.click();
  await wait(100);
  night = (await events()).filter((e) => e.title === '夜班' && local(e.start).startsWith('2026-10-22'));
  assert.equal(night.length, 0);
});

test('short rest between shifts is flagged in the month view', async () => {
  await page.click('[data-act=mode][data-v=month]');
  const cell = page.locator('.cell:not(.out)', { has: page.locator('.n', { hasText: /^20$/ }) });
  assert.ok(await cell.locator('.warn').count());
  assert.match(await page.textContent('.mo-sum'), /夜班 1/);
});

test('recurring events are not dragged', async () => {
  await page.click('[data-act=prev]'); // Thursday
  for (let i = 0; i < 3; i++) await page.click('[data-act=prev]'); // Monday
  const b = await blockBox('科室例会');
  await longPressDrag({ x: b.x + 30, y: b.y + 10 }, { x: b.x + 30, y: b.y + 70 });
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /重复日程/);
  const ev = (await events()).filter((e) => e.title === '科室例会');
  assert.ok(ev.every((e) => local(e.start).endsWith('07:30')));
});

test('week view drags an event to the next day', async () => {
  await page.click('[data-act=mode][data-v=week]');
  const b = await blockBox('晨会');
  const colW = (390 - 30) / 7;
  await longPressDrag({ x: b.x + 10, y: b.y + 8 }, { x: b.x + 10 + colW, y: b.y + 8 });
  const ev = (await events()).find((e) => e.title === '晨会');
  assert.equal(local(ev.start), '2026-10-17 08:00');
});

test('swipe the week strip to the next week', async () => {
  const s = await page.locator('.strip').boundingBox();
  await swipe({ x: s.x + 300, y: s.y + 30 }, { x: s.x + 40, y: s.y + 35 });
  assert.match(await page.textContent('#hdr h1'), /10月23日/);
});

test('pinch zooms the day timeline', async () => {
  const p = await gridPoint(12);
  await touch('touchStart', [{ x: p.x, y: p.y - 40, id: 1 }, { x: p.x, y: p.y + 40, id: 2 }]);
  for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: p.x, y: p.y - 40 - i * 8, id: 1 }, { x: p.x, y: p.y + 40 + i * 8, id: 2 }]);
  await touch('touchEnd', []);
  await wait(150);
  const hh = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.grid')).getPropertyValue('--hh')));
  assert.ok(hh > 80, `hour height ${hh}`);
});

test('list style: postpone a task from its menu', async () => {
  await page.click('[data-act=style]');
  await page.locator('.row', { hasText: '交病历' }).locator('[data-act=task-menu]').click();
  await page.click('[data-act=menu-postpone]');
  await wait(100);
  assert.equal(local((await reminders()).find((x) => x.title === '交病历').due), '2026-10-17 17:00');
  assert.match(await page.textContent('.list'), /空闲/);
});

test('delete an event after confirming', async () => {
  await page.locator('.blk', { hasText: '电话会诊' }).click();
  await page.click('[data-act=event-delete]');
  await page.click('[data-act=confirm-yes]');
  await wait(100);
  assert.ok(!(await events()).some((e) => e.title === '电话会诊'));
});

test('settings hide a calendar and change capacity', async () => {
  await page.click('[data-act=settings]');
  await page.locator('.f', { hasText: '个人' }).locator('.switch').click();
  await page.locator('[data-act=step][data-name=capacityHours][data-v="1"]').click();
  await page.click('[data-act=settings-save]');
  await wait(150);
  const settings = await mock(() => window.__MOCK__.handle('load', {}).then((d) => d.settings));
  assert.equal(settings.capacityHours, 9);
  assert.deepEqual(settings.hidden, ['cal-home']);
  assert.equal(await page.locator('.blk', { hasText: '文献阅读' }).count(), 0);
});

test('task editor schedules a time and duration', async () => {
  await page.locator('.chip', { hasText: '回复会诊意见' }).locator('.t').click();
  await page.waitForSelector('.sheet [name=hasTime]', { state: 'attached' });
  await page.locator('.f', { hasText: '时间' }).locator('.switch').click();
  await page.fill('[name=dt]', '16:15');
  await page.selectOption('[name=duration]', '60');
  await page.click('[data-act=task-save]');
  await wait(100);
  const r = (await reminders()).find((x) => x.title === '回复会诊意见');
  assert.equal(local(r.due), '2026-10-16 16:15');
  const b = await blockBox('回复会诊意见');
  assert.ok(b.height > 50, 'one hour tall');
});
