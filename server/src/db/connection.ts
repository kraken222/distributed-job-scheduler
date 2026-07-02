import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { migrate } from './schema.js';

export type DB = Database.Database;

/**
 * Opens a SQLite connection tuned for multi-process use (API + N workers
 * sharing one database file):
 *  - WAL allows concurrent readers while one writer commits.
 *  - busy_timeout makes writers queue instead of failing on contention.
 *  - foreign_keys enforces the relational integrity declared in the schema.
 */
export function openDatabase(file: string = config.databaseFile): DB {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
