import { build, context } from 'esbuild';
import { spawnPnpm } from './pnpm.mjs';
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { buildNative } from './build-native.mjs';
import { writeThirdPartyNotices } from './third-party-notices.mjs';

const watchMode = process.argv.includes('--watch');
if (!watchMode) {
  await rm('dist', { recursive: true, force: true });
}
await mkdir('dist', { recursive: true });
await buildNative();
await copyFile('native/build/Release/crw_guard.node', 'dist/native-guard.node');
const nodeBundleOptions = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['vscode', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
};
const bundles = [
  {
    bundle: true,
    platform: 'browser',
    target: 'chrome150',
    format: 'iife',
    minify: !watchMode,
    define: { 'process.env.NODE_ENV': JSON.stringify(watchMode ? 'development' : 'production') },
    entryPoints: ['src/webviews/draft-main.tsx'],
    outfile: 'dist/draft-writer.js',
  },
  { ...nodeBundleOptions, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs' },
  {
    ...nodeBundleOptions,
    entryPoints: ['src/connections/readiness-worker.ts'],
    outfile: 'dist/readiness-worker.cjs',
  },
  {
    ...nodeBundleOptions,
    entryPoints: ['src/connections/native-probe-worker.ts'],
    outfile: 'dist/native-probe-worker.cjs',
  },
  {
    ...nodeBundleOptions,
    entryPoints: ['src/connections/store-worker.ts'],
    outfile: 'dist/store-worker.cjs',
  },
  {
    bundle: true,
    platform: 'browser',
    target: 'chrome150',
    format: 'iife',
    minify: !watchMode,
    define: { 'process.env.NODE_ENV': JSON.stringify(watchMode ? 'development' : 'production') },
    entryPoints: ['src/webviews/main.tsx'],
    outfile: 'dist/readiness.js',
  },
];
if (watchMode) {
  for (const options of bundles) {
    const bundleWatcher = await context(options);
    await bundleWatcher.watch();
  }
} else {
  const results = await Promise.all(
    bundles.map((options) => build({ ...options, metafile: true })),
  );
  await writeThirdPartyNotices(results);
}
const stylesheetCompiler = spawnPnpm([
  'exec',
  'tailwindcss',
  '-i',
  'src/webviews/styles.css',
  '-o',
  'dist/readiness.css',
  watchMode ? '--watch' : '--minify',
]);
stylesheetCompiler.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
stylesheetCompiler.on('exit', (code) => {
  if (code) {
    process.exitCode = code;
  }
});
