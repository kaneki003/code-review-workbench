import { spawn } from 'node:child_process';

// pnpm supplies its own executable path. It can be a native executable (pnpm 12)
// or its registry package's JS launcher. Neither needs a Windows command shell.
export function spawnPnpm(args, options = {}) {
  const executable = process.env.npm_execpath;
  if (!executable) throw new Error('Run this script through pnpm run.');
  const script = /\.(?:cjs|mjs|js)$/i.test(executable);
  return spawn(script ? process.execPath : executable, script ? [executable, ...args] : args,
    { stdio: 'inherit', ...options, shell: false });
}
