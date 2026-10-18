export interface StoreProcess {
  pid: number;
  start: string;
}

export interface StoreLease {
  token: string;
  storeId: string;
  incarnation: string;
  fence: number;
  revision: number;
  scopeId: string;
}

export interface StoreView {
  status: 'closed' | 'owned' | 'busy' | 'recovery' | 'blocked';
  detail: string;
  root?: string;
  storeId?: string;
  incarnation?: string;
  fence?: number;
  revision?: number;
  scopeId?: string;
  process?: StoreProcess;
  ownerLocation?: string;
  code?: string;
}

export interface StoreConfiguration {
  osHome: string;
  candidateRoot: string;
  windowId: string;
  location: string;
  actor?: { host: 'github.com'; userId: string };
}

export interface StoreRequest {
  protocol: 1;
  id: string;
  action:
    | 'open'
    | 'inspect'
    | 'release'
    | 'renew'
    | 'handoff'
    | 'recordIntent'
    | 'prepareRef'
    | 'executeOperation'
    | 'recover'
    | 'inspectOperation'
    | 'saveCandidate';
  lease?: StoreLease;
  targetWindowId?: string;
  handoff?: StoreHandoff;
  refUpdate?: { ref: string; newOid: string };
  operationId?: string;
  candidate?: ReviewCandidate;
  workspacePath?: string;
}

export interface StoreHandoff {
  token: string;
  targetWindowId: string;
  storeId: string;
  incarnation: string;
  fence: number;
}
export interface StoreReply {
  view: StoreView;
  lease?: StoreLease;
  handoff?: StoreHandoff;
  reservation?: { id: string; scopes: string[] };
  operation?: {
    id: string;
    phase: 'prepared' | 'armed' | 'observed';
    outcome?: 'applied' | 'not-applied' | 'refused';
    exitCode?: number;
  };
  candidate?: ReviewCandidate;
}

export interface ReviewCandidate {
  account: { host: 'github.com'; userId: string };
  baseRepositoryId: string;
  pullRequestId: string;
  pullNumber: number;
  localRepository: {
    path: string;
    repositoryId: string;
    relation: 'base' | 'head';
    transport: 'https' | 'ssh';
  };
  record: {
    title: string;
    body: string;
    state: 'open' | 'closed';
    draft: boolean;
    url: string;
    author: { userId: string; login: string };
    baseFullName: string;
    baseRef: string;
    baseOid: string;
    headRepositoryId: string;
    headFullName: string;
    headRef: string;
    headOid: string;
  };
}

export interface StoreConnection {
  request(message: StoreRequest): Promise<StoreReply>;
  dispose(): Promise<void>;
}

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
