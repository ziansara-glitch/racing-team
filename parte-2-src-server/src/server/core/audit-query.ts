import { ForbiddenError, type Actor } from "../authz/authorize.ts";
import { all, one, type Conn, type Param } from "./sql.ts";

export type AuditRow = { id: number; at: string; action: string; actorName: string | null; entityType: string | null; entityId: number | null; meta: Record<string, unknown> };

/** Consultazione del registro di audit: solo chi ha `audit.read` su tutta l'organizzazione. Paginata, con filtri. */
export function listAudit(conn: Conn, actor: Actor, f: { action?: string; actorUserId?: number; from?: string; to?: string; page?: number; pageSize?: number } = {}): { rows: AuditRow[]; total: number; pageSize: number } {
  if (actor.permissions["audit.read"] !== "all") throw new ForbiddenError("audit.read");
  const where = ["a.org_id = ?"];
  const params: Param[] = [actor.orgId];
  if (f.action) { where.push("a.action LIKE ? ESCAPE '\\'"); params.push(`${f.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`); }
  if (f.actorUserId) { where.push("a.actor_user_id = ?"); params.push(f.actorUserId); }
  if (f.from) { where.push("a.at >= ?"); params.push(f.from); }
  if (f.to) { where.push("a.at <= ?"); params.push(`${f.to}T23:59:59.999Z`); }
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const total = one<{ n: number }>(conn, `SELECT COUNT(*) AS n FROM audit_logs a WHERE ${where.join(" AND ")}`, ...params)?.n ?? 0;
  const rows = all<{ id: number; at: string; action: string; name: string | null; entity_type: string | null; entity_id: number | null; meta: string }>(
    conn, `SELECT a.id, a.at, a.action, u.name, a.entity_type, a.entity_id, a.meta FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);
  return { total, pageSize, rows: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actorName: r.name, entityType: r.entity_type, entityId: r.entity_id, meta: JSON.parse(r.meta) })) };
}
