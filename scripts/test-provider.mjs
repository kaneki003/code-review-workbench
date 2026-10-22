import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const url = process.argv[2];
if (!url) throw new Error('Pass a separately authorized read-only PR fixture URL.');
const directory = await mkdtemp(join(tmpdir(), 'crw-provider-read-'));
try {
  const outfile = join(directory, 'fixture.mjs');
  await build({
    entryPoints: ['tests/provider/github-read.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
  });
  const child = spawn(process.execPath, [outfile, url], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Provider fixture exited ${code}`)),
    );
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
