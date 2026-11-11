import { publish, type RtEvent } from "./bus.ts";
import { all, type Conn } from "./sql.ts";
import { afterCommit } from "./tx.ts";

/** Pubblica un evento dopo il commit della transazione corrente. */
export function emit(conn: Conn, event: RtEvent, recipients: number[]): void {
  if (recipients.length === 0) return;
  afterCommit(conn, () => publish(event, recipients));
}

/** Membri attivi di un team. */
export const teamMemberIds = (conn: Conn, orgId: number, teamId: number): number[] =>
  all<{ id: number }>(
    conn,
    `SELECT tm.membership_id AS id FROM team_members tm JOIN memberships m ON m.id = tm.membership_id
      WHERE tm.org_id = ? AND tm.team_id = ? AND m.status = 'active'`,
    orgId,
    teamId,
  ).map((r) => r.id);

/** Amministratori che vedono tutta l'organizzazione (admin.access = all, cioè super admin e admin dell'organizzazione di default). */
export const orgAdminIds = (conn: Conn, orgId: number): number[] =>
  all<{ id: number }>(conn, "SELECT id FROM memberships WHERE org_id = ? AND status = 'active' AND role IN ('super_admin', 'org_admin')", orgId).map((r) => r.id);
