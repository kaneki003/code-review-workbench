import { beforeEach, expect, test, vi } from 'vitest';
import type { ReviewCandidate } from '../src/application/pull-request';

const host = vi.hoisted(() => {
  class Uri {
    constructor(
      readonly scheme: string,
      readonly path: string,
    ) {}
    static from(value: { scheme: string; path: string }) {
      return new Uri(value.scheme, value.path);
    }
    static parse(value: string) {
      const separator = value.indexOf(':');
      const scheme = value.slice(0, separator);
      return new Uri(
        scheme,
        scheme === 'file' ? new URL(value).pathname : value.slice(separator + 1),
      );
    }
    toString() {
      return `${this.scheme}:${this.scheme === 'file' ? '//' : ''}${this.path}`;
    }
  }
  class TabInputText {
    constructor(readonly uri: Uri) {}
  }
  class TabInputWebview {}
  class TabInputTextDiff {}
  class Selection {
    constructor(
      readonly anchorLine: number,
      readonly anchorCharacter: number,
      readonly activeLine: number,
      readonly activeCharacter: number,
    ) {}
  }
  type Tab = {
    label: string;
    input: TabInputText | TabInputWebview;
    isActive: boolean;
    isDirty: boolean;
    isPinned: boolean;
    isPreview: boolean;
  };
  const group = {
    viewColumn: 1,
    isActive: true,
    tabs: [] as Tab[],
    get activeTab() {
      return this.tabs.find((tab) => tab.isActive);
    },
  };
  const tabGroups = {
    all: [group],
    activeTabGroup: group,
    close: async (tabs: Tab[]) => {
      group.tabs = group.tabs.filter((tab) => !tabs.includes(tab));
      if (!group.activeTab && group.tabs[0]) group.tabs[0].isActive = true;
      return true;
    },
  };
  function activate(tab: Tab) {
    for (const candidate of group.tabs) candidate.isActive = candidate === tab;
  }
  function show(uri: Uri, preview: boolean) {
    const label = `${preview ? 'Preview ' : ''}${uri.path.split('/').pop()}`;
    let tab = group.tabs.find((tab) => tab.label === label);
    if (!tab) {
      tab = {
        label,
        input: preview ? new TabInputWebview() : new TabInputText(uri),
        isActive: false,
        isDirty: false,
        isPinned: false,
        isPreview: false,
      };
      group.tabs.push(tab);
    }
    activate(tab);
  }
  const window = {
    tabGroups,
    showTextDocument: async (document: { uri: Uri } | Uri) =>
      show(document instanceof Uri ? document : document.uri, false),
    get activeTextEditor() {
      const input = group.activeTab?.input;
      if (!(input instanceof TabInputText)) return undefined;
      return {
        document: { uri: input.uri },
        viewColumn: 1,
        visibleRanges: [{ start: { line: 0 } }],
        selections: [
          { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isReversed: false },
        ],
      };
    },
    get visibleTextEditors() {
      return this.activeTextEditor ? [this.activeTextEditor] : [];
    },
  };
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
  return {
    Uri,
    TabInputText,
    TabInputTextDiff,
    TabInputWebview,
    Selection,
    EventEmitter,
    window,
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      textDocuments: [],
      saveAll: async () => true,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      openTextDocument: async (uri: Uri) => ({ uri }),
    },
    languages: { setTextDocumentLanguage: async () => {} },
    commands: {
      executeCommand: async (command: string, uri?: Uri) => {
        if (command === 'markdown.showPreview') show(uri!, true);
        if (command === 'workbench.action.nextEditorInGroup') {
          const index = group.tabs.indexOf(group.activeTab!);
          activate(group.tabs[(index + 1) % group.tabs.length]!);
        }
        if (command === 'vscode.getEditorLayout') return { orientation: 0, groups: [{ size: 1 }] };
        return undefined;
      },
    },
  };
});

vi.mock('vscode', () => host);

import { createOverviewDocuments } from '../src/vscode/overview-documents';
import { createCheckoutEditors } from '../src/vscode/checkout-editors';

const directory = { path: process.cwd(), device: '1', inode: '1' };
const remote = { owner: 'acme', repository: 'service', transport: 'https' as const };
const candidate: ReviewCandidate = {
  account: { host: 'github.com', userId: '1001', login: 'reviewer' },
  pullRequest: {
    id: '9001',
    number: 20,
    title: 'Review this change',
    body: '',
    state: 'open',
    draft: false,
    url: 'https://github.com/acme/service/pull/20',
    author: null,
    base: {
      repository: { id: '3001', fullName: 'acme/service' },
      ref: 'main',
      oid: 'a'.repeat(40),
    },
    head: { repository: null, ref: 'feature', oid: 'b'.repeat(40) },
  },
  localRepository: {
    confirmation: 'user-confirmed',
    facts: {
      worktree: directory,
      gitDirectory: directory,
      commonDirectory: directory,
      remotes: [],
    },
    repositoryId: '3001',
    relation: 'base',
    remote,
  },
};

beforeEach(() => {
  host.window.tabGroups.activeTabGroup.tabs = [];
});

test('reopening the same PR reuses its overview document and preview', async () => {
  const documents = createOverviewDocuments();
  try {
    const first = await documents.show(candidate);
    const second = await documents.show({
      ...candidate,
      pullRequest: { ...candidate.pullRequest, body: 'Updated description' },
    });
    expect(second?.toString()).toBe(first?.toString());
    expect(host.window.tabGroups.all.flatMap((group) => group.tabs)).toHaveLength(2);
    expect(documents.read(first!.toString())).toContain('Updated description');
  } finally {
    documents.dispose();
  }
});

test('a long overview and its preview do not consume the prior-work snapshot budget', async () => {
  const documents = createOverviewDocuments();
  try {
    await documents.show({
      ...candidate,
      pullRequest: { ...candidate.pullRequest, body: 'Description paragraph.\n'.repeat(1200) },
    });
    const snapshot = await createCheckoutEditors(documents).capture();
    expect(snapshot.groups[0]!.tabs).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(48000);
  } finally {
    documents.dispose();
  }
});

test('closing review overviews leaves ordinary editor tabs open', async () => {
  const documents = createOverviewDocuments();
  try {
    const uri = host.Uri.from({ scheme: 'file', path: '/prior-work.ts' });
    await host.window.showTextDocument(uri);
    await documents.show(candidate);
    await documents.close();
    expect(host.window.tabGroups.activeTabGroup.tabs.map((tab) => tab.label)).toEqual([
      'prior-work.ts',
    ]);
  } finally {
    documents.dispose();
  }
});

test('removing an active overview from capture preserves the ordinary tab and restores it on Exit', async () => {
  const documents = createOverviewDocuments();
  try {
    const uri = host.Uri.from({ scheme: 'file', path: '/prior-work.ts' });
    await host.window.showTextDocument(uri);
    await documents.show(candidate);
    const editors = createCheckoutEditors(documents);
    const snapshot = await editors.capture();
    expect(snapshot.groups[0]!.tabs.map((tab) => [tab.uri, tab.active])).toEqual([
      [uri.toString(), true],
    ]);
    await editors.restore(snapshot);
    expect(host.window.tabGroups.activeTabGroup.tabs.map((tab) => tab.label)).toEqual([
      'prior-work.ts',
    ]);
  } finally {
    documents.dispose();
  }
});

test('Exit restoration does not reopen overview tabs the reviewer closed', async () => {
  const documents = createOverviewDocuments();
  try {
    await documents.show(candidate);
    const editors = createCheckoutEditors(documents);
    const snapshot = await editors.capture();
    await host.window.tabGroups.close([...host.window.tabGroups.activeTabGroup.tabs]);
    await editors.restore(snapshot);
    expect(host.window.tabGroups.activeTabGroup.tabs).toEqual([]);
  } finally {
    documents.dispose();
  }
});

test('repeated owner recreation reuses overview identity and recognizes a preview without saving its description', async () => {
  const originalDocuments = createOverviewDocuments();
  await originalDocuments.show(candidate);
  const snapshot = await createCheckoutEditors(originalDocuments).capture();
  expect(snapshot.overviewUris).toHaveLength(1);
  const sourceTab = host.window.tabGroups.activeTabGroup.tabs.find(
    (tab) => tab.input instanceof host.TabInputText,
  )!;
  await host.window.tabGroups.close([sourceTab]);
  originalDocuments.dispose();
  const documents = createOverviewDocuments();
  try {
    const editors = createCheckoutEditors(documents);
    editors.retain!(snapshot);
    const reopened = await documents.show(candidate);
    expect(reopened!.toString()).toBe(snapshot.overviewUris![0]);
    await host.window.tabGroups.close(
      host.window.tabGroups.activeTabGroup.tabs.filter(
        (tab) => tab.input instanceof host.TabInputText,
      ),
    );
    documents.dispose();
    const recreated = createOverviewDocuments();
    const recovered = createCheckoutEditors(recreated);
    recovered.retain!(snapshot);
    await recovered.capture();
    await recovered.restore(snapshot);
    recreated.dispose();
    expect(host.window.tabGroups.activeTabGroup.tabs).toEqual([]);
  } finally {
    documents.dispose();
  }
});
