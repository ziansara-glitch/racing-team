import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/authorize";
import { world } from "@/test/world";
import { subscribe, type RtEvent } from "./bus";
import { cancelOccurrence, createEvent, deleteEvent, dispatchReminders, eventAttendance, listCalendars, listEvents, recordAttendance, respondToEvent, setCalendarGrant, teamCalendar, updateEvent } from "./calendar";
import { ValidationError } from "./errors";
import { listNotifications, unreadCount } from "./notifications";
import { cancelPoll, closeExpiredPolls, closePoll, createPoll, finalizePoll, generateRecurringPolls, listPollsAdmin, listPollsForMember, pendingPollCount, pollResults, publishPoll, respondToPoll, setPollAttendance, updatePoll } from "./polls";
import { expandOccurrences, mondayOf, type Recurrence } from "./recurrence";
import { emit } from "./realtime";
import { addTeamMember, createTeam, deleteTeam, listTeams, removeTeamMember, teamMembers, teamStats, updateTeam } from "./teams";
import { transaction } from "./tx";

let w: ReturnType<typeof world>;
let boss: ReturnType<typeof w.person>; // org_admin
let leadA: typeof boss; // team_admin del team A
let m1: typeof boss; // membro team A
let m2: typeof boss; // membro team A
let m3: typeof boss; // membro team B
let teamA: number;
let teamB: number;

beforeEach(() => {
  w = world();
  boss = w.person("Boss", "org_admin");
  leadA = w.person("Lia Lead", "team_admin", ["Alfa"]);
  m1 = w.person("Mario", "member", ["Alfa"]);
  m2 = w.person("Marta", "member", ["Alfa"]);
  m3 = w.person("Bruno", "member", ["Beta"]);
  teamA = w.teamId("Alfa");
  teamB = w.teamId("Beta");
  w.conn.prepare("UPDATE team_members SET role = 'lead' WHERE team_id = ? AND membership_id = ?").run(teamA, leadA.membershipId);
});

const rec = (over: Partial<Recurrence>): Recurrence => ({ freq: null, interval: 1, byday: "", until: null, count: null, ...over });
const ev = (starts: string, ends: string, r: Recurrence) => ({ starts_at: starts, ends_at: ends, rec: r });
const dates = (e: ReturnType<typeof ev>, from: string, to: string, ex: string[] = []) => expandOccurrences(e, from, to, new Set(ex)).map((o) => o.date);

describe("ricorrenze", () => {
  it("evento singolo: compare solo se tocca la finestra, anche su più giorni", () => {
    const e = ev("2026-03-10T09:00", "2026-03-12T18:00", rec({}));
    expect(dates(e, "2026-03-01", "2026-03-09")).toEqual([]);
    expect(dates(e, "2026-03-11", "2026-03-20")).toEqual(["2026-03-10"]);
    expect(expandOccurrences(e, "2026-03-10", "2026-03-10")[0].end).toBe("2026-03-12T18:00");
  });

  it("giornaliera con intervallo, until e count", () => {
    expect(dates(ev("2026-03-01T10:00", "2026-03-01T11:00", rec({ freq: "daily", interval: 3 })), "2026-03-01", "2026-03-12")).toEqual(["2026-03-01", "2026-03-04", "2026-03-07", "2026-03-10"]);
    expect(dates(ev("2026-03-01T10:00", "2026-03-01T11:00", rec({ freq: "daily", until: "2026-03-03" })), "2026-03-01", "2026-03-30")).toHaveLength(3);
    expect(dates(ev("2026-03-01T10:00", "2026-03-01T11:00", rec({ freq: "daily", count: 4 })), "2026-03-01", "2026-12-30")).toHaveLength(4);
  });

  it("settimanale: giorni scelti, intervallo di due settimane, il count si applica dall'inizio della serie", () => {
    const e = ev("2026-03-02T18:00", "2026-03-02T19:30", rec({ freq: "weekly", byday: "MO,WE" }));
    expect(dates(e, "2026-03-02", "2026-03-11")).toEqual(["2026-03-02", "2026-03-04", "2026-03-09", "2026-03-11"]);
    expect(dates(ev("2026-03-02T18:00", "2026-03-02T19:00", rec({ freq: "weekly", interval: 2 })), "2026-03-01", "2026-04-15")).toEqual(["2026-03-02", "2026-03-16", "2026-03-30", "2026-04-13"]);
    // 3 occorrenze totali (2, 4, 9 marzo): chiedere solo da aprile non ne restituisce nessuna
    expect(dates(ev("2026-03-02T18:00", "2026-03-02T19:00", rec({ freq: "weekly", byday: "MO,WE", count: 3 })), "2026-03-10", "2026-05-01")).toEqual([]);
  });

  it("l'orario resta lo stesso attraverso il cambio dell'ora legale", () => {
    const o = expandOccurrences(ev("2026-03-23T18:00", "2026-03-23T19:00", rec({ freq: "weekly" })), "2026-03-23", "2026-04-06");
    expect(o.map((x) => x.start.slice(11))).toEqual(["18:00", "18:00", "18:00"]);
  });

  it("mensile: salta i mesi che non hanno quel giorno; eccezioni escluse", () => {
    expect(dates(ev("2026-01-31T10:00", "2026-01-31T11:00", rec({ freq: "monthly" })), "2026-01-01", "2026-06-30")).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(dates(ev("2026-03-02T10:00", "2026-03-02T11:00", rec({ freq: "weekly" })), "2026-03-01", "2026-03-31", ["2026-03-09"])).toEqual(["2026-03-02", "2026-03-16", "2026-03-23", "2026-03-30"]);
  });

  it("mondayOf restituisce il lunedì della settimana", () => {
    expect([mondayOf("2026-03-04"), mondayOf("2026-03-08"), mondayOf("2026-03-02")]).toEqual(["2026-03-02", "2026-03-02", "2026-03-02"]);
  });
});

describe("team", () => {
  it("solo un admin con ambito completo crea team; nascono calendario e chat; nomi e cicli validati", () => {
    expect(() => createTeam(w.conn, leadA, { name: "Gamma" })).toThrow(ForbiddenError);
    expect(() => createTeam(w.conn, m1, { name: "Gamma" })).toThrow(ForbiddenError);
    const id = createTeam(w.conn, boss, { name: "Gamma", description: "Nuovo", leaderMembershipId: leadA.membershipId });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM calendars WHERE team_id = ?").get(id)).toEqual({ n: 1 });
    expect(w.conn.prepare("SELECT kind FROM conversations WHERE team_id = ? ORDER BY kind").all(id).map((r) => (r as { kind: string }).kind)).toEqual(["announcement", "team_group"]);
    expect(() => createTeam(w.conn, boss, { name: "Gamma" })).toThrow(/già un team/);
    const child = createTeam(w.conn, boss, { name: "Gamma 2", parentId: id });
    expect(() => updateTeam(w.conn, boss, id, { parentId: child })).toThrow(/discendente/);
    expect(w.conn.prepare("SELECT role FROM team_members WHERE team_id = ? AND membership_id = ?").get(id, leadA.membershipId)).toEqual({ role: "lead" });
  });

  it("il team admin modifica solo il proprio team; i membri nessuno; gli estranei non lo vedono", () => {
    updateTeam(w.conn, leadA, teamA, { description: "Descrizione" });
    expect(() => updateTeam(w.conn, leadA, teamB, { description: "x" })).toThrow();
    expect(() => updateTeam(w.conn, m1, teamA, { description: "x" })).toThrow(ForbiddenError);
    expect(() => teamMembers(w.conn, m3, teamA)).toThrow();
    expect(() => teamStats(w.conn, m3, teamA)).toThrow();
    expect(teamMembers(w.conn, boss, teamA)).toHaveLength(3);
  });

  it("elenchi: admin vede tutti i team, il team admin solo i propri, il membro solo i suoi", () => {
    expect(listTeams(w.conn, boss, "admin").map((t) => t.name)).toEqual(expect.arrayContaining(["Alfa", "Beta"]));
    expect(listTeams(w.conn, leadA, "admin").map((t) => t.name)).toEqual(["Alfa"]);
    expect(listTeams(w.conn, m3, "mine").map((t) => t.name)).toEqual(["Beta"]);
    expect(() => listTeams(w.conn, m1, "admin")).toThrow(ForbiddenError);
  });

  it("i contatti dei membri li vedono solo gli amministratori", () => {
    w.conn.prepare("INSERT INTO user_profiles (membership_id, phone, contact_email) VALUES (?, '333 1234567', 'mario@esempio.it')").run(m1.membershipId);
    expect(teamMembers(w.conn, boss, teamA).find((x) => x.name === "Mario")).toMatchObject({ email: "mario@esempio.it", phone: "333 1234567" });
    expect(teamMembers(w.conn, m2, teamA).find((x) => x.name === "Mario")).toMatchObject({ email: null, phone: null });
  });

  it("aggiungere/rimuovere membri: notifica, audit, e l'accesso cessa subito", () => {
    expect(() => addTeamMember(w.conn, m1, teamA, m3.membershipId)).toThrow(ForbiddenError);
    expect(() => addTeamMember(w.conn, leadA, teamB, m3.membershipId)).toThrow();
    addTeamMember(w.conn, leadA, teamA, m3.membershipId, { title: "Aerodinamico" });
    expect(listNotifications(w.conn, m3).items.map((n) => n.kind)).toContain("team");
    expect(teamMembers(w.conn, boss, teamA).find((x) => x.name === "Bruno")!.teamTitle).toBe("Aerodinamico");
    const joined = w.reload(m3);
    expect(teamCalendar(w.conn, joined, teamA).team_id).toBe(teamA);
    removeTeamMember(w.conn, leadA, teamA, m3.membershipId);
    expect(() => teamCalendar(w.conn, w.reload(m3), teamA)).toThrow();
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'team.member.%'").get()).toEqual({ n: 2 });
  });

  it("statistiche calcolate dai dati e team eliminato: archivia chat e annulla sondaggi aperti", () => {
    const s = teamStats(w.conn, boss, teamA, "2026-03-02");
    expect(s).toMatchObject({ members: 3, leads: 1, openPolls: 0, attendanceRate: null });
    const id = createTeam(w.conn, boss, { name: "Temporaneo" });
    deleteTeam(w.conn, boss, id);
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM conversations WHERE team_id = ? AND archived_at IS NULL").get(id)).toEqual({ n: 0 });
    expect(listTeams(w.conn, boss, "admin").map((t) => t.id)).not.toContain(id);
  });
});

describe("calendari: accessi", () => {
  it("il calendario del team lo vedono i membri; gli altri team e i membri non lo vedono; l'admin sì", () => {
    expect(listCalendars(w.conn, m1).map((c) => c.name)).toEqual(["Calendario Alfa"]);
    expect(listCalendars(w.conn, m3).map((c) => c.name)).toEqual(["Calendario Beta"]);
    expect(listCalendars(w.conn, boss).map((c) => c.kind)).toContain("admin");
    expect(listCalendars(w.conn, m1).some((c) => c.kind === "admin")).toBe(false);
    expect(listCalendars(w.conn, leadA).some((c) => c.kind === "admin")).toBe(false);
  });

  it("solo admin, responsabili e chi ha un permesso 'edit' modificano il calendario del team", () => {
    const cal = teamCalendar(w.conn, boss, teamA);
    const input = { title: "Briefing", startsAt: "2026-03-05T18:00", endsAt: "2026-03-05T19:00" };
    expect(() => createEvent(w.conn, m1, cal.id, input)).toThrow(ForbiddenError);
    expect(() => createEvent(w.conn, m3, cal.id, input)).toThrow();
    expect(createEvent(w.conn, leadA, cal.id, input)).toBeGreaterThan(0);
    expect(createEvent(w.conn, boss, cal.id, input)).toBeGreaterThan(0);
    setCalendarGrant(w.conn, boss, cal.id, m1.membershipId, "edit");
    expect(createEvent(w.conn, w.reload(m1), cal.id, input)).toBeGreaterThan(0);
    expect(() => setCalendarGrant(w.conn, leadA, cal.id, m2.membershipId, "edit")).toThrow(ForbiddenError);
  });

  it("calendario amministratori: privato agli admin; un permesso 'view' apre la sola lettura", () => {
    const admin = listCalendars(w.conn, boss).find((c) => c.kind === "admin")!;
    const id = createEvent(w.conn, boss, admin.id, { title: "CdA", startsAt: "2026-03-05T10:00", endsAt: "2026-03-05T11:00" });
    expect(listEvents(w.conn, m1, { from: "2026-03-01", to: "2026-03-31" })).toEqual([]);
    expect(() => createEvent(w.conn, leadA, admin.id, { title: "x", startsAt: "2026-03-05T10:00", endsAt: "2026-03-05T11:00" })).toThrow();
    setCalendarGrant(w.conn, boss, admin.id, leadA.membershipId, "view");
    const lead = w.reload(leadA);
    expect(listEvents(w.conn, lead, { from: "2026-03-01", to: "2026-03-31" }).map((e) => e.title)).toEqual(["CdA"]);
    expect(() => updateEvent(w.conn, lead, id, { title: "Hack" })).toThrow(ForbiddenError);
  });

  it("un'altra organizzazione non vede né modifica nulla", () => {
    const cal = teamCalendar(w.conn, boss, teamA);
    const id = createEvent(w.conn, boss, cal.id, { title: "Riservato", startsAt: "2026-03-05T18:00", endsAt: "2026-03-05T19:00" });
    const foreign = w.otherOrg("beta");
    expect(listEvents(w.conn, foreign, { from: "2026-03-01", to: "2026-03-31" })).toEqual([]);
    expect(() => deleteEvent(w.conn, foreign, id)).toThrow();
  });
});

describe("calendari: eventi, risposte, presenze, promemoria", () => {
  const mk = (over = {}) => createEvent(w.conn, leadA, teamCalendar(w.conn, leadA, teamA).id, { title: "Riunione", startsAt: "2026-03-05T18:00", endsAt: "2026-03-05T19:00", location: "Aula T", ...over });

  it("crea, valida, notifica tutto il team e filtra per periodo, categoria e testo", () => {
    expect(() => mk({ title: "" })).toThrow(ValidationError);
    expect(() => mk({ startsAt: "2026-03-05T20:00" })).toThrow(/precede/);
    expect(() => mk({ meetingUrl: "ftp://x" })).toThrow(/http/);
    expect(() => mk({ participantIds: [m3.membershipId] })).toThrow(/non ha accesso/);
    const cat = (w.conn.prepare("SELECT id FROM event_categories WHERE name = 'Scadenza'").get() as { id: number }).id;
    mk();
    mk({ title: "Consegna relazione", categoryId: cat, location: "", startsAt: "2026-04-01T09:00", endsAt: "2026-04-01T10:00" });
    expect(unreadCount(w.conn, m1)).toBe(2);
    expect(unreadCount(w.conn, m3)).toBe(0);
    expect(unreadCount(w.conn, leadA)).toBe(0);
    const q = (f: object) => listEvents(w.conn, m1, { from: "2026-03-01", to: "2026-04-30", ...f }).map((e) => e.title);
    expect(q({})).toEqual(["Riunione", "Consegna relazione"]);
    expect(q({ to: "2026-03-31" })).toEqual(["Riunione"]);
    expect(q({ categoryId: cat })).toEqual(["Consegna relazione"]);
    expect(q({ q: "aula" })).toEqual(["Riunione"]);
  });

  it("modifica notifica solo se cambia qualcosa di rilevante; l'eliminazione annulla e avvisa", () => {
    const id = mk();
    const before = unreadCount(w.conn, m1);
    updateEvent(w.conn, leadA, id, { description: "Solo testo" });
    expect(unreadCount(w.conn, m1)).toBe(before);
    updateEvent(w.conn, leadA, id, { startsAt: "2026-03-06T18:00", endsAt: "2026-03-06T19:00" });
    expect(unreadCount(w.conn, m1)).toBe(before + 1);
    deleteEvent(w.conn, leadA, id);
    expect(listEvents(w.conn, m1, { from: "2026-03-01", to: "2026-03-31" })).toEqual([]);
    expect(listNotifications(w.conn, m1).items[0].title).toMatch(/annullato/);
  });

  it("serie settimanale: occorrenze, annullo di una sola data, RSVP per occorrenza", () => {
    const id = mk({ recurrence: { freq: "weekly" }, startsAt: "2026-03-02T18:00", endsAt: "2026-03-02T19:00" });
    const list = () => listEvents(w.conn, m1, { from: "2026-03-01", to: "2026-03-31" });
    expect(list().map((e) => e.date)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30"]);
    cancelOccurrence(w.conn, leadA, id, "2026-03-09");
    expect(list()).toHaveLength(4);
    respondToEvent(w.conn, m1, id, "2026-03-16", "no");
    respondToEvent(w.conn, m1, id, "2026-03-23", "yes");
    expect(list().map((e) => e.myRsvp)).toEqual([null, "no", "yes", null]);
    expect(() => respondToEvent(w.conn, m3, id, "2026-03-16", "yes")).toThrow();
    expect(() => respondToEvent(w.conn, m1, id, "2026-03-16", "forse" as never)).toThrow(ValidationError);
  });

  it("presenze: solo chi modifica le registra, solo per le persone attese; il report unisce RSVP e presenza", () => {
    const id = mk();
    respondToEvent(w.conn, m1, id, "2026-03-05", "yes");
    expect(() => recordAttendance(w.conn, m1, id, "2026-03-05", [{ membershipId: m1.membershipId, state: "present" }])).toThrow(ForbiddenError);
    expect(() => recordAttendance(w.conn, leadA, id, "2026-03-05", [{ membershipId: m3.membershipId, state: "present" }])).toThrow(/non è tra i partecipanti/);
    recordAttendance(w.conn, leadA, id, "2026-03-05", [{ membershipId: m1.membershipId, state: "present" }, { membershipId: m2.membershipId, state: "absent" }]);
    const rows = eventAttendance(w.conn, leadA, id, "2026-03-05");
    expect(rows.find((r) => r.name === "Mario")).toMatchObject({ rsvp: "yes", state: "present" });
    expect(rows.find((r) => r.name === "Marta")).toMatchObject({ rsvp: null, state: "absent" });
    expect(teamStats(w.conn, boss, teamA, "2026-03-10").attendanceRate).toBe(50);
  });

  it("promemoria: una sola notifica per persona e occorrenza, solo nella finestra giusta", () => {
    mk({ reminders: [60, 1440] });
    expect(dispatchReminders(w.conn, "2026-03-03T10:00")).toBe(0);
    const n1 = dispatchReminders(w.conn, "2026-03-04T18:30"); // 24h prima (≥ 17:00 del 4) -> 1440
    expect(n1).toBeGreaterThan(0);
    const before = unreadCount(w.conn, m1);
    expect(dispatchReminders(w.conn, "2026-03-04T18:45")).toBe(0); // già inviato
    expect(unreadCount(w.conn, m1)).toBe(before);
    expect(dispatchReminders(w.conn, "2026-03-05T17:30")).toBeGreaterThan(0); // 60 minuti prima
    expect(dispatchReminders(w.conn, "2026-03-05T18:30")).toBe(0); // evento già iniziato
  });

  it("gli invitati espliciti restringono il pubblico dell'evento", () => {
    const id = mk({ participantIds: [m1.membershipId] });
    expect(unreadCount(w.conn, m1)).toBe(1);
    expect(unreadCount(w.conn, m2)).toBe(0);
    expect(() => respondToEvent(w.conn, m2, id, "2026-03-05", "yes")).toThrow(ForbiddenError);
  });
});

describe("sondaggi di riunione", () => {
  const NOW = "2026-02-27T10:00";
  const options = [
    { date: "2026-03-03", startTime: "18:00", endTime: "19:30" },
    { date: "2026-03-04", startTime: "18:00", endTime: "19:30" },
    { date: "2026-03-05", startTime: "21:00", endTime: "22:00" },
  ];
  const mkPoll = (over = {}) => createPoll(w.conn, leadA, { teamId: teamA, title: "Riunione settimanale", weekStart: "2026-03-04", location: "Aula T", options, deadline: "2026-03-01T20:00", ...over }, NOW);
  const publish = (over = {}) => { const id = mkPoll(over); publishPoll(w.conn, leadA, id); return id; };
  const opt = (pollId: number, i: number) => (w.conn.prepare("SELECT id FROM poll_options WHERE poll_id = ? ORDER BY date, start_time LIMIT 1 OFFSET ?").get(pollId, i) as { id: number }).id;

  it("creazione: permessi, settimana normalizzata al lunedì e validazione delle opzioni", () => {
    expect(() => createPoll(w.conn, m1, { teamId: teamA, title: "x1", weekStart: "2026-03-02", options }, NOW)).toThrow(ForbiddenError);
    expect(() => createPoll(w.conn, leadA, { teamId: teamB, title: "Altro team", weekStart: "2026-03-02", options }, NOW)).toThrow(ForbiddenError);
    const id = mkPoll();
    expect(w.conn.prepare("SELECT week_start, status FROM meeting_polls WHERE id = ?").get(id)).toEqual({ week_start: "2026-03-02", status: "draft" });
    expect(() => mkPoll({ options: [] })).toThrow(/almeno un/);
    expect(() => mkPoll({ options: [{ date: "2026-03-20", startTime: "18:00", endTime: "19:00" }] })).toThrow(/settimana scelta/);
    expect(() => mkPoll({ options: [{ date: "2026-03-03", startTime: "19:00", endTime: "18:00" }] })).toThrow(/fine/);
    expect(() => mkPoll({ options: [options[0], options[0]] })).toThrow(/uguali/);
    expect(() => mkPoll({ deadline: "2026-02-01T10:00" })).toThrow(/già passata/);
    expect(() => mkPoll({ meetingUrl: "javascript:alert(1)" })).toThrow(/http/);
  });

  it("una bozza è invisibile ai membri; la pubblicazione avvisa tutto il team e fotografa gli invitati", () => {
    const id = mkPoll();
    expect(listPollsForMember(w.conn, m1, NOW)).toEqual([]);
    expect(() => respondToPoll(w.conn, m1, id, { attendance: "attending" }, NOW)).toThrow();
    publishPoll(w.conn, leadA, id);
    expect(listNotifications(w.conn, m1).items.map((n) => n.kind)).toEqual(["poll_published"]);
    expect(unreadCount(w.conn, m2)).toBe(1);
    expect(unreadCount(w.conn, m3)).toBe(0);
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM poll_invitees WHERE poll_id = ?").get(id)).toEqual({ n: 3 });
    expect(() => publishPoll(w.conn, leadA, id)).toThrow(/bozza/);
    expect(listPollsForMember(w.conn, m1, NOW)).toHaveLength(1);
    expect(pendingPollCount(w.conn, m1, NOW)).toBe(1);
  });

  it("l'isolamento tra team: chi non è del team non vede né risponde", () => {
    const id = publish();
    expect(listPollsForMember(w.conn, m3, NOW)).toEqual([]);
    expect(() => respondToPoll(w.conn, m3, id, { attendance: "attending" }, NOW)).toThrow();
    expect(() => pollResults(w.conn, m3, id)).toThrow();
    expect(() => pollResults(w.conn, m1, id)).toThrow(ForbiddenError);
    const otherLead = w.person("Lea Altro", "team_admin", ["Beta"]);
    expect(() => pollResults(w.conn, otherLead, id)).toThrow();
    expect(() => finalizePoll(w.conn, otherLead, id, opt(id, 0))).toThrow();
    expect(listPollsAdmin(w.conn, otherLead).map((p) => p.id)).not.toContain(id);
  });

  it("il membro vota, sostituisce il voto e dichiara la presenza; opzione preferita solo tra quelle 'sì'", () => {
    const id = publish();
    const [o1, o2, o3] = [opt(id, 0), opt(id, 1), opt(id, 2)];
    expect(() => respondToPoll(w.conn, m1, id, { votes: [{ optionId: o1, availability: "no" }], preferredOptionId: o1 }, NOW)).toThrow(/preferita/);
    expect(() => respondToPoll(w.conn, m1, id, { votes: [{ optionId: 99999, availability: "yes" }] }, NOW)).toThrow(/Opzione non valida/);
    expect(() => respondToPoll(w.conn, m1, id, { votes: [{ optionId: o1, availability: "forse" as never }] }, NOW)).toThrow(/Disponibilità/);
    respondToPoll(w.conn, m1, id, { votes: [{ optionId: o1, availability: "yes" }, { optionId: o2, availability: "maybe" }, { optionId: o3, availability: "no" }], preferredOptionId: o1, attendance: "attending" }, NOW);
    respondToPoll(w.conn, m1, id, { votes: [{ optionId: o2, availability: "yes" }], preferredOptionId: o2 }, NOW);
    const mine = listPollsForMember(w.conn, m1, NOW)[0];
    expect(mine.options.map((o) => o.availability)).toEqual([null, "yes", null]);
    expect(mine.options.filter((o) => o.preferred)).toHaveLength(1);
    expect(mine).toMatchObject({ attendance: "attending", responded: true, canRespond: true });
    expect(pendingPollCount(w.conn, m1, NOW)).toBe(0);
  });

  it("una risposta non valida non lascia nulla (atomicità)", () => {
    const id = publish();
    respondToPoll(w.conn, m1, id, { votes: [{ optionId: opt(id, 0), availability: "yes" }], attendance: "attending" }, NOW);
    expect(() => respondToPoll(w.conn, m1, id, { votes: [{ optionId: opt(id, 1), availability: "yes" }], attendance: "boh" as never }, NOW)).toThrow();
    expect(listPollsForMember(w.conn, m1, NOW)[0].options.map((o) => o.availability)).toEqual(["yes", null, null]);
  });

  it("dopo la scadenza o la chiusura non si vota più; la presenza si può ancora aggiornare", () => {
    const id = publish();
    expect(() => respondToPoll(w.conn, m1, id, { attendance: "attending" }, "2026-03-02T09:00")).toThrow(/scaduto/);
    expect(closeExpiredPolls(w.conn, "2026-03-02T09:00")).toBe(1);
    expect(listNotifications(w.conn, leadA).items.map((n) => n.kind)).toContain("poll_closed");
    expect(() => respondToPoll(w.conn, m1, id, { attendance: "attending" }, NOW)).toThrow(/non è aperto/);
    setPollAttendance(w.conn, m1, id, "not_attending", "Esame");
    expect(listPollsForMember(w.conn, m1, NOW)[0]).toMatchObject({ attendance: "not_attending", note: "Esame", status: "closed", canRespond: false });
    expect(w.conn.prepare("SELECT status FROM meeting_polls WHERE id = ?").get(id)).toEqual({ status: "closed" }); // chiusura sì, conferma mai in automatico
  });

  it("i risultati: conteggi, classifica, giorno e ora preferiti, non rispondenti, tasso di risposta", () => {
    const id = publish();
    const [o1, o2, o3] = [opt(id, 0), opt(id, 1), opt(id, 2)];
    respondToPoll(w.conn, m1, id, { votes: [{ optionId: o1, availability: "yes" }, { optionId: o2, availability: "yes" }, { optionId: o3, availability: "no" }], preferredOptionId: o2, attendance: "attending" }, NOW);
    respondToPoll(w.conn, m2, id, { votes: [{ optionId: o1, availability: "maybe" }, { optionId: o2, availability: "yes" }, { optionId: o3, availability: "yes" }], attendance: "tentative" }, NOW);
    respondToPoll(w.conn, leadA, id, { attendance: "not_attending" }, NOW);
    const r = pollResults(w.conn, leadA, id);
    expect(r).toMatchObject({ invitees: 3, responded: 3, responseRate: 100 });
    expect(r.options.map((o) => [o.yes.length, o.maybe.length, o.no.length, o.score])).toEqual([[1, 1, 0, 3], [2, 0, 0, 5], [1, 0, 1, 2]]);
    expect(r.ranking[0]).toBe(o2);
    expect(r.best).toMatchObject({ optionId: o2, date: "2026-03-04" });
    expect(r.preferredDay).toEqual({ date: "2026-03-04", available: 2 });
    expect(r.preferredTime).toEqual({ startTime: "18:00", available: 2 });
    expect(r.attendance.attending.map((p) => p.name)).toEqual(["Mario"]);
    expect(r.attendance.notAttending.map((p) => p.name)).toEqual(["Lia Lead"]);
    expect(r.summary).toMatchObject({ available: 2, unavailable: 1, tentative: 1, noResponse: 0 });
    respondToPoll(w.conn, m1, id, { votes: [] }, NOW); // m1 cancella i voti
    const withNone = w.person("Nuovo", "member", ["Alfa"]); // arrivato dopo la pubblicazione: non è tra gli invitati
    expect(pollResults(w.conn, leadA, id).invitees).toBe(3);
    expect(() => respondToPoll(w.conn, withNone, id, { attendance: "attending" }, NOW)).toThrow(ForbiddenError);
    expect(pollResults(w.conn, boss, id).nonResponders.map((p) => p.name)).toEqual([]);
  });

  it("conferma: crea l'evento nel calendario del team con partecipanti e promemoria, avvisa tutti, conserva i voti", () => {
    const id = publish();
    const [o1, o2] = [opt(id, 0), opt(id, 1)];
    respondToPoll(w.conn, m1, id, { votes: [{ optionId: o2, availability: "yes" }], preferredOptionId: o2, attendance: "attending" }, NOW);
    setPollAttendance(w.conn, m2, id, "not_attending");
    expect(() => finalizePoll(w.conn, m1, id, o2)).toThrow(ForbiddenError);
    expect(() => finalizePoll(w.conn, leadA, id, 99999)).toThrow(/non appartiene/);
    const { eventId } = finalizePoll(w.conn, leadA, id, o2);
    const eventRow = w.conn.prepare("SELECT title, kind, starts_at, ends_at, location FROM events WHERE id = ?").get(eventId);
    expect(eventRow).toEqual({ title: "Riunione settimanale", kind: "meeting", starts_at: "2026-03-04T18:00", ends_at: "2026-03-04T19:30", location: "Aula T" });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ?").get(eventId)).toEqual({ n: 3 });
    expect(w.conn.prepare("SELECT offset_minutes FROM event_reminders WHERE event_id = ?").all(eventId)).toEqual([{ offset_minutes: 60 }]);
    expect(w.conn.prepare("SELECT status, final_option_id, event_id FROM meeting_polls WHERE id = ?").get(id)).toEqual({ status: "finalized", final_option_id: o2, event_id: eventId });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?").get(id)).toEqual({ n: 1 });
    expect(w.conn.prepare("SELECT membership_id, rsvp FROM event_responses WHERE event_id = ? ORDER BY membership_id").all(eventId)).toEqual([{ membership_id: m1.membershipId, rsvp: "yes" }, { membership_id: m2.membershipId, rsvp: "no" }]);
    expect(listNotifications(w.conn, m1).items.map((n) => n.kind)).toContain("poll_finalized");
    expect(listNotifications(w.conn, m2).items.find((n) => n.kind === "poll_finalized")!.body).toContain("2026-03-04 18:00–19:30");
    expect(listEvents(w.conn, m1, { from: "2026-03-01", to: "2026-03-31" }).map((e) => [e.title, e.myRsvp])).toEqual([["Riunione settimanale", "yes"]]);
    expect(listEvents(w.conn, m3, { from: "2026-03-01", to: "2026-03-31" })).toEqual([]);
    expect(() => finalizePoll(w.conn, leadA, id, o1)).toThrow(/già stata confermata/);
    expect(listPollsForMember(w.conn, m1, NOW)[0].final).toMatchObject({ date: "2026-03-04", startTime: "18:00", eventId });
    // la presenza dichiarata dopo la conferma aggiorna direttamente l'evento
    setPollAttendance(w.conn, m2, id, "attending");
    expect(w.conn.prepare("SELECT rsvp FROM event_responses WHERE event_id = ? AND membership_id = ?").get(eventId, m2.membershipId)).toEqual({ rsvp: "yes" });
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'poll.finalize'").get()).toEqual({ n: 1 });
  });

  it("settimanale: alla conferma nasce la bozza della settimana dopo, spostata di 7 giorni e mai pubblicata", () => {
    const id = publish({ recurrence: "weekly", recurUntil: "2026-03-20" });
    const { eventId } = finalizePoll(w.conn, leadA, id, opt(id, 1));
    void eventId;
    const next = w.conn.prepare("SELECT id, week_start, status, deadline, parent_poll_id FROM meeting_polls WHERE parent_poll_id = ?").get(id) as { id: number; week_start: string; status: string; deadline: string; parent_poll_id: number };
    expect(next).toMatchObject({ week_start: "2026-03-09", status: "draft", deadline: "2026-03-08T20:00" });
    expect(w.conn.prepare("SELECT date FROM poll_options WHERE poll_id = ? ORDER BY date").all(next.id).map((r) => (r as { date: string }).date)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect(listPollsForMember(w.conn, m1, NOW).map((p) => p.id)).toEqual([id]); // la bozza non è visibile ai membri
    expect(listNotifications(w.conn, leadA).items.map((n) => n.kind)).toContain("poll_draft");
    // la settimana successiva oltre recur_until non viene creata
    publishPoll(w.conn, leadA, next.id);
    const { eventId: e2 } = finalizePoll(w.conn, leadA, next.id, opt(next.id, 0));
    expect(e2).toBeGreaterThan(0);
    const third = w.conn.prepare("SELECT week_start FROM meeting_polls WHERE parent_poll_id = ?").get(next.id) as { week_start: string };
    expect(third.week_start).toBe("2026-03-16");
    publishPoll(w.conn, leadA, w.conn.prepare("SELECT id FROM meeting_polls WHERE parent_poll_id = ?").get(next.id) ? (w.conn.prepare("SELECT id FROM meeting_polls WHERE parent_poll_id = ?").get(next.id) as { id: number }).id : 0);
    expect(w.conn.prepare("SELECT COUNT(*) AS n FROM meeting_polls WHERE recur_until = '2026-03-20'").get()).toEqual({ n: 3 });
  });

  it("generateRecurringPolls prepara la bozza anche per un sondaggio ricorrente chiuso senza conferma, una sola volta", () => {
    const id = publish({ recurrence: "weekly" });
    closePoll(w.conn, leadA, id);
    expect(generateRecurringPolls(w.conn)).toBe(1);
    expect(generateRecurringPolls(w.conn)).toBe(0);
    expect(w.conn.prepare("SELECT status FROM meeting_polls WHERE parent_poll_id = ?").get(id)).toEqual({ status: "draft" });
  });

  it("modifiche: bozza libera, aperto solo nei testi; annullato non si conferma; elenco admin con progressi", () => {
    const id = mkPoll();
    updatePoll(w.conn, leadA, id, { title: "Nuovo titolo", options: [options[0]] }, NOW);
    publishPoll(w.conn, leadA, id);
    expect(() => updatePoll(w.conn, leadA, id, { options: [options[1]] }, NOW)).toThrow(/dopo la pubblicazione/);
    updatePoll(w.conn, leadA, id, { description: "Portate il portatile" }, NOW);
    respondToPoll(w.conn, m1, id, { attendance: "attending" }, NOW);
    expect(listPollsAdmin(w.conn, leadA)[0]).toMatchObject({ title: "Nuovo titolo", status: "open", options: 1, invitees: 3, responded: 1 });
    cancelPoll(w.conn, leadA, id);
    expect(() => finalizePoll(w.conn, leadA, id, opt(id, 0))).toThrow(/non è in uno stato/);
    expect(listPollsForMember(w.conn, m1, NOW)).toEqual([]);
  });
});

describe("tempo reale", () => {
  it("gli eventi partono solo dopo il commit e mai dopo un rollback", () => {
    const received: RtEvent[] = [];
    const off = subscribe(m1.membershipId, (e) => received.push(e));
    expect(() => transaction(w.conn, () => { emit(w.conn, { type: "x.rolled_back" }, [m1.membershipId]); throw new Error("boom"); })).toThrow("boom");
    expect(received).toEqual([]);
    transaction(w.conn, () => { emit(w.conn, { type: "x.committed", id: 1 }, [m1.membershipId]); expect(received).toEqual([]); });
    expect(received).toEqual([{ type: "x.committed", id: 1 }]);
    off();
    emit(w.conn, { type: "x.after_unsubscribe" }, [m1.membershipId]);
    expect(received).toHaveLength(1);
  });

  it("la pubblicazione di un sondaggio e il voto raggiungono solo i destinatari autorizzati", () => {
    const seen = { m1: [] as RtEvent[], m3: [] as RtEvent[], lead: [] as RtEvent[] };
    const offs = [subscribe(m1.membershipId, (e) => seen.m1.push(e)), subscribe(m3.membershipId, (e) => seen.m3.push(e)), subscribe(leadA.membershipId, (e) => seen.lead.push(e))];
    const id = createPoll(w.conn, leadA, { teamId: teamA, title: "Riunione", weekStart: "2026-03-02", options: [{ date: "2026-03-03", startTime: "18:00", endTime: "19:00" }] }, "2026-02-27T10:00");
    publishPoll(w.conn, leadA, id);
    respondToPoll(w.conn, m1, id, { attendance: "attending" }, "2026-02-27T10:00");
    expect(seen.m1.map((e) => e.type)).toContain("poll.updated");
    expect(seen.lead.filter((e) => e.type === "poll.updated").length).toBeGreaterThanOrEqual(2);
    expect(seen.m3).toEqual([]); // un membro di un altro team non riceve nulla
    for (const o of offs) o();
  });
});
