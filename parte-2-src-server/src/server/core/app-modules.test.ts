import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { db as mockDb } from "@/server/db";
import { resetDb } from "@/test/mock-db";
import { world } from "@/test/world";
import { createEvent, recordAttendance, teamCalendar } from "./calendar";
import { sendMessage } from "./chat";
import { listAudit } from "./audit-query";
import { adminDashboard, memberHome } from "./dashboard";
import { ValidationError } from "./errors";
import { registerAttachment } from "./media";
import { createPoll, publishPoll } from "./polls";
import { getProfile, updateProfile } from "./profile";
import { ensureTeamResources } from "./teams";
import { listConversations } from "./chat";
import { runMaintenance } from "@/server/maintenance";
import { writeAudit } from "@/server/audit";
import { listNotifications } from "./notifications";

vi.mock("@/server/db", () => import("@/test/mock-db"));

const w = world(mockDb);
let boss: ReturnType<typeof w.person>;
let lead: typeof boss;
let m1: typeof boss;
let m3: typeof boss;
let teamA: number;

beforeEach(() => {
  resetDb();
  boss = w.person("Boss", "org_admin");
  lead = w.person("Lia Lead", "team_admin", ["Alfa"]);
  m1 = w.person("Mario", "member", ["Alfa"]);
  m3 = w.person("Bruno", "member", ["Beta"]);
  teamA = w.teamId("Alfa");
  w.conn.prepare("UPDATE team_members SET role = 'lead' WHERE team_id = ? AND membership_id = ?").run(teamA, lead.membershipId);
  for (const t of [teamA, w.teamId("Beta")]) ensureTeamResources(w.conn, 1, t, boss.membershipId);
});

describe("centro di comando", () => {
  it("un team admin vede solo i numeri del proprio team; l'admin dell'organizzazione quelli di tutti", () => {
    const l = adminDashboard(w.conn, lead, "2026-03-10").kpis;
    expect(l).toMatchObject({ teams: 1, members: 2 });
    const b = adminDashboard(w.conn, boss, "2026-03-10").kpis;
    expect(b.members).toBe(4);
    expect(b.teams).toBeGreaterThan(l.teams);
  });

  it("le candidature (non ancora legate ai team) le conta solo chi ha ambito completo", () => {
    w.conn.prepare("INSERT INTO applications (name, course, year, interests, status) VALUES ('A', 'c', 'y', 'i', 'Nuova')").run();
    expect(adminDashboard(w.conn, lead).kpis.pendingApplications).toBe(0);
    expect(adminDashboard(w.conn, boss).kpis.pendingApplications).toBe(1);
  });

  it("presenze e riunioni calcolate dai dati, nell'ambito di chi guarda", () => {
    const cal = teamCalendar(w.conn, lead, teamA);
    const id = createEvent(w.conn, lead, cal.id, { title: "Riunione", kind: "meeting", startsAt: "2026-03-09T18:00", endsAt: "2026-03-09T19:00" });
    recordAttendance(w.conn, lead, id, "2026-03-09", [{ membershipId: m1.membershipId, state: "present" }, { membershipId: lead.membershipId, state: "absent" }]);
    const d = adminDashboard(w.conn, lead, "2026-03-10");
    expect(d.kpis).toMatchObject({ attendanceRate: 50, attendanceRecords: 2 });
    const other = w.person("Altro Lead", "team_admin", ["Beta"]);
    expect(adminDashboard(w.conn, other, "2026-03-10").kpis.attendanceRate).toBeNull();
    expect(adminDashboard(w.conn, lead, "2026-03-07").kpis.upcomingMeetings).toBe(1);
  });

  it("i sondaggi da gestire sono quelli del proprio ambito", () => {
    const id = createPoll(w.conn, lead, { teamId: teamA, title: "Riunione", weekStart: "2026-03-09", options: [{ date: "2026-03-10", startTime: "18:00", endTime: "19:00" }] }, "2026-03-01T10:00");
    expect(adminDashboard(w.conn, lead).polls.map((p) => p.id)).toEqual([id]);
    expect(adminDashboard(w.conn, w.person("Altro", "team_admin", ["Beta"])).polls).toEqual([]);
  });
});

describe("home dei membri", () => {
  it("annunci, eventi e sondaggi sono solo del proprio team", () => {
    const ann = listConversations(w.conn, lead).find((c) => c.kind === "announcement" && c.teamId === teamA)!.id;
    sendMessage(w.conn, lead, ann, { body: "Solo per Alfa" });
    const id = createPoll(w.conn, lead, { teamId: teamA, title: "Riunione", weekStart: "2026-03-09", options: [{ date: "2026-03-10", startTime: "18:00", endTime: "19:00" }] }, "2026-03-01T10:00");
    publishPoll(w.conn, lead, id);
    expect(memberHome(w.conn, m1, "2026-03-05", "2026-03-05T10:00").announcements.map((a) => a.body)).toEqual(["Solo per Alfa"]);
    expect(memberHome(w.conn, m1, "2026-03-05", "2026-03-05T10:00").polls).toHaveLength(1);
    const other = memberHome(w.conn, m3, "2026-03-05", "2026-03-05T10:00");
    expect(other.announcements).toEqual([]);
    expect(other.polls).toEqual([]);
    expect(memberHome(w.conn, m1).unreadNotifications).toBeGreaterThan(0);
  });
});

describe("profilo e privacy", () => {
  it("email e telefono li vedono solo il diretto interessato e gli amministratori", () => {
    updateProfile(w.conn, m1, { phone: "+39 333 1234567", contactEmail: "mario@esempio.it" });
    expect(getProfile(w.conn, m1)).toMatchObject({ phone: "+39 333 1234567", contactEmail: "mario@esempio.it" });
    expect(getProfile(w.conn, boss, m1.membershipId)).toMatchObject({ phone: "+39 333 1234567" });
    // un collega semplice non vede i contatti
    const colleague = w.person("Marta", "member", ["Alfa"]);
    expect(getProfile(w.conn, colleague, m1.membershipId)).toMatchObject({ email: null, phone: "", contactEmail: "" });
    // il responsabile del team li vede perché condivide il team; il responsabile di un ALTRO team no
    expect(getProfile(w.conn, lead, m1.membershipId)).toMatchObject({ phone: "+39 333 1234567" });
    const otherLead = w.person("Altro Lead", "team_admin", ["Beta"]);
    expect(getProfile(w.conn, otherLead, m1.membershipId)).toMatchObject({ email: null, phone: "", contactEmail: "" });
    expect(() => getProfile(w.conn, m1, w.otherOrg("beta").membershipId)).toThrow(NotFoundError);
  });

  it("valida i campi e usa i valori di default riservati (presenza visibile, DM tra colleghi)", () => {
    expect(getProfile(w.conn, m1)).toMatchObject({ showPresence: true, directMessages: "team" });
    expect(() => updateProfile(w.conn, m1, { phone: "abc" })).toThrow(ValidationError);
    expect(() => updateProfile(w.conn, m1, { contactEmail: "non-una-email" })).toThrow(ValidationError);
    expect(() => updateProfile(w.conn, m1, { bio: "x".repeat(301) })).toThrow(ValidationError);
    expect(() => updateProfile(w.conn, m1, { directMessages: "chiunque" as never })).toThrow(ValidationError);
    updateProfile(w.conn, m1, { showPresence: false, directMessages: "requests" });
    expect(getProfile(w.conn, m1)).toMatchObject({ showPresence: false, directMessages: "requests" });
  });

  it("l'avatar deve essere un'immagine caricata da sé stessi", () => {
    const own = registerAttachment(w.conn, m1, { storageKey: "1/a", originalName: "a.png", mime: "image/png", size: 10, sha256: "0" });
    const doc = registerAttachment(w.conn, m1, { storageKey: "1/b", originalName: "b.pdf", mime: "application/pdf", size: 10, sha256: "0" });
    const theirs = registerAttachment(w.conn, lead, { storageKey: "1/c", originalName: "c.png", mime: "image/png", size: 10, sha256: "0" });
    expect(() => updateProfile(w.conn, m1, { avatarAttachmentId: doc })).toThrow(/Immagine/);
    expect(() => updateProfile(w.conn, m1, { avatarAttachmentId: theirs })).toThrow(/Immagine/);
    updateProfile(w.conn, m1, { avatarAttachmentId: own });
    expect(getProfile(w.conn, m1).avatarId).toBe(own);
    expect(w.conn.prepare("SELECT status FROM attachments WHERE id = ?").get(own)).toEqual({ status: "attached" });
  });
});

describe("registro attività", () => {
  it("solo chi ha audit.read su tutta l'organizzazione lo consulta; filtri e paginazione", () => {
    for (let i = 0; i < 7; i++) writeAudit(w.conn, { orgId: 1, actorUserId: boss.userId, action: i % 2 ? "poll.create" : "team.create", meta: { i } });
    expect(() => listAudit(w.conn, lead)).toThrow(ForbiddenError);
    expect(() => listAudit(w.conn, m1)).toThrow(ForbiddenError);
    const all = listAudit(w.conn, boss);
    expect(all.total).toBeGreaterThanOrEqual(7);
    expect(listAudit(w.conn, boss, { action: "poll." }).rows.every((r) => r.action.startsWith("poll."))).toBe(true);
    expect(listAudit(w.conn, boss, { action: "poll.", pageSize: 2, page: 2 }).rows).toHaveLength(1);
    expect(listAudit(w.conn, boss, { action: "%" }).total).toBe(0);
    expect(listAudit(w.conn, w.otherOrg("beta")).total).toBe(0);
  });
});

describe("manutenzione periodica", () => {
  it("chiude i sondaggi scaduti e manda i promemoria, senza confermare né pubblicare nulla", () => {
    const poll = createPoll(w.conn, lead, { teamId: teamA, title: "Riunione", weekStart: "2026-03-09", deadline: "2026-03-09T20:00", recurrence: "weekly", options: [{ date: "2026-03-10", startTime: "18:00", endTime: "19:00" }] }, "2026-03-01T10:00");
    publishPoll(w.conn, lead, poll);
    const cal = teamCalendar(w.conn, lead, teamA);
    createEvent(w.conn, lead, cal.id, { title: "Prove", startsAt: "2026-03-10T09:00", endsAt: "2026-03-10T17:00", reminders: [60] });
    const early = runMaintenance(new Date("2026-03-09T15:00:00Z")); // 16:00 a Roma, prima della scadenza
    expect(early.closedPolls).toBe(0);
    const late = runMaintenance(new Date("2026-03-09T21:30:00Z")); // 22:30 a Roma: scaduto
    expect(late.closedPolls).toBe(1);
    expect(w.conn.prepare("SELECT status, event_id FROM meeting_polls WHERE id = ?").get(poll)).toEqual({ status: "closed", event_id: null });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM events WHERE title = 'Riunione'").get()).toEqual({ n: 0 }); // nessun evento: la conferma resta all'amministratore
    // chiusura e bozza ricorrente avvengono nella stessa esecuzione; la successiva non ne crea una seconda
    expect(late.draftPolls).toBe(1);
    expect(runMaintenance(new Date("2026-03-09T22:00:00Z")).draftPolls).toBe(0);
    expect(w.conn.prepare("SELECT status FROM meeting_polls WHERE parent_poll_id = ?").get(poll)).toEqual({ status: "draft" });
    const rem = runMaintenance(new Date("2026-03-10T07:30:00Z")); // 08:30 a Roma: entro 60 minuti dall'inizio
    expect(rem.reminders).toBeGreaterThan(0);
    expect(listNotifications(w.conn, m1).items.some((n) => n.kind === "event_reminder")).toBe(true);
    expect(runMaintenance(new Date("2026-03-10T07:40:00Z")).reminders).toBe(0); // già inviato
  });

  it("ripulisce i file caricati e mai usati da più di 24 ore, non quelli recenti o già agganciati", () => {
    const reg = (key: string) => registerAttachment(w.conn, m1, { storageKey: key, originalName: "f.png", mime: "image/png", size: 5, sha256: "0" });
    const hex = (c: string) => `1/${c.repeat(32)}`;
    const old = reg(hex("a"));
    const fresh = reg(hex("b"));
    const used = reg(hex("c"));
    const broken = reg("chiave-non-valida"); // non deve bloccare la pulizia degli altri
    w.conn.prepare("UPDATE attachments SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(broken);
    w.conn.prepare("UPDATE attachments SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(old, used);
    w.conn.prepare("UPDATE attachments SET status = 'attached' WHERE id = ?").run(used);
    expect(runMaintenance().orphanFiles).toBe(2);
    const state = (id: number) => (w.conn.prepare("SELECT deleted_at IS NOT NULL AS gone FROM attachments WHERE id = ?").get(id) as { gone: number }).gone;
    expect([state(old), state(fresh), state(used), state(broken)]).toEqual([1, 0, 0, 1]);
  });
});
