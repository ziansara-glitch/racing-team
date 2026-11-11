-- 0006 — Profili, dettagli dei team, allegati generici e categorie di evento.

ALTER TABLE teams ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE teams ADD COLUMN color TEXT NOT NULL DEFAULT '#6366f1';
-- Ruolo nel team in parole (es. "Capo reparto"), diverso dal ruolo di piattaforma.
ALTER TABLE team_members ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- File caricati (chat, eventi, documenti). Il file vive su disco con una chiave casuale: qui solo i metadati.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  uploader_membership_id INTEGER NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  -- 'pending' finché non è agganciato a un messaggio/evento: i file orfani si possono ripulire.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (id, org_id),
  FOREIGN KEY (uploader_membership_id, org_id) REFERENCES memberships (id, org_id)
);
CREATE INDEX attachments_pending_idx ON attachments (status, created_at);

-- Profilo e privacy di una persona in un'organizzazione.
CREATE TABLE user_profiles (
  membership_id INTEGER PRIMARY KEY REFERENCES memberships(id) ON DELETE CASCADE,
  phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  -- Privacy: mostrare "online"/ultimo accesso ai colleghi; chi può scriverti in privato.
  show_presence INTEGER NOT NULL DEFAULT 1 CHECK (show_presence IN (0, 1)),
  direct_messages TEXT NOT NULL DEFAULT 'team' CHECK (direct_messages IN ('everyone', 'team', 'requests', 'nobody')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE event_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);
INSERT INTO event_categories (org_id, name, color) VALUES
  (1, 'Riunione', '#3b82f6'), (1, 'Scadenza', '#ef4444'), (1, 'Attività', '#10b981'),
  (1, 'Evento', '#a855f7'), (1, 'Trasferta', '#f59e0b'), (1, 'Formazione', '#14b8a6');
