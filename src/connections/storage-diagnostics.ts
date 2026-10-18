import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from '../application/private-store';
import { object, text, type NativeStore } from './store-records';

// Host-only failure injection at the durability/process seam. Never read from
// settings, the environment, a webview request or repository content.
export interface StorageDiagnostics {
  boundary: string;
  mode: 'error' | 'crash' | 'commit' | 'native' | 'read-only' | 'disk-full';
  stage?: 'write' | 'file-flush' | 'rename' | 'directory-flush';
}
export class StorageFaults {
  private used = false;
  private readonly fault: StorageDiagnostics | undefined;
  private reset: (() => void) | undefined;
  constructor(value: unknown) {
    if (value === undefined) return;
    if (
      !object(value) ||
      !text(value.boundary, 128) ||
      !['error', 'crash', 'commit', 'native', 'read-only', 'disk-full'].includes(
        String(value.mode),
      ) ||
      (value.mode === 'native' &&
        !['write', 'file-flush', 'rename', 'directory-flush'].includes(String(value.stage)))
    )
      throw new StoreError('INVALID_DIAGNOSTICS', 'Unsupported host storage diagnostics.');
    this.fault = value as unknown as StorageDiagnostics;
  }
  at(boundary: string, database?: DatabaseSync) {
    if (this.used || this.fault?.boundary !== boundary || this.fault.mode === 'native') return;
    this.used = true;
    if (this.fault.mode === 'crash') process.exit(86);
    if (this.fault.mode === 'read-only' && database) {
      this.reset = () => database.exec('PRAGMA query_only=OFF');
      database.exec('PRAGMA query_only=ON');
      return;
    }
    if (this.fault.mode === 'disk-full' && database) {
      const limit = database.prepare('PRAGMA max_page_count').get()!.max_page_count;
      const pages = database.prepare('PRAGMA page_count').get()!.page_count;
      this.reset = () => {
        database.prepare(`PRAGMA max_page_count=${limit}`).get();
      };
      database.prepare(`PRAGMA max_page_count=${pages}`).get();
      // Exercise SQLITE_FULL and SQLite's automatic rollback on the actual
      // driver. This diagnostic allocation is never a successful transaction.
      database.exec(
        'CREATE TABLE crw_injected_full (value BLOB) STRICT; INSERT INTO crw_injected_full VALUES (zeroblob(1048576))',
      );
      throw new StoreError(
        'INJECTED_IO',
        'SQLite unexpectedly accepted a bounded full-disk fixture.',
      );
    }
    if (this.fault.mode === 'commit' && database) {
      database.exec(
        "CREATE TEMP TRIGGER crw_injected_commit BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'injected metadata commit failure'); END",
      );
      return;
    }
    throw new StoreError('INJECTED_IO', 'Storage boundary failed; no success was acknowledged.');
  }
  resetDatabase() {
    const reset = this.reset;
    this.reset = undefined;
    reset?.();
  }
  publish(phase: string, native: NativeStore, path: string, record: unknown) {
    this.at(`${phase}.record.before`);
    if (!this.used && this.fault?.mode === 'native' && this.fault.boundary === `${phase}.record`) {
      this.used = true;
      native.publishRecord(path, JSON.stringify(record), this.fault.stage!);
    } else native.publishRecord(path, JSON.stringify(record));
    this.at(`${phase}.record.after`);
  }
}
