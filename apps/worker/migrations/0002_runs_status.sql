-- The DO persists run state with a `status` column (indexed by resumeStaleRuns);
-- it was missing from the initial schema.

ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'done';

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
