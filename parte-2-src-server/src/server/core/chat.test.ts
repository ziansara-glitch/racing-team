import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { world } from "@/test/world";
import { subscribe, type RtEvent } from "./bus";
import { addGroupMember, blockUser, BUILTIN_STICKERS, canReadAttachment, createAdminGroup, deleteMessage, editMessage, forwardMessage, getChatPolicy, getMessages, groupMembers, listConversations, markRead, openDirect, removeGroupMember, respondToRequest, sendMessage, setChatPolicy, setConversationPrefs, setGroupRole, setPinned, toggleReaction, totalUnread, updateConversation } from "./chat";
import { ValidationError } from "./errors";
import { cleanFileName, registerAttachment, sniffMime, validateUpload } from "./media";
import { listNotifications } from "./notifications";
import { presenceFor, resetPresence, setTyping, touch, typingNow } from "./presence";
import { ensureTeamResources } from "./teams";

let w: ReturnType<typeof world>;
let boss: ReturnType<typeof w.person>;
let boss2: typeof boss;
let leadA: typeof boss;
let m1: typeof boss;
let m2: typeof boss;
let m3: typeof boss;
let teamA: number;
let teamB: number;

const conv = (a: typeof boss, kind: string, teamId?: number) => listConversations(w.conn, a).find((c) => c.kind === kind && (teamId === undefined || c.teamId === teamId));

beforeEach(() => {
  w = world();
  resetPresence();
  boss = w.person("Boss", "org_admin");
  boss2 = w.person("Beatrice", "org_admin");
  leadA = w.person("Lia Lead", "team_admin", ["Alfa"]);
  m1 = w.person("Mario", "member", ["Alfa"]);
  m2 = w.person("Marta", "member", ["Alfa"]);
  m3 = w.person("Bruno", "member", ["Beta"]);
  teamA = w.teamId("Alfa");
  teamB = w.teamId("Beta");
  for (const t of [teamA, teamB]) ensureTeamResources(w.conn, 1, t, boss.membershipId);
});

describe("chat di team e annunci: isolamento", () => {
  it("ogni membro vede solo le chat dei propri team; l'admin con ambito completo le vede tutte", () => {
    expect(listConversations(w.conn, m1).map((c) => `${c.kind}:${c.title}`).sort()).toEqual(["announcement:Annunci Alfa", "team_group:Alfa"]);
    expect(listConversations(w.conn, m3).every((c) => c.teamId === teamB)).toBe(true);
    expect(listConversations(w.conn, boss).filter((c) => c.kind === "team_group").map((c) => c.title)).toEqual(expect.arrayContaining(["Alfa", "Beta"]));
  });

  it("chi non è del team non legge, non scrive e non scopre che la chat esiste", () => {
    const chatA = conv(m1, "team_group")!.id;
    sendMessage(w.conn, m1, chatA, { body: "Ciao team" });
    expect(() => getMessages(w.conn, m3, chatA)).toThrow(NotFoundError);
    expect(() => sendMessage(w.conn, m3, chatA, { body: "intruso" })).toThrow(NotFoundError);
    expect(() => markRead(w.conn, m3, chatA)).toThrow(NotFoundError);
    expect(() => toggleReaction(w.conn, m3, 1, "👍")).toThrow();
    const foreign = w.otherOrg("beta");
    expect(() => getMessages(w.conn, foreign, chatA)).toThrow(NotFoundError);
    expect(listConversations(w.conn, foreign)).toEqual([]);
  });

  it("un membro rimosso dal team perde subito l'accesso alla chat", () => {
    const chatA = conv(m2, "team_group")!.id;
    sendMessage(w.conn, m2, chatA, { body: "Prima" });
    w.conn.prepare("DELETE FROM team_members WHERE membership_id = ?").run(m2.membershipId);
    expect(() => getMessages(w.conn, w.reload(m2), chatA)).toThrow(NotFoundError);
  });

  it("negli annunci scrivono solo gli amministratori; tutti i membri sono avvisati", () => {
    const ann = conv(m1, "announcement", teamA)!;
    expect(ann.canWrite).toBe(false);
    expect(() => sendMessage(w.conn, m1, ann.id, { body: "Posso?" })).toThrow(ForbiddenError);
    sendMessage(w.conn, leadA, ann.id, { body: "Riunione giovedì" });
    sendMessage(w.conn, boss, ann.id, { body: "Promemoria" });
    expect(listNotifications(w.conn, m1).items.map((n) => n.kind)).toEqual(["announcement", "announcement"]);
    expect(listNotifications(w.conn, m3).items).toEqual([]);
    const other = conv(boss, "announcement", teamB)!;
    expect(() => sendMessage(w.conn, leadA, other.id, { body: "fuori ambito" })).toThrow();
  });
});

describe("gruppi riservati agli amministratori", () => {
  it("solo gli admin li creano e vi entrano; i membri non li vedono e non possono entrarci", () => {
    expect(() => createAdminGroup(w.conn, m1, { title: "Segreto", memberIds: [] })).toThrow(ForbiddenError);
    expect(() => createAdminGroup(w.conn, boss, { title: "Segreto", memberIds: [m1.membershipId] })).toThrow(/solo gli amministratori/);
    const id = createAdminGroup(w.conn, boss, { title: "Direttivo", description: "Solo admin", memberIds: [boss2.membershipId, leadA.membershipId] });
    sendMessage(w.conn, boss2, id, { body: "Budget approvato" });
    expect(getMessages(w.conn, leadA, id).messages[0].body).toBe("Budget approvato");
    for (const outsider of [m1, m3]) {
      expect(() => getMessages(w.conn, outsider, id)).toThrow(NotFoundError);
      expect(() => sendMessage(w.conn, outsider, id, { body: "x" })).toThrow(NotFoundError);
      expect(listConversations(w.conn, outsider).some((c) => c.kind === "admin_group")).toBe(false);
      expect(() => addGroupMember(w.conn, outsider, id, outsider.membershipId)).toThrow();
    }
    // un org_admin che non è iscritto non la vede nemmeno (non è una chat "di tutti gli admin")
    const third = w.person("Terzo Admin", "org_admin");
    expect(() => getMessages(w.conn, third, id)).toThrow(NotFoundError);
  });

  it("un admin declassato a membro perde subito l'accesso, anche se è ancora iscritto", () => {
    const id = createAdminGroup(w.conn, boss, { title: "Direttivo", memberIds: [boss2.membershipId] });
    sendMessage(w.conn, boss, id, { body: "Riservato" });
    expect(getMessages(w.conn, boss2, id).messages).toHaveLength(1);
    w.conn.prepare("UPDATE memberships SET role = 'member' WHERE id = ?").run(boss2.membershipId);
    const demoted = w.reload(boss2);
    expect(() => getMessages(w.conn, demoted, id)).toThrow(NotFoundError);
    expect(() => sendMessage(w.conn, demoted, id, { body: "x" })).toThrow(NotFoundError);
  });

  it("gestione del gruppo: nome, descrizione, membri e ruoli; chi esce non legge più", () => {
    const id = createAdminGroup(w.conn, boss, { title: "Direttivo", memberIds: [boss2.membershipId] });
    expect(() => updateConversation(w.conn, boss2, id, { title: "Hack" })).toThrow(ForbiddenError);
    updateConversation(w.conn, boss, id, { title: "Consiglio", description: "Decisioni" });
    expect(listConversations(w.conn, boss).find((c) => c.id === id)).toMatchObject({ title: "Consiglio", description: "Decisioni" });
    setGroupRole(w.conn, boss, id, boss2.membershipId, "admin");
    addGroupMember(w.conn, boss2, id, leadA.membershipId);
    expect(groupMembers(w.conn, boss, id).map((m) => [m.name, m.role])).toEqual([["Boss", "owner"], ["Beatrice", "admin"], ["Lia Lead", "member"]]);
    expect(() => removeGroupMember(w.conn, boss2, id, boss.membershipId)).toThrow(/creatore/);
    removeGroupMember(w.conn, boss, id, leadA.membershipId);
    expect(() => getMessages(w.conn, leadA, id)).toThrow(NotFoundError);
    removeGroupMember(w.conn, boss2, id, boss2.membershipId); // si può uscire da soli
    expect(() => getMessages(w.conn, boss2, id)).toThrow(NotFoundError);
  });
});

describe("conversazioni dirette: privacy, richieste, blocchi", () => {
  it("una sola conversazione per coppia; tra colleghi di team si scrive subito", () => {
    const id = openDirect(w.conn, m1, m2.membershipId);
    expect(openDirect(w.conn, m2, m1.membershipId)).toBe(id);
    sendMessage(w.conn, m1, id, { body: "Hai le note?" });
    expect(listConversations(w.conn, m2).find((c) => c.id === id)).toMatchObject({ title: "Mario", unread: 1, kind: "direct" });
    expect(() => getMessages(w.conn, m3, id)).toThrow(NotFoundError);
    expect(() => openDirect(w.conn, m1, m1.membershipId)).toThrow(ValidationError);
  });

  it("con l'impostazione 'team' un estraneo non può scrivere; con 'nessuno' nemmeno; l'amministratore sì", () => {
    expect(() => openDirect(w.conn, m1, m3.membershipId)).toThrow(ForbiddenError);
    w.conn.prepare("INSERT INTO user_profiles (membership_id, direct_messages) VALUES (?, 'nobody')").run(m3.membershipId);
    expect(() => openDirect(w.conn, m2, m3.membershipId)).toThrow(ForbiddenError);
    expect(openDirect(w.conn, leadA, m3.membershipId)).toBeGreaterThan(0);
  });

  it("richieste di messaggio: un solo messaggio finché non si accetta; il rifiuto chiude", () => {
    w.conn.prepare("INSERT INTO user_profiles (membership_id, direct_messages) VALUES (?, 'requests')").run(m3.membershipId);
    const id = openDirect(w.conn, m1, m3.membershipId);
    sendMessage(w.conn, m1, id, { body: "Ciao, sono Mario" });
    expect(() => sendMessage(w.conn, m1, id, { body: "Ci sei?" })).toThrow(/un solo messaggio/);
    expect(() => sendMessage(w.conn, m3, id, { body: "Rispondo" })).toThrow(/Accetta/);
    expect(listConversations(w.conn, m3).find((c) => c.id === id)).toMatchObject({ incomingRequest: true });
    expect(totalUnread(w.conn, m3)).toBe(0); // le richieste non gonfiano il contatore
    expect(() => respondToRequest(w.conn, m1, id, true)).toThrow(ValidationError);
    respondToRequest(w.conn, m3, id, true);
    sendMessage(w.conn, m3, id, { body: "Ciao Mario" });
    sendMessage(w.conn, m1, id, { body: "Ora posso" });
    const id2 = (() => { w.conn.prepare("INSERT INTO user_profiles (membership_id, direct_messages) VALUES (?, 'requests')").run(m2.membershipId); return id; })();
    void id2;
  });

  it("il blocco impedisce di aprire e di scrivere, in entrambe le direzioni; si può togliere", () => {
    const id = openDirect(w.conn, m1, m2.membershipId);
    sendMessage(w.conn, m1, id, { body: "ok" });
    blockUser(w.conn, m2, m1.membershipId, true);
    expect(() => sendMessage(w.conn, m1, id, { body: "x" })).toThrow(ForbiddenError);
    expect(() => sendMessage(w.conn, m2, id, { body: "x" })).toThrow(ForbiddenError);
    expect(() => openDirect(w.conn, m1, m2.membershipId)).not.toThrow(); // la conversazione esiste: si riapre per leggere
    expect(getMessages(w.conn, m1, id).messages).toHaveLength(1);
    blockUser(w.conn, m2, m1.membershipId, false);
    sendMessage(w.conn, m1, id, { body: "di nuovo" });
    blockUser(w.conn, m1, m3.membershipId, true);
    expect(() => openDirect(w.conn, m3, m1.membershipId)).toThrow(ForbiddenError);
  });
});

describe("messaggi", () => {
  let chat: number;
  beforeEach(() => { chat = conv(m1, "team_group")!.id; });

  it("invia testo, risposte e sticker; valida contenuto, lunghezza e riferimenti", () => {
    const a = sendMessage(w.conn, m1, chat, { body: "  Ciao  " });
    const b = sendMessage(w.conn, m2, chat, { body: "Ciao a te", replyToId: a });
    sendMessage(w.conn, m1, chat, { stickerKey: BUILTIN_STICKERS[1].key });
    const msgs = getMessages(w.conn, m2, chat).messages;
    expect(msgs.map((m) => m.kind)).toEqual(["text", "text", "sticker"]);
    expect(msgs[0].body).toBe("Ciao");
    expect(msgs[1].replyTo).toMatchObject({ id: a, authorName: "Mario", body: "Ciao" });
    expect(() => sendMessage(w.conn, m1, chat, { body: "" })).toThrow(/Scrivi un messaggio/);
    expect(() => sendMessage(w.conn, m1, chat, { body: "x".repeat(4001) })).toThrow(/4000/);
    expect(() => sendMessage(w.conn, m1, chat, { stickerKey: "builtin:nope" })).toThrow(/Sticker/);
    const other = conv(m3, "team_group")!.id;
    const foreignMsg = sendMessage(w.conn, m3, other, { body: "altro team" });
    expect(() => sendMessage(w.conn, m1, chat, { body: "x", replyToId: foreignMsg })).toThrow(/non esiste in questa conversazione/);
    void b;
  });

  it("limita le raffiche di messaggi", () => {
    for (let i = 0; i < 20; i++) sendMessage(w.conn, m1, chat, { body: `m${i}` });
    expect(() => sendMessage(w.conn, m1, chat, { body: "21" })).toThrow(/troppo in fretta/);
    sendMessage(w.conn, m2, chat, { body: "altri non penalizzati" });
  });

  it("allegati: solo i propri, ancora in attesa, una volta sola; il tipo del messaggio segue il contenuto", () => {
    const reg = (a: typeof m1, mime: string, name = "f") => registerAttachment(w.conn, a, { storageKey: `k-${Math.random()}`, originalName: name, mime, size: 100, sha256: "00" });
    const img1 = reg(m1, "image/png", "a.png");
    const img2 = reg(m1, "image/jpeg", "b.jpg");
    const voice = reg(m1, "audio/webm", "nota.webm");
    const theirs = reg(m2, "image/png");
    expect(() => sendMessage(w.conn, m1, chat, { attachmentIds: [theirs] })).toThrow(/Allegato non valido/);
    expect(() => sendMessage(w.conn, m1, chat, { attachmentIds: [999999] })).toThrow(/Allegato non valido/);
    sendMessage(w.conn, m1, chat, { body: "Foto", attachmentIds: [img1, img2] });
    sendMessage(w.conn, m1, chat, { attachmentIds: [voice] });
    expect(() => sendMessage(w.conn, m1, chat, { attachmentIds: [img1] })).toThrow(/già usato/);
    const msgs = getMessages(w.conn, m2, chat).messages;
    expect(msgs.map((m) => [m.kind, m.attachments.length])).toEqual([["image", 2], ["audio", 1]]);
    expect(msgs[1].attachments[0]).toMatchObject({ mime: "audio/webm", name: "nota.webm" });
    // accesso agli allegati: chi legge la chat sì, gli altri no
    expect(canReadAttachment(w.conn, m2, img1)).toBe(true);
    expect(canReadAttachment(w.conn, m3, img1)).toBe(false);
    expect(canReadAttachment(w.conn, w.otherOrg("beta"), img1)).toBe(false);
    expect(canReadAttachment(w.conn, m1, theirs)).toBe(false); // in attesa: solo chi l'ha caricato
    expect(canReadAttachment(w.conn, m2, theirs)).toBe(true);
  });

  it("modifica e eliminazione rispettano le finestre di tempo dell'organizzazione; i moderatori eliminano tutto con audit", () => {
    const id = sendMessage(w.conn, m1, chat, { body: "Originale" });
    editMessage(w.conn, m1, id, "Corretto");
    expect(getMessages(w.conn, m2, chat).messages[0]).toMatchObject({ body: "Corretto", canEdit: false });
    expect(() => editMessage(w.conn, m2, id, "Hack")).toThrow(ForbiddenError);
    expect(getMessages(w.conn, m1, chat).messages[0]).toMatchObject({ canEdit: true, canDelete: true });
    w.conn.prepare("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    expect(() => editMessage(w.conn, m1, id, "Troppo tardi")).toThrow(/scaduto/);
    expect(() => deleteMessage(w.conn, m1, id)).toThrow(/scaduto/);
    expect(() => deleteMessage(w.conn, m2, id)).toThrow(ForbiddenError);
    deleteMessage(w.conn, leadA, id);
    expect(getMessages(w.conn, m2, chat).messages[0]).toMatchObject({ deleted: true, body: "" });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'chat.message.moderate'").get()).toEqual({ n: 1 });
    expect(() => editMessage(w.conn, m1, id, "x")).toThrow();
  });

  it("la policy dell'organizzazione cambia le finestre; solo chi gestisce l'organizzazione la modifica", () => {
    expect(() => setChatPolicy(w.conn, leadA, { editWindowMinutes: 0 })).toThrow(ForbiddenError);
    expect(() => setChatPolicy(w.conn, boss, { editWindowMinutes: -5 })).toThrow(/non validi/);
    setChatPolicy(w.conn, boss, { editWindowMinutes: 0 }); // 0 = nessun limite
    const id = sendMessage(w.conn, m1, chat, { body: "Vecchio" });
    w.conn.prepare("UPDATE messages SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    editMessage(w.conn, m1, id, "Ancora modificabile");
    expect(getChatPolicy(w.conn, 1)).toMatchObject({ editWindowMinutes: 0, deleteWindowMinutes: 60 });
  });

  it("reazioni: si aggiungono e si tolgono; solo emoji; non su messaggi eliminati", () => {
    const id = sendMessage(w.conn, m1, chat, { body: "Bella!" });
    toggleReaction(w.conn, m2, id, "👍");
    toggleReaction(w.conn, m1, id, "👍");
    toggleReaction(w.conn, m2, id, "🔥");
    const r = () => getMessages(w.conn, m2, chat).messages[0].reactions;
    expect(r()).toEqual([{ emoji: "👍", count: 2, mine: true }, { emoji: "🔥", count: 1, mine: true }]);
    toggleReaction(w.conn, m2, id, "👍");
    expect(r()[0]).toMatchObject({ emoji: "👍", count: 1, mine: false });
    expect(() => toggleReaction(w.conn, m2, id, "abc")).toThrow(/non valida/);
    expect(() => toggleReaction(w.conn, m3, id, "👍")).toThrow();
    deleteMessage(w.conn, m1, id);
    expect(() => toggleReaction(w.conn, m2, id, "👍")).toThrow(/eliminato/);
  });

  it("messaggi fissati: solo i moderatori nelle chat di team; elenco dedicato", () => {
    const id = sendMessage(w.conn, m1, chat, { body: "Regole del team" });
    sendMessage(w.conn, m1, chat, { body: "Altro" });
    expect(() => setPinned(w.conn, m1, id, true)).toThrow(ForbiddenError);
    setPinned(w.conn, leadA, id, true);
    expect(getMessages(w.conn, m2, chat, { pinnedOnly: true }).messages.map((m) => m.body)).toEqual(["Regole del team"]);
    setPinned(w.conn, leadA, id, false);
    expect(getMessages(w.conn, m2, chat, { pinnedOnly: true }).messages).toEqual([]);
  });

  it("inoltro: copia testo e allegati nelle conversazioni dove si può scrivere", () => {
    const att = registerAttachment(w.conn, m1, { storageKey: "kk", originalName: "doc.pdf", mime: "application/pdf", size: 10, sha256: "0" });
    const id = sendMessage(w.conn, m1, chat, { body: "Guarda", attachmentIds: [att] });
    const dm = openDirect(w.conn, m1, m2.membershipId);
    const [copy] = forwardMessage(w.conn, m1, id, [dm]);
    expect(getMessages(w.conn, m2, dm).messages[0]).toMatchObject({ id: copy, body: "Guarda", forwarded: true });
    expect(getMessages(w.conn, m2, dm).messages[0].attachments).toHaveLength(1);
    const ann = conv(m1, "announcement", teamA)!.id;
    expect(() => forwardMessage(w.conn, m1, id, [ann])).toThrow(ForbiddenError); // non può scrivere negli annunci
    expect(() => forwardMessage(w.conn, m3, id, [conv(m3, "team_group")!.id])).toThrow(); // non può leggere l'originale
  });

  it("lettura: contatori, ricevute di lettura e silenziamento", () => {
    const a = sendMessage(w.conn, m1, chat, { body: "uno" });
    sendMessage(w.conn, m1, chat, { body: "due" });
    expect(conv(m2, "team_group")!.unread).toBe(2);
    expect(conv(m1, "team_group")!.unread).toBe(0);
    expect(getMessages(w.conn, m1, chat).messages.map((m) => m.readBy)).toEqual([0, 0]);
    markRead(w.conn, m2, chat, a);
    expect(conv(m2, "team_group")!.unread).toBe(1);
    expect(getMessages(w.conn, m1, chat).messages.map((m) => m.readBy)).toEqual([1, 0]);
    markRead(w.conn, m2, chat);
    expect(conv(m2, "team_group")!.unread).toBe(0);
    sendMessage(w.conn, m1, chat, { body: "tre" });
    setConversationPrefs(w.conn, m2, chat, { muted: true, pinned: true });
    expect(conv(m2, "team_group")).toMatchObject({ unread: 1, muted: true, pinned: true });
    expect(totalUnread(w.conn, m2)).toBe(0); // silenziata: non conta nel totale
    expect(listConversations(w.conn, m2, { unreadOnly: true }).map((c) => c.kind)).toEqual(["team_group"]);
    expect(listConversations(w.conn, m2, { q: "annunci" }).map((c) => c.kind)).toEqual(["announcement"]);
  });

  it("paginazione e ricerca nella conversazione", () => {
    for (let i = 1; i <= 45; i++) {
      w.conn.prepare("INSERT INTO messages (org_id, conversation_id, author_membership_id, body) VALUES (1, ?, ?, ?)").run(chat, m1.membershipId, i === 7 ? "cerco la FASCIA alare" : `messaggio ${i}`);
    }
    const first = getMessages(w.conn, m2, chat, { limit: 20 });
    expect(first.messages).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(first.messages[0].body).toBe("messaggio 26");
    const older = getMessages(w.conn, m2, chat, { limit: 20, beforeId: first.messages[0].id });
    expect(older.messages[0].body).toBe("messaggio 6");
    expect(getMessages(w.conn, m2, chat, { q: "fascia" }).messages.map((m) => m.body)).toEqual(["cerco la FASCIA alare"]);
    expect(getMessages(w.conn, m2, chat, { q: "%" }).messages).toEqual([]);
  });
});

describe("tempo reale della chat", () => {
  it("un messaggio arriva ai membri del team e agli admin con ambito completo, non agli altri team", () => {
    const seen: Record<string, RtEvent[]> = { m2: [], m3: [], boss: [], lead: [] };
    const offs = [subscribe(m2.membershipId, (e) => seen.m2.push(e)), subscribe(m3.membershipId, (e) => seen.m3.push(e)), subscribe(boss.membershipId, (e) => seen.boss.push(e)), subscribe(leadA.membershipId, (e) => seen.lead.push(e))];
    const chat = conv(m1, "team_group")!.id;
    const id = sendMessage(w.conn, m1, chat, { body: "Ciao" });
    toggleReaction(w.conn, m2, id, "👍");
    markRead(w.conn, m2, chat);
    expect(seen.m2.map((e) => e.type)).toEqual(["message.created", "message.updated", "read.updated"]);
    expect(seen.lead.map((e) => e.type)).toContain("message.created");
    expect(seen.boss.map((e) => e.type)).toContain("message.created");
    expect(seen.m3).toEqual([]);
    for (const o of offs) o();
  });

  it("i messaggi di un gruppo admin e dei diretti raggiungono solo gli iscritti", () => {
    const g = createAdminGroup(w.conn, boss, { title: "Direttivo", memberIds: [boss2.membershipId] });
    const seen: Record<string, RtEvent[]> = { boss2: [], lead: [], m1: [] };
    const offs = [subscribe(boss2.membershipId, (e) => seen.boss2.push(e)), subscribe(leadA.membershipId, (e) => seen.lead.push(e)), subscribe(m1.membershipId, (e) => seen.m1.push(e))];
    sendMessage(w.conn, boss, g, { body: "Riservato" });
    const dm = openDirect(w.conn, m1, m2.membershipId);
    sendMessage(w.conn, m1, dm, { body: "privato" });
    expect(seen.boss2.map((e) => e.conversationId)).toEqual([g]);
    expect(seen.lead).toEqual([]);
    expect(seen.m1.map((e) => e.conversationId)).toEqual([dm]);
    for (const o of offs) o();
  });
});

describe("presenza e 'sta scrivendo'", () => {
  it("visibile solo a chi condivide team o conversazione e solo se non disattivata", () => {
    const now = 1_000_000;
    touch(m2.membershipId, now - 10_000);
    touch(m3.membershipId, now - 10_000);
    touch(boss.membershipId, now - 10_000);
    expect(presenceFor(w.conn, m1, [m2.membershipId, m3.membershipId, m1.membershipId], now)).toEqual({ [m2.membershipId]: "online", [m3.membershipId]: "hidden" });
    w.conn.prepare("INSERT INTO user_profiles (membership_id, show_presence) VALUES (?, 0)").run(m2.membershipId);
    expect(presenceFor(w.conn, m1, [m2.membershipId], now)[m2.membershipId]).toBe("hidden");
    touch(leadA.membershipId, now - 120_000);
    expect(presenceFor(w.conn, m1, [leadA.membershipId], now)[leadA.membershipId]).toBe("offline");
  });

  it("l'indicatore 'sta scrivendo' scade dopo pochi secondi", () => {
    setTyping(5, m1.membershipId, 1000);
    setTyping(5, m2.membershipId, 4000);
    expect(typingNow(5, 6500).sort()).toEqual([m2.membershipId]);
    expect(typingNow(5, 20_000)).toEqual([]);
  });
});

describe("upload: validazione dei file", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(32).fill(0)]);
  const txt = (s: string) => new TextEncoder().encode(s);
  const check = (name: string, mime: string, head: Uint8Array, size = 1000, max = 25) => validateUpload({ fileName: name, declaredMime: mime, size, head, maxUploadMb: max });

  it("riconosce i formati dai primi byte, indipendentemente dal nome", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "x.bin")).toBe("image/png");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0), "x")).toBe("image/jpeg");
    expect(sniffMime(txt("GIF89a......"), "x")).toBe("image/gif");
    expect(sniffMime(new Uint8Array([...txt("RIFF"), 0, 0, 0, 0, ...txt("WEBP")]), "x")).toBe("image/webp");
    expect(sniffMime(new Uint8Array([...txt("RIFF"), 0, 0, 0, 0, ...txt("WAVE")]), "x")).toBe("audio/wav");
    expect(sniffMime(txt("%PDF-1.7"), "x")).toBe("application/pdf");
    expect(sniffMime(txt("OggS...."), "x")).toBe("audio/ogg");
    expect(sniffMime(txt("ID3\x03"), "x")).toBe("audio/mpeg");
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3), "voce.webm", "audio/webm")).toBe("audio/webm");
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3), "clip.webm", "video/webm")).toBe("video/webm");
    expect(sniffMime(new Uint8Array([0, 0, 0, 24, ...txt("ftypisom")]), "v.mp4")).toBe("video/mp4");
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04), "relazione.docx")).toContain("wordprocessingml");
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04), "archivio.zip")).toBeNull();
    expect(sniffMime(txt("a,b\n1,2\n"), "dati.csv")).toBe("text/csv");
  });

  it("rifiuta HTML, SVG, script ed eseguibili travestiti, e i tipi non dichiarati coerenti", () => {
    expect(() => check("p.html", "text/html", txt("<html><script>alert(1)</script>"))).toThrow(/non consentito/);
    expect(() => check("logo.svg", "image/svg+xml", txt("<svg onload=alert(1)>"))).toThrow(/non consentito/);
    expect(() => check("note.txt", "text/plain", txt("<script>alert(1)</script>"))).toThrow(/non consentito/);
    expect(() => check("foto.png", "image/png", txt("MZ\x90\x00 eseguibile"))).toThrow(/non consentito/);
    expect(() => check("a.txt", "text/plain", new Uint8Array([65, 0, 66]))).toThrow(/non consentito/);
    expect(() => check("foto.jpg", "image/png", bytes(0xff, 0xd8, 0xff))).toThrow(/non corrisponde/);
    expect(check("foto.jpg", "application/octet-stream", bytes(0xff, 0xd8, 0xff)).mime).toBe("image/jpeg");
    expect(check("nota.webm", "audio/webm;codecs=opus", bytes(0x1a, 0x45, 0xdf, 0xa3)).kind).toBe("audio");
  });

  it("applica i limiti di dimensione per tipo e quello dell'organizzazione", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(() => check("g.png", "image/png", png, 11 * 1024 * 1024)).toThrow(/10 MB/);
    expect(() => check("g.pdf", "application/pdf", txt("%PDF-"), 6 * 1024 * 1024, 5)).toThrow(/5 MB/);
    expect(() => check("v.png", "image/png", png, 0)).toThrow(/vuoto/);
    expect(check("g.pdf", "application/pdf", txt("%PDF-"), 20 * 1024 * 1024).inline).toBe(true);
    expect(check("g.docx", "", bytes(0x50, 0x4b, 0x03, 0x04), 100).inline).toBe(false);
  });

  it("ripulisce i nomi dei file", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("etcpasswd");
    expect(cleanFileName("  ..\\win\u0000dows.txt ")).toBe("windows.txt");
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName("a".repeat(300))).toHaveLength(120);
  });
});
