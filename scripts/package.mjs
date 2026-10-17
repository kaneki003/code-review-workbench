import { spawnPnpm } from './pnpm.mjs';

const targets = { darwin: 'darwin-arm64', linux: 'linux-x64', win32: 'win32-x64' };
const target = targets[process.platform];
if (!target || !target.endsWith(`-${process.arch}`))
  throw new Error('Unsupported native package target');
const child = spawnPnpm(
  [
    'exec',
    'vsce',
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--skip-license',
    '--target',
    target,
    '--out',
    'dist/code-review-workbench.vsix',
  ],
  { stdio: 'inherit' },
);
await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`Packaging exited ${code}`)),
  );
});
