import type { Actor } from "../authz/authorize.ts";
import { hasAdminAccess } from "./teams.ts";
import { all, type Conn, type Param } from "./sql.ts";

export type PersonDTO = { membershipId: number; name: string; title: string; department: string; role: string };

/** Ricerca nella directory dell'organizzazione (solo membri attivi). `adminsOnly` serve ai gruppi riservati agli amministratori. */
export function searchPeople(conn: Conn, actor: Actor, opts: { q?: string; adminsOnly?: boolean; teamId?: number; limit?: number } = {}): PersonDTO[] {
  if (opts.adminsOnly && !hasAdminAccess(actor)) return [];
  const where = ["m.org_id = ?", "m.status = 'active'", "m.id <> ?"];
  const params: Param[] = [actor.orgId, actor.membershipId];
  if (opts.adminsOnly) where.push("m.role IN ('super_admin','org_admin','team_admin')");
  if (opts.teamId) { where.push("EXISTS (SELECT 1 FROM team_members tm WHERE tm.membership_id = m.id AND tm.team_id = ?)"); params.push(opts.teamId); }
  if (opts.q?.trim()) {
    const p = `%${opts.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(u.name LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')");
    params.push(p, p);
  }
  return all<{ id: number; name: string; title: string; department: string; role: string }>(
    conn, `SELECT m.id, u.name, m.title, u.department, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${where.join(" AND ")} ORDER BY u.name LIMIT ?`, ...params, Math.min(opts.limit ?? 30, 100),
  ).map((r) => ({ membershipId: r.id, name: r.name, title: r.title, department: r.department, role: r.role }));
}
