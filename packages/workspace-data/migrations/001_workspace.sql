CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  waker_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  path TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing', 'ready', 'error', 'archived')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX projects_waker_idx ON projects(waker_id, updated_at DESC);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  waker_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'api', 'event')),
  schedule TEXT,
  prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run INTEGER,
  next_run INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind != 'schedule' OR (schedule IS NOT NULL AND length(trim(schedule)) > 0))
);

CREATE INDEX automations_waker_idx ON automations(waker_id, updated_at DESC);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('disconnected', 'connected', 'error')),
  config_metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  type TEXT NOT NULL CHECK (length(trim(type)) > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  waker_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (status != 'completed' OR completed_at IS NOT NULL),
  CHECK (status != 'failed' OR (completed_at IS NOT NULL AND error IS NOT NULL))
);

CREATE INDEX tasks_waker_idx ON tasks(waker_id, created_at DESC);
CREATE INDEX tasks_project_idx ON tasks(project_id);
