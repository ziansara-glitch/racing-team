import type { Actor } from "../authz/authorize.ts";
import { all, run, type Conn } from "./sql.ts";

export type ActivityInput = {
  orgId: number;
  projectId: number | null;
  entityType: "project" | "task";
  entityId: number;
  actorMembershipId: number | null;
  verb: string;
  meta?: Record<string, unknown>;
};

export function logActivity(conn: Conn, a: ActivityInput): void {
  run(
    conn,
    "INSERT INTO activity (org_id, project_id, entity_type, entity_id, actor_membership_id, verb, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
    a.orgId,
    a.projectId,
    a.entityType,
    a.entityId,
    a.actorMembershipId,
    a.verb,
    JSON.stringify(a.meta ?? {}),
  );
}

export type ActivityDTO = { id: number; verb: string; actorName: string | null; entityType: string; entityId: number; meta: Record<string, unknown>; at: string };

type Row = { id: number; verb: string; actor_name: string | null; entity_type: string; entity_id: number; meta: string; at: string };
const toDTO = (r: Row): ActivityDTO => ({ id: r.id, verb: r.verb, actorName: r.actor_name, entityType: r.entity_type, entityId: r.entity_id, meta: JSON.parse(r.meta), at: r.at });

const BASE = `SELECT a.id, a.verb, u.name AS actor_name, a.entity_type, a.entity_id, a.meta, a.at
                FROM activity a LEFT JOIN memberships m ON m.id = a.actor_membership_id LEFT JOIN users u ON u.id = m.user_id`;

// L'accesso al progetto/task va già verificato dal chiamante (requireProject/requireTask).
export const projectActivity = (conn: Conn, actor: Actor, projectId: number, limit = 30): ActivityDTO[] =>
  all<Row>(conn, `${BASE} WHERE a.org_id = ? AND a.project_id = ? ORDER BY a.id DESC LIMIT ?`, actor.orgId, projectId, limit).map(toDTO);

export const taskActivity = (conn: Conn, actor: Actor, taskId: number, limit = 50): ActivityDTO[] =>
  all<Row>(conn, `${BASE} WHERE a.org_id = ? AND a.entity_type = 'task' AND a.entity_id = ? ORDER BY a.id DESC LIMIT ?`, actor.orgId, taskId, limit).map(toDTO);
