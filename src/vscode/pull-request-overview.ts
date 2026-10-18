import type { PullRequestOverview } from '../application/review-manager';

type ReadyOverview = Extract<PullRequestOverview, { status: 'ready' }>;

export function createPullRequestOverviewMarkdown(overview: ReadyOverview): string {
  const pull = overview.pullRequest;
  const local = overview.localRepository;
  return [
    `# ${inline(pull.title)}`,
    '',
    `**${pull.base.repository.fullName} #${pull.number}** · ${pull.state}${pull.draft ? ' · draft' : ''}`,
    '',
    `Signed in as \`${inline(overview.account.login)}\` · Author \`${inline(pull.author.login)}\``,
    '',
    `Base: \`${inline(pull.base.ref)}\` at \`${pull.base.oid}\`  `,
    `Head: \`${inline(pull.head.repository.fullName)}:${inline(pull.head.ref)}\` at \`${pull.head.oid}\``,
    '',
    '## Author description',
    '',
    safeAuthorMarkdown(pull.body || '_No author description was provided._'),
    '',
    '## Local registration',
    '',
    `Verified ${local.relation} repository ID \`${local.repositoryId}\` at \`${inline(local.path)}\` using the existing ${local.transport.toUpperCase()} Git transport configuration.`,
    '',
    '> This is a read-only PR overview. No branch was switched, no source was fetched or cloned, and no GitHub content was changed. Full source availability, discussion, checkout, and generated review content are not available at this stage.',
    '',
    `PR: ${pull.url}`,
    '',
  ].join('\n');
}

function inline(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replace(/[\r\n]+/g, ' ');
}

function safeAuthorMarkdown(value: string): string {
  return value
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/!\[/g, '\\![')
    .replace(/\]\(\s*(?:command|vscode|javascript|data):/gi, '](_blocked_:');
}
