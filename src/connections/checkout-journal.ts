import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CheckoutReview, EditorSnapshot } from '../application/checkout-review';
import { validRange } from '../application/committed-source';
import { StoreError } from '../application/private-store';
import {
  object,
  readRecord,
  sequence,
  text,
  uuid,
  recovery,
  type NativeStore,
} from './store-records';
import { oid } from './repository-operation';
import type { StorageFaults } from './storage-diagnostics';

export function validEditorSnapshot(value: unknown): value is EditorSnapshot {
  if (
    !object(value) ||
    value.protocol !== 1 ||
    !text(value.workspace) ||
    !object(value.layout) ||
    !Array.isArray(value.layout.groups) ||
    !Array.isArray(value.groups) ||
    value.groups.length < 1 ||
    value.groups.length > 9 ||
    JSON.stringify(value).length > 48000
  )
    return false;
  let tabs = 0;
  return value.groups.every(
    (group, index) =>
      object(group) &&
      group.column === index + 1 &&
      typeof group.active === 'boolean' &&
      Array.isArray(group.tabs) &&
      group.tabs.every((tab) => {
        tabs += 1;
        return (
          tabs <= 100 &&
          object(tab) &&
          ['text', 'diff'].includes(String(tab.kind)) &&
          text(tab.uri, 8192) &&
          (tab.kind !== 'diff' || text(tab.original, 8192)) &&
          typeof tab.active === 'boolean' &&
          typeof tab.preview === 'boolean' &&
          typeof tab.pinned === 'boolean' &&
          Array.isArray(tab.views) &&
          tab.views.length <= 2 &&
          tab.views.every(
            (view) =>
              object(view) &&
              text(view.uri, 8192) &&
              sequence(view.topLine) &&
              Array.isArray(view.selections) &&
              view.selections.length > 0 &&
              view.selections.length <= 100 &&
              view.selections.every(validRange),
          )
        );
      }),
  );
}
function validReview(value: unknown): value is CheckoutReview {
  return (
    object(value) &&
    value.protocol === 1 &&
    uuid(value.id) &&
    uuid(value.storeId) &&
    uuid(value.incarnation) &&
    uuid(value.scopeId) &&
    sequence(value.revision) &&
    value.revision > 0 &&
    ['entering', 'active', 'exiting', 'restoring-editors', 'complete'].includes(
      String(value.phase),
    ) &&
    uuid(value.sourceId) &&
    uuid(value.entryId) &&
    (value.exitId === null || uuid(value.exitId)) &&
    object(value.original) &&
    (value.original.branch === null ||
      (text(value.original.branch) && value.original.branch.startsWith('refs/heads/'))) &&
    oid(value.original.commit) &&
    text(value.original.fingerprint, 64) &&
    object(value.repository) &&
    object(value.repository.worktree) &&
    text(value.repository.worktree.path) &&
    validEditorSnapshot(value.editors) &&
    value.editors.workspace === value.repository.worktree.path
  );
}
const digest = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text).digest('hex');
export interface CheckoutJournalState {
  record: CheckoutReview;
  databaseRecord: string | null;
  independentRecord: string;
  agrees: boolean;
}

/** Row revisions are separate from store ownership revisions. The OS guard and
 * fencing are still checked inside every write transaction by the caller. */
export class CheckoutJournal {
  constructor(
    private readonly database: DatabaseSync,
    private readonly directory: string,
    private readonly native: NativeStore,
    private readonly faults: StorageFaults,
  ) {}
  private databaseRecord(): string | null {
    if (!this.database.prepare("SELECT name FROM sqlite_master WHERE name='checkout_review'").get())
      return null;
    const row = this.database.prepare('SELECT record FROM checkout_review WHERE id=1').get();
    return row ? String(row.record) : null;
  }
  read(allowUnprojected = false): CheckoutJournalState | undefined {
    const raw = readRecord(join(this.directory, 'checkout-review.json'), true);
    const databaseRecord = this.databaseRecord();
    if (raw === undefined && databaseRecord === null) return undefined;
    if (
      !object(raw) ||
      !validReview(raw.record) ||
      !(raw.databaseBefore === null || text(raw.databaseBefore, 64))
    )
      recovery('The checkout recovery journal is malformed or missing.');
    const independentRecord = JSON.stringify(raw.record);
    const agrees = independentRecord === databaseRecord;
    if (
      (!agrees && digest(databaseRecord) !== raw.databaseBefore) ||
      (!agrees && !allowUnprojected)
    )
      throw new StoreError(
        'CHECKOUT_RECOVERY',
        'Checkout intent and its database receipt disagree. Use Recover PR Checkout; no Git command was repeated.',
      );
    return { record: raw.record, databaseRecord, independentRecord, agrees };
  }
  publish(record: CheckoutReview, previous: CheckoutJournalState | undefined) {
    if (!validReview(record) || JSON.stringify(record).length > 60000)
      throw new StoreError(
        'INVALID_CHECKOUT',
        'The editor/recovery snapshot is unsupported or exceeds the bounded save size.',
      );
    if (this.databaseRecord() !== (previous?.databaseRecord ?? null))
      recovery('The checkout row changed before publication.');
    this.faults.publish(
      `checkout-${record.phase}`,
      this.native,
      join(this.directory, 'checkout-review.json'),
      { record, databaseBefore: digest(previous?.databaseRecord ?? null) },
    );
  }
  project(record: CheckoutReview, previous: CheckoutJournalState | undefined) {
    if (this.databaseRecord() !== (previous?.databaseRecord ?? null))
      recovery('The checkout row changed before commit.');
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS checkout_review (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL) STRICT',
    );
    this.database
      .prepare(
        'INSERT INTO checkout_review VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
      )
      .run(JSON.stringify(record));
  }
}
