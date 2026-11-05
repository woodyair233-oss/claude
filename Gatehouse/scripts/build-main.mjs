// Bundles the Electron main and preload processes with esbuild.
// `ssh2` stays external: it carries optional native addons that must be
// resolved at runtime (it falls back to pure JS when they are absent).
import { build, context } from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist/main', { recursive: true, force: true });
rmSync('dist/preload', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'linked',
  external: ['electron', 'ssh2'],
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.GATEHOUSE_BUILD': JSON.stringify(new Date().toISOString()) },
};

const configs = [
  { ...common, entryPoints: { index: 'src/main/index.ts' }, outdir: 'dist/main' },
  { ...common, entryPoints: { index: 'src/preload/index.ts' }, outdir: 'dist/preload' },
];

if (watch) {
  for (const cfg of configs) (await context(cfg)).watch();
} else {
  await Promise.all(configs.map((cfg) => build(cfg)));
}
