-- 0008 — Sondaggi settimanali di riunione e risposte di presenza.

CREATE TABLE meeting_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Lunedì della settimana a cui si riferisce la riunione.
  week_start TEXT NOT NULL,
  meeting_type TEXT NOT NULL DEFAULT 'in_person' CHECK (meeting_type IN ('in_person', 'online', 'hybrid')),
  location TEXT NOT NULL DEFAULT '',
  meeting_url TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 5 AND 600),
  -- Scadenza per votare (ora locale AAAA-MM-GGTHH:MM); dopo, il sondaggio non accetta più voti.
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'finalized', 'cancelled')),
  -- Ripetizione settimanale: alla chiusura di una settimana, un amministratore (o lo scheduler) crea la successiva come bozza.
  recurrence TEXT CHECK (recurrence IN ('weekly')),
  recur_until TEXT,
  parent_poll_id INTEGER,
  final_option_id INTEGER,
  event_id INTEGER REFERENCES events(id),
  finalized_by_membership_id INTEGER,
  finalized_at TEXT,
  created_by_membership_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  closed_at TEXT,
  UNIQUE (id, org_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id),
  FOREIGN KEY (created_by_membership_id, org_id) REFERENCES memberships (id, org_id)
);
CREATE INDEX meeting_polls_team_idx ON meeting_polls (org_id, team_id, status);

CREATE TABLE poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, poll_id),
  UNIQUE (poll_id, date, start_time),
  FOREIGN KEY (poll_id, org_id) REFERENCES meeting_polls (id, org_id) ON DELETE CASCADE,
  CHECK (end_time > start_time)
);

-- Chi è stato invitato a votare: fotografia dei membri del team alla pubblicazione, così i
-- "non rispondenti" restano corretti anche se il team cambia dopo.
CREATE TABLE poll_invitees (
  poll_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  PRIMARY KEY (poll_id, membership_id),
  FOREIGN KEY (poll_id, org_id) REFERENCES meeting_polls (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('yes', 'maybe', 'no')),
  -- Una sola opzione "preferita" per persona (garantita dal servizio e dall'indice parziale sotto).
  preferred INTEGER NOT NULL DEFAULT 0 CHECK (preferred IN (0, 1)),
  voted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (option_id, membership_id),
  FOREIGN KEY (option_id, poll_id) REFERENCES poll_options (id, poll_id) ON DELETE CASCADE,
  FOREIGN KEY (poll_id, membership_id) REFERENCES poll_invitees (poll_id, membership_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX poll_votes_preferred_idx ON poll_votes (poll_id, membership_id) WHERE preferred = 1;

-- Risposta esplicita di presenza: "Sono presente" / "Non sono presente" (+ "Forse").
CREATE TABLE poll_attendance (
  poll_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attending', 'not_attending', 'tentative')),
  note TEXT NOT NULL DEFAULT '',
  responded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (poll_id, membership_id),
  FOREIGN KEY (poll_id, membership_id) REFERENCES poll_invitees (poll_id, membership_id) ON DELETE CASCADE
);
