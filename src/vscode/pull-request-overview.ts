import MarkdownIt from 'markdown-it';
import type { ReviewCandidate } from '../application/pull-request';

const authorMarkdown = new MarkdownIt({ html: false, linkify: false });
// Author content keeps Markdown structure but cannot create any navigation or
// resource load. Only the separately generated GitHub link is actionable.
authorMarkdown.renderer.rules.link_open = () => '';
authorMarkdown.renderer.rules.link_close = () => '';
authorMarkdown.renderer.rules.image = (tokens, index) =>
  `${authorMarkdown.utils.escapeHtml(tokens[index]!.content)} [image omitted]`;

export function createPullRequestOverviewMarkdown(overview: ReviewCandidate): string {
  const { pullRequest: pull, account, localRepository: local } = overview;
  return [
    `# ${literal(pull.title)}`,
    '',
    `${literal(pull.base.repository.fullName)} #${pull.number} · ${pull.state}${pull.draft ? ' · draft' : ''}`,
    '',
    `Signed in as ${code(account.login)} · GitHub user ID ${code(account.userId)}`,
    '',
    `Author: ${pull.author ? code(pull.author.login) : 'Deleted account'}`,
    '',
    `Base: ${code(pull.base.repository.fullName)} / ${code(pull.base.ref)} at ${code(pull.base.oid)}  `,
    `Head: ${pull.head.repository ? code(pull.head.repository.fullName) : 'Fork unavailable'} / ${code(pull.head.ref)} at ${code(pull.head.oid)}`,
    '',
    '## Author description',
    '',
    '_Author links and images are disabled in this overview._',
    '',
    authorMarkdown.render(pull.body || '*No author description was provided.*'),
    '',
    '## Selected local copy',
    '',
    `${code(local.facts.worktree.path)} · ${local.relation} repository ID ${code(local.repositoryId)}`,
    '',
    `Configured Git transport: ${local.remote.transport.toUpperCase()}. Git authentication has not been tested. API sign-in does not configure Git's HTTPS credential helper or SSH keys.`,
    '',
    '> Read-only metadata overview. Checkout, full source availability, discussion and AI content are unavailable at this stage. No branch was switched or source fetched.',
    '',
    `[Open PR on GitHub](${pull.url})`,
    '',
  ].join('\n');
}

function literal(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001f]/g, ' ')
    .replace(/[\\`*_{}\[\]()#+.!|<>~&]/g, (character) => `&#${character.charCodeAt(0)};`);
}
function code(value: string): string {
  return `<code>${authorMarkdown.utils.escapeHtml(value.replace(/[\r\n\u0000-\u001f]/g, ' '))}</code>`;
}
