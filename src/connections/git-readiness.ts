import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capability } from '../shared/readiness';

const execute = promisify(execFile);

export async function probeGit(folder: string): Promise<Capability> {
  // Ambient Git overrides must not redirect the read away from the selected folder.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  const options = {
    cwd: folder,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  };
  const result = (status: Capability['status'], detail: string): Capability => ({
    id: 'git',
    label: 'Git and repository',
    status,
    detail,
  });
  let version: string;
  try {
    version = (await execute('git', ['--version'], options)).stdout.trim();
  } catch {
    return result(
      'blocked',
      'Git could not run within five seconds. Install Git 2.23+ on PATH, then check again.',
    );
  }
  const match = /^git version (\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 23)) {
    return result('blocked', `${version}. Update Git to 2.23 or newer.`);
  }
  try {
    const { stdout } = await execute(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--is-inside-work-tree',
        '--is-bare-repository',
      ],
      options,
    );
    if (stdout.trim().replaceAll('\r\n', '\n') !== 'true\nfalse')
      throw new Error('Not a working repository');
    return result(
      'passed',
      `${version}; local working repository detected. Read-only discovery passed. Checkout, stash and ref-update behavior still require later preservation/ownership fixtures.`,
    );
  } catch {
    return result(
      'blocked',
      `${version}; no accessible working repository. Open an already-cloned repository; check Git safe.directory configuration and folder access. Nothing was cloned.`,
    );
  }
}
