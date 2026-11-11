-- 0002 — Multi-tenancy, ruoli (RBAC), audit log, rate limit persistente, metadati di sessione.
-- Espansione senza rotture: le colonne legacy (users.role / department / title) restano.

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL DEFAULT 'it',
  timezone TEXT NOT NULL DEFAULT 'Europe/Rome',
  -- L'AI è spenta di default: va attivata esplicitamente da chi può gestire le integrazioni.
  ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0, 1)),
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

-- Organizzazione di partenza (assunzione A3: una sola organizzazione, ma ogni tabella ha già org_id).
INSERT INTO organizations (id, name, slug) VALUES (1, 'Recent Team', 'recent-team');

CREATE TABLE memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'org_admin', 'team_admin', 'project_manager', 'member', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'left')),
  title TEXT NOT NULL DEFAULT 'Membro',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (org_id, user_id),
  -- Permette alle tabelle figlie di usare una chiave esterna composta (x_id, org_id).
  UNIQUE (id, org_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Un utente legacy = una membership. admin -> org_admin (conserva l'accesso attuale, budget incluso),
-- member -> member. Il primo admin creato diventa super_admin (modificabile dall'interfaccia).
INSERT INTO memberships (org_id, user_id, role, title)
SELECT 1, u.id,
       CASE
         WHEN u.role = 'admin' AND u.id = (SELECT MIN(id) FROM users WHERE role = 'admin') THEN 'super_admin'
         WHEN u.role = 'admin' THEN 'org_admin'
         ELSE 'member'
       END,
       u.title
  FROM users u;

-- Solo le DEROGHE ai permessi di default (che vivono nel codice): così gli aggiornamenti dei
-- default non cancellano le personalizzazioni di un'organizzazione.
CREATE TABLE role_permission_overrides (
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'org_admin', 'team_admin', 'project_manager', 'member', 'viewer')),
  permission TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'scoped', 'none')),
  PRIMARY KEY (org_id, role, permission)
);

-- Registro di audit: solo aggiunte. Nessun FK sull'utente, la storia deve sopravvivere a lui.
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  request_id TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_logs_org_at_idx ON audit_logs (org_id, at);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs è append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs è append-only'); END;

-- Finestra fissa per bucket+chiave (login, upload, AI...). Sostituisce la Map in memoria.
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

-- Metadati di sessione. ADD COLUMN in SQLite non ammette default non costanti: i valori li scrive l'app.
ALTER TABLE sessions ADD COLUMN org_id INTEGER REFERENCES organizations(id);
ALTER TABLE sessions ADD COLUMN created_at TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
