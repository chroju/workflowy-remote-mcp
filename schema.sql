DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS nodes_fts;
DROP TABLE IF EXISTS sync_meta;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  note TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  layout_mode TEXT NOT NULL DEFAULT 'bullets',
  created_at INTEGER,
  modified_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);

-- Full-text search. name/note hold plain text with HTML tags stripped.
-- See README for the LIKE fallback used for short queries.
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id UNINDEXED, name, note,
  tokenize='trigram'
);

-- Sync bookkeeping. Keys in use:
--   last_synced_at       unix seconds of the last successful sync
--   last_sync_attempt_at unix seconds of the last attempt (60s debounce)
--   last_sync_status     "ok" or "error: <message>"
--   sync_lock_until      unix seconds the running sync's lease expires;
--                        '0' once released. Claimed by a single conditional
--                        write so only one sync runs at a time.
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
