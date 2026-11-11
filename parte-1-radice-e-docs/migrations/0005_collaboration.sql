-- 0005 — Collaborazione: commenti con menzioni, attività, notifiche, viste salvate, template di
-- progetto, inviti e indice di ricerca full-text (FTS5).

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'project')),
  entity_id INTEGER NOT NULL,
  author_membership_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mentions)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  edited_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (author_membership_id, org_id) REFERENCES memberships (id, org_id)
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at);

-- Cronologia leggibile dagli utenti (diversa dall'audit di sicurezza).
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id INTEGER,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_membership_id INTEGER,
  verb TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX activity_project_idx ON activity (project_id, at);
CREATE INDEX activity_entity_idx ON activity (entity_type, entity_id, at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  recipient_membership_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  actor_membership_id INTEGER,
  -- Se presente, la stessa notifica non viene creata due volte per lo stesso destinatario.
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (recipient_membership_id, dedupe_key),
  FOREIGN KEY (recipient_membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);
CREATE INDEX notifications_inbox_idx ON notifications (recipient_membership_id, read_at, created_at);

CREATE TABLE notification_preferences (
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0, 1)),
  PRIMARY KEY (membership_id, kind)
);

-- Viste salvate: filtri, ordinamento, raggruppamento e colonne di una vista, memorizzati come query string.
CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  project_id INTEGER,
  owner_membership_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  view_type TEXT NOT NULL CHECK (view_type IN ('table', 'board', 'calendar', 'timeline', 'gantt')),
  query TEXT NOT NULL DEFAULT '',
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);
CREATE INDEX saved_views_project_idx ON saved_views (org_id, project_id);

-- Template creati dall'organizzazione (quelli predefiniti vivono nel codice).
CREATE TABLE project_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  created_by_membership_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, name)
);

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('org_admin', 'team_admin', 'project_manager', 'member', 'viewer')),
  team_id INTEGER,
  -- Solo l'hash del token: una copia del database non permette di accettare inviti.
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_membership_id INTEGER,
  expires_at INTEGER NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id)
);
CREATE UNIQUE INDEX invitations_pending_idx ON invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Ricerca globale. L'indice contiene solo testo: i permessi si applicano SEMPRE dopo, con join
-- sulla visibilità della risorsa (vedi core/search.ts).
CREATE VIRTUAL TABLE search_index USING fts5(
  title,
  body,
  org_id UNINDEXED,
  project_id UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO search_index (title, body, org_id, project_id, entity_type, entity_id)
SELECT name, description, org_id, id, 'project', id FROM projects WHERE deleted_at IS NULL;
INSERT INTO search_index (title, body, org_id, project_id, entity_type, entity_id)
SELECT title, description, org_id, project_id, 'task', id FROM tasks WHERE deleted_at IS NULL;
