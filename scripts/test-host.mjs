import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { spawnPnpm } from './pnpm.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const testOutputDirectory = join(projectRoot, '.host-test');
const evidenceFile = join(testOutputDirectory, 'evidence.json');

await mkdir(testOutputDirectory, { recursive: true });
await writeJson(evidenceFile, {
  status: 'starting',
  startedAt: new Date().toISOString(),
  requestedVscode: process.env.CRW_VSCODE_VERSION || 'stable',
  developerNode: process.versions.node,
});

try {
  await runCommand('pnpm', ['run', 'package']);
  const fixture = await createDisposableWorkspace();
  const vscodeExecutable =
    process.env.CRW_VSCODE_EXECUTABLE ||
    (await downloadAndUnzipVSCode({ version: process.env.CRW_VSCODE_VERSION || 'stable' }));

  await installPackagedExtension(vscodeExecutable, fixture);
  const runnerConfig = await prepareHostTestRunner(vscodeExecutable, fixture);

  console.log(`Installed-host fixtures: ${fixture.directory}`);
  await runCommand('pnpm', ['exec', 'vscode-test', '--config', runnerConfig]);
} catch (error) {
  // Keep versions and any completed test outcomes, even if a later step fails.
  const recordedEvidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
  await writeJson(evidenceFile, {
    ...recordedEvidence,
    status: 'failed',
    failure: String(error),
  });
  throw error;
}

async function createDisposableWorkspace() {
  // Spaces make every platform exercise argument handling as well as packaging.
  const directory = await mkdtemp(join(tmpdir(), 'crw packaged host '));
  const fixture = {
    directory,
    workspace: join(directory, 'repository'),
    extensions: join(directory, 'extensions'),
    profile: join(directory, 'profile'),
    harness: join(directory, 'harness'),
  };

  const fixtureDirectories = [
    fixture.workspace,
    fixture.extensions,
    fixture.harness,
    join(fixture.profile, 'User'),
  ];
  await Promise.all(fixtureDirectories.map((path) => mkdir(path, { recursive: true })));

  // VS Code's test runner needs a development extension. This empty harness runs
  // the tests; the real workbench is loaded from the separately installed VSIX.
  await writeJson(join(fixture.harness, 'package.json'), {
    name: 'readiness-test-harness',
    publisher: 'fixture',
    version: '0.0.0',
    engines: { vscode: '^1.141.2' },
  });

  // These settings affect only the disposable profile, never the user's profile.
  await writeJson(join(fixture.profile, 'User/settings.json'), {
    'security.workspace.trust.enabled': false,
    'git.enabled': false,
    'workbench.startupEditor': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'telemetry.telemetryLevel': 'off',
  });

  await runCommand('git', ['-C', fixture.workspace, 'init', '--quiet']);
  await writeFile(join(fixture.workspace, 'fixture.txt'), 'staged fixture\n');
  await runCommand('git', ['-C', fixture.workspace, 'add', 'fixture.txt']);
  await writeFile(join(fixture.workspace, 'fixture.txt'), 'unstaged fixture\n');
  await writeFile(join(fixture.workspace, 'untracked.txt'), 'keep me\n');

  return fixture;
}

async function installPackagedExtension(vscodeExecutable, fixture) {
  const [cliLauncher, ...cliArguments] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutable, {
    reuseMachineInstall: true,
  });
  const installArguments = [
    ...cliArguments,
    '--user-data-dir',
    fixture.profile,
    '--extensions-dir',
    fixture.extensions,
    '--install-extension',
    join(projectRoot, 'dist/code-review-workbench.vsix'),
    '--force',
  ];

  if (process.platform !== 'win32') {
    await runCommand(cliLauncher, installArguments);
    return;
  }

  // Windows .cmd files need a shell. Resolve the vendor's actual JS entry instead
  // so Node can preserve each argument, including source/temp paths with spaces.
  const cliScript = await findWindowsCliScript(cliLauncher, vscodeExecutable);
  await runCommand(vscodeExecutable, [cliScript, ...installArguments], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

async function findWindowsCliScript(cliLauncher, vscodeExecutable) {
  // Some archives put resources under a versioned directory. The vendor launcher
  // identifies that location; assuming resources/app is next to Code.exe fails.
  const launcherSource = await readFile(cliLauncher, 'utf8');
  const cliPathMatch = /"%~dp0([^"\r\n]*resources\\app\\out\\cli\.js)"/i.exec(launcherSource);
  if (!cliPathMatch) {
    throw new Error(`Cannot locate the packaged Windows CLI in ${cliLauncher}`);
  }

  const cliScript = resolve(dirname(cliLauncher), cliPathMatch[1]);
  const relativeCliPath = relative(dirname(vscodeExecutable), cliScript);
  if (isAbsolute(relativeCliPath) || relativeCliPath.startsWith('..')) {
    throw new Error('Windows CLI is outside the selected installation');
  }
  return cliScript;
}

async function prepareHostTestRunner(vscodeExecutable, fixture) {
  const compiledTests = join(testOutputDirectory, 'readiness.cjs');
  await build({
    entryPoints: [join(projectRoot, 'tests/host/readiness.ts')],
    outfile: compiledTests,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['vscode', 'mocha'],
  });

  const runnerConfig = {
    files: [compiledTests],
    extensionDevelopmentPath: fixture.harness,
    workspaceFolder: fixture.workspace,
    useInstallation: { fromPath: vscodeExecutable },
    skipExtensionDependencies: true,
    env: {
      CRW_HOST_SANDBOX: fixture.directory,
      CRW_SOURCE_ROOT: projectRoot,
      CRW_HOST_EVIDENCE: evidenceFile,
    },
    launchArgs: [
      '--user-data-dir',
      fixture.profile,
      '--extensions-dir',
      fixture.extensions,
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-extension',
      'github.copilot',
      '--disable-extension',
      'github.copilot-chat',
    ],
    mocha: { timeout: 25000, ui: 'tdd' },
  };
  const configFile = join(testOutputDirectory, 'config.mjs');
  await writeFile(configFile, `export default ${JSON.stringify(runnerConfig, null, 2)};`);
  return configFile;
}

async function runCommand(command, args, options = {}) {
  const spawnOptions = { cwd: projectRoot, stdio: 'inherit', ...options, shell: false };
  const child =
    command === 'pnpm' ? spawnPnpm(args, spawnOptions) : spawn(command, args, spawnOptions);

  await new Promise((resolveRun, reject) => {
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} exited ${exitCode}`));
      }
    });
  });
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}
