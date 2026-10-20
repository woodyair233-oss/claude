// Bundles the sources into
//   dist/一览.js      – the single Scriptable script to copy to iCloud Drive/Scriptable
//   dist/preview.html – the same UI with sample data, for a desktop browser and the UI tests
// Usage: node build.mjs [--check]   (--check fails if dist/ is out of date)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');
const core = src('core.js');
const app = src('app.js');
const css = src('app.css');
const mock = src('mock.js');

for (const [name, text] of Object.entries({ core, app, css, mock })) {
  if (/<\/script/i.test(text)) throw new Error(`${name} contains "</script", which would end the inline script early`);
}

const page = (extraScript) => `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>一览</title>
<style>
${css}
</style>
</head>
<body>
<div id="app"><header id="hdr"></header><main id="main"></main><section id="inbox"></section><footer id="qa"></footer></div>
<div id="sheet-root"></div>
<script>
${core}
</script>
${extraScript ? `<script>\n${extraScript}\n</script>\n` : ''}<script>
${app}
</script>
</body>
</html>
`;

const html = page('');
const runtimeSource = src('scriptable.js');
// The version is a content hash, so rebuilding unchanged sources gives the same file
const version = createHash('sha256').update(core + runtimeSource + html).digest('hex').slice(0, 8);
const header = `// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: calendar-alt;
// 一览 · 日历与任务排程（Scriptable 版）。由 CalendarApp/Scriptable/build.mjs 生成，请勿手动修改。
// @version ${version}
`;
const runtime = runtimeSource.replace('__APP_HTML__', () => JSON.stringify(html)).replace('__VERSION__', version);
const script = `${header}\n${core}\n${runtime}`;

// Syntax check: Scriptable runs scripts with top-level await, so parse as an async function body
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction(script);

const outputs = {
  'dist/一览.js': script,
  'dist/preview.html': page(mock),
};

if (process.argv.includes('--check')) {
  const stale = Object.entries(outputs).filter(([f, text]) => !existsSync(join(root, f)) || readFileSync(join(root, f), 'utf8') !== text);
  if (stale.length) {
    console.error(`Out of date: ${stale.map(([f]) => f).join(', ')}. Run: node CalendarApp/Scriptable/build.mjs`);
    process.exit(1);
  }
  console.log('dist/ is up to date');
} else {
  mkdirSync(join(root, 'dist'), { recursive: true });
  for (const [f, text] of Object.entries(outputs)) writeFileSync(join(root, f), text);
  console.log(`Wrote dist/一览.js (${(script.length / 1024).toFixed(0)} KB) and dist/preview.html`);
}
