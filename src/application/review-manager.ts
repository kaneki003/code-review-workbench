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
    const checks: Capability[] = [];
    const workspaceSupported = host.desktop && !host.remote && host.folders.length === 1
      && host.folders[0]?.scheme === 'file';
    checks.push({ id: 'workspace', label: 'Workspace', status: workspaceSupported ? 'passed' : 'blocked',
      detail: workspaceSupported ? 'One local desktop folder.'
        : 'Open one already-cloned local desktop folder. Remote, virtual, browser and multi-root workspaces are unavailable; nothing was cloned.' });
    checks.push({ id: 'trust', label: 'Workspace Trust', status: host.trusted ? 'passed' : 'blocked',
      detail: host.trusted ? 'Trusted workspace.' : 'Use VS Code Workspace Trust to trust this folder before running probes.' });
    const runtimeSupported = atLeast(host.vscode, 1, 141, 2) && host.vscode.startsWith('1.')
      && atLeast(host.node, 24, 15, 0) && host.node.startsWith('24.');
    checks.push({ id: 'runtime', label: 'Embedded runtime', status: runtimeSupported ? 'passed' : 'blocked',
      detail: `VS Code ${host.vscode}; Node ${host.node}; Electron ${host.electron ?? 'unavailable'}; Chromium ${host.chrome ?? 'unavailable'}. Requires VS Code 1.141.2+ and embedded Node 24.15+ within Node 24.` });
    const platformSupported = (host.platform === 'darwin' && host.arch === 'arm64')
      || (['win32', 'linux'].includes(host.platform) && host.arch === 'x64');
    checks.push({ id: 'platform', label: 'Platform target', status: platformSupported ? 'passed' : 'blocked',
      detail: `${host.platform} ${host.arch}. Target matrix: Windows x64, Linux x64, macOS arm64. A passing probe alone does not establish platform support.` });
    if (checks.every(check => check.status === 'passed')) {
      const folder = host.folders[0]!;
      const results = await Promise.allSettled([this.connections.git(folder.path), this.connections.sqlite()]);
      results.forEach((result, index) => checks.push(result.status === 'fulfilled' ? result.value : {
        id: index === 0 ? 'git' : 'sqlite', label: index === 0 ? 'Git' : 'Packaged SQLite worker',
        status: 'blocked', detail: 'Probe failed. Check Git installation or reinstall the VSIX, then check again.',
      }));
    } else {
      checks.push({ id: 'probes', label: 'Local probes', status: 'blocked', detail: 'Git and SQLite probes were skipped until the host and workspace checks pass.' });
    }
    checks.push({ id: 'ownership', label: 'Review ownership', status: 'pending',
      detail: 'Readiness inspection only. Shared-store ownership is not implemented (#18); starting a review and private-state writes remain unavailable.' });
    return { checkedAt: new Date().toISOString(), checks, reviewAvailable: false };
  }
}

function atLeast(version: string, major: number, minor: number, patch: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const expected = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== expected[i]) return actual[i]! > expected[i]!;
  }
  return true;
}
