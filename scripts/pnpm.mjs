import { spawn } from 'node:child_process';

// pnpm supplies its own executable path. It can be a native executable (pnpm 12)
// or its registry package's JS launcher. Neither needs a Windows command shell.
export function spawnPnpm(args, options = {}) {
  const packageManagerPath = process.env.npm_execpath;
  if (!packageManagerPath) {
    throw new Error('Run this script through pnpm run.');
  }

  const usesJavaScriptLauncher = /\.(?:cjs|mjs|js)$/i.test(packageManagerPath);
  const executable = usesJavaScriptLauncher ? process.execPath : packageManagerPath;
  const commandArguments = usesJavaScriptLauncher ? [packageManagerPath, ...args] : args;

  return spawn(executable, commandArguments, {
    stdio: 'inherit',
    ...options,
    shell: false,
  });
}
