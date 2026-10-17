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
  action: 'open' | 'inspect' | 'release' | 'renew' | 'handoff' | 'recordIntent';
  lease?: StoreLease;
  targetWindowId?: string;
  handoff?: StoreHandoff;
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
