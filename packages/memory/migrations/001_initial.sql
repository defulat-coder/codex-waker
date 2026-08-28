CREATE TABLE memory_documents (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('waker', 'project', 'group')),
  scope_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_memory_documents_scope
  ON memory_documents(scope_type, scope_id, source, updated_at DESC);

CREATE TABLE memory_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES memory_documents(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  operation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);

CREATE INDEX idx_memory_versions_document
  ON memory_versions(document_id, version DESC);

CREATE TABLE memory_snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES memory_documents(id),
  version_id TEXT NOT NULL REFERENCES memory_versions(id),
  operation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_snapshots_document
  ON memory_snapshots(document_id, created_at DESC);

CREATE TABLE memory_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES memory_documents(id),
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_memory_timeline_scope_time
  ON memory_timeline(scope_type, scope_id, source, created_at DESC);
