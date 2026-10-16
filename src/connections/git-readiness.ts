import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capability } from '../shared/readiness';

const execFileAsync = promisify(execFile);

export async function probeGit(folder: string): Promise<Capability> {
  // Ambient Git overrides must not redirect the read away from the selected folder.
  const environmentWithoutGitOverrides = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  const commandOptions = {
    cwd: folder,
    env: { ...environmentWithoutGitOverrides, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  };
  const gitCheck = (status: Capability['status'], detail: string): Capability => ({
    id: 'git',
    label: 'Git and repository',
    status,
    detail,
  });
  let gitVersion: string;
  try {
    const versionCommand = await execFileAsync('git', ['--version'], commandOptions);
    gitVersion = versionCommand.stdout.trim();
  } catch {
    return gitCheck(
      'blocked',
      'Git could not run within five seconds. Install Git 2.23+ on PATH, then check again.',
    );
  }
  const versionParts = /^git version (\d+)\.(\d+)/.exec(gitVersion);
  const majorVersion = Number(versionParts?.[1]);
  const minorVersion = Number(versionParts?.[2]);
  const hasSupportedVersion = majorVersion > 2 || (majorVersion === 2 && minorVersion >= 23);
  if (!hasSupportedVersion) {
    return gitCheck('blocked', `${gitVersion}. Update Git to 2.23 or newer.`);
  }
  try {
    const repositoryCommand = await execFileAsync(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--is-inside-work-tree',
        '--is-bare-repository',
      ],
      commandOptions,
    );
    const repositoryFacts = repositoryCommand.stdout.trim().replaceAll('\r\n', '\n');
    if (repositoryFacts !== 'true\nfalse') {
      throw new Error('Not a working repository');
    }
    return gitCheck(
      'passed',
      `${gitVersion}; local working repository detected. Read-only discovery passed. Checkout, stash and ref-update behavior still require later preservation/ownership fixtures.`,
    );
  } catch {
    return gitCheck(
      'blocked',
      `${gitVersion}; no accessible working repository. Open an already-cloned repository; check Git safe.directory configuration and folder access. Nothing was cloned.`,
    );
  }
}
