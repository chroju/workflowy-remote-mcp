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

CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
