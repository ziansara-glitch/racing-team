-- 0009 — Chat: conversazioni (gruppi admin, chat di team, diretti, annunci), messaggi, allegati,
-- reazioni, messaggi fissati, sticker, blocchi.

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('admin_group', 'team_group', 'direct', 'announcement')),
  team_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  avatar_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  -- Per i diretti: "idPiùPiccolo:idPiùGrande" delle membership, così esiste una sola conversazione per coppia.
  direct_key TEXT,
  -- Richieste di messaggio: 'pending' finché il destinatario non accetta (chi scrive può mandare un solo messaggio).
  request_status TEXT CHECK (request_status IN ('pending', 'accepted', 'declined')),
  created_by_membership_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_message_at TEXT,
  archived_at TEXT,
  UNIQUE (id, org_id),
  UNIQUE (org_id, direct_key),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id),
  FOREIGN KEY (created_by_membership_id, org_id) REFERENCES memberships (id, org_id),
  CHECK ((kind IN ('team_group', 'announcement')) = (team_id IS NOT NULL)),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);
-- Una chat di gruppo e un canale annunci per team.
CREATE UNIQUE INDEX conversations_team_chat_idx ON conversations (org_id, team_id) WHERE kind = 'team_group';
CREATE UNIQUE INDEX conversations_team_announce_idx ON conversations (org_id, team_id) WHERE kind = 'announcement';

-- Iscritti: esplicito per admin_group e direct. Per team_group/announcement l'accesso deriva dall'appartenenza
-- al team (letta a ogni richiesta); qui restano solo le righe di stato di lettura/silenziamento/fissaggio.
CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL,
  membership_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  left_at TEXT,
  PRIMARY KEY (conversation_id, membership_id),
  FOREIGN KEY (conversation_id, org_id) REFERENCES conversations (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_membership_idx ON conversation_members (membership_id);

CREATE TABLE stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id),
  created_by_membership_id INTEGER,
  UNIQUE (org_id, name)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  author_membership_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'audio', 'video', 'file', 'sticker', 'system')),
  body TEXT NOT NULL DEFAULT '',
  reply_to_id INTEGER REFERENCES messages(id),
  forwarded_from_id INTEGER REFERENCES messages(id),
  -- Sticker: chiave di uno sticker predefinito ("builtin:party") o id di uno sticker dell'organizzazione.
  sticker_key TEXT,
  pinned_at TEXT,
  pinned_by_membership_id INTEGER,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (conversation_id, org_id) REFERENCES conversations (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (author_membership_id, org_id) REFERENCES memberships (id, org_id)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id);
CREATE INDEX messages_pinned_idx ON messages (conversation_id) WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE message_attachments (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, attachment_id)
);

CREATE TABLE message_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (message_id, membership_id, emoji)
);

CREATE TABLE user_blocks (
  blocker_membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  blocked_membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (blocker_membership_id, blocked_membership_id),
  CHECK (blocker_membership_id <> blocked_membership_id)
);

-- Una chat e un canale annunci per ogni team esistente.
INSERT INTO conversations (org_id, kind, team_id, title, created_by_membership_id)
SELECT t.org_id, 'team_group', t.id, t.name, (SELECT id FROM memberships WHERE org_id = t.org_id ORDER BY id LIMIT 1)
  FROM teams t WHERE t.deleted_at IS NULL AND EXISTS (SELECT 1 FROM memberships WHERE org_id = t.org_id);
INSERT INTO conversations (org_id, kind, team_id, title, created_by_membership_id)
SELECT t.org_id, 'announcement', t.id, 'Annunci ' || t.name, (SELECT id FROM memberships WHERE org_id = t.org_id ORDER BY id LIMIT 1)
  FROM teams t WHERE t.deleted_at IS NULL AND EXISTS (SELECT 1 FROM memberships WHERE org_id = t.org_id);
