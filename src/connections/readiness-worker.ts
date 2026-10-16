import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

// Deliberately no workerData, disk path, store initialization or migration API.
const database = new DatabaseSync(':memory:');
try {
  database.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000;');
  database.exec('CREATE TABLE probe (value TEXT NOT NULL) STRICT; BEGIN IMMEDIATE;');
  database.prepare('INSERT INTO probe VALUES (?)').run('packaged worker');
  const row = database.prepare('SELECT value FROM probe').get();
  database.exec('ROLLBACK');
  const empty = database.prepare('SELECT count(*) AS count FROM probe').get();
  const version = database.prepare('SELECT sqlite_version() AS version').get();
  if (row?.value !== 'packaged worker' || empty?.count !== 0) throw new Error('SQLite transaction probe failed');
  parentPort?.postMessage({ ok: true, sqlite: version?.version, node: process.versions.node });
} finally {
  database.close();
  parentPort?.close();
}
