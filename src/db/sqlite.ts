/**
 * SQLite database layer for GlobPod.
 *
 * Responsibilities:
 * - Track articles that were *used in a published episode* (blacklist)
 * - Purge rows older than 7 days to keep the DB small
 *
 * Articles are NOT written at fetch time. Fetch only checks hasArticle();
 * markArticlesUsed() is called after a successful publish (LIV-8).
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
  id: string; // namespaced dedup key: `${feedName}:${guid|link}`
  title: string;
  feed_source: string; // e.g. "BBC News"
  region: string; // "hk" | "uk" | "nl"
  pub_date: string; // ISO 8601 string
  used_at: string; // ISO 8601 — when it was used in a published episode
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
      fetched_at  TEXT NOT NULL,
      used_at     TEXT
    );
  `);

  // Migrate older DBs that predate used_at (LIV-8). SQLite has no IF NOT EXISTS
  // for columns, so probe pragma and add when missing.
  const cols = db.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "used_at")) {
    db.exec("ALTER TABLE articles ADD COLUMN used_at TEXT");
  }

  return db;
}

/**
 * Check whether an article ID was already used in a published episode.
 * @param id - namespaced key (`${feedName}:${guid|link}`)
 */
export function hasArticle(id: string): boolean {
  const row = initDb()
    .prepare("SELECT 1 FROM articles WHERE id = ?")
    .get(id);
  return row !== undefined;
}

/**
 * Permanently blacklist articles that were used in a published episode.
 * Safe to call with an empty list. Uses INSERT OR IGNORE so retries are fine.
 */
export function markArticlesUsed(articles: ArticleRecord[]): number {
  if (articles.length === 0) return 0;

  const insert = initDb().prepare(
    `INSERT OR IGNORE INTO articles
       (id, title, feed_source, region, pub_date, fetched_at, used_at)
     VALUES
       (@id, @title, @feed_source, @region, @pub_date, @used_at, @used_at)`
  );

  const tx = initDb().transaction((rows: ArticleRecord[]) => {
    let written = 0;
    for (const row of rows) {
      const result = insert.run(row);
      written += result.changes;
    }
    return written;
  });

  return tx(articles);
}

/**
 * Remove articles older than RETENTION_DAYS.
 * Prefers used_at when present; falls back to fetched_at for legacy rows.
 * Called once per pipeline run to keep the DB lean.
 */
export function purgeOldArticles(): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString();

  const result = initDb()
    .prepare(
      `DELETE FROM articles
       WHERE COALESCE(used_at, fetched_at) < ?`
    )
    .run(cutoffIso);

  return result.changes;
}
