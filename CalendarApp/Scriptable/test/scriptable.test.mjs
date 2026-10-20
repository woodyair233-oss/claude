// Runs the bundled dist/一览.js against a fake Scriptable runtime whose WebView
// is a real Chromium page, so the bridge, the handlers and the UI are tested together.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createStore, makeGlobals, runScript, seed } from './fake-scriptable.mjs';

const SCRIPT = fileURLToPath(new URL('../dist/一览.js', import.meta.url));
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
let browser;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function openApp(setup) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  const store = createStore();
  const env = makeGlobals(store, { page });
  const seeded = seed(store, env, today());
  if (setup) setup(store, env, seeded);
  const run = runScript(SCRIPT, env.globals);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const drag = async (from, to) => {
    await touch('touchStart', [from]);
    await page.waitForTimeout(550);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 }]);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
  };
  const row = async (title) => {
    const el = page.locator('.row', { hasText: title }).first();
    await el.scrollIntoViewIfNeeded();
    return el.boundingBox();
  };
  /** A date-strip day next to today that is in the same week (tomorrow, or yesterday on the last day). */
  const neighbour = async () => page.evaluate(() => {
    const days = [...document.querySelectorAll('.strip-day')];
    const i = days.findIndex((d) => d.classList.contains('sel'));
    const j = i < days.length - 1 ? i + 1 : i - 1;
    const r = days[j].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, delta: j - i };
  });
  const close = async () => {
    env.closeWebView();
    await run;
    await ctx.close();
    assert.deepEqual(errors, [], 'page errors');
    assert.deepEqual(store.errors || [], [], 'script errors');
  };
  return { page, store, env, seeded, drag, row, neighbour, close, run };
}

test('full-screen app reads and writes EventKit through the bridge', async () => {
  const app = await openApp();
  const { page, store } = app;
  await page.waitForSelector('.list .row');
  assert.doesNotMatch(await page.textContent('.list'), /\d{1,2}:\d{2}/, 'no clock times');
  assert.match(await page.textContent('.inbox'), /买牛奶/);

  // Drag 门诊 to the neighbouring day: same time of day, different date
  const r = await app.row('门诊');
  const target = await app.neighbour();
  await app.drag({ x: r.x + 120, y: r.y + 20 }, target);
  const clinic = store.events.find((e) => e.identifier === 'E-clinic');
  assert.equal(clinic.startDate.getDate(), new Date(today().getTime() + target.delta * 864e5).getDate());
  assert.equal(clinic.startDate.getHours(), 9);
  assert.equal(clinic.endDate.getHours(), 12);

  // Drag 买牛奶 from the to-do area onto today's list
  const chip = await page.locator('.inbox .chip', { hasText: '买牛奶' }).boundingBox();
  const list = await page.locator('.list').boundingBox();
  await app.drag({ x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 }, { x: list.x + 200, y: list.y + 60 });
  const milk = store.reminders.find((x) => x.identifier === 'R-3');
  assert.equal(milk.dueDate.getTime(), today().getTime());
  assert.equal(milk.dueDateIncludesTime, false);

  // Tick a task
  await page.locator('.row', { hasText: '回复会诊意见' }).locator('.check').click();
  await page.waitForTimeout(200);
  assert.equal(store.reminders.find((x) => x.identifier === 'R-1').isCompleted, true);

  // Quick add: with a date onto that day, without a date into the to-do area
  await page.fill('#qa-input', '明天 开会');
  await page.press('#qa-input', 'Enter');
  await page.waitForTimeout(300);
  const meeting = store.reminders.find((x) => x.title === '开会');
  assert.ok(meeting, 'reminder created');
  assert.equal(meeting.dueDate.getTime(), today().getTime() + 864e5);
  await page.fill('#qa-input', '准备讲稿');
  await page.press('#qa-input', 'Enter');
  await page.waitForTimeout(300);
  assert.equal(store.reminders.find((x) => x.title === '准备讲稿').dueDate, null);
  assert.ok(await page.locator('.inbox .chip', { hasText: '准备讲稿' }).count());

  // Settings round trip
  await page.click('[data-act=settings]');
  await page.locator('[data-act=cap][data-v="1"]').click();
  await page.click('[data-act=settings-save]');
  await page.waitForTimeout(300);
  assert.equal(JSON.parse(store.files.get('/docs/oneglance/settings.json')).capacity, 7);

  await app.close();
  assert.equal(store.completed, true);
});

test('a series found only by the native check goes to the system editor', async () => {
  const app = await openApp();
  const { page, store } = app;
  await page.waitForSelector('.list .row');
  const r = await app.row('年度体检');
  await app.drag({ x: r.x + 120, y: r.y + 20 }, await app.neighbour());
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /重复日程/);
  const series = store.events.filter((e) => e.identifier === 'E-yearly');
  assert.equal(series[0].startDate.getTime(), app.seeded.at(0, 14).getTime(), 'series untouched');
  await page.click('[data-act=toast-action]');
  await page.waitForTimeout(300);
  assert.deepEqual(store.nativeEdits, ['E-yearly']);
  await app.close();
});

test('检查更新 replaces the script with the latest build', async () => {
  const app = await openApp((store) => {
    store.remote = '// icon-glyph: calendar-alt;\n// @version 1234abcd\nGlanceCore';
  });
  const { page, store } = app;
  await page.waitForSelector('.list .row');
  await page.click('[data-act=settings]');
  await page.click('[data-act=self-update]');
  await page.waitForFunction(() => /已更新到 1234abcd/.test(document.querySelector('.toast')?.textContent || ''));
  assert.match(store.requests[0], /raw\.githubusercontent\.com\/woodyair233-oss\/claude\/.*%E4%B8%80%E8%A7%88\.js$/);
  assert.equal(store.files.get('/docs/一览.js'), store.remote);
  await app.close();
});

test('read-only calendars cannot be edited', async () => {
  const app = await openApp();
  const { page } = app;
  await page.waitForSelector('.list .row');
  await page.click('[data-act=next]');
  await page.locator('.row', { hasText: '纪念日' }).click();
  await page.waitForSelector('.sheet');
  assert.ok(await page.locator('[data-act=event-save][disabled]').count());
  assert.match(await page.textContent('.sheet'), /只读/);
  await app.close();
});

test('without calendar access the app explains how to grant it', async () => {
  const app = await openApp((store) => { store.granted = false; });
  const { page, store } = app;
  await page.waitForSelector('.center-msg h2');
  assert.match(await page.textContent('.center-msg'), /需要日历权限/);
  await page.click('[data-act=open-settings-app]');
  await page.waitForTimeout(200);
  assert.deepEqual(store.opened, ['app-settings:']);
  await app.close();
});

test('widget lists today without clock times', async () => {
  const store = createStore();
  const env = makeGlobals(store, { config: { runsInApp: false, runsInWidget: true, widgetFamily: 'medium' } });
  seed(store, env, today());
  await runScript(SCRIPT, env.globals);
  const texts = store.widget.texts().join(' | ');
  assert.match(texts, /门诊/);
  assert.match(texts, /年度体检/);
  assert.match(texts, /回复会诊意见/);
  assert.match(texts, /待办区 1/);
  assert.doesNotMatch(texts, /\d{1,2}:\d{2}/);
  assert.equal(store.completed, true);
});

test('Shortcuts / Siri quick add creates tasks without the UI', async () => {
  const store = createStore();
  const env = makeGlobals(store, { args: { shortcutParameter: '明天 开会' } });
  seed(store, env, today());
  await runScript(SCRIPT, env.globals);
  const r = store.reminders.find((x) => x.title === '开会');
  assert.ok(r);
  assert.equal(r.dueDate.getTime(), today().getTime() + 864e5);
  assert.match(store.shortcutOutput, /已加入明天：「开会」/);

  const store2 = createStore();
  const env2 = makeGlobals(store2, { args: { shortcutParameter: '买药' } });
  seed(store2, env2, today());
  await runScript(SCRIPT, env2.globals);
  assert.equal(store2.reminders.find((x) => x.title === '买药').dueDate, null);
  assert.match(store2.shortcutOutput, /已加入待办区/);
});
