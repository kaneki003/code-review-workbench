import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubConnection } from './github';
import type {
  LocalRepositoryConnection,
  LocalRepositoryInspection,
} from '../application/review-manager';

const execFileAsync = promisify(execFile);

export function createLocalRepositoryConnection(
  github: GitHubConnection,
): LocalRepositoryConnection {
  return {
    async inspect(path): Promise<LocalRepositoryInspection> {
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
      const remoteNames = await execFileAsync(
        'git',
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'remote'],
        commandOptions,
      );
      const remoteUrls = (
        await Promise.all(
          remoteNames.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((name) =>
              execFileAsync(
                'git',
                [
                  '--no-optional-locks',
                  '-c',
                  'core.fsmonitor=false',
                  'remote',
                  'get-url',
                  '--all',
                  name,
                ],
                commandOptions,
              ).then((result) => result.stdout.split(/\r?\n/).filter(Boolean)),
            ),
        )
      ).flat();
      const coordinates = new Map<
        string,
        { owner: string; repository: string; transport: 'https' | 'ssh' }
      >();
      for (const remote of remoteUrls) {
        const parsed = parseGitHubRemote(remote);
        if (parsed)
          coordinates.set(
            `${parsed.owner.toLowerCase()}/${parsed.repository.toLowerCase()}`,
            parsed,
          );
      }
      const resolved = await Promise.all(
        [...coordinates.values()].map(async (remote) => ({
          remote,
          repository: await github.resolveRepository(remote.owner, remote.repository),
        })),
      );
      const repositories = resolved.filter(
        (item): item is typeof item & { repository: NonNullable<typeof item.repository> } =>
          Boolean(item.repository),
      );
      if (repositories.length === 0) {
        throw new Error(
          'No GitHub.com remote in the selected folder could be verified. Configure existing HTTPS-helper or SSH Git transport, then retry.',
        );
      }
      return {
        path,
        repositoryIds: [...new Set(repositories.map((item) => item.repository.id))],
        transport: repositories.some((item) => item.remote.transport === 'ssh') ? 'ssh' : 'https',
      };
    },
  };
}

function parseGitHubRemote(
  input: string,
): { owner: string; repository: string; transport: 'https' | 'ssh' } | undefined {
  const ssh = /^(?:ssh:\/\/)?git@github\.com(?::|\/)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(input);
  if (ssh) return { owner: ssh[1]!, repository: ssh[2]!, transport: 'ssh' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return undefined;
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  return match ? { owner: match[1]!, repository: match[2]!, transport: 'https' } : undefined;
}
