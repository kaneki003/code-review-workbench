import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  });
}
await run(pnpm, ['run', 'package']);
const sandbox = await mkdtemp(join(tmpdir(), 'crw-packaged-host-'));
const workspace = join(sandbox, 'repository');
const extensions = join(sandbox, 'extensions');
const profile = join(sandbox, 'profile');
const harness = join(sandbox, 'harness');
await Promise.all([workspace, extensions, harness, join(profile, 'User')].map(path => mkdir(path, { recursive: true })));
await writeFile(join(harness, 'package.json'), JSON.stringify({ name: 'readiness-test-harness', publisher: 'fixture', version: '0.0.0', engines: { vscode: '^1.141.2' } }));
// Only this disposable profile disables trust prompts and the built-in Git UI.
await writeFile(join(profile, 'User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'git.enabled': false, 'workbench.startupEditor': 'none',
  'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
}));
await run('git', ['-C', workspace, 'init', '--quiet']);
await writeFile(join(workspace, 'fixture.txt'), 'staged fixture\n');
await run('git', ['-C', workspace, 'add', 'fixture.txt']);
await writeFile(join(workspace, 'fixture.txt'), 'unstaged fixture\n');
await writeFile(join(workspace, 'untracked.txt'), 'keep me\n');
const executable = process.env.CRW_VSCODE_EXECUTABLE || await downloadAndUnzipVSCode({ version: process.env.CRW_VSCODE_VERSION || 'stable' });
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
await run(cli, [...cliArgs, '--user-data-dir', profile, '--extensions-dir', extensions,
  '--install-extension', join(root, 'dist/code-review-workbench.vsix'), '--force']);
await mkdir(join(root, '.host-test'), { recursive: true });
const suite = join(root, '.host-test/readiness.cjs');
await build({ entryPoints: [join(root, 'tests/host/readiness.ts')], outfile: suite, bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', external: ['vscode', 'mocha'] });
const config = join(root, '.host-test/config.mjs');
await writeFile(config, `export default ${JSON.stringify({
  files: [suite], extensionDevelopmentPath: harness, workspaceFolder: workspace,
  useInstallation: { fromPath: executable }, skipExtensionDependencies: true,
  env: { CRW_HOST_SANDBOX: sandbox, CRW_SOURCE_ROOT: root, CRW_HOST_EVIDENCE: resolve('.host-test/evidence.json') },
  launchArgs: ['--user-data-dir', profile, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--no-sandbox', '--disable-gpu'],
  mocha: { timeout: 25000, ui: 'tdd' },
})};`);
console.log(`Installed-host fixtures: ${sandbox}`);
await run(pnpm, ['exec', 'vscode-test', '--config', config]);
