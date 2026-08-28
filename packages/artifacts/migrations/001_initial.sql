CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE session_attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  stored_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  created_at TEXT NOT NULL,
  UNIQUE(session_id, sha256)
);

CREATE INDEX session_attachments_session_created
  ON session_attachments(session_id, created_at, id);
CREATE INDEX session_attachments_stored_path
  ON session_attachments(stored_path);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  content_preview TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX artifacts_session_created ON artifacts(session_id, created_at, id);

CREATE TABLE file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'update', 'delete')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX file_changes_session_created ON file_changes(session_id, created_at, id);
