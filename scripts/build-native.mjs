import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, lstat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';

export async function buildNative() {
  const project = fileURLToPath(new URL('..', import.meta.url));
  const targets = { darwin: 'arm64', linux: 'x64', win32: 'x64' };
  if (targets[process.platform] !== process.arch) {
    throw new Error(`Unsupported native target: ${process.platform} ${process.arch}`);
  }
  // gyp's Unix Makefiles split header paths containing spaces. Keep only the
  // development header cache in an OS-user temp directory with a plain path.
  const cache = resolve(tmpdir(), `crw-electron-headers-${userInfo().uid}`);
  if (/\s/.test(cache)) throw new Error('Native builds need a temporary directory without spaces.');
  await mkdir(cache, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const metadata = await lstat(cache);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== 'win32' && (metadata.uid !== userInfo().uid || metadata.mode & 0o077))
  ) {
    throw new Error('Native header cache must be a private OS-user directory.');
  }
  const child = spawn(
    process.execPath,
    [
      resolve(project, 'node_modules/node-gyp/bin/node-gyp.js'),
      'rebuild',
      '--directory',
      resolve(project, 'native'),
      '--target=43.7.7',
      '--dist-url=https://electronjs.org/headers',
      `--arch=${process.arch}`,
      `--devdir=${cache}`,
    ],
    { stdio: 'inherit', shell: false },
  );
  await new Promise((resolveBuild, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveBuild() : reject(new Error(`Native build exited ${code}`)),
    );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildNative();
}
