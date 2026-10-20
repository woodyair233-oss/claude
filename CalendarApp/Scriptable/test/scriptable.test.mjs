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
  const block = async (title) => {
    const el = page.locator('.blk', { hasText: title }).first();
    await el.evaluate((node) => {
      const s = node.closest('.grid-scroll');
      s.scrollTop += node.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 3;
    });
    return el.boundingBox();
  };
  const close = async () => {
    env.closeWebView();
    await run;
    await ctx.close();
    assert.deepEqual(errors, [], 'page errors');
    assert.deepEqual(store.errors || [], [], 'script errors');
  };
  return { page, store, env, seeded, drag, block, close, run };
}

test('full-screen app reads and writes EventKit through the bridge', async () => {
  const app = await openApp();
  const { page, store } = app;
  await page.waitForSelector('.blk');
  assert.ok(await page.locator('.blk', { hasText: '门诊' }).count());

  // Drag 门诊 one hour later
  const b = await app.block('门诊');
  await app.drag({ x: b.x + 40, y: b.y + 15 }, { x: b.x + 40, y: b.y + 71 });
  const clinic = store.events.find((e) => e.identifier === 'E-clinic');
  assert.equal(clinic.startDate.getHours(), 10);
  assert.equal(clinic.endDate.getHours(), 13);

  // Tick a task
  await page.locator('.chip', { hasText: '回复会诊意见' }).locator('.check').click();
  await page.waitForTimeout(200);
  assert.equal(store.reminders.find((r) => r.identifier === 'R-1').isCompleted, true);

  // Quick add an event and a task
  await page.fill('#qa-input', '明天下午3点 开会 1小时');
  await page.press('#qa-input', 'Enter');
  await page.waitForTimeout(300);
  const meeting = store.events.find((e) => e.title === '开会');
  assert.ok(meeting, 'event created');
  assert.equal(meeting.startDate.getHours(), 15);
  assert.equal(meeting.calendar.identifier, 'C-work');
  await page.fill('#qa-input', '待办 准备讲稿 2小时');
  await page.press('#qa-input', 'Enter');
  await page.waitForTimeout(300);
  const talk = store.reminders.find((r) => r.title === '准备讲稿');
  assert.ok(talk, 'reminder created');
  assert.equal(talk.dueDate.getDate(), today().getDate());

  // The duration estimate is kept in the settings file
  const saved = JSON.parse(store.files.get('/docs/oneglance/settings.json'));
  assert.equal(saved.taskDurations[talk.identifier], 120);

  // Timed tasks get a Scriptable notification
  assert.ok(store.pending.some((n) => n.identifier.startsWith('oneglance-task-R-2-') && n.title === '交病历'));

  // Settings round trip
  await page.click('[data-act=settings]');
  await page.locator('[data-act=step][data-name=capacityHours][data-v="1"]').click();
  await page.click('[data-act=settings-save]');
  await page.waitForTimeout(300);
  assert.equal(JSON.parse(store.files.get('/docs/oneglance/settings.json')).capacityHours, 9);

  await app.close();
  assert.equal(store.completed, true);
});

test('a series found only by the native check goes to the system editor', async () => {
  const app = await openApp();
  const { page, store } = app;
  await page.waitForSelector('.blk');
  const b = await app.block('年度体检');
  await app.drag({ x: b.x + 30, y: b.y + 12 }, { x: b.x + 30, y: b.y + 68 });
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /重复日程/);
  assert.ok(store.events.filter((e) => e.identifier === 'E-yearly').every((e) => e.startDate.getHours() === 14), 'series untouched');
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
  await page.waitForSelector('.blk');
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
  await page.waitForSelector('.blk');
  await page.click('[data-act=next]');
  await page.locator('.chip', { hasText: '纪念日' }).click();
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

test('widget shows the shift, upcoming events and tasks', async () => {
  const store = createStore();
  const env = makeGlobals(store, { config: { runsInApp: false, runsInWidget: true, widgetFamily: 'medium' } });
  const { work } = seed(store, env, today());
  const soon = new Date(Date.now() + 3600e3);
  const shiftStart = new Date(today().getTime() + 8 * 3600e3);
  store.events.push(Object.assign(new env.globals.CalendarEvent(), { identifier: 'E-soon', title: '病例讨论', startDate: soon, endDate: new Date(soon.getTime() + 1800e3), calendar: work }));
  store.events.push(Object.assign(new env.globals.CalendarEvent(), { identifier: 'E-shift', title: '白班', startDate: shiftStart, endDate: new Date(shiftStart.getTime() + 9 * 3600e3), calendar: work }));
  await runScript(SCRIPT, env.globals);
  const texts = store.widget.texts().join(' | ');
  assert.match(texts, /白班/);
  assert.match(texts, /病例讨论/);
  assert.match(texts, /回复会诊意见/);
  assert.equal(store.completed, true);
});

test('Shortcuts / Siri quick add creates items without the UI', async () => {
  const store = createStore();
  const env = makeGlobals(store, { args: { shortcutParameter: '明天下午3点 开会 1小时' } });
  seed(store, env, today());
  await runScript(SCRIPT, env.globals);
  const ev = store.events.find((e) => e.title === '开会');
  assert.ok(ev);
  assert.equal(ev.startDate.getHours(), 15);
  assert.match(store.shortcutOutput, /已新增日程「开会」/);

  const store2 = createStore();
  const env2 = makeGlobals(store2, { args: { shortcutParameter: '周六 夜班' } });
  seed(store2, env2, today());
  await runScript(SCRIPT, env2.globals);
  const night = store2.events.find((e) => e.title === '夜班');
  assert.ok(night);
  assert.equal(night.startDate.getHours(), 20);
  assert.equal(night.startDate.getDay(), 6);
  assert.match(store2.shortcutOutput, /已排夜班/);
});
