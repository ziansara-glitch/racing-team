-- 0004 — Motore progetti e task: stati configurabili, workflow, campi personalizzati, milestone,
-- dipendenze, sottotask. Sostituisce la tabella `tasks` legacy (rinominata `legacy_tasks`, tenuta
-- finché non arriva la migrazione di "contract").
-- Tutte le chiavi esterne tra tabelle di tenant sono composte (x_id, org_id) o (x_id, project_id).

-- La rinomina va PRIMA di creare la nuova `tasks`.
ALTER TABLE tasks RENAME TO legacy_tasks;

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  key TEXT NOT NULL CHECK (key GLOB '[A-Z][A-Z0-9]*' AND length(key) BETWEEN 2 AND 8),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('private', 'team', 'org')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  color TEXT NOT NULL DEFAULT '#6366f1',
  owner_membership_id INTEGER,
  team_id INTEGER,
  start_date TEXT,
  due_date TEXT,
  -- Con workflow "limitato" sono ammesse solo le transizioni elencate in workflow_transitions.
  workflow_restricted INTEGER NOT NULL DEFAULT 0 CHECK (workflow_restricted IN (0, 1)),
  next_task_number INTEGER NOT NULL DEFAULT 1,
  template_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (id, org_id),
  UNIQUE (org_id, key),
  FOREIGN KEY (owner_membership_id, org_id) REFERENCES memberships (id, org_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
);
CREATE INDEX projects_org_status_idx ON projects (org_id, status);

CREATE TABLE project_members (
  project_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('manager', 'member', 'viewer')),
  PRIMARY KEY (project_id, membership_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);
CREATE INDEX project_members_membership_idx ON project_members (membership_id);

CREATE TABLE project_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('backlog', 'todo', 'in_progress', 'review', 'done', 'archived')),
  color TEXT NOT NULL DEFAULT '#64748b',
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, project_id),
  UNIQUE (project_id, name),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE workflow_transitions (
  project_id INTEGER NOT NULL,
  from_status_id INTEGER NOT NULL,
  to_status_id INTEGER NOT NULL,
  PRIMARY KEY (project_id, from_status_id, to_status_id),
  FOREIGN KEY (from_status_id, project_id) REFERENCES project_statuses (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (to_status_id, project_id) REFERENCES project_statuses (id, project_id) ON DELETE CASCADE
);

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  completed_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'checkbox', 'url')),
  options TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, project_id),
  UNIQUE (project_id, name),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  parent_task_id INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status_id INTEGER NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_membership_id INTEGER,
  reporter_membership_id INTEGER,
  milestone_id INTEGER,
  start_date TEXT,
  due_date TEXT,
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  -- Ordine nelle colonne della board: posizione frazionaria, così uno spostamento tocca una sola riga.
  position REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (id, org_id),
  UNIQUE (id, project_id),
  UNIQUE (project_id, number),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (status_id, project_id) REFERENCES project_statuses (id, project_id),
  FOREIGN KEY (parent_task_id, project_id) REFERENCES tasks (id, project_id),
  FOREIGN KEY (milestone_id, project_id) REFERENCES milestones (id, project_id),
  FOREIGN KEY (assignee_membership_id, org_id) REFERENCES memberships (id, org_id),
  FOREIGN KEY (reporter_membership_id, org_id) REFERENCES memberships (id, org_id),
  CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date)
);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status_id, position);
CREATE INDEX tasks_assignee_idx ON tasks (org_id, assignee_membership_id, completed_at, due_date);
CREATE INDEX tasks_parent_idx ON tasks (project_id, parent_task_id);
CREATE INDEX tasks_due_idx ON tasks (org_id, due_date) WHERE deleted_at IS NULL;

CREATE TABLE task_dependencies (
  task_id INTEGER NOT NULL,
  depends_on_task_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id, project_id) REFERENCES tasks (id, project_id) ON DELETE CASCADE,
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE task_field_values (
  task_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (task_id, field_id),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (field_id, project_id) REFERENCES custom_fields (id, project_id) ON DELETE CASCADE
);

-- ───────── Compiti legacy -> progetto "Attività del team" (GEN) ─────────
-- Stati storici ('Da fare', 'In corso', 'Fatto') corrispondono a Da fare / In corso / Completato;
-- il reparto diventa il campo personalizzato "Reparto".
INSERT INTO projects (org_id, key, name, description, status, visibility, color, owner_membership_id, next_task_number)
SELECT 1, 'GEN', 'Attività del team', 'Compiti trasversali dei reparti (importati dal vecchio elenco compiti).', 'active', 'org', '#d5231b',
       (SELECT id FROM memberships WHERE org_id = 1 AND role = 'super_admin' ORDER BY id LIMIT 1),
       (SELECT COUNT(*) + 1 FROM legacy_tasks);

INSERT INTO project_statuses (org_id, project_id, name, category, color, position)
SELECT 1, p.id, s.name, s.category, s.color, s.position
  FROM projects p,
       (SELECT 'Backlog' AS name, 'backlog' AS category, '#94a3b8' AS color, 0 AS position
        UNION ALL SELECT 'Da fare', 'todo', '#3b82f6', 1
        UNION ALL SELECT 'In corso', 'in_progress', '#f59e0b', 2
        UNION ALL SELECT 'In revisione', 'review', '#a855f7', 3
        UNION ALL SELECT 'Completato', 'done', '#10b981', 4
        UNION ALL SELECT 'Archiviato', 'archived', '#6b7280', 5) s
 WHERE p.org_id = 1 AND p.key = 'GEN';

INSERT INTO custom_fields (org_id, project_id, name, type, options, position)
SELECT 1, p.id, 'Reparto', 'select',
       '["Direzione","Aerodinamica","Business","Telaio & Dinamica","Software & Telemetria","Motore","Media & Design","Officina"]', 0
  FROM projects p WHERE p.org_id = 1 AND p.key = 'GEN';

INSERT INTO tasks (org_id, project_id, number, title, status_id, assignee_membership_id, due_date, position, completed_at)
SELECT 1, p.id, ROW_NUMBER() OVER (ORDER BY lt.id), lt.title, st.id, m.id, lt.due, lt.id * 1000.0,
       CASE WHEN lt.status = 'Fatto' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
  FROM legacy_tasks lt
  JOIN projects p ON p.org_id = 1 AND p.key = 'GEN'
  JOIN project_statuses st ON st.project_id = p.id
       AND st.name = CASE lt.status WHEN 'Da fare' THEN 'Da fare' WHEN 'In corso' THEN 'In corso' ELSE 'Completato' END
  LEFT JOIN memberships m ON m.org_id = 1 AND m.user_id = lt.assignee_id;

INSERT INTO task_field_values (task_id, field_id, project_id, value)
SELECT t.id, f.id, p.id, json_quote(lt.department)
  FROM legacy_tasks lt
  JOIN projects p ON p.org_id = 1 AND p.key = 'GEN'
  JOIN tasks t ON t.project_id = p.id AND t.position = lt.id * 1000.0
  JOIN custom_fields f ON f.project_id = p.id AND f.name = 'Reparto';
