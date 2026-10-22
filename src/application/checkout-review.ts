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
