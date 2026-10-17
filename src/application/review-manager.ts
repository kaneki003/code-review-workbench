import type { Capability, ReadinessReport } from '../shared/readiness';

export interface HostEnvironment {
  vscode: string;
  node: string;
  electron: string | undefined;
  chrome: string | undefined;
  platform: string;
  arch: string;
  desktop: boolean;
  trusted: boolean;
  remote: string | undefined;
  folders: { scheme: string; path: string }[];
}

export interface ReadinessConnections {
  environment(): HostEnvironment;
  git(folder: string): Promise<Capability>;
  sqlite(): Promise<Capability>;
}

// This public action only inspects capabilities. It never acquires review ownership.
export class ReviewManager {
  constructor(private readonly connections: ReadinessConnections) {}

  async checkReadiness(): Promise<ReadinessReport> {
    const host = this.connections.environment();
    const checks = [
      checkWorkspace(host),
      checkWorkspaceTrust(host),
      checkEmbeddedRuntime(host),
      checkPlatform(host),
    ];
    const canRunLocalProbes = checks.every((check) => check.status === 'passed');

    if (canRunLocalProbes) {
      // checkWorkspace has established that exactly one local folder exists.
      const repositoryFolder = host.folders[0]!;
      const [gitResult, sqliteResult] = await Promise.allSettled([
        this.connections.git(repositoryFolder.path),
        this.connections.sqlite(),
      ]);

      checks.push(
        readProbeResult(gitResult, 'git', 'Git'),
        readProbeResult(sqliteResult, 'sqlite', 'Packaged SQLite worker'),
      );
    } else {
      checks.push({
        id: 'probes',
        label: 'Local probes',
        status: 'blocked',
        detail: 'Git and SQLite probes were skipped until the host and workspace checks pass.',
      });
    }

    checks.push({
      id: 'ownership',
      label: 'Review ownership',
      status: 'blocked',
      detail:
        'Safe cross-window ownership is unavailable (#18). Starting a review and private-state writes remain disabled. Continue using the editor; ownership requires an extension update.',
    });

    return { checkedAt: new Date().toISOString(), checks, reviewAvailable: false };
  }
}

function checkWorkspace(host: HostEnvironment): Capability {
  const hasOneLocalFolder = host.folders.length === 1 && host.folders[0]?.scheme === 'file';
  const isSupported = host.desktop && !host.remote && hasOneLocalFolder;

  return {
    id: 'workspace',
    label: 'Workspace',
    status: isSupported ? 'passed' : 'blocked',
    detail: isSupported
      ? 'One local desktop folder.'
      : 'Open one already-cloned local desktop folder. Remote, virtual, browser and multi-root workspaces are unavailable; nothing was cloned.',
  };
}

function checkWorkspaceTrust(host: HostEnvironment): Capability {
  return {
    id: 'trust',
    label: 'Workspace Trust',
    status: host.trusted ? 'passed' : 'blocked',
    detail: host.trusted
      ? 'Trusted workspace.'
      : 'Use VS Code Workspace Trust to trust this folder before running probes.',
  };
}

function checkEmbeddedRuntime(host: HostEnvironment): Capability {
  const hasSupportedVsCode =
    host.vscode.startsWith('1.') && meetsMinimumVersion(host.vscode, [1, 141, 2]);
  const hasSupportedNode =
    host.node.startsWith('24.') && meetsMinimumVersion(host.node, [24, 15, 0]);

  return {
    id: 'runtime',
    label: 'Embedded runtime',
    status: hasSupportedVsCode && hasSupportedNode ? 'passed' : 'blocked',
    detail: `VS Code ${host.vscode}; Node ${host.node}; Electron ${host.electron ?? 'unavailable'}; Chromium ${host.chrome ?? 'unavailable'}. Requires VS Code 1.141.2+ and embedded Node 24.15+ within Node 24.`,
  };
}

function checkPlatform(host: HostEnvironment): Capability {
  const isMacArm = host.platform === 'darwin' && host.arch === 'arm64';
  const isWindowsOrLinuxX64 = ['win32', 'linux'].includes(host.platform) && host.arch === 'x64';

  return {
    id: 'platform',
    label: 'Platform target',
    status: isMacArm || isWindowsOrLinuxX64 ? 'passed' : 'blocked',
    detail: `${host.platform} ${host.arch}. Target matrix: Windows x64, Linux x64, macOS arm64. A passing probe alone does not establish platform support.`,
  };
}

function readProbeResult(
  result: PromiseSettledResult<Capability>,
  id: string,
  label: string,
): Capability {
  if (result.status === 'fulfilled') {
    return result.value;
  }

  return {
    id,
    label,
    status: 'blocked',
    detail: 'Probe failed. Check Git installation or reinstall the VSIX, then check again.',
  };
}

function meetsMinimumVersion(version: string, minimum: [number, number, number]): boolean {
  const versionParts = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
  if (!versionParts) {
    return false;
  }

  const major = Number(versionParts[1]);
  const minor = Number(versionParts[2]);
  const patch = Number(versionParts[3]);
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;

  if (major !== minimumMajor) {
    return major > minimumMajor;
  }
  if (minor !== minimumMinor) {
    return minor > minimumMinor;
  }
  return patch >= minimumPatch;
}
