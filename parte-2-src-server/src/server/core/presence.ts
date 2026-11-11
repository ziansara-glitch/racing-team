import type { Actor } from "../authz/authorize.ts";
import { all, one, placeholders, type Conn } from "./sql.ts";

// Presenza e "sta scrivendo": solo in memoria, a scadenza breve. Nessun dato personale su disco.
type State = { seen: Map<number, number>; typing: Map<number, Map<number, number>> };
const g = globalThis as unknown as { __rtPresence?: State };
const state = (g.__rtPresence ??= { seen: new Map(), typing: new Map() });

export const ONLINE_MS = 45_000;
export const TYPING_MS = 5_000;

export const touch = (membershipId: number, now = Date.now()) => void state.seen.set(membershipId, now);
export const setTyping = (conversationId: number, membershipId: number, now = Date.now()) => {
  const m = state.typing.get(conversationId) ?? new Map<number, number>();
  m.set(membershipId, now);
  state.typing.set(conversationId, m);
};
export const typingNow = (conversationId: number, now = Date.now()): number[] =>
  [...(state.typing.get(conversationId) ?? [])].filter(([, t]) => now - t < TYPING_MS).map(([id]) => id);
export const resetPresence = () => { state.seen.clear(); state.typing.clear(); };

export type PresenceStatus = "online" | "offline" | "hidden";

/**
 * Stato di presenza di altre persone, nel rispetto della privacy: si vede solo se la persona non l'ha disattivata
 * E condivide con chi guarda un team o una conversazione. Altrimenti "hidden": non si distingue da "offline".
 */
export function presenceFor(conn: Conn, actor: Actor, ids: number[], now = Date.now()): Record<number, PresenceStatus> {
  const out: Record<number, PresenceStatus> = {};
  const unique = [...new Set(ids)].filter((i) => i !== actor.membershipId);
  if (unique.length === 0) return out;
  const hiddenByChoice = new Set(all<{ id: number }>(conn, `SELECT membership_id AS id FROM user_profiles WHERE show_presence = 0 AND membership_id IN (${placeholders(unique.length)})`, ...unique).map((r) => r.id));
  for (const id of unique) {
    const shared = one(conn, `SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.membership_id = ? AND b.membership_id = ?
                              UNION SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id = b.conversation_id WHERE a.membership_id = ? AND b.membership_id = ? AND a.left_at IS NULL AND b.left_at IS NULL`, actor.membershipId, id, actor.membershipId, id);
    if (hiddenByChoice.has(id) || !shared) out[id] = "hidden";
    else out[id] = now - (state.seen.get(id) ?? 0) < ONLINE_MS ? "online" : "offline";
  }
  return out;
}
