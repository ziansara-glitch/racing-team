import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "@/server/db/migrate";

export const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export function openMemory(): DatabaseSync {
  const conn = new DatabaseSync(":memory:");
  conn.exec("PRAGMA foreign_keys = ON;");
  return conn;
}

/** Database vuoto con tutte le migrazioni applicate. */
export function migratedDb(): DatabaseSync {
  const conn = openMemory();
  migrate(conn, MIGRATIONS_DIR);
  return conn;
}

/** Copia in una cartella temporanea le migrazioni fino a `upTo` (incluso), per simulare un database "vecchio". */
export function migrationsUpTo(upTo: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-mig-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
    if (Number(f.slice(0, 4)) <= upTo) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return dir;
}

export type LegacyUser = { name: string; email: string; role: "admin" | "member"; department: string; title?: string };

/** Inserisce utenti nello schema legacy (colonne role/department/title su users). */
export function insertLegacyUsers(conn: DatabaseSync, users: LegacyUser[]): number[] {
  const stmt = conn.prepare("INSERT INTO users (name, email, password_hash, role, department, title) VALUES (?, ?, 'x', ?, ?, ?)");
  return users.map((u) => Number(stmt.run(u.name, u.email, u.role, u.department, u.title ?? "Membro").lastInsertRowid));
}

/** Aggiunge una seconda organizzazione e un utente con membership al suo interno, per i test di isolamento. */
export function addOrgWithMember(conn: DatabaseSync, slug: string, role = "member"): { orgId: number; userId: number; membershipId: number } {
  const orgId = Number(conn.prepare("INSERT INTO organizations (name, slug) VALUES (?, ?)").run(slug, slug).lastInsertRowid);
  const userId = Number(
    conn
      .prepare("INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, 'x', 'member', 'Business')")
      .run(`User ${slug}`, `${slug}@test.local`).lastInsertRowid,
  );
  const membershipId = Number(conn.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)").run(orgId, userId, role).lastInsertRowid);
  return { orgId, userId, membershipId };
}
