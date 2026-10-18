import type { SourceRange } from './committed-source';
import type { LocalRepositoryFacts } from './pull-request';

export interface EditorLayout {
  orientation?: number;
  groups: { size?: number; groups?: EditorLayout['groups'] }[];
}
export interface EditorView {
  uri: string;
  selections: SourceRange[];
  topLine: number;
}
export interface EditorTab {
  kind: 'text' | 'diff';
  uri: string;
  original?: string;
  active: boolean;
  preview: boolean;
  pinned: boolean;
  views: EditorView[];
}
export interface EditorSnapshot {
  protocol: 1;
  workspace: string;
  layout: EditorLayout;
  groups: { column: number; active: boolean; tabs: EditorTab[] }[];
}
export interface CheckoutEditors {
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
  exitId: string | null;
}
export interface CheckoutResult {
  status: 'active' | 'complete' | 'blocked' | 'recovery';
  detail: string;
  review?: CheckoutReview;
}
export const checkoutActions = [
  'beginCheckout',
  'readCheckout',
  'activateCheckout',
  'beginCheckoutExit',
  'finishCheckoutGit',
  'completeCheckout',
  'reconcileCheckout',
] as const;
export function isCheckoutAction(action: string) {
  return (checkoutActions as readonly string[]).includes(action);
}
