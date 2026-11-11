import { loadActor } from "../authz/actor.ts";
import { can, ForbiddenError, NotFoundError, type Actor } from "../authz/authorize.ts";
import type { Permission } from "../authz/permissions.ts";
import { ValidationError } from "./errors.ts";
import { one, placeholders, type Conn, type Param } from "./sql.ts";
import type { ProjectRole, ProjectStatus, Visibility, Priority } from "./types.ts";

export type ProjectRow = {
  id: number;
  org_id: number;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  visibility: Visibility;
  priority: Priority;
  color: string;
  owner_membership_id: number | null;
  team_id: number | null;
  start_date: string | null;
  due_date: string | null;
  workflow_restricted: number;
  next_task_number: number;
  template_key: string | null;
  created_at: string;
  updated_at: string;
};

export type Access = { role: ProjectRole | null; read: boolean; manage: boolean; writeTasks: boolean; comment: boolean; archived: boolean };

/**
 * Cosa può fare `actor` su un progetto. Unica definizione di "può vedere / modificare": letture,
 * ricerca, esportazioni e notifiche passano da qui (o dal suo equivalente SQL, visibleProjects).
 */
export function projectAccess(conn: Conn, actor: Actor, p: ProjectRow): Access {
  const role = one<{ role: ProjectRole }>(conn, "SELECT role FROM project_members WHERE project_id = ? AND membership_id = ?", p.id, actor.membershipId)?.role ?? null;
  const scope = actor.permissions["projects.read"];
  const isOwner = p.owner_membership_id === actor.membershipId;
  const inTeam = p.team_id != null && actor.teamIds.includes(p.team_id);
  const read =
    p.org_id === actor.orgId &&
    !!scope &&
    (scope === "all" || isOwner || role !== null || p.visibility === "org" || (p.visibility === "team" && inTeam));
  const ctx = { orgId: p.org_id, ownerMembershipId: p.owner_membership_id, teamId: p.team_id };
  const archived = p.status === "archived";
  return {
    role,
    read,
    archived,
    manage: read && can(actor, "projects.manage", { ...ctx, actorInProject: role === "manager" }),
    writeTasks: read && !archived && can(actor, "tasks.write", { ...ctx, actorInProject: role === "manager" || role === "member" }),
    // Su un progetto visibile a tutta l'organizzazione commenta chiunque abbia il permesso: il feedback tra team
    // non richiede di essere membri. Modificare i task invece sì (writeTasks).
    comment:
      read && !archived
        ? can(actor, "comments.write", { ...ctx, actorInProject: role === "manager" || role === "member" }) || (p.visibility === "org" && !!actor.permissions["comments.write"])
        : false,
  };
}

/** Frammento SQL equivalente a `access.read`, per le liste. Alias della tabella progetti: `p`. */
export function visibleProjects(actor: Actor, alias = "p"): { sql: string; params: Param[] } {
  const scope = actor.permissions["projects.read"];
  if (!scope) return { sql: "0", params: [] };
  let sql = `${alias}.org_id = ? AND ${alias}.deleted_at IS NULL`;
  const params: Param[] = [actor.orgId];
  if (scope === "scoped") {
    sql += ` AND (${alias}.owner_membership_id = ? OR ${alias}.visibility = 'org'
             OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias}.id AND pm.membership_id = ?)`;
    params.push(actor.membershipId, actor.membershipId);
    if (actor.teamIds.length > 0) {
      sql += ` OR (${alias}.visibility = 'team' AND ${alias}.team_id IN (${placeholders(actor.teamIds.length)}))`;
      params.push(...actor.teamIds);
    }
    sql += ")";
  }
  return { sql, params };
}

type Need = "read" | "manage" | "writeTasks" | "comment";
const NEED_PERMISSION: Record<Exclude<Need, "read">, Permission> = { manage: "projects.manage", writeTasks: "tasks.write", comment: "comments.write" };

/** Carica un progetto (per id o chiave) e verifica il livello richiesto. Un progetto invisibile = "non trovato". */
export function requireProject(conn: Conn, actor: Actor, ref: number | string, need: Need = "read"): { project: ProjectRow; access: Access } {
  const project =
    typeof ref === "number"
      ? one<ProjectRow>(conn, "SELECT * FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL", ref, actor.orgId)
      : one<ProjectRow>(conn, "SELECT * FROM projects WHERE key = ? AND org_id = ? AND deleted_at IS NULL", ref.toUpperCase(), actor.orgId);
  if (!project) throw new NotFoundError("Progetto");
  const access = projectAccess(conn, actor, project);
  if (!access.read) throw new NotFoundError("Progetto");
  if (need !== "read" && !access[need]) {
    if (need === "writeTasks" && access.archived) throw new ValidationError("Il progetto è archiviato: riattivalo per modificare i task.");
    throw new ForbiddenError(NEED_PERMISSION[need]);
  }
  return { project, access };
}

/** Un'altra persona dell'organizzazione può vedere questo progetto? (per assegnazioni e menzioni) */
export function membershipCanRead(conn: Conn, orgId: number, membershipId: number, project: ProjectRow): boolean {
  const m = one<{ user_id: number }>(conn, "SELECT user_id FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, orgId);
  if (!m) return false;
  const actor = loadActor(conn, m.user_id, orgId);
  return !!actor && actor.membershipId === membershipId && projectAccess(conn, actor, project).read;
}
