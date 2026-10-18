import MarkdownIt from 'markdown-it';
import type { ReviewCandidate } from '../application/pull-request';
import type { CommittedSource } from '../application/committed-source';
import { committedDocumentUri } from './committed-links';

const authorMarkdown = new MarkdownIt({ html: false, linkify: false });
// Author content keeps Markdown structure but cannot create any navigation or
// resource load. Only the separately generated GitHub link is actionable.
authorMarkdown.renderer.rules.link_open = () => '';
authorMarkdown.renderer.rules.link_close = () => '';
authorMarkdown.renderer.rules.image = (tokens, index) =>
  `${authorMarkdown.utils.escapeHtml(tokens[index]!.content)} [image omitted]`;

export function createPullRequestOverviewMarkdown(
  overview: ReviewCandidate,
  source?: CommittedSource,
): string {
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
    'Mapping: user-confirmed local registration. Canonical directory identities are checked; Git remote names alone cannot prove clone origin.',
    ...(local.unverifiedRemotes
      ? [
          '',
          '> Some other configured remotes could not be verified. This mapping uses only the accessible base/head repository ID.',
        ]
      : []),
    '',
    `Configured Git transport: ${local.remote.transport.toUpperCase()}. API sign-in does not configure Git's HTTPS credential helper or SSH keys.`,
    '',
    ...(source
      ? [
          '## Inspected committed source',
          '',
          '> No-switch reading. Ordinary working files and terminals remain on their earlier checkout. Saving or staging does not change inspected source.',
          '',
          `Inspected PR head: ${code(source.head)}  `,
          `Observed base tip: ${code(source.baseTip)}  `,
          `Merge base: ${code(source.mergeBase ?? 'unavailable')}  `,
          'Comparison: merge base → exact PR head. This is the retained version verified during inspection; later remote updates require a new inspection.',
          '',
          ...source.limitations.map((detail) => `> ${literal(detail)}`),
          '',
          `## Changed files (${source.files.length}${source.completeness === 'complete' ? ', complete Git comparison' : ', comparison unavailable'})`,
          '',
          'Use the Workbench changed-file sidebar for native split/unified diffs and explicit Reviewed actions. These links open exact-revision source tabs. Text loads on demand; binary, Git LFS pointers and blobs over 2 MiB have explicit reading limits.',
          '',
          ...source.files.map((file) => {
            const side = file.new ? 'new' : 'old';
            const rename =
              file.old && file.new && file.old.path !== file.new.path
                ? ` (from ${literal(file.old.path)})`
                : '';
            return `- [${literal(file.path)}](${committedDocumentUri(source, file, side)}) · ${file.status}${rename} · ${side === 'old' ? 'original side; deleted in head' : 'new committed side'}`;
          }),
          '',
          'Discussion and AI content remain unavailable in this slice.',
        ]
      : [
          '> Read-only metadata overview. Run **Code Review Workbench: Inspect Committed PR Diffs** to fetch exact source without switching branches. Source availability and Git transport authentication have not been tested. Discussion and AI content remain unavailable.',
        ]),
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
