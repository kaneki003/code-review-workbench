import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { StoreError } from '../storage/contracts';
import type {
  CommittedContent,
  CommittedFile,
  CommittedSource,
  SourcePlan,
  SourceSide,
} from '../domain/committed-source';
import type { RepositoryOperation } from './repository-operation';

const execute = promisify(execFile);
// Only committed object reads run here. Mutations use the journalled native
// launcher, and these reads never invoke filters, external diff or lazy fetch.
export class CommittedGit {
  constructor(private readonly repository: RepositoryOperation) {}
  private async git(args: string[], limit = 64 * 1024 * 1024): Promise<Buffer> {
    try {
      const result = await execute(
        this.repository.executable,
        this.repository.readArguments(args),
        {
          env: this.repository.environment,
          encoding: 'buffer',
          maxBuffer: limit,
          timeout: 15000,
          windowsHide: true,
        },
      );
      return result.stdout;
    } catch {
      throw new StoreError(
        'SOURCE_UNAVAILABLE',
        'Committed objects could not be read within the loading limit. Restore object access or fetch full history, then Retry. No working file was substituted.',
      );
    }
  }
  async compare(plan: SourcePlan): Promise<CommittedSource> {
    const source: CommittedSource = {
      id: plan.id,
      candidate: plan.candidate,
      head: plan.candidate.pullRequest.head.oid,
      baseTip: plan.candidate.pullRequest.base.oid,
      mergeBase: null,
      method: 'merge-base-to-head',
      completeness: 'unavailable',
      limitations: [],
      files: [],
    };
    try {
      if (
        (await this.git(['rev-parse', '--is-shallow-repository'])).toString().trim() !== 'false'
      ) {
        source.limitations.push(
          'Insufficient history: this local repository is shallow. Fetch full history with ordinary Git, then Retry.',
        );
        return source;
      }
      const bases = (await this.git(['merge-base', '--all', source.baseTip, source.head]))
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      if (bases.length !== 1) {
        source.limitations.push(
          'Multiple merge bases: there is no single unambiguous PR comparison.',
        );
        return source;
      }
      source.mergeBase = bases[0]!;
      const raw = await this.git([
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=none',
        source.mergeBase,
        source.head,
        '--',
      ]);
      const entries = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
      for (let index = 0; index < entries.length - 1;) {
        const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(
          entries[index++]!,
        );
        if (!header) throw new Error('Invalid raw diff');
        const oldPath = entries[index++]!;
        const newPath = header[5] === 'R' || header[5] === 'C' ? entries[index++]! : oldPath;
        if (!oldPath || !newPath) throw new Error('Invalid raw path');
        const old =
          header[1] === '000000' ? null : { path: oldPath, mode: header[1]!, blob: header[3]! };
        const current =
          header[2] === '000000' ? null : { path: newPath, mode: header[2]!, blob: header[4]! };
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([header[5], old, current]))
          .digest('hex');
        source.files.push({
          id: fingerprint,
          fingerprint,
          path: newPath,
          status: header[5]!,
          old,
          new: current,
        });
      }
      source.completeness = 'complete';
    } catch {
      source.files = [];
      source.limitations.push(
        'Comparison unavailable: history, objects or the complete file listing could not be read within the 15-second / 64 MiB loading bound. No partial list is presented as complete.',
      );
    }
    return source;
  }
  async read(
    source: CommittedSource,
    file: CommittedFile,
    side: SourceSide,
  ): Promise<CommittedContent> {
    const entry = file[side];
    if (!entry)
      return {
        status: 'absent',
        detail: `This file has no ${side === 'old' ? 'original' : 'new'} side (${file.status}).`,
        anchor: {
          sourceId: source.id,
          fileId: file.id,
          side,
          path: file.path,
          blob: null,
          commit: side === 'old' ? source.mergeBase! : source.head,
        },
      };
    if (entry.mode === '160000')
      return {
        status: 'unavailable',
        detail: 'Submodule commit: its nested repository is not part of this source document.',
      };
    try {
      const size = Number((await this.git(['cat-file', '-s', entry.blob], 1024)).toString());
      if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024)
        return {
          status: 'unavailable',
          detail:
            'This committed blob exceeds the 2 MiB text loading limit. Its path and exact identity remain in the complete file list.',
        };
      const bytes = await this.git(['cat-file', 'blob', entry.blob], 2 * 1024 * 1024);
      if (bytes.includes(0))
        return {
          status: 'binary',
          detail: 'Binary committed blob. Native textual comparison is unavailable.',
        };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return {
          status: 'binary',
          detail:
            'This committed blob is not UTF-8 text. No decoded or working-file substitute was opened.',
        };
      }
      if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(text))
        return {
          status: 'lfs',
          detail:
            'Git LFS pointer only. The referenced large-file content has not been downloaded.',
        };
      return {
        status: 'available',
        text,
        anchor: {
          sourceId: source.id,
          fileId: file.id,
          side,
          path: entry.path,
          blob: entry.blob,
          commit: side === 'old' ? source.mergeBase! : source.head,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        detail:
          error instanceof StoreError
            ? error.message
            : 'Exact committed source is unavailable. No current working line was opened.',
      };
    }
  }
}
