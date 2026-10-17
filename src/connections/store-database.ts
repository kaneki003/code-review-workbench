import { DatabaseSync } from 'node:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import type {
  StoreConfiguration,
  StoreLease,
  StoreReply,
  StoreRequest,
} from '../application/private-store';
import { StoreError } from '../application/private-store';
import {
  recovery,
  sequence,
  type StoreControl,
  type StoreRegistry,
  type OwnerRecord,
} from './store-records';
import { createHash, randomUUID } from 'node:crypto';

const APPLICATION_ID = 0x43525731;
export function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function configure(database: DatabaseSync) {
  database.exec(
    'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;',
  );
  for (const [name, expected] of Object.entries({
    journal_mode: 'wal',
    synchronous: 2,
    foreign_keys: 1,
    secure_delete: 1,
    busy_timeout: 1000,
  })) {
    const result = database.prepare(`PRAGMA ${name}`).get();
    if (!result || Object.values(result)[0] !== expected) {
      throw new StoreError(
        'SQLITE_CAPABILITY',
        `SQLite could not establish ${name}; private writes are unavailable.`,
      );
    }
  }
}

export function initializeDatabase(path: string, registry: StoreRegistry): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    configure(database);
    transaction(database, () => {
      database.exec(`
        CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL,
          protocol INTEGER NOT NULL, store_id TEXT NOT NULL, incarnation TEXT NOT NULL,
          fence INTEGER NOT NULL CHECK(fence>=0), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
        CREATE TABLE owner_scopes (scope_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('local','github')),
          host TEXT, user_id TEXT, UNIQUE(host,user_id),
          CHECK((kind='local' AND host IS NULL AND user_id IS NULL) OR (kind='github' AND host IS NOT NULL AND user_id IS NOT NULL))) STRICT;
        CREATE TABLE ownership (token TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES owner_scopes,
          window_id TEXT NOT NULL, location TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL,
          fence INTEGER NOT NULL UNIQUE, heartbeat INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
          UNIQUE(token,scope_id)) STRICT;
        CREATE TABLE requests (request_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, scope_id TEXT NOT NULL,
          action TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
          FOREIGN KEY(owner_token,scope_id) REFERENCES ownership(token,scope_id)) STRICT;
        CREATE TABLE operations (operation_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, scope_id TEXT NOT NULL,
          scopes TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('pending','complete')),
          pid INTEGER, process_start TEXT, exit_code INTEGER,
          FOREIGN KEY(owner_token,scope_id) REFERENCES ownership(token,scope_id)) STRICT;
        PRAGMA user_version=1;
        PRAGMA application_id=${APPLICATION_ID};
      `);
      database
        .prepare('INSERT INTO metadata VALUES (1,1,1,?,?,0,0)')
        .run(registry.storeId, registry.incarnation);
      database
        .prepare("INSERT INTO owner_scopes VALUES (?,'local',NULL,NULL)")
        .run(registry.localScopeId);
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function metadata(database: DatabaseSync) {
  const row = database.prepare('SELECT * FROM metadata WHERE id=1').get();
  if (
    !row ||
    row.format !== 1 ||
    row.protocol !== 1 ||
    !sequence(row.fence) ||
    !sequence(row.revision)
  )
    recovery('The private-store metadata is unsupported or malformed.');
  return {
    storeId: row.store_id,
    incarnation: row.incarnation,
    fence: row.fence,
    revision: row.revision,
  };
}

export function openDatabase(
  path: string,
  registry: StoreRegistry,
  control: StoreControl,
): DatabaseSync {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    (process.platform !== 'win32' && (file.uid !== userInfo().uid || file.mode & 0o077))
  )
    recovery('The private database is missing or not a private regular file.');
  // Inspect compatibility and integrity without changing an unknown/newer file.
  const inspection = new DatabaseSync(path, { readOnly: true });
  try {
    const version = inspection.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version === 'number' && version > 1)
      throw new StoreError(
        'NEWER_SCHEMA',
        'This private store uses a newer schema. Update the extension; the database was not replaced.',
      );
    if (
      version !== 1 ||
      inspection.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
      inspection.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
    )
      recovery('Private-store format or integrity checks failed.');
    const meta = metadata(inspection);
    if (
      meta.storeId !== registry.storeId ||
      meta.incarnation !== registry.incarnation ||
      meta.fence !== control.fence ||
      meta.revision !== control.revision
    )
      recovery('Database and independent ownership identities disagree.');
  } finally {
    inspection.close();
  }
  const database = new DatabaseSync(path);
  try {
    configure(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function accountScope(
  database: DatabaseSync,
  registry: StoreRegistry,
  actor: StoreConfiguration['actor'],
): string {
  if (!actor) return registry.localScopeId;
  const row = database
    .prepare("SELECT scope_id FROM owner_scopes WHERE kind='github' AND host=? AND user_id=?")
    .get(actor.host, actor.userId);
  return typeof row?.scope_id === 'string' ? row.scope_id : randomUUID();
}

export function claimDatabase(
  database: DatabaseSync,
  registry: StoreRegistry,
  owner: OwnerRecord,
  configuration: StoreConfiguration,
  fence: number,
  verifyClaim: () => void,
): number {
  return transaction(database, () => {
    verifyClaim();
    const previous = metadata(database);
    if (previous.fence + 1 !== fence || previous.revision === Number.MAX_SAFE_INTEGER)
      recovery('The next ownership generation cannot be established.');
    if (configuration.actor)
      database
        .prepare("INSERT OR IGNORE INTO owner_scopes VALUES (?,'github',?,?)")
        .run(owner.scopeId, configuration.actor.host, configuration.actor.userId);
    database.prepare('UPDATE ownership SET active=0 WHERE active=1').run();
    database
      .prepare('INSERT INTO ownership VALUES (?,?,?,?,?,?,?,?,1)')
      .run(
        owner.token,
        owner.scopeId,
        owner.windowId,
        owner.location,
        owner.process.pid,
        owner.process.start,
        fence,
        owner.heartbeat,
      );
    database.prepare('UPDATE metadata SET fence=?,revision=revision+1 WHERE id=1').run(fence);
    return previous.revision + 1;
  });
}

export function requestDigest(request: StoreRequest) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function previousReply(
  database: DatabaseSync,
  request: StoreRequest,
): StoreReply | undefined {
  const row = database.prepare('SELECT * FROM requests WHERE request_id=?').get(request.id);
  if (!row) return undefined;
  if (
    row.owner_token !== request.lease?.token ||
    row.scope_id !== request.lease?.scopeId ||
    row.digest !== requestDigest(request)
  ) {
    throw new StoreError(
      'REQUEST_COLLISION',
      'A request ID was reused with different ownership or content.',
    );
  }
  if (typeof row.result !== 'string') recovery('A durable request receipt is malformed.');
  return JSON.parse(row.result) as StoreReply;
}

export function saveReply(
  database: DatabaseSync,
  request: StoreRequest,
  lease: StoreLease,
  reply: StoreReply,
) {
  database
    .prepare('INSERT INTO requests VALUES (?,?,?,?,?,?)')
    .run(
      request.id,
      lease.token,
      lease.scopeId,
      request.action,
      requestDigest(request),
      JSON.stringify(reply),
    );
}
