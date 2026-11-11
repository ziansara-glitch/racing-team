-- 0007 — Calendari (amministratori condiviso + uno per team) ed eventi con ricorrenza.
-- Gli orari sono "ora locale dell'organizzazione" (AAAA-MM-GGTHH:MM, senza fuso): il fuso è una
-- proprietà dell'organizzazione e le ricorrenze non scivolano con l'ora legale.

CREATE TABLE calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('admin', 'team')),
  team_id INTEGER,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, org_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id),
  CHECK ((kind = 'team') = (team_id IS NOT NULL))
);
CREATE UNIQUE INDEX calendars_team_idx ON calendars (org_id, team_id) WHERE kind = 'team';
CREATE UNIQUE INDEX calendars_admin_idx ON calendars (org_id) WHERE kind = 'admin';

-- Permessi espliciti oltre a quelli impliciti (admin: tutti gli amministratori; team: i membri del team).
CREATE TABLE calendar_grants (
  calendar_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('view', 'edit')),
  PRIMARY KEY (calendar_id, membership_id),
  FOREIGN KEY (calendar_id, org_id) REFERENCES calendars (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  calendar_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'meeting', 'deadline', 'activity')),
  category_id INTEGER,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  location TEXT NOT NULL DEFAULT '',
  meeting_url TEXT NOT NULL DEFAULT '',
  color TEXT,
  recur_freq TEXT CHECK (recur_freq IN ('daily', 'weekly', 'monthly')),
  recur_interval INTEGER NOT NULL DEFAULT 1 CHECK (recur_interval BETWEEN 1 AND 52),
  -- Giorni della settimana per la ricorrenza settimanale, es. 'MO,WE' (vuoto = il giorno dell'inizio).
  recur_byday TEXT NOT NULL DEFAULT '',
  recur_until TEXT,
  recur_count INTEGER CHECK (recur_count IS NULL OR recur_count BETWEEN 1 AND 500),
  created_by_membership_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  UNIQUE (id, org_id),
  FOREIGN KEY (calendar_id, org_id) REFERENCES calendars (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id, org_id) REFERENCES event_categories (id, org_id),
  FOREIGN KEY (created_by_membership_id, org_id) REFERENCES memberships (id, org_id),
  CHECK (ends_at >= starts_at)
);
CREATE INDEX events_calendar_idx ON events (calendar_id, starts_at) WHERE deleted_at IS NULL;

-- Occorrenze di una serie annullate singolarmente.
CREATE TABLE event_exceptions (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  PRIMARY KEY (event_id, occurrence_date)
);

-- Invitati espliciti (oltre alle persone con accesso al calendario).
CREATE TABLE event_participants (
  event_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  PRIMARY KEY (event_id, membership_id),
  FOREIGN KEY (event_id, org_id) REFERENCES events (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

-- Risposta all'invito, per singola occorrenza (data di inizio dell'occorrenza).
CREATE TABLE event_responses (
  event_id INTEGER NOT NULL,
  occurrence_date TEXT NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  rsvp TEXT NOT NULL CHECK (rsvp IN ('yes', 'no', 'maybe')),
  responded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, occurrence_date, membership_id),
  FOREIGN KEY (event_id, org_id) REFERENCES events (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

-- Presenza effettiva (rilevata dopo l'evento da chi lo gestisce).
CREATE TABLE event_attendance (
  event_id INTEGER NOT NULL,
  occurrence_date TEXT NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('present', 'absent', 'late', 'excused')),
  recorded_by_membership_id INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, occurrence_date, membership_id),
  FOREIGN KEY (event_id, org_id) REFERENCES events (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

CREATE TABLE event_reminders (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes BETWEEN 0 AND 20160),
  PRIMARY KEY (event_id, offset_minutes)
);
-- Evita promemoria doppi: una riga per (occorrenza, persona, anticipo).
CREATE TABLE reminder_log (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  membership_id INTEGER NOT NULL,
  offset_minutes INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (event_id, occurrence_date, membership_id, offset_minutes)
);

CREATE TABLE event_attachments (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, attachment_id)
);

-- Un calendario per gli amministratori e uno per ogni team esistente.
INSERT INTO calendars (org_id, kind, name, color) VALUES (1, 'admin', 'Calendario amministratori', '#d5231b');
INSERT INTO calendars (org_id, kind, team_id, name, color)
SELECT org_id, 'team', id, 'Calendario ' || name, color FROM teams WHERE org_id = 1 AND deleted_at IS NULL;
