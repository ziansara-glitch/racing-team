CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  department TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Membro',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Da fare' CHECK (status IN ('Da fare', 'In corso', 'Fatto'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  place TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  going INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Entrata', 'Uscita')),
  category TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  course TEXT NOT NULL,
  year TEXT NOT NULL,
  interests TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Nuova' CHECK (status IN ('Nuova', 'Colloquio', 'Accettata', 'Rifiutata'))
);
