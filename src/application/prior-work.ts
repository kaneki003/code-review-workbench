/** Saved Git and disk facts; these protect unfinished work, never review inputs. */
export interface WorkFile {
  path: string;
  mode: '100644' | '100755' | '120000' | 'missing';
  oid: string | null;
}
export interface WorkManifest {
  index: WorkFile[];
  files: WorkFile[];
  untracked: string[];
}
export interface PriorWork {
  manifest: WorkManifest;
  marker: string;
  previousStash: string | null;
  stashId: string;
  applyId: string;
  object: string | null;
  /** Clean original checkout, observed only after verified preservation. */
  clean: { branch: string | null; commit: string; fingerprint: string } | null;
}
