CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  waker_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command TEXT,
  url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('disabled', 'ready', 'error')),
  tools TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (transport != 'stdio' OR (command IS NOT NULL AND length(trim(command)) > 0)),
  CHECK (transport != 'http' OR (url IS NOT NULL AND length(trim(url)) > 0))
);

CREATE INDEX connectors_waker_idx ON connectors(waker_id, updated_at DESC);

CREATE TABLE permission_policies (
  waker_id TEXT PRIMARY KEY,
  sandbox_mode TEXT NOT NULL CHECK (sandbox_mode IN ('read-only', 'workspace-write', 'danger-full-access')),
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('never', 'untrusted', 'on-request', 'on-failure')),
  tool_guard TEXT NOT NULL CHECK (tool_guard IN ('deny', 'ask', 'allow')),
  file_guard TEXT NOT NULL CHECK (file_guard IN ('deny', 'ask', 'allow')),
  builtin_tools TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE human_actions (
  id TEXT PRIMARY KEY,
  waker_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('workflow', 'codex')),
  source_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'handled', 'ignored')),
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK (status = 'pending' OR resolved_at IS NOT NULL),
  CHECK (status != 'handled' OR result IS NOT NULL)
);

CREATE INDEX human_actions_waker_idx ON human_actions(waker_id, status, created_at DESC);

CREATE TABLE session_contexts (
  session_id TEXT PRIMARY KEY,
  waker_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  working_directory TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX session_contexts_waker_idx ON session_contexts(waker_id, updated_at DESC);
