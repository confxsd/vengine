-- vengine storage on D1: comic projects, snapshots, the cross-project
-- library, the persistent output cache (content-addressed generation
-- results), finished/in-flight run results, and training poll bookkeeping.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS snapshots (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS library (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS train_poll (
  id TEXT PRIMARY KEY,
  polled_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);
