import { ForbiddenError, NotFoundError, type Actor } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { hit } from "../rate-limit.ts";
import { publish } from "./bus.ts";
import { setTyping } from "./presence.ts";
import { ValidationError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { emit, orgAdminIds, teamMemberIds } from "./realtime.ts";
import { all, insert, nowISO, one, placeholders, run, type Conn, type Param } from "./sql.ts";
import { adminScope, ensureTeamResources, hasAdminAccess } from "./teams.ts";
import { transaction } from "./tx.ts";

export type ConversationKind = "admin_group" | "team_group" | "direct" | "announcement";
export type MessageKind = "text" | "image" | "audio" | "video" | "file" | "sticker" | "system";

export const BUILTIN_STICKERS = [
  { key: "builtin:thumbs", emoji: "👍", label: "Ok" }, { key: "builtin:party", emoji: "🎉", label: "Festa" }, { key: "builtin:flag", emoji: "🏁", label: "Traguardo" },
  { key: "builtin:fire", emoji: "🔥", label: "Fuoco" }, { key: "builtin:rocket", emoji: "🚀", label: "Via!" }, { key: "builtin:gear", emoji: "⚙️", label: "Ingranaggio" },
  { key: "builtin:wrench", emoji: "🔧", label: "Officina" }, { key: "builtin:car", emoji: "🏎️", label: "Monoposto" }, { key: "builtin:clap", emoji: "👏", label: "Bravi" },
  { key: "builtin:think", emoji: "🤔", label: "Mmh" }, { key: "builtin:laugh", emoji: "😂", label: "Ahah" }, { key: "builtin:heart", emoji: "❤️", label: "Grazie" },
] as const;

export type ChatPolicy = { editWindowMinutes: number; deleteWindowMinutes: number; directMessages: boolean; maxUploadMb: number };
const DEFAULT_POLICY: ChatPolicy = { editWindowMinutes: 15, deleteWindowMinutes: 60, directMessages: true, maxUploadMb: 25 };

/** Regole della chat dell'organizzazione (organizations.settings.chat), con valori di default. */
export function getChatPolicy(conn: Conn, orgId: number): ChatPolicy {
  const row = one<{ settings: string }>(conn, "SELECT settings FROM organizations WHERE id = ?", orgId);
  const chat = row ? (JSON.parse(row.settings).chat ?? {}) : {};
  return { ...DEFAULT_POLICY, ...chat };
}

export function setChatPolicy(conn: Conn, actor: Actor, patch: Partial<ChatPolicy>): ChatPolicy {
  if (actor.permissions["org.manage"] !== "all") throw new ForbiddenError("org.manage");
  const cur = getChatPolicy(conn, actor.orgId);
  const next: ChatPolicy = { ...cur, ...patch };
  const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!ok(next.editWindowMinutes, 0, 10_080) || !ok(next.deleteWindowMinutes, 0, 10_080) || !ok(next.maxUploadMb, 1, 100) || typeof next.directMessages !== "boolean") throw new ValidationError("Valori non validi.");
  transaction(conn, () => {
    const settings = JSON.parse(one<{ settings: string }>(conn, "SELECT settings FROM organizations WHERE id = ?", actor.orgId)!.settings);
    run(conn, "UPDATE organizations SET settings = ? WHERE id = ?", JSON.stringify({ ...settings, chat: next }), actor.orgId);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "chat.policy.update", meta: { ...next } });
  });
  return next;
}

type ConvRow = { id: number; org_id: number; kind: ConversationKind; team_id: number | null; title: string; description: string; avatar_attachment_id: number | null; direct_key: string | null; request_status: "pending" | "accepted" | "declined" | null; created_by_membership_id: number; archived_at: string | null };
export type ConvAccess = { read: boolean; write: boolean; moderate: boolean };

const memberRow = (conn: Conn, convId: number, mid: number) => one<{ role: "owner" | "admin" | "member"; left_at: string | null; last_read_message_id: number }>(conn, "SELECT role, left_at, last_read_message_id FROM conversation_members WHERE conversation_id = ? AND membership_id = ?", convId, mid);
const isBlocked = (conn: Conn, a: number, b: number) => !!one(conn, "SELECT 1 FROM user_blocks WHERE (blocker_membership_id = ? AND blocked_membership_id = ?) OR (blocker_membership_id = ? AND blocked_membership_id = ?)", a, b, b, a);

/**
 * Regole di accesso, rilette a OGNI richiesta (niente permessi "ricordati"):
 * · admin_group: iscritto E ancora amministratore (un admin declassato non legge più nulla);
 * · team_group: membri del team e amministratori con ambito completo; scrivono tutti loro;
 * · announcement: leggono come sopra, scrivono solo gli amministratori del team (ambito completo, o Team Admin del team);
 * · direct: i due partecipanti; la scrittura cessa se uno blocca l'altro.
 */
export function conversationAccess(conn: Conn, actor: Actor, c: ConvRow): ConvAccess {
  const none = { read: false, write: false, moderate: false };
  if (c.org_id !== actor.orgId || c.archived_at) return c.org_id === actor.orgId && c.archived_at && c.team_id !== null && actor.teamIds.includes(c.team_id) ? { read: true, write: false, moderate: false } : none;
  const manage = actor.permissions["chat.manage"];
  if (c.kind === "admin_group") {
    const m = memberRow(conn, c.id, actor.membershipId);
    const ok = !!m && !m.left_at && hasAdminAccess(actor);
    // La moderazione è un ruolo DEL GRUPPO (creatore o amministratore del gruppo), non un privilegio globale.
    return { read: ok, write: ok, moderate: ok && m!.role !== "member" };
  }
  if (c.kind === "direct") {
    const m = memberRow(conn, c.id, actor.membershipId);
    if (!m || m.left_at) return none;
    const other = Number(c.direct_key!.split(":").find((x) => Number(x) !== actor.membershipId));
    return { read: true, write: !isBlocked(conn, actor.membershipId, other) && c.request_status !== "declined", moderate: false };
  }
  const member = c.team_id !== null && actor.teamIds.includes(c.team_id);
  const adminAll = adminScope(actor) === "all";
  if (!member && !adminAll) return none;
  const teamAdmin = member && actor.role === "team_admin";
  const canPostAnnouncement = adminAll || teamAdmin;
  return { read: true, write: c.kind === "announcement" ? canPostAnnouncement : true, moderate: adminAll || teamAdmin || manage === "all" };
}

function requireConversation(conn: Conn, actor: Actor, id: number, need: "read" | "write" | "moderate" = "read"): { conv: ConvRow; access: ConvAccess } {
  const conv = one<ConvRow>(conn, "SELECT id, org_id, kind, team_id, title, description, avatar_attachment_id, direct_key, request_status, created_by_membership_id, archived_at FROM conversations WHERE id = ? AND org_id = ?", id, actor.orgId);
  if (!conv) throw new NotFoundError("Conversazione");
  const access = conversationAccess(conn, actor, conv);
  if (!access.read) throw new NotFoundError("Conversazione"); // chi non può leggere non deve nemmeno sapere che esiste
  if (need !== "read" && !access[need]) throw new ForbiddenError("chat.manage");
  return { conv, access };
}

/** Chi deve ricevere gli eventi in tempo reale di una conversazione (ciascuno ricontrollato all'accesso). */
export function conversationAudience(conn: Conn, c: ConvRow): number[] {
  if (c.kind === "team_group" || c.kind === "announcement") return [...new Set([...teamMemberIds(conn, c.org_id, c.team_id!), ...orgAdminIds(conn, c.org_id)])];
  return all<{ id: number }>(conn, "SELECT membership_id AS id FROM conversation_members WHERE conversation_id = ? AND left_at IS NULL", c.id).map((r) => r.id);
}

const ensureRow = (conn: Conn, c: ConvRow, actor: Actor) =>
  run(conn, "INSERT OR IGNORE INTO conversation_members (conversation_id, membership_id, org_id) VALUES (?, ?, ?)", c.id, actor.membershipId, actor.orgId);

// ───────────────────────── Elenco ─────────────────────────

export type ConversationSummary = {
  id: number; kind: ConversationKind; title: string; description: string; teamId: number | null; avatarId: number | null; unread: number; pinned: boolean; muted: boolean;
  requestStatus: "pending" | "accepted" | "declined" | null; incomingRequest: boolean; canWrite: boolean; otherMembershipId: number | null;
  last: { author: string; kind: MessageKind; body: string; at: string } | null; lastMessageAt: string | null;
};

export function listConversations(conn: Conn, actor: Actor, f: { q?: string; kind?: ConversationKind; unreadOnly?: boolean } = {}): ConversationSummary[] {
  const teamIds = adminScope(actor) === "all" ? all<{ id: number }>(conn, "SELECT id FROM teams WHERE org_id = ? AND deleted_at IS NULL", actor.orgId).map((t) => t.id) : [...actor.teamIds];
  for (const t of teamIds) ensureTeamResources(conn, actor.orgId, t, actor.membershipId);
  const rows = all<ConvRow & { unread: number; pinned: number | null; muted: number | null; last_message_at: string | null }>(
    conn,
    `SELECT c.id, c.org_id, c.kind, c.team_id, c.title, c.description, c.avatar_attachment_id, c.direct_key, c.request_status, c.created_by_membership_id, c.archived_at, c.last_message_at,
            cm.pinned, cm.muted,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.id > COALESCE(cm.last_read_message_id, 0) AND m.author_membership_id <> ? AND m.deleted_at IS NULL AND m.kind <> 'system') AS unread
       FROM conversations c LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.membership_id = ?
      WHERE c.org_id = ? AND c.archived_at IS NULL AND (
            (c.team_id IS NOT NULL AND c.team_id IN (${teamIds.length ? placeholders(teamIds.length) : "NULL"}))
         OR (c.kind IN ('admin_group','direct') AND cm.membership_id IS NOT NULL AND cm.left_at IS NULL))`,
    actor.membershipId, actor.membershipId, actor.orgId, ...teamIds,
  );
  const out: ConversationSummary[] = [];
  for (const c of rows) {
    const access = conversationAccess(conn, actor, c);
    if (!access.read) continue;
    let title = c.title;
    let other: number | null = null;
    if (c.kind === "direct") {
      other = Number(c.direct_key!.split(":").find((x) => Number(x) !== actor.membershipId));
      title = one<{ name: string }>(conn, "SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ?", other)?.name ?? "Utente";
    }
    const last = one<{ name: string; kind: MessageKind; body: string; created_at: string; deleted_at: string | null }>(
      conn, `SELECT u.name, m.kind, m.body, m.created_at, m.deleted_at FROM messages m JOIN memberships mm ON mm.id = m.author_membership_id JOIN users u ON u.id = mm.user_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`, c.id);
    const incoming = c.kind === "direct" && c.request_status === "pending" && c.created_by_membership_id !== actor.membershipId;
    if (f.kind && c.kind !== f.kind) continue;
    if (f.unreadOnly && c.unread === 0) continue;
    if (f.q && !title.toLowerCase().includes(f.q.toLowerCase())) continue;
    out.push({
      id: c.id, kind: c.kind, title, description: c.description, teamId: c.team_id, avatarId: c.avatar_attachment_id, unread: c.unread, pinned: c.pinned === 1, muted: c.muted === 1,
      requestStatus: c.request_status, incomingRequest: incoming, canWrite: access.write, otherMembershipId: other,
      last: last ? { author: last.name, kind: last.kind, body: last.deleted_at ? "Messaggio eliminato" : last.body, at: last.created_at } : null, lastMessageAt: c.last_message_at,
    });
  }
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || a.title.localeCompare(b.title));
}

export const totalUnread = (conn: Conn, actor: Actor): number => listConversations(conn, actor).filter((c) => !c.muted && !(c.incomingRequest)).reduce((s, c) => s + c.unread, 0);

// ───────────────────────── Messaggi ─────────────────────────

export type AttachmentDTO = { id: number; name: string; mime: string; size: number; width: number | null; height: number | null; durationMs: number | null };
export type MessageDTO = {
  id: number; conversationId: number; authorId: number; authorName: string; kind: MessageKind; body: string; stickerKey: string | null; createdAt: string; editedAt: string | null;
  deleted: boolean; pinned: boolean; mine: boolean; readBy: number; replyTo: { id: number; authorName: string; body: string; kind: MessageKind } | null; forwarded: boolean;
  attachments: AttachmentDTO[]; reactions: { emoji: string; count: number; mine: boolean }[]; canEdit: boolean; canDelete: boolean;
};

/** Pagina di messaggi, dal più vecchio al più nuovo. `beforeId` carica la pagina precedente. */
export function getMessages(conn: Conn, actor: Actor, conversationId: number, opts: { beforeId?: number; limit?: number; pinnedOnly?: boolean; q?: string } = {}): { messages: MessageDTO[]; hasMore: boolean } {
  const { access } = requireConversation(conn, actor, conversationId, "read");
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = ["m.conversation_id = ?"];
  const params: Param[] = [conversationId];
  if (opts.beforeId) { where.push("m.id < ?"); params.push(opts.beforeId); }
  if (opts.pinnedOnly) where.push("m.pinned_at IS NOT NULL AND m.deleted_at IS NULL");
  if (opts.q?.trim()) { where.push("m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'"); params.push(`%${opts.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`); }
  const rows = all<{ id: number; author: number; name: string; kind: MessageKind; body: string; sticker_key: string | null; created_at: string; edited_at: string | null; deleted_at: string | null; pinned_at: string | null; reply_to_id: number | null; forwarded_from_id: number | null }>(
    conn,
    `SELECT m.id, m.author_membership_id AS author, u.name, m.kind, m.body, m.sticker_key, m.created_at, m.edited_at, m.deleted_at, m.pinned_at, m.reply_to_id, m.forwarded_from_id
       FROM messages m JOIN memberships mm ON mm.id = m.author_membership_id JOIN users u ON u.id = mm.user_id
      WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`,
    ...params, limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  if (page.length === 0) return { messages: [], hasMore };
  const ids = page.map((r) => r.id);
  const attachments = all<{ message_id: number; id: number; name: string; mime: string; size: number; width: number | null; height: number | null; duration_ms: number | null }>(
    conn, `SELECT ma.message_id, a.id, a.original_name AS name, a.mime, a.size_bytes AS size, a.width, a.height, a.duration_ms FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
            WHERE ma.message_id IN (${placeholders(ids.length)}) AND a.deleted_at IS NULL ORDER BY ma.position`, ...ids);
  const reactions = all<{ message_id: number; emoji: string; n: number; mine: number }>(
    conn, `SELECT message_id, emoji, COUNT(*) AS n, SUM(membership_id = ?) AS mine FROM message_reactions WHERE message_id IN (${placeholders(ids.length)}) GROUP BY message_id, emoji ORDER BY MIN(created_at)`, actor.membershipId, ...ids);
  const reads = all<{ last: number }>(conn, "SELECT last_read_message_id AS last FROM conversation_members WHERE conversation_id = ? AND membership_id <> ? AND left_at IS NULL", conversationId, actor.membershipId).map((r) => r.last);
  const replyIds = [...new Set(page.map((r) => r.reply_to_id).filter((x): x is number => x !== null))];
  const replies = new Map(replyIds.length ? all<{ id: number; name: string; body: string; kind: MessageKind; deleted_at: string | null }>(
    conn, `SELECT m.id, u.name, m.body, m.kind, m.deleted_at FROM messages m JOIN memberships mm ON mm.id = m.author_membership_id JOIN users u ON u.id = mm.user_id WHERE m.id IN (${placeholders(replyIds.length)}) AND m.conversation_id = ?`, ...replyIds, conversationId).map((r) => [r.id, r]) : []);
  const policy = getChatPolicy(conn, actor.orgId);
  const withinWindow = (at: string, minutes: number) => minutes === 0 || Date.now() - Date.parse(at) <= minutes * 60_000;
  return {
    hasMore,
    messages: page.map((r) => {
      const mine = r.author === actor.membershipId;
      const reply = r.reply_to_id ? replies.get(r.reply_to_id) : undefined;
      const deleted = r.deleted_at !== null;
      return {
        id: r.id, conversationId, authorId: r.author, authorName: r.name, kind: r.kind, body: deleted ? "" : r.body, stickerKey: deleted ? null : r.sticker_key, createdAt: r.created_at, editedAt: r.edited_at,
        deleted, pinned: r.pinned_at !== null && !deleted, mine, readBy: mine ? reads.filter((l) => l >= r.id).length : 0,
        replyTo: reply ? { id: reply.id, authorName: reply.name, body: reply.deleted_at ? "Messaggio eliminato" : reply.body, kind: reply.kind } : null, forwarded: r.forwarded_from_id !== null,
        attachments: deleted ? [] : attachments.filter((a) => a.message_id === r.id).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, width: a.width, height: a.height, durationMs: a.duration_ms })),
        reactions: deleted ? [] : reactions.filter((x) => x.message_id === r.id).map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine > 0 })),
        canEdit: mine && !deleted && r.kind === "text" && access.write && withinWindow(r.created_at, policy.editWindowMinutes),
        canDelete: !deleted && ((mine && withinWindow(r.created_at, policy.deleteWindowMinutes)) || access.moderate),
      };
    }),
  };
}

export type SendInput = { body?: string; attachmentIds?: number[]; replyToId?: number | null; stickerKey?: string | null };

function kindFromMime(mime: string): MessageKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function sendMessage(conn: Conn, actor: Actor, conversationId: number, input: SendInput): number {
  const { conv } = requireConversation(conn, actor, conversationId, "write");
  const body = (input.body ?? "").trim();
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (body.length > 4000) throw new ValidationError("Il messaggio può avere al massimo 4000 caratteri.", "body");
  const sticker = input.stickerKey ?? null;
  if (sticker && !(BUILTIN_STICKERS.some((s) => s.key === sticker) || (/^org:\d+$/.test(sticker) && one(conn, "SELECT 1 FROM stickers WHERE id = ? AND org_id = ?", Number(sticker.slice(4)), actor.orgId)))) throw new ValidationError("Sticker non valido.");
  if (!body && attachmentIds.length === 0 && !sticker) throw new ValidationError("Scrivi un messaggio o allega un file.");
  if (attachmentIds.length > 10) throw new ValidationError("Massimo 10 allegati per messaggio.");
  // Protezione da raffiche: 20 messaggi ogni 10 secondi per persona.
  if (hit(conn, "chat_send", String(actor.membershipId), { limit: 20, windowMs: 10_000 }).count > 20) throw new ValidationError("Stai scrivendo troppo in fretta: attendi qualche secondo.");
  if (conv.kind === "direct") {
    if (conv.request_status === "pending" && conv.created_by_membership_id === actor.membershipId && one(conn, "SELECT 1 FROM messages WHERE conversation_id = ? AND author_membership_id = ?", conversationId, actor.membershipId)) {
      throw new ValidationError("Puoi inviare un solo messaggio finché la richiesta non viene accettata.");
    }
    if (conv.request_status === "pending" && conv.created_by_membership_id !== actor.membershipId) throw new ValidationError("Accetta la richiesta per poter rispondere.");
  }
  let replyTo: number | null = null;
  if (input.replyToId) {
    if (!one(conn, "SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?", input.replyToId, conversationId)) throw new ValidationError("Il messaggio a cui rispondi non esiste in questa conversazione.");
    replyTo = input.replyToId;
  }
  const atts = attachmentIds.length ? all<{ id: number; mime: string; uploader_membership_id: number; status: string }>(conn, `SELECT id, mime, uploader_membership_id, status FROM attachments WHERE org_id = ? AND deleted_at IS NULL AND id IN (${placeholders(attachmentIds.length)})`, actor.orgId, ...attachmentIds) : [];
  if (atts.length !== attachmentIds.length || atts.some((a) => a.uploader_membership_id !== actor.membershipId || a.status !== "pending")) throw new ValidationError("Allegato non valido o già usato.");
  const kind: MessageKind = sticker ? "sticker" : atts.length ? (atts.every((a) => a.mime.startsWith("image/")) ? "image" : kindFromMime(atts[0].mime)) : "text";
  return transaction(conn, () => {
    const id = insert(conn, "INSERT INTO messages (org_id, conversation_id, author_membership_id, kind, body, reply_to_id, sticker_key) VALUES (?, ?, ?, ?, ?, ?, ?)", actor.orgId, conversationId, actor.membershipId, kind, body, replyTo, sticker);
    attachmentIds.forEach((aid, i) => {
      run(conn, "INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)", id, aid, i);
      run(conn, "UPDATE attachments SET status = 'attached' WHERE id = ?", aid);
    });
    ensureRow(conn, conv, actor);
    run(conn, "UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND membership_id = ?", id, conversationId, actor.membershipId);
    run(conn, "UPDATE conversations SET last_message_at = ? WHERE id = ?", nowISO(), conversationId);
    const audience = conversationAudience(conn, conv);
    if (conv.kind === "announcement") {
      notify(conn, { orgId: actor.orgId, recipientIds: audience, actorMembershipId: actor.membershipId, kind: "announcement", title: `Annuncio: ${conv.title.replace(/^Annunci /, "")}`, body: body.slice(0, 200), url: "/app/chat", dedupeKey: `announcement:${id}` });
    }
    if (conv.kind === "direct" && conv.request_status === "pending") {
      notify(conn, { orgId: actor.orgId, recipientIds: audience, actorMembershipId: actor.membershipId, kind: "chat_request", title: "Nuova richiesta di messaggio", url: "/app/chat", dedupeKey: `chat_request:${conversationId}` });
    }
    emit(conn, { type: "message.created", conversationId, messageId: id }, audience);
    return id;
  });
}

function requireMessage(conn: Conn, actor: Actor, messageId: number, need: "read" | "write" = "read") {
  const m = one<{ id: number; conversation_id: number; author_membership_id: number; kind: MessageKind; body: string; created_at: string; deleted_at: string | null; pinned_at: string | null }>(
    conn, "SELECT id, conversation_id, author_membership_id, kind, body, created_at, deleted_at, pinned_at FROM messages WHERE id = ? AND org_id = ?", messageId, actor.orgId);
  if (!m) throw new NotFoundError("Messaggio");
  return { m, ...requireConversation(conn, actor, m.conversation_id, need) };
}

const within = (at: string, minutes: number) => minutes === 0 || Date.now() - Date.parse(at) <= minutes * 60_000;

export function editMessage(conn: Conn, actor: Actor, messageId: number, body: string): void {
  const { m, conv } = requireMessage(conn, actor, messageId, "write");
  const text = body.trim();
  if (m.author_membership_id !== actor.membershipId) throw new ForbiddenError("chat.manage");
  if (m.deleted_at || m.kind !== "text") throw new ValidationError("Questo messaggio non si può modificare.");
  if (!text || text.length > 4000) throw new ValidationError("Il messaggio deve avere tra 1 e 4000 caratteri.", "body");
  if (!within(m.created_at, getChatPolicy(conn, actor.orgId).editWindowMinutes)) throw new ValidationError("Il tempo per modificare il messaggio è scaduto.");
  transaction(conn, () => {
    run(conn, "UPDATE messages SET body = ?, edited_at = ? WHERE id = ?", text, nowISO(), messageId);
    emit(conn, { type: "message.updated", conversationId: conv.id, messageId }, conversationAudience(conn, conv));
  });
}

export function deleteMessage(conn: Conn, actor: Actor, messageId: number): void {
  const { m, conv, access } = requireMessage(conn, actor, messageId, "read");
  const own = m.author_membership_id === actor.membershipId;
  if (!own && !access.moderate) throw new ForbiddenError("chat.manage");
  if (own && !access.moderate && !within(m.created_at, getChatPolicy(conn, actor.orgId).deleteWindowMinutes)) throw new ValidationError("Il tempo per eliminare il messaggio è scaduto.");
  transaction(conn, () => {
    run(conn, "UPDATE messages SET deleted_at = ?, pinned_at = NULL WHERE id = ?", nowISO(), messageId);
    if (!own) writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "chat.message.moderate", entityType: "message", entityId: messageId, meta: { conversationId: conv.id } });
    emit(conn, { type: "message.updated", conversationId: conv.id, messageId }, conversationAudience(conn, conv));
  });
}

/** Aggiunge o toglie (toggle) una reazione. */
export function toggleReaction(conn: Conn, actor: Actor, messageId: number, emoji: string): void {
  const { m, conv } = requireMessage(conn, actor, messageId, "write");
  if (m.deleted_at) throw new ValidationError("Il messaggio è stato eliminato.");
  if (!/\p{Extended_Pictographic}/u.test(emoji) || [...emoji].length > 8) throw new ValidationError("Reazione non valida.");
  transaction(conn, () => {
    const gone = Number(run(conn, "DELETE FROM message_reactions WHERE message_id = ? AND membership_id = ? AND emoji = ?", messageId, actor.membershipId, emoji).changes);
    if (!gone) run(conn, "INSERT INTO message_reactions (message_id, membership_id, emoji) VALUES (?, ?, ?)", messageId, actor.membershipId, emoji);
    emit(conn, { type: "message.updated", conversationId: conv.id, messageId }, conversationAudience(conn, conv));
  });
}

export function setPinned(conn: Conn, actor: Actor, messageId: number, pinned: boolean): void {
  const { m, conv, access } = requireMessage(conn, actor, messageId, "write");
  if (!(access.moderate || conv.kind === "direct")) throw new ForbiddenError("chat.manage");
  if (m.deleted_at) throw new ValidationError("Il messaggio è stato eliminato.");
  transaction(conn, () => {
    run(conn, "UPDATE messages SET pinned_at = ?, pinned_by_membership_id = ? WHERE id = ?", pinned ? nowISO() : null, pinned ? actor.membershipId : null, messageId);
    emit(conn, { type: "message.updated", conversationId: conv.id, messageId }, conversationAudience(conn, conv));
  });
}

/** Inoltra un messaggio (testo e allegati) in altre conversazioni dove si può scrivere. */
export function forwardMessage(conn: Conn, actor: Actor, messageId: number, targetIds: number[]): number[] {
  const { m } = requireMessage(conn, actor, messageId, "read");
  if (m.deleted_at) throw new ValidationError("Il messaggio è stato eliminato.");
  const targets = [...new Set(targetIds)].slice(0, 10);
  if (targets.length === 0) throw new ValidationError("Scegli almeno una conversazione.");
  return transaction(conn, () => targets.map((t) => {
    const { conv } = requireConversation(conn, actor, t, "write");
    const nid = insert(conn, "INSERT INTO messages (org_id, conversation_id, author_membership_id, kind, body, forwarded_from_id, sticker_key) SELECT org_id, ?, ?, kind, body, id, sticker_key FROM messages WHERE id = ?", t, actor.membershipId, messageId);
    run(conn, "INSERT INTO message_attachments (message_id, attachment_id, position) SELECT ?, attachment_id, position FROM message_attachments WHERE message_id = ?", nid, messageId);
    ensureRow(conn, conv, actor);
    run(conn, "UPDATE conversations SET last_message_at = ? WHERE id = ?", nowISO(), t);
    emit(conn, { type: "message.created", conversationId: t, messageId: nid }, conversationAudience(conn, conv));
    return nid;
  }));
}

export function markRead(conn: Conn, actor: Actor, conversationId: number, upToMessageId?: number): void {
  const { conv } = requireConversation(conn, actor, conversationId, "read");
  const last = upToMessageId ?? one<{ m: number | null }>(conn, "SELECT MAX(id) AS m FROM messages WHERE conversation_id = ?", conversationId)?.m ?? 0;
  transaction(conn, () => {
    ensureRow(conn, conv, actor);
    const changed = Number(run(conn, "UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND membership_id = ? AND last_read_message_id < ?", last, conversationId, actor.membershipId, last).changes);
    if (changed) emit(conn, { type: "read.updated", conversationId, membershipId: actor.membershipId }, conversationAudience(conn, conv));
  });
}

export function setConversationPrefs(conn: Conn, actor: Actor, conversationId: number, prefs: { muted?: boolean; pinned?: boolean }): void {
  const { conv } = requireConversation(conn, actor, conversationId, "read");
  ensureRow(conn, conv, actor);
  if (prefs.muted !== undefined) run(conn, "UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND membership_id = ?", prefs.muted ? 1 : 0, conversationId, actor.membershipId);
  if (prefs.pinned !== undefined) run(conn, "UPDATE conversation_members SET pinned = ? WHERE conversation_id = ? AND membership_id = ?", prefs.pinned ? 1 : 0, conversationId, actor.membershipId);
}

// ───────────────────────── Gruppi admin e diretti ─────────────────────────

export function createAdminGroup(conn: Conn, actor: Actor, input: { title: string; description?: string; memberIds: number[] }): number {
  if (!hasAdminAccess(actor) || !actor.permissions["chat.manage"]) throw new ForbiddenError("chat.manage");
  const title = input.title.trim();
  if (title.length < 2 || title.length > 60) throw new ValidationError("Il nome del gruppo deve avere tra 2 e 60 caratteri.", "title");
  const members = [...new Set([actor.membershipId, ...input.memberIds])];
  return transaction(conn, () => {
    const id = insert(conn, "INSERT INTO conversations (org_id, kind, title, description, created_by_membership_id) VALUES (?, 'admin_group', ?, ?, ?)", actor.orgId, title, (input.description ?? "").trim(), actor.membershipId);
    for (const m of members) {
      assertAdminMember(conn, actor.orgId, m);
      run(conn, "INSERT INTO conversation_members (conversation_id, membership_id, org_id, role) VALUES (?, ?, ?, ?)", id, m, actor.orgId, m === actor.membershipId ? "owner" : "member");
    }
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "chat.group.create", entityType: "conversation", entityId: id, meta: { title, members: members.length } });
    return id;
  });
}

/** Solo chi è amministratore (admin.access) può entrare in un gruppo riservato agli admin. */
function assertAdminMember(conn: Conn, orgId: number, membershipId: number): void {
  const m = one<{ role: string }>(conn, "SELECT role FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, orgId);
  if (!m) throw new ValidationError("La persona selezionata non è un membro attivo.");
  if (!["super_admin", "org_admin", "team_admin"].includes(m.role)) throw new ValidationError("Nei gruppi riservati agli amministratori possono entrare solo gli amministratori.");
}

export function updateConversation(conn: Conn, actor: Actor, conversationId: number, patch: { title?: string; description?: string; avatarAttachmentId?: number | null }): void {
  const { conv, access } = requireConversation(conn, actor, conversationId, "moderate");
  if (conv.kind !== "admin_group" && access.moderate !== true) throw new ForbiddenError("chat.manage");
  if (conv.kind === "direct") throw new ValidationError("Le conversazioni dirette non hanno un nome.");
  const title = patch.title?.trim();
  if (title !== undefined && (title.length < 2 || title.length > 60)) throw new ValidationError("Il nome deve avere tra 2 e 60 caratteri.", "title");
  if (patch.avatarAttachmentId && !one(conn, "SELECT 1 FROM attachments WHERE id = ? AND org_id = ? AND mime LIKE 'image/%' AND uploader_membership_id = ?", patch.avatarAttachmentId, actor.orgId, actor.membershipId)) throw new ValidationError("Immagine non valida.");
  transaction(conn, () => {
    run(conn, "UPDATE conversations SET title = ?, description = ?, avatar_attachment_id = ? WHERE id = ?", conv.kind === "admin_group" ? title ?? conv.title : conv.title, patch.description?.trim() ?? conv.description, patch.avatarAttachmentId === undefined ? conv.avatar_attachment_id : patch.avatarAttachmentId, conversationId);
    if (patch.avatarAttachmentId) run(conn, "UPDATE attachments SET status = 'attached' WHERE id = ?", patch.avatarAttachmentId);
    emit(conn, { type: "conversation.updated", conversationId }, conversationAudience(conn, conv));
  });
}

export function groupMembers(conn: Conn, actor: Actor, conversationId: number): { membershipId: number; name: string; role: "owner" | "admin" | "member" }[] {
  const { conv } = requireConversation(conn, actor, conversationId, "read");
  if (conv.kind !== "admin_group" && conv.kind !== "direct") return [];
  return all<{ id: number; name: string; role: "owner" | "admin" | "member" }>(conn, `SELECT cm.membership_id AS id, u.name, cm.role FROM conversation_members cm JOIN memberships m ON m.id = cm.membership_id JOIN users u ON u.id = m.user_id WHERE cm.conversation_id = ? AND cm.left_at IS NULL ORDER BY (cm.role = 'owner') DESC, u.name`, conversationId)
    .map((r) => ({ membershipId: r.id, name: r.name, role: r.role }));
}

export function addGroupMember(conn: Conn, actor: Actor, conversationId: number, membershipId: number): void {
  const { conv } = requireConversation(conn, actor, conversationId, "moderate");
  if (conv.kind !== "admin_group") throw new ValidationError("Solo i gruppi di amministratori hanno membri esplicitamente gestibili.");
  assertAdminMember(conn, actor.orgId, membershipId);
  transaction(conn, () => {
    run(conn, `INSERT INTO conversation_members (conversation_id, membership_id, org_id) VALUES (?, ?, ?) ON CONFLICT (conversation_id, membership_id) DO UPDATE SET left_at = NULL`, conversationId, membershipId, actor.orgId);
    emit(conn, { type: "conversation.updated", conversationId }, conversationAudience(conn, conv));
  });
}

export function removeGroupMember(conn: Conn, actor: Actor, conversationId: number, membershipId: number): void {
  const { conv } = requireConversation(conn, actor, conversationId, membershipId === actor.membershipId ? "read" : "moderate");
  if (conv.kind !== "admin_group") throw new ValidationError("Operazione non valida per questa conversazione.");
  const target = memberRow(conn, conversationId, membershipId);
  if (target?.role === "owner" && membershipId !== actor.membershipId) throw new ValidationError("Il creatore del gruppo non può essere rimosso da altri.");
  transaction(conn, () => {
    const audience = conversationAudience(conn, conv);
    run(conn, "UPDATE conversation_members SET left_at = ? WHERE conversation_id = ? AND membership_id = ?", nowISO(), conversationId, membershipId);
    emit(conn, { type: "conversation.updated", conversationId }, audience);
  });
}

export function setGroupRole(conn: Conn, actor: Actor, conversationId: number, membershipId: number, role: "admin" | "member"): void {
  const { conv } = requireConversation(conn, actor, conversationId, "moderate");
  if (conv.kind !== "admin_group") throw new ValidationError("Operazione non valida per questa conversazione.");
  if (!["admin", "member"].includes(role)) throw new ValidationError("Ruolo non valido.");
  if (memberRow(conn, conversationId, membershipId)?.role === "owner") throw new ValidationError("Il ruolo del creatore non si cambia.");
  run(conn, "UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND membership_id = ?", role, conversationId, membershipId);
}

/** Apre (o riapre) la conversazione diretta con un'altra persona, rispettando blocchi e privacy. */
export function openDirect(conn: Conn, actor: Actor, otherId: number): number {
  if (otherId === actor.membershipId) throw new ValidationError("Non puoi scrivere a te stesso.");
  const other = one<{ id: number; role: string }>(conn, "SELECT id, role FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", otherId, actor.orgId);
  if (!other) throw new NotFoundError("Persona");
  const key = [actor.membershipId, otherId].sort((a, b) => a - b).join(":");
  // Una conversazione esistente si riapre sempre (lo storico resta leggibile); con un blocco in corso non si può scrivere.
  const existing = one<{ id: number }>(conn, "SELECT id FROM conversations WHERE org_id = ? AND direct_key = ?", actor.orgId, key);
  if (existing) return existing.id;
  if (isBlocked(conn, actor.membershipId, otherId)) throw new ForbiddenError("chat.manage");
  const policy = getChatPolicy(conn, actor.orgId);
  const adminInitiated = hasAdminAccess(actor);
  if (!policy.directMessages && !adminInitiated) throw new ForbiddenError("chat.manage");
  const setting = one<{ direct_messages: "everyone" | "team" | "requests" | "nobody" }>(conn, "SELECT direct_messages FROM user_profiles WHERE membership_id = ?", otherId)?.direct_messages ?? "team";
  const shareTeam = !!one(conn, "SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.membership_id = ? AND b.membership_id = ?", actor.membershipId, otherId);
  let status: "pending" | "accepted" = "accepted";
  if (setting === "nobody" && !adminInitiated) throw new ForbiddenError("chat.manage");
  if (!adminInitiated && !shareTeam && setting !== "everyone") {
    if (setting === "requests") status = "pending";
    else throw new ForbiddenError("chat.manage");
  }
  return transaction(conn, () => {
    const id = insert(conn, "INSERT INTO conversations (org_id, kind, direct_key, request_status, created_by_membership_id) VALUES (?, 'direct', ?, ?, ?)", actor.orgId, key, status, actor.membershipId);
    for (const m of [actor.membershipId, otherId]) run(conn, "INSERT INTO conversation_members (conversation_id, membership_id, org_id) VALUES (?, ?, ?)", id, m, actor.orgId);
    return id;
  });
}

export function respondToRequest(conn: Conn, actor: Actor, conversationId: number, accept: boolean): void {
  const { conv } = requireConversation(conn, actor, conversationId, "read");
  if (conv.kind !== "direct" || conv.request_status !== "pending" || conv.created_by_membership_id === actor.membershipId) throw new ValidationError("Nessuna richiesta da gestire.");
  transaction(conn, () => {
    run(conn, "UPDATE conversations SET request_status = ? WHERE id = ?", accept ? "accepted" : "declined", conversationId);
    emit(conn, { type: "conversation.updated", conversationId }, conversationAudience(conn, conv));
  });
}

export function blockUser(conn: Conn, actor: Actor, otherId: number, blocked: boolean): void {
  if (!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND org_id = ?", otherId, actor.orgId) || otherId === actor.membershipId) throw new ValidationError("Persona non valida.");
  if (blocked) run(conn, "INSERT OR IGNORE INTO user_blocks (blocker_membership_id, blocked_membership_id) VALUES (?, ?)", actor.membershipId, otherId);
  else run(conn, "DELETE FROM user_blocks WHERE blocker_membership_id = ? AND blocked_membership_id = ?", actor.membershipId, otherId);
}

export const blockedByMe = (conn: Conn, actor: Actor): number[] => all<{ id: number }>(conn, "SELECT blocked_membership_id AS id FROM user_blocks WHERE blocker_membership_id = ?", actor.membershipId).map((r) => r.id);

// ───────────────────────── Allegati ─────────────────────────

/** Può leggere un allegato chi può leggere un messaggio che lo contiene, chi lo ha caricato (finché è in attesa) o, per gli avatar, i membri dell'organizzazione. */
export function canReadAttachment(conn: Conn, actor: Actor, attachmentId: number): boolean {
  const a = one<{ uploader: number; org_id: number }>(conn, "SELECT uploader_membership_id AS uploader, org_id FROM attachments WHERE id = ? AND deleted_at IS NULL", attachmentId);
  if (!a || a.org_id !== actor.orgId) return false;
  if (a.uploader === actor.membershipId) return true;
  if (one(conn, "SELECT 1 FROM user_profiles WHERE avatar_attachment_id = ?", attachmentId) || one(conn, "SELECT 1 FROM stickers WHERE attachment_id = ?", attachmentId)) return true;
  const convIds = all<{ id: number }>(conn, `SELECT DISTINCT m.conversation_id AS id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id = ? AND m.deleted_at IS NULL`, attachmentId).map((r) => r.id);
  const avatarConvs = all<{ id: number }>(conn, "SELECT id FROM conversations WHERE avatar_attachment_id = ?", attachmentId).map((r) => r.id);
  for (const id of [...convIds, ...avatarConvs]) {
    const c = one<ConvRow>(conn, "SELECT id, org_id, kind, team_id, title, description, avatar_attachment_id, direct_key, request_status, created_by_membership_id, archived_at FROM conversations WHERE id = ?", id);
    if (c && conversationAccess(conn, actor, c).read) return true;
  }
  return false; // gli allegati degli eventi non hanno ancora un'interfaccia: nessun accesso implicito
}

/** "Sta scrivendo…": effimero (solo in memoria) e inviato solo a chi può leggere la conversazione. */
export function announceTyping(conn: Conn, actor: Actor, conversationId: number): void {
  const { conv } = requireConversation(conn, actor, conversationId, "write");
  setTyping(conversationId, actor.membershipId);
  publish({ type: "typing", conversationId, membershipId: actor.membershipId }, conversationAudience(conn, conv).filter((id) => id !== actor.membershipId));
}

/** Dati per servire un allegato, solo se l'attore può leggerlo; altrimenti null (risposta uniforme "non trovato"). */
export function readableAttachment(conn: Conn, actor: Actor, attachmentId: number): { storageKey: string; name: string; mime: string; size: number } | null {
  if (!canReadAttachment(conn, actor, attachmentId)) return null;
  const a = one<{ storage_key: string; original_name: string; mime: string; size_bytes: number }>(conn, "SELECT storage_key, original_name, mime, size_bytes FROM attachments WHERE id = ? AND deleted_at IS NULL", attachmentId);
  return a ? { storageKey: a.storage_key, name: a.original_name, mime: a.mime, size: a.size_bytes } : null;
}
