import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { test } from 'mocha';
import type { ReadinessReport } from '../../src/protocol/readiness';

import { execFileSync } from 'node:child_process';

export interface HostTestEvidence {
  status: string;
  tests: { name: string; result: string; failure?: string }[];
  host?: unknown;
  report?: ReadinessReport;
  extensionPath?: string;
  drafts?: unknown;
}

export async function fingerprintFiles(directory: string): Promise<Record<string, string>> {
  const fileHashes: Record<string, string> = {};

  async function visitDirectory(absolutePath: string, relativePrefix: string) {
    for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
      const relativePath = `${relativePrefix}${entry.name}`;
      const entryPath = join(absolutePath, entry.name);

      if (entry.isDirectory()) {
        await visitDirectory(entryPath, `${relativePath}/`);
      } else {
        const contents = await readFile(entryPath);
        fileHashes[relativePath] = createHash('sha256').update(contents).digest('hex');
      }
    }
  }
  await visitDirectory(directory, '');
  return fileHashes;
}

export function fixtureCommit(location: string) {
  const git = (args: string[], input = '') =>
    execFileSync('git', ['-C', location, '-c', 'commit.gpgSign=false', ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const tree = git(['mktree']);
  return git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit-tree',
    tree,
    '-m',
    'fixture',
  ]);
}
