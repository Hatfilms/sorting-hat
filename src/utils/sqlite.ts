import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.SQLITE_DB_PATH || path.join('.', 'data', 'moderation.sqlite');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS image_scam_cache (
    image_hash TEXT PRIMARY KEY,
    has_scam_indicators INTEGER NOT NULL,
    matched_keywords TEXT NOT NULL,
    full_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recent_image_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    image_hash TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recent_image_posts_lookup
    ON recent_image_posts (user_id, image_hash, created_at);
`);

export type ScamCacheResult = {
  hasScamIndicators: boolean;
  matchedKeywords: string[];
  fullText: string;
};

export const getCachedScamResult = (
  imageHash: string,
): ScamCacheResult | null => {
  const row = db
    .prepare(
      'SELECT has_scam_indicators, matched_keywords, full_text FROM image_scam_cache WHERE image_hash = ?',
    )
    .get(imageHash) as
    | { has_scam_indicators: number; matched_keywords: string; full_text: string }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    hasScamIndicators: row.has_scam_indicators === 1,
    matchedKeywords: JSON.parse(row.matched_keywords),
    fullText: row.full_text,
  };
};

export const saveScamResult = (
  imageHash: string,
  result: ScamCacheResult,
) => {
  db.prepare(
    `INSERT INTO image_scam_cache (image_hash, has_scam_indicators, matched_keywords, full_text, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_hash) DO UPDATE SET
       has_scam_indicators = excluded.has_scam_indicators,
       matched_keywords = excluded.matched_keywords,
       full_text = excluded.full_text`,
  ).run(
    imageHash,
    result.hasScamIndicators ? 1 : 0,
    JSON.stringify(result.matchedKeywords),
    result.fullText,
    Date.now(),
  );
};

export type CrossChannelHit = {
  channelId: string;
  messageId: string;
};

const CROSS_CHANNEL_WINDOW_MS = 60 * 1000;
const CROSS_CHANNEL_THRESHOLD = 3;

export const recordImagePost = (
  userId: string,
  imageHash: string,
  channelId: string,
  messageId: string,
) => {
  const now = Date.now();
  db.prepare(
    'DELETE FROM recent_image_posts WHERE created_at < ?',
  ).run(now - CROSS_CHANNEL_WINDOW_MS);

  db.prepare(
    `INSERT INTO recent_image_posts (user_id, image_hash, channel_id, message_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, imageHash, channelId, messageId, now);
};

export const getCrossChannelHits = (
  userId: string,
  imageHash: string,
  windowMs: number = CROSS_CHANNEL_WINDOW_MS,
  channelThreshold: number = CROSS_CHANNEL_THRESHOLD,
): CrossChannelHit[] => {
  const rows = db
    .prepare(
      `SELECT DISTINCT channel_id, message_id FROM recent_image_posts
       WHERE user_id = ? AND image_hash = ? AND created_at > ?`,
    )
    .all(userId, imageHash, Date.now() - windowMs) as {
    channel_id: string;
    message_id: string;
  }[];

  const distinctChannels = new Set(rows.map((row) => row.channel_id));
  if (distinctChannels.size < channelThreshold) {
    return [];
  }

  return rows.map((row) => ({
    channelId: row.channel_id,
    messageId: row.message_id,
  }));
};
