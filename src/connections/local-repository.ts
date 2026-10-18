import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import type {
  DirectoryIdentity,
  GitHubRemote,
  LocalRepositoryConnection,
} from '../application/pull-request';

const execFileAsync = promisify(execFile);

export function createLocalRepositoryConnection(): LocalRepositoryConnection {
  return {
    async inspect(folder) {
      const path = await realpath(folder);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
      );
      const commandOptions = {
        cwd: path,
        env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        timeout: 5000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      };
      const read = async (args: string[]) =>
        (
          await execFileAsync(
            'git',
            ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
            commandOptions,
          )
        ).stdout.trimEnd();
      const roots = (
        await read([
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--absolute-git-dir',
          '--git-common-dir',
        ])
      ).split(/\r?\n/);
      if (roots.length !== 3 || (await realpath(roots[0]!)) !== path)
        throw new Error('Select the repository root.');
      const remoteNames = (await read(['remote'])).split(/\r?\n/).filter(Boolean);
      if (remoteNames.length > 16) throw new Error('Too many remotes.');
      const remotes: GitHubRemote[] = [];
      // Read raw config URLs; Git's insteadOf-expanded URLs can contain secrets.
      // No URL is ever placed in argv, a log, or an application record.
      for (const name of remoteNames) {
        const values = (await read(['config', '--null', '--get-all', `remote.${name}.url`]))
          .split('\0')
          .filter(Boolean);
        for (const value of values) {
          const remote = parseRemote(value);
          if (remote && !remotes.some((item) => JSON.stringify(item) === JSON.stringify(remote)))
            remotes.push(remote);
        }
      }
      return {
        worktree: await directoryIdentity(path),
        gitDirectory: await directoryIdentity(roots[1]!),
        commonDirectory: await directoryIdentity(roots[2]!),
        remotes,
      };
    },
  };
}

async function directoryIdentity(input: string): Promise<DirectoryIdentity> {
  const path = await realpath(input);
  const metadata = await stat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.ino < 1n) throw new Error('Unsupported local directory.');
  return { path, device: String(metadata.dev), inode: String(metadata.ino) };
}

function parseRemote(value: string): GitHubRemote | undefined {
  const ssh =
    /^(?:ssh:\/\/)?git@github\.com(?::|\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value,
    );
  if (ssh) return { owner: ssh[1]!, repository: ssh[2]!, transport: 'ssh' };
  // Strict raw syntax rejects credential URLs, rewrites, options and encoded paths.
  const https = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    value,
  );
  if (!https) return undefined;
  return { owner: https[1]!, repository: https[2]!, transport: 'https' };
}
