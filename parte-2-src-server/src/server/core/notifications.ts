import type { Actor } from "../authz/authorize.ts";
import { emit } from "./realtime.ts";
import { all, one, placeholders, run, type Conn, type Param } from "./sql.ts";

export const NOTIFICATION_KINDS = {
  assigned: "Un task mi viene assegnato",
  mention: "Vengo menzionato in un commento",
  comment: "Nuovo commento su un task che ho creato o che mi è assegnato",
  status: "Cambia lo stato di un task che ho creato",
  project_member: "Vengo aggiunto a un progetto",
  due_soon: "Scadenza imminente di un mio task",
  poll_published: "Viene pubblicato un sondaggio di riunione per il mio team",
  poll_finalized: "Una riunione viene confermata",
  event_invited: "Vengo invitato a un evento",
  event_changed: "Un evento a cui partecipo cambia o viene annullato",
  event_reminder: "Promemoria prima di un evento",
  team: "Vengo aggiunto o rimosso da un team",
  poll_closed: "Un sondaggio che ho creato è scaduto",
  poll_draft: "È pronta la bozza di un sondaggio ricorrente",
  announcement: "Viene pubblicato un annuncio nel mio team",
  chat_request: "Ricevo una richiesta di messaggio",
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export type NotifyInput = {
  orgId: number;
  recipientIds: number[];
  actorMembershipId: number | null;
  kind: NotificationKind;
  title: string;
  body?: string;
  url?: string;
  dedupeKey?: string;
};

/** Crea una notifica per ciascun destinatario (mai per chi agisce), rispettando le preferenze. Restituisce quante ne ha create. */
export function notify(conn: Conn, input: NotifyInput): number {
  let created = 0;
  for (const rid of new Set(input.recipientIds)) {
    if (rid === input.actorMembershipId) continue;
    const pref = one<{ in_app: number }>(conn, "SELECT in_app FROM notification_preferences WHERE membership_id = ? AND kind = ?", rid, input.kind);
    if (pref && pref.in_app === 0) continue;
    const res = run(
      conn,
      `INSERT OR IGNORE INTO notifications (org_id, recipient_membership_id, kind, title, body, url, actor_membership_id, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.orgId,
      rid,
      input.kind,
      input.title,
      input.body ?? "",
      input.url ?? null,
      input.actorMembershipId,
      input.dedupeKey ?? null,
    );
    if (Number(res.changes)) {
      created++;
      emit(conn, { type: "notification.created" }, [rid]);
    }
  }
  return created;
}

export type NotificationDTO = {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  actorName: string | null;
  read: boolean;
  createdAt: string;
};

export function listNotifications(conn: Conn, actor: Actor, opts: { unreadOnly?: boolean; kind?: string; limit?: number; offset?: number } = {}): { items: NotificationDTO[]; total: number } {
  const where = ["n.recipient_membership_id = ?"];
  const params: Param[] = [actor.membershipId];
  if (opts.unreadOnly) where.push("n.read_at IS NULL");
  if (opts.kind) {
    where.push("n.kind = ?");
    params.push(opts.kind);
  }
  const total = one<{ n: number }>(conn, `SELECT COUNT(*) AS n FROM notifications n WHERE ${where.join(" AND ")}`, ...params)?.n ?? 0;
  const rows = all<{ id: number; kind: string; title: string; body: string; url: string | null; actor_name: string | null; read_at: string | null; created_at: string }>(
    conn,
    `SELECT n.id, n.kind, n.title, n.body, n.url, u.name AS actor_name, n.read_at, n.created_at
       FROM notifications n
       LEFT JOIN memberships am ON am.id = n.actor_membership_id
       LEFT JOIN users u ON u.id = am.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
    ...params,
    opts.limit ?? 30,
    opts.offset ?? 0,
  );
  return {
    total,
    items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, actorName: r.actor_name, read: r.read_at !== null, createdAt: r.created_at })),
  };
}

export const unreadCount = (conn: Conn, actor: Actor): number =>
  one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM notifications WHERE recipient_membership_id = ? AND read_at IS NULL", actor.membershipId)?.n ?? 0;

/** Segna come lette alcune notifiche (solo le proprie) o tutte. */
export function markRead(conn: Conn, actor: Actor, ids: number[] | "all", read = true): number {
  const value = read ? new Date().toISOString() : null;
  if (ids === "all") return Number(run(conn, "UPDATE notifications SET read_at = ? WHERE recipient_membership_id = ? AND read_at IS NULL", value, actor.membershipId).changes);
  if (ids.length === 0) return 0;
  return Number(run(conn, `UPDATE notifications SET read_at = ? WHERE recipient_membership_id = ? AND id IN (${placeholders(ids.length)})`, value, actor.membershipId, ...ids).changes);
}

export function deleteNotifications(conn: Conn, actor: Actor, ids: number[]): number {
  if (ids.length === 0) return 0;
  return Number(run(conn, `DELETE FROM notifications WHERE recipient_membership_id = ? AND id IN (${placeholders(ids.length)})`, actor.membershipId, ...ids).changes);
}

export function getPreferences(conn: Conn, actor: Actor): Record<NotificationKind, boolean> {
  const rows = all<{ kind: string; in_app: number }>(conn, "SELECT kind, in_app FROM notification_preferences WHERE membership_id = ?", actor.membershipId);
  const out = Object.fromEntries((Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((k) => [k, true])) as Record<NotificationKind, boolean>;
  for (const r of rows) if (r.kind in out) out[r.kind as NotificationKind] = r.in_app === 1;
  return out;
}

export function setPreference(conn: Conn, actor: Actor, kind: NotificationKind, inApp: boolean): void {
  if (!(kind in NOTIFICATION_KINDS)) return;
  run(
    conn,
    `INSERT INTO notification_preferences (membership_id, kind, in_app) VALUES (?, ?, ?)
     ON CONFLICT (membership_id, kind) DO UPDATE SET in_app = excluded.in_app`,
    actor.membershipId,
    kind,
    inApp ? 1 : 0,
  );
}
