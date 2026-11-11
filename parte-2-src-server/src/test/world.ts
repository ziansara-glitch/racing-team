import type { DatabaseSync } from "node:sqlite";
import { loadActor } from "@/server/authz/actor";
import type { Actor } from "@/server/authz/authorize";
import type { Role } from "@/server/authz/permissions";
import { migratedDb } from "./helpers";

/** Piccolo "mondo" di test: database migrato (org 1) + fabbrica di persone con ruolo e team. */
export function world(existing?: DatabaseSync) {
  const conn: DatabaseSync = existing ?? migratedDb();
  let n = 0;
  const teamId = (name: string, orgId = 1): number => {
    const row = conn.prepare("SELECT id FROM teams WHERE org_id = ? AND name = ?").get(orgId, name) as { id: number } | undefined;
    if (row) return row.id;
    return Number(conn.prepare("INSERT INTO teams (org_id, name) VALUES (?, ?)").run(orgId, name).lastInsertRowid);
  };
  /** Crea utente + membership attiva (+ appartenenza ai team indicati) e restituisce l'Actor. */
  const person = (name: string, role: Role, teams: string[] = [], orgId = 1): Actor => {
    n++;
    const userId = Number(
      conn.prepare("INSERT INTO users (name, email, password_hash, role, department, title) VALUES (?, ?, 'x', 'member', 'Motore', 'Membro')").run(name, `p${n}-${name.toLowerCase().replace(/\W/g, "")}@t.l`).lastInsertRowid,
    );
    const membershipId = Number(conn.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)").run(orgId, userId, role).lastInsertRowid);
    for (const t of teams) conn.prepare("INSERT INTO team_members (team_id, membership_id, org_id) VALUES (?, ?, ?)").run(teamId(t, orgId), membershipId, orgId);
    return loadActor(conn, userId, orgId)!;
  };
  /** Ricarica l'Actor (dopo cambi di team o di ruolo). */
  const reload = (a: Actor): Actor => loadActor(conn, a.userId, a.orgId)!;
  const otherOrg = (slug: string, role: Role = "super_admin"): Actor => {
    const orgId = Number(conn.prepare("INSERT INTO organizations (name, slug) VALUES (?, ?)").run(slug, slug).lastInsertRowid);
    return person(`Admin ${slug}`, role, [], orgId);
  };
  return { conn, person, reload, teamId, otherOrg };
}
