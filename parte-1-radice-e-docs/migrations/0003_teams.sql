-- 0003 — Team e reparti come DATI (prima erano costanti TypeScript in lib/data.ts).
-- Le chiavi esterne sono composte (x_id, org_id): un riferimento tra organizzazioni diverse è
-- impossibile già a livello di database.

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  parent_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'department' CHECK (kind IN ('department', 'team')),
  responsibilities TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (id, org_id),
  UNIQUE (org_id, name),
  FOREIGN KEY (parent_id, org_id) REFERENCES teams (id, org_id)
);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  PRIMARY KEY (team_id, membership_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);
CREATE INDEX team_members_membership_idx ON team_members (membership_id);

-- Reparti storici dell'app (lib/data.ts) + eventuali reparti già presenti sugli utenti.
INSERT OR IGNORE INTO teams (org_id, name, kind)
VALUES (1, 'Direzione', 'department'), (1, 'Aerodinamica', 'department'), (1, 'Business', 'department'),
       (1, 'Telaio & Dinamica', 'department'), (1, 'Software & Telemetria', 'department'),
       (1, 'Motore', 'department'), (1, 'Media & Design', 'department'), (1, 'Officina', 'department');
INSERT OR IGNORE INTO teams (org_id, name, kind)
SELECT DISTINCT 1, department, 'department' FROM users WHERE department <> '';

-- Responsabile di reparto = titolo che inizia per "Responsabile" (così lo seleziona il seed storico).
INSERT INTO team_members (team_id, membership_id, org_id, role)
SELECT t.id, m.id, 1, CASE WHEN u.title LIKE 'Responsabile%' THEN 'lead' ELSE 'member' END
  FROM users u
  JOIN memberships m ON m.user_id = u.id AND m.org_id = 1
  JOIN teams t ON t.org_id = 1 AND t.name = u.department;
