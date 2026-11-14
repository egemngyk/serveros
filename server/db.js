import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './logger.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const dbFile = path.join(config.dataDir, 'serveros.db');

// A restore of the application database is staged by the backup service and swapped in
// here, before the database is opened. The previous database is kept, never deleted.
const pending = path.join(config.dataDir, 'restore-pending', 'serveros.db');
if (fs.existsSync(pending)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const keep = path.join(config.dataDir, 'pre-restore-db-' + stamp);
  fs.mkdirSync(keep, { recursive: true, mode: 0o700 });
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + ext)) fs.renameSync(dbFile + ext, path.join(keep, 'serveros.db' + ext));
  }
  fs.renameSync(pending, dbFile);
  log.warn('Application database restored from backup', { previousDatabase: keep });
}

export const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
try { fs.chmodSync(dbFile, 0o600); } catch { /* ignore */ }

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    log.info('Applied migration', { migration: f });
  }
}
migrate();

export function closeDb() { try { db.close(); } catch { /* ignore */ } }
