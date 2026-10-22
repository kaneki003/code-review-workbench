import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  CheckoutCommandFailure,
  CheckoutResult,
  CheckoutSession,
  CheckoutStep,
  CheckoutWorkspace,
} from '../domain/checkout';

const OID = /^[0-9a-f]{40,64}$/;
const RECEIPT_DIRECTORY = 'code-review-workbench';
const RECEIPT_FILE = 'checkout.json';
const MAX_OUTPUT = 4 * 1024 * 1024;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function quote(argument: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function displayCommand(repository: string, arguments_: string[]): string {
  return ['git', '-C', repository, ...arguments_].map(quote).join(' ');
}

export class GitCommandFailure extends Error implements CheckoutCommandFailure {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      [
        `Git command failed${exitCode === null ? '' : ` with exit code ${exitCode}`}.`,
        `Command: ${command}`,
        stderr ? `stderr:\n${stderr}` : undefined,
        stdout ? `stdout:\n${stdout}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

function execute(repository: string, arguments_: string[], accepted = [0]): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    execFile(
      'git',
      ['-C', repository, ...arguments_],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === 'number' ? error.code : error ? null : 0;
        const result = { stdout: String(stdout), stderr: String(stderr), exitCode: exitCode ?? -1 };
        if (!error || (exitCode !== null && accepted.includes(exitCode))) {
          resolveCommand(result);
          return;
        }
        reject(
          new GitCommandFailure(
            displayCommand(repository, arguments_),
            exitCode,
            result.stdout,
            result.stderr,
          ),
        );
      },
    );
  });
}

function validReceipt(value: unknown): value is CheckoutSession {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as CheckoutSession;
  return (
    receipt.protocol === 2 &&
    typeof receipt.repository === 'string' &&
    typeof receipt.gitDirectory === 'string' &&
    typeof receipt.windowId === 'string' &&
    typeof receipt.sourceId === 'string' &&
    typeof receipt.original?.commit === 'string' &&
    (receipt.original.branch === null || typeof receipt.original.branch === 'string') &&
    typeof receipt.target === 'string' &&
    typeof receipt.stash?.marker === 'string' &&
    (receipt.stash.oid === null || OID.test(receipt.stash.oid)) &&
    [
      'stashing',
      'switching-to-review',
      'active',
      'switching-back',
      'applying-stash',
      'dropping-stash',
      'manual-recovery',
    ].includes(receipt.step)
  );
}

function failureResult(receipt: CheckoutSession, error: unknown): CheckoutResult {
  const failure =
    error instanceof GitCommandFailure
      ? error
      : new GitCommandFailure('Internal checkout receipt update', null, '', String(error));
  return {
    status: 'recovery',
    detail: `${failure.message}\n\nAutomatic recovery was not attempted. Use Git in ${receipt.repository}, then clear the saved recovery receipt when the repository is correct.`,
    review: { ...receipt, step: 'manual-recovery', failure },
  };
}

export function createCheckoutGit(options: {
  repository: string;
  windowId: string;
}): CheckoutWorkspace {
  const repository = resolve(options.repository);
  let receiptPath: string | undefined;

  async function locateReceipt(): Promise<string> {
    if (receiptPath) return receiptPath;
    const gitDirectory = (
      await execute(repository, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])
    ).stdout.trim();
    receiptPath = join(gitDirectory, RECEIPT_DIRECTORY, RECEIPT_FILE);
    return receiptPath;
  }

  async function read(): Promise<CheckoutSession | undefined> {
    const path = await locateReceipt();
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!validReceipt(parsed))
        throw new Error(`The checkout receipt at ${path} is unsupported or malformed.`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async function create(receipt: CheckoutSession): Promise<void> {
    const path = await locateReceipt();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let file;
    try {
      file = await open(path, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          `This repository already has a checkout receipt at ${path}. Inspect it and recover the repository before starting another review.`,
        );
      throw error;
    } finally {
      await file?.close();
    }
  }

  async function save(receipt: CheckoutSession): Promise<void> {
    await writeFile(await locateReceipt(), `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async function move(
    receipt: CheckoutSession,
    step: CheckoutStep,
    fields: Partial<CheckoutSession> = {},
  ): Promise<CheckoutSession> {
    const next = { ...receipt, ...fields, step };
    await save(next);
    return next;
  }

  async function fail(receipt: CheckoutSession, error: unknown): Promise<CheckoutResult> {
    const result = failureResult(receipt, error);
    try {
      await save(result.review!);
    } catch {
      // Preserve the original command failure. The receipt path is already in its detail.
    }
    return result;
  }

  return {
    read,
    async enter(sourceId, target) {
      if (!OID.test(target))
        return { status: 'blocked', detail: 'The committed review target is not a Git object ID.' };
      try {
        const existing = await read();
        if (existing) {
          const sameActiveReview =
            existing.step === 'active' &&
            existing.windowId === options.windowId &&
            existing.sourceId === sourceId &&
            existing.target === target;
          return {
            status: sameActiveReview
              ? 'active'
              : existing.step === 'active'
                ? 'blocked'
                : 'recovery',
            detail: sameActiveReview
              ? 'This repository already has an active review.'
              : existing.step === 'active'
                ? `This repository is already being reviewed by window ${existing.windowId}. Different repositories may be reviewed concurrently, but this checkout cannot be shared.`
                : `This repository has an interrupted checkout at ${await locateReceipt()}. Recover it manually before continuing.`,
            review: existing,
          };
        }
        const commit = (await execute(repository, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
        const branchResult = await execute(
          repository,
          ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          [0, 1],
        );
        const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
        const gitDirectory = dirname(await locateReceipt());
        let receipt: CheckoutSession = {
          protocol: 2,
          repository,
          gitDirectory: dirname(gitDirectory),
          windowId: options.windowId,
          sourceId,
          original: { branch, commit },
          target,
          stash: { marker: `code-review-workbench:${randomUUID()}`, oid: null },
          step: 'stashing',
        };
        await create(receipt);
        try {
          const dirty = (await execute(repository, ['status', '--porcelain=v1', '-z'])).stdout;
          if (dirty) {
            const beforeStash = await execute(
              repository,
              ['rev-parse', '--quiet', '--verify', 'refs/stash'],
              [0, 1],
            );
            await execute(repository, [
              'stash',
              'push',
              '--include-untracked',
              '--message',
              receipt.stash.marker,
            ]);
            const stashOid = (
              await execute(repository, ['rev-parse', '--verify', 'refs/stash'])
            ).stdout.trim();
            if (!OID.test(stashOid)) throw new Error('Git returned an invalid stash object ID.');
            receipt = await move(
              receipt,
              'switching-to-review',
              beforeStash.exitCode !== 0 || beforeStash.stdout.trim() !== stashOid
                ? { stash: { ...receipt.stash, oid: stashOid } }
                : {},
            );
          } else {
            receipt = await move(receipt, 'switching-to-review');
          }
          await execute(repository, ['switch', '--detach', target]);
          receipt = await move(receipt, 'active');
          return {
            status: 'active',
            detail: `Active review at ${target}. Prior work is ${receipt.stash.oid ? `saved in stash ${receipt.stash.oid}` : 'unchanged because the worktree was clean'}.`,
            review: receipt,
          };
        } catch (error) {
          return await fail(receipt, error);
        }
      } catch (error) {
        return {
          status: 'blocked',
          detail: error instanceof Error ? error.message : 'The Git checkout could not start.',
        };
      }
    },
    async exit() {
      let receipt: CheckoutSession | undefined;
      try {
        receipt = await read();
        if (!receipt)
          return { status: 'blocked', detail: 'This repository has no active review checkout.' };
        if (receipt.step !== 'active')
          return {
            status: 'recovery',
            detail: `The checkout stopped during ${receipt.step}. Automatic recovery was not attempted. Recover Git in ${repository}, then clear the receipt.`,
            review: receipt,
          };
        receipt = await move(receipt, 'switching-back');
        if (receipt.original.branch)
          await execute(repository, ['switch', '--', receipt.original.branch]);
        else await execute(repository, ['switch', '--detach', receipt.original.commit]);
        if (receipt.stash.oid) {
          const stashOid = receipt.stash.oid;
          receipt = await move(receipt, 'applying-stash');
          await execute(repository, ['stash', 'apply', '--index', stashOid]);
          receipt = await move(receipt, 'dropping-stash');
          const list = (await execute(repository, ['stash', 'list', '--format=%H%x09%gd'])).stdout;
          const entry = list
            .split(/\r?\n/)
            .map((line) => line.split('\t'))
            .find(([oid]) => oid === stashOid)?.[1];
          if (entry) await execute(repository, ['stash', 'drop', entry]);
        }
        await unlink(await locateReceipt());
        return {
          status: 'complete',
          detail: `Exit complete: Git returned to ${receipt.original.branch ?? receipt.original.commit}${receipt.stash.oid ? ' and reapplied the saved index and worktree changes' : ''}. VS Code manages its own editor layout.`,
        };
      } catch (error) {
        if (receipt) return await fail(receipt, error);
        return {
          status: 'blocked',
          detail:
            error instanceof Error ? error.message : 'The Git checkout could not be restored.',
        };
      }
    },
    async clearRecovery() {
      const receipt = await read();
      if (!receipt)
        return { status: 'complete', detail: 'There is no checkout recovery receipt to clear.' };
      if (receipt.step === 'active')
        return {
          status: 'blocked',
          detail: 'Exit the active review before clearing its checkout receipt.',
          review: receipt,
        };
      await unlink(await locateReceipt());
      return {
        status: 'complete',
        detail: 'The recovery receipt was cleared. No Git command was run.',
      };
    },
  };
}
