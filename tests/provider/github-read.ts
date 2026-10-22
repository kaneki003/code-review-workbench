import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitHubConnection, parsePullRequestUrl } from '../../src/github/pull-requests';
import { createLocalRepositoryConnection } from '../../src/git/repository';

const url = process.argv[2] ?? '';
if (!parsePullRequestUrl(url))
  throw new Error('Pass the separately authorized GitHub.com PR fixture URL.');
const exec = promisify(execFile);
const connection = createGitHubConnection({
  // This opt-in provider fixture uses the already-authorized CLI account. It
  // does not establish interactive VS Code consent or change product auth.
  getSession: async () => {
    const token = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], {
      timeout: 5000,
      maxBuffer: 8192,
      windowsHide: true,
    });
    return { accessToken: token.stdout.trim() };
  },
});
const local = await createLocalRepositoryConnection().inspect(process.cwd());
const result = await connection.resolvePullRequest(url, local.remotes);
if (result.status !== 'ready')
  throw new Error(`Provider fixture: ${result.status}. ${result.detail}`);
if (
  !result.repositories.some(
    (item) =>
      item.identity.id === result.pullRequest.base.repository.id ||
      item.identity.id === result.pullRequest.head.repository?.id,
  )
)
  throw new Error('No verified local base/head registration.');
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      status: 'passed',
      fixture: url,
      sdk: 'octokit@5.0.5',
      restVersion: '2026-03-10',
      credentialRoute: 'authorized GitHub CLI fixture only',
      accountVerified: true,
      baseRepositoryId: result.pullRequest.base.repository.id,
      pullRequestId: result.pullRequest.id,
      pullNumber: result.pullRequest.number,
      headRepositoryId: result.pullRequest.head.repository?.id ?? null,
      fork: result.pullRequest.head.repository?.id !== result.pullRequest.base.repository.id,
      metadataAndDescriptionRead: true,
      localRemoteResolved: true,
      firstRegistration: 'requires explicit user confirmation in the product',
      interactiveVSCodeConsent: 'not exercised',
      privateAccess: 'controlled tests only',
    },
    null,
    2,
  ),
);
