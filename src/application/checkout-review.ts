import type { SourceRange } from './committed-source';
import type { LocalRepositoryFacts } from './pull-request';
import type { PriorWork } from './prior-work';

export interface EditorLayout {
  orientation?: number;
  groups: { size?: number; groups?: EditorLayout['groups'] }[];
}
export interface EditorView {
  uri: string;
  selections: SourceRange[];
  reversed: boolean[];
  topLine: number;
}
export interface EditorTab {
  kind: 'text' | 'diff' | 'markdown-preview';
  uri: string;
  original?: string;
  active: boolean;
  preview: boolean;
  pinned: boolean;
  views: EditorView[];
  content?: string;
  title?: string;
  focus?: string;
}
export interface EditorSnapshot {
  protocol: 1;
  workspace: string;
  layout: EditorLayout;
  groups: { column: number; active: boolean; tabs: EditorTab[] }[];
  /** Identify disposable review views after owner recreation without storing their content. */
  overviewUris?: string[];
}
export interface CheckoutEditors {
  /** Rehydrates our own readonly documents after an authorized store read. */
  retain?(snapshot: EditorSnapshot): void;
  /** Normal host saves followed by a stable inventory of restorable tabs. */
  capture(): Promise<EditorSnapshot>;
  /** Refuses unsaved/uncertain buffers immediately before a Git/host effect. */
  assertSaved(): void;
  /** Restores and verifies the actual native layout before resolving. */
  restore(snapshot: EditorSnapshot): Promise<void>;
}
export interface CheckoutReview {
  protocol: 1;
  id: string;
  storeId: string;
  incarnation: string;
  scopeId: string;
  revision: number;
  phase: 'entering' | 'active' | 'exiting' | 'restoring-editors' | 'complete';
  sourceId: string;
  repository: LocalRepositoryFacts;
  original: { branch: string | null; commit: string; fingerprint: string };
  editors: EditorSnapshot;
  entryId: string;
  /** Retain reference ownership across fresh checkout attempts after recovery. */
  earlierEntryIds?: string[];
  exitId: string | null;
  priorWork?: PriorWork;
}

export type CheckoutStep =
  | 'stashing'
  | 'switching-to-review'
  | 'active'
  | 'switching-back'
  | 'applying-stash'
  | 'dropping-stash'
  | 'manual-recovery';

export interface CheckoutCommandFailure {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The bounded receipt shared by windows that operate on the same checkout.
 * It is evidence for manual recovery, not an automatic recovery journal.
 */
export interface CheckoutSession {
  protocol: 2;
  repository: string;
  gitDirectory: string;
  windowId: string;
  sourceId: string;
  original: { branch: string | null; commit: string };
  target: string;
  stash: { marker: string; oid: string | null };
  step: CheckoutStep;
  failure?: CheckoutCommandFailure;
}

export interface CheckoutDocuments {
  save(): Promise<boolean>;
}

export interface CheckoutWorkspace {
  read(): Promise<CheckoutSession | undefined>;
  enter(sourceId: string, target: string): Promise<CheckoutResult>;
  exit(): Promise<CheckoutResult>;
  clearRecovery(): Promise<CheckoutResult>;
}

export interface CheckoutResult {
  status: 'active' | 'complete' | 'blocked' | 'recovery';
  detail: string;
  review?: CheckoutSession;
}
export const checkoutActions = [
  'beginCheckout',
  'preservePriorWork',
  'restorePriorWork',
  'readCheckout',
  'activateCheckout',
  'beginCheckoutExit',
  'finishCheckoutGit',
  'completeCheckout',
  'reconcileCheckout',
  'cleanupCheckout',
] as const;
export function isCheckoutAction(action: string) {
  return (checkoutActions as readonly string[]).includes(action);
}
