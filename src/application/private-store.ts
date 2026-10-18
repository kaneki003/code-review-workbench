import type { GitHubAccount, ReviewCandidate, LocalRepositoryRegistration } from './pull-request';
import type {
  CommittedContent,
  CommittedSource,
  SourcePlan,
  SourceSide,
  SourceNavigation,
} from './committed-source';

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
    | 'prepareCleanCheckout'
    | 'prepareCleanRestore'
    | 'executeOperation'
    | 'recover'
    | 'inspectOperation'
    | 'saveCandidate'
    | 'readCandidate'
    | 'readRegistration'
    | 'prepareSource'
    | 'prepareSourceFetch'
    | 'publishSource'
    | 'readSource'
    | 'readCommittedFile'
    | 'setReviewed'
    | 'readReviewed'
    | 'saveNavigation'
    | 'validateNavigation'
    | 'readNavigation';
  lease?: StoreLease;
  targetWindowId?: string;
  handoff?: StoreHandoff;
  refUpdate?: { ref: string; newOid: string };
  operationId?: string;
  candidate?: ReviewCandidate;
  actor?: Pick<GitHubAccount, 'host' | 'userId'>;
  candidateKey?: { baseRepositoryId: string; pullNumber: number };
  registrationPath?: string;
  workspacePath?: string;
  sourceId?: string;
  fileId?: string;
  side?: SourceSide;
  reviewed?: boolean;
  navigation?: SourceNavigation;
}

export interface StoreHandoff {
  token: string;
  targetWindowId: string;
  storeId: string;
  incarnation: string;
  fence: number;
}
export interface StoreReply {
  sourceId?: string;
  sourcePlan?: SourcePlan;
  source?: CommittedSource;
  content?: CommittedContent;
  reviewed?: string[];
  navigation?: SourceNavigation;
  registration?: LocalRepositoryRegistration;
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
