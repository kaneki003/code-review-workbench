import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';

const watch = process.argv.includes('--watch');
if (!watch) await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
const host = {
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  external: ['vscode', ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
};
const bundles = [
  { ...host, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' },
  { ...host, entryPoints: ['src/connections/readiness-worker.ts'], outfile: 'dist/readiness-worker.cjs' },
  { bundle: true, platform: 'browser', target: 'chrome150', format: 'iife', minify: !watch,
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    entryPoints: ['src/webviews/main.tsx'], outfile: 'dist/readiness.js' },
];
if (watch) {
  for (const options of bundles) await (await context(options)).watch();
} else {
  await Promise.all(bundles.map(options => build(options)));
}
const css = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
  'exec', 'tailwindcss', '-i', 'src/webviews/styles.css', '-o', 'dist/readiness.css',
  watch ? '--watch' : '--minify',
], { stdio: 'inherit', shell: process.platform === 'win32' });
css.on('error', error => { console.error(error); process.exitCode = 1; });
css.on('exit', code => { if (code) process.exitCode = code; });
