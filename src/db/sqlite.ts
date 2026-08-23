/**
 * SQLite database layer for GlobPod.
 *
 * Responsibilities:
 * - Track seen article GUIDs to prevent re-processing duplicates
 * - Purge articles older than 7 days to keep the DB small
 *
 * The DB file is created automatically in the project root on first run.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

// Resolve __dirname equivalent in ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../../globpod.db");

// Retention window: purge articles older than this many days
const RETENTION_DAYS = 7;

export interface ArticleRecord {
  id: string; // guid ?? link — deduplication key
  title: string;
  feed_source: string; // e.g. "BBC News"
  region: string; // "hk" | "uk" | "nl"
  pub_date: string; // ISO 8601 string
  fetched_at: string; // ISO 8601 string
}

let db: Database.Database | null = null;

/** Open (or reuse) the SQLite connection and ensure the schema exists. */
export function initDb(): Database.Database {
  if (db) return db;

  db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      feed_source TEXT NOT NULL,
      region      TEXT NOT NULL,
      pub_date    TEXT NOT NULL,
      fetched_at  TEXT NOT NULL
    );
  `);

  return db;
}

/**
 * Check whether an article ID has already been processed.
 * @param id - guid ?? link value from the RSS item
 */
export function hasArticle(id: string): boolean {
  const row = initDb()
    .prepare("SELECT 1 FROM articles WHERE id = ?")
    .get(id);
  return row !== undefined;
}

/**
 * Persist a new article record to the DB.
 * Call only after confirming hasArticle() is false.
 */
export function insertArticle(article: ArticleRecord): void {
  initDb()
    .prepare(
      `INSERT OR IGNORE INTO articles (id, title, feed_source, region, pub_date, fetched_at)
       VALUES (@id, @title, @feed_source, @region, @pub_date, @fetched_at)`
    )
    .run(article);
}

/**
 * Remove articles fetched more than RETENTION_DAYS ago.
 * Called once per pipeline run to keep the DB lean.
 */
export function purgeOldArticles(): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const result = initDb()
    .prepare("DELETE FROM articles WHERE fetched_at < ?")
    .run(cutoff.toISOString());

  return result.changes;
}
