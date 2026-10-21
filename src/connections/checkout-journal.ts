import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { statSync } from 'node:fs';
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
import { validPriorWork } from './prior-work';
import type { StorageFaults } from './storage-diagnostics';

export function validEditorSnapshot(value: unknown): value is EditorSnapshot {
  const editorUri = (value: unknown): value is string =>
    text(value, 8192) && /^(?:file:\/\/\/|crw-source:|crw-overview:)/.test(value);
  function leaves(groups: unknown, depth = 0): number {
    if (!Array.isArray(groups) || !groups.length || groups.length > 9 || depth > 8) return 0;
    let count = 0;
    for (const group of groups) {
      if (
        !object(group) ||
        (group.size !== undefined &&
          (typeof group.size !== 'number' || !Number.isFinite(group.size) || group.size <= 0))
      )
        return 0;
      const children = group.groups === undefined ? 1 : leaves(group.groups, depth + 1);
      if (!children) return 0;
      count += children;
    }
    return count;
  }
  if (
    !object(value) ||
    value.protocol !== 1 ||
    !text(value.workspace) ||
    !object(value.layout) ||
    !Array.isArray(value.layout.groups) ||
    (value.layout.orientation !== undefined &&
      value.layout.orientation !== 0 &&
      value.layout.orientation !== 1) ||
    !Array.isArray(value.groups) ||
    value.groups.length < 1 ||
    value.groups.length > 9 ||
    (value.overviewUris !== undefined &&
      (!Array.isArray(value.overviewUris) ||
        value.overviewUris.length > 100 ||
        !value.overviewUris.every((uri) => editorUri(uri) && uri.startsWith('crw-overview:')))) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 48000 ||
    leaves(value.layout.groups) !== value.groups.length ||
    value.groups.filter((group) => object(group) && group.active === true).length !== 1
  )
    return false;
  let tabs = 0;
  return value.groups.every(
    (group, index) =>
      object(group) &&
      group.column === index + 1 &&
      typeof group.active === 'boolean' &&
      Array.isArray(group.tabs) &&
      (group.tabs.length === 0 ||
        group.tabs.filter((tab) => object(tab) && tab.active === true).length === 1) &&
      group.tabs.every((tab) => {
        tabs += 1;
        return (
          tabs <= 100 &&
          object(tab) &&
          ['text', 'diff', 'markdown-preview'].includes(String(tab.kind)) &&
          editorUri(tab.uri) &&
          (tab.title === undefined || text(tab.title, 4096)) &&
          (tab.kind !== 'markdown-preview' ||
            (String(tab.uri).startsWith('crw-overview:') && typeof tab.content === 'string')) &&
          (tab.focus === undefined || tab.focus === tab.uri || tab.focus === tab.original) &&
          (tab.content === undefined ||
            (typeof tab.content === 'string' &&
              tab.content.length <= 48000 &&
              tab.uri.startsWith('crw-overview:'))) &&
          (tab.kind !== 'diff' || editorUri(tab.original)) &&
          typeof tab.active === 'boolean' &&
          typeof tab.preview === 'boolean' &&
          typeof tab.pinned === 'boolean' &&
          Array.isArray(tab.views) &&
          tab.views.length <= 2 &&
          tab.views.every(
            (view) =>
              object(view) &&
              text(view.uri, 8192) &&
              (view.uri === tab.uri || view.uri === tab.original) &&
              sequence(view.topLine) &&
              Array.isArray(view.selections) &&
              Array.isArray(view.reversed) &&
              view.reversed.length === view.selections.length &&
              view.reversed.every((flag) => typeof flag === 'boolean') &&
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
    (value.earlierEntryIds === undefined ||
      (Array.isArray(value.earlierEntryIds) &&
        value.earlierEntryIds.length <= 32 &&
        value.earlierEntryIds.every(uuid) &&
        new Set(value.earlierEntryIds).size === value.earlierEntryIds.length &&
        !value.earlierEntryIds.includes(value.entryId))) &&
    (value.exitId === null || uuid(value.exitId)) &&
    object(value.original) &&
    (value.original.branch === null ||
      (text(value.original.branch) && value.original.branch.startsWith('refs/heads/'))) &&
    oid(value.original.commit) &&
    (value.priorWork === undefined || validPriorWork(value.priorWork)) &&
    text(value.original.fingerprint, 64) &&
    object(value.repository) &&
    object(value.repository.worktree) &&
    text(value.repository.worktree.path) &&
    validEditorSnapshot(value.editors) &&
    value.editors.workspace === value.repository.worktree.path
  );
}
export function checkoutRecoveryApplies(
  directory: string,
  location: string,
  includeCompleted = false,
): boolean {
  const raw = readRecord(join(directory, 'checkout-review.json'), true);
  if (raw === undefined) return false;
  if (!object(raw) || !validReview(raw.record))
    recovery('The checkout recovery journal is malformed.');
  const record = raw.record;
  if (
    (!includeCompleted && record.phase === 'complete') ||
    record.repository.worktree.path !== location
  )
    return false;
  const actual = statSync(location, { bigint: true });
  return (
    String(actual.dev) === record.repository.worktree.device &&
    String(actual.ino) === record.repository.worktree.inode
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
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (!validReview(record) || bytes > 60000)
      throw new StoreError(
        'INVALID_CHECKOUT',
        'The editor/recovery snapshot is unsupported or exceeds the bounded save size.',
      );
    // Later proof adds an object/clean snapshot; up to 32 fresh checkout IDs
    // and larger revision counters must still fit the durable record limit.
    if (record.revision === 1 && record.priorWork && bytes > 56000)
      throw new StoreError(
        'INVALID_CHECKOUT',
        'The saved manifest and editors exceed the entry budget for required recovery headroom. Keep no-switch reading; reduce the workspace representation before Retry.',
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
