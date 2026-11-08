// Every user-visible English string must have a Simplified Chinese entry.
// English is the key; a missing entry silently falls back to English in the
// Chinese UI, so this test scans the renderer for strings passed to t() — both
// literal keys and the values of the label maps that are translated
// dynamically (MODE_META, REASON_LABEL, …).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ZH } from '../../src/renderer/lib/zh';

const RENDERER = join(import.meta.dirname, '../../src/renderer');
// Shared modules that hold user-visible text the renderer translates.
const SHARED_TEXT = [join(import.meta.dirname, '../../src/shared/conn-text.ts')];

// Values that are intentionally shown as-is in every language.
const UNTRANSLATED = new Set(['CSV', 'JSON', 'Ed25519', 'RSA 4096', 'ECDSA', 'English']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(f) && !p.endsWith('zh.ts') ? [p] : [];
  });
}

/** Evaluates the body of a single-quoted JS string literal exactly as the runtime would. */
function literal(body: string): string {
  return new Function(`return '${body}';`)() as string;
}

function collect(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of [...sourceFiles(RENDERER), ...SHARED_TEXT]) {
    const code = readFileSync(file, 'utf8');
    const where = relative(RENDERER, file);
    for (const m of code.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) found.set(literal(m[1]), where);
    // label/desc/short/... values inside constant maps that are passed through t() at the use site
    for (const m of code.matchAll(/\b(?:label|desc|short)\s*:\s*'((?:[^'\\]|\\.)*)'/g)) {
      const s = literal(m[1]);
      if (/^[A-Z]/.test(s) && /[A-Za-z]{2}/.test(s)) found.set(s, `${where} (map)`);
    }
    // Record<…, string> maps such as REASON_LABEL / CAUSE_TEXT / TOOL_LABEL
    for (const block of code.matchAll(/const ([A-Z_]+)\s*:\s*Record<[^>]+,\s*string>\s*=\s*\{([\s\S]*?)\n\};/g)) {
      for (const m of block[2].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) {
        const s = literal(m[1]);
        if (!/^#[0-9a-f]{3,8}$/i.test(s)) found.set(s, `${where} (${block[1]})`);
      }
    }
  }
  return found;
}

describe('Chinese language pack', () => {
  const strings = collect();

  it('scans a meaningful number of UI strings', () => {
    expect(strings.size).toBeGreaterThan(600);
  });

  it('has a translation for every UI string', () => {
    const missing = [...strings].filter(([s]) => !UNTRANSLATED.has(s) && !(s in ZH)).map(([s, where]) => `${where}: ${JSON.stringify(s)}`);
    expect(missing).toEqual([]);
  });

  it('keeps {placeholders} intact in translations', () => {
    const broken = Object.entries(ZH).filter(([en, zh]) => {
      const want = (en.match(/\{\w+\}/g) ?? []).sort().join();
      const got = (zh.match(/\{\w+\}/g) ?? []).sort().join();
      return want !== got;
    });
    expect(broken.map(([en]) => en)).toEqual([]);
  });
});
