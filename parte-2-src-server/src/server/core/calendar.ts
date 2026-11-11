import type { Actor } from "../authz/authorize.ts";
import { ForbiddenError, NotFoundError } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { ValidationError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { expandOccurrences, type Recurrence } from "./recurrence.ts";
import { emit, teamMemberIds } from "./realtime.ts";
import { addDays, all, insert, nowISO, one, placeholders, run, todayISO, type Conn, type Param } from "./sql.ts";
import { adminScope, ensureTeamResources } from "./teams.ts";
import { queryTasks } from "./tasks.ts";
import { transaction } from "./tx.ts";

const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const isDateTime = (v: unknown): v is string => typeof v === "string" && DT_RE.test(v) && !Number.isNaN(Date.parse(`${v}:00Z`));
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080] as const;

export type CalendarRow = { id: number; org_id: number; kind: "admin" | "team"; team_id: number | null; name: string; color: string };
export type CalendarAccess = { view: boolean; edit: boolean; grants: boolean };

/**
 * Regole di accesso ai calendari.
 * · Amministratori: li vedono gli admin con ambito completo (o chi ha un permesso esplicito); li modifica chi ha anche `events.manage`.
 * · Team: lo vede chi è nel team o è admin con ambito completo; lo modifica un admin con `events.manage`=all, un
 *   responsabile del team (team_members.role = lead, o ruolo di piattaforma Team Admin) o chi ha un permesso 'edit'.
 *   I membri semplici NON modificano il calendario del team, salvo permesso esplicito.
 */
export function calendarAccess(conn: Conn, actor: Actor, cal: CalendarRow): CalendarAccess {
  const none = { view: false, edit: false, grants: false };
  if (cal.org_id !== actor.orgId) return none;
  const grant = one<{ access: "view" | "edit" }>(conn, "SELECT access FROM calendar_grants WHERE calendar_id = ? AND membership_id = ?", cal.id, actor.membershipId)?.access;
  const adminAll = adminScope(actor) === "all";
  if (cal.kind === "admin") {
    return { view: adminAll || !!grant, edit: (adminAll && !!actor.permissions["events.manage"]) || grant === "edit", grants: adminAll };
  }
  const member = cal.team_id !== null && actor.teamIds.includes(cal.team_id);
  const lead = member && (actor.role === "team_admin" || !!one(conn, "SELECT 1 FROM team_members WHERE team_id = ? AND membership_id = ? AND role = 'lead'", cal.team_id, actor.membershipId));
  return {
    view: member || adminAll || !!grant,
    edit: (adminAll && actor.permissions["events.manage"] === "all") || lead || grant === "edit",
    grants: adminAll,
  };
}

export function listCalendars(conn: Conn, actor: Actor): (CalendarRow & CalendarAccess)[] {
  for (const t of actor.teamIds) ensureTeamResources(conn, actor.orgId, t, actor.membershipId);
  return all<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE org_id = ? ORDER BY (kind = 'admin') DESC, name", actor.orgId)
    .map((c) => ({ ...c, ...calendarAccess(conn, actor, c) }))
    .filter((c) => c.view);
}

function requireCalendar(conn: Conn, actor: Actor, calendarId: number, need: "view" | "edit" | "grants"): CalendarRow {
  const cal = one<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE id = ? AND org_id = ?", calendarId, actor.orgId);
  if (!cal) throw new NotFoundError("Calendario");
  const acc = calendarAccess(conn, actor, cal);
  if (!acc.view) throw new NotFoundError("Calendario");
  if (need !== "view" && !acc[need]) throw new ForbiddenError("events.manage");
  return cal;
}

/** Calendario di un team (creato al volo se manca). */
export function teamCalendar(conn: Conn, actor: Actor, teamId: number): CalendarRow {
  ensureTeamResources(conn, actor.orgId, teamId, actor.membershipId);
  const cal = one<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE org_id = ? AND team_id = ?", actor.orgId, teamId);
  if (!cal) throw new NotFoundError("Calendario");
  requireCalendar(conn, actor, cal.id, "view");
  return cal;
}

type EventRow = {
  id: number; org_id: number; calendar_id: number; title: string; description: string; kind: string; category_id: number | null; starts_at: string; ends_at: string;
  all_day: number; location: string; meeting_url: string; color: string | null; recur_freq: Recurrence["freq"]; recur_interval: number; recur_byday: string;
  recur_until: string | null; recur_count: number | null; created_by_membership_id: number;
};
const rec = (e: EventRow): Recurrence => ({ freq: e.recur_freq, interval: e.recur_interval, byday: e.recur_byday, until: e.recur_until, count: e.recur_count });

/** Chi "è atteso": gli invitati espliciti, altrimenti tutto il pubblico naturale del calendario. */
export function eventAudience(conn: Conn, ev: Pick<EventRow, "id" | "org_id" | "calendar_id">): number[] {
  const explicit = all<{ id: number }>(conn, "SELECT membership_id AS id FROM event_participants WHERE event_id = ?", ev.id).map((r) => r.id);
  if (explicit.length) return explicit;
  const cal = one<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE id = ?", ev.calendar_id)!;
  if (cal.kind === "team") return teamMemberIds(conn, ev.org_id, cal.team_id!);
  return all<{ id: number }>(conn, "SELECT id FROM memberships WHERE org_id = ? AND status = 'active' AND role IN ('super_admin','org_admin')", ev.org_id).map((r) => r.id);
}

function eligible(conn: Conn, cal: CalendarRow, membershipId: number): boolean {
  if (!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, cal.org_id)) return false;
  if (one(conn, "SELECT 1 FROM calendar_grants WHERE calendar_id = ? AND membership_id = ?", cal.id, membershipId)) return true;
  if (cal.kind === "team") return !!one(conn, "SELECT 1 FROM team_members WHERE team_id = ? AND membership_id = ?", cal.team_id, membershipId);
  return !!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND role IN ('super_admin','org_admin')", membershipId);
}

// ───────────────────────── Lettura ─────────────────────────

export type EventOccurrence = {
  key: string; eventId: number; calendarId: number; calendarName: string; calendarKind: "admin" | "team"; teamId: number | null;
  title: string; description: string; kind: string; categoryId: number | null; categoryName: string | null; color: string;
  date: string; start: string; end: string; allDay: boolean; location: string; meetingUrl: string;
  recurring: boolean; myRsvp: "yes" | "no" | "maybe" | null; canEdit: boolean; participants: number;
};

export type EventFilter = { from: string; to: string; calendarIds?: number[]; categoryId?: number; kind?: string; q?: string };

export function listEvents(conn: Conn, actor: Actor, f: EventFilter): EventOccurrence[] {
  const cals = listCalendars(conn, actor).filter((c) => !f.calendarIds || f.calendarIds.includes(c.id));
  if (cals.length === 0) return [];
  const where = [`e.org_id = ?`, `e.deleted_at IS NULL`, `e.calendar_id IN (${placeholders(cals.length)})`, `substr(e.starts_at, 1, 10) <= ?`, `(e.recur_freq IS NOT NULL OR substr(e.ends_at, 1, 10) >= ?)`];
  const params: Param[] = [actor.orgId, ...cals.map((c) => c.id), f.to, f.from];
  if (f.categoryId) { where.push("e.category_id = ?"); params.push(f.categoryId); }
  if (f.kind) { where.push("e.kind = ?"); params.push(f.kind); }
  if (f.q?.trim()) {
    const p = `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(e.title LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.location LIKE ? ESCAPE '\\')");
    params.push(p, p, p);
  }
  const rows = all<EventRow & { cat_name: string | null; cat_color: string | null }>(
    conn, `SELECT e.*, cat.name AS cat_name, cat.color AS cat_color FROM events e LEFT JOIN event_categories cat ON cat.id = e.category_id WHERE ${where.join(" AND ")}`, ...params);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const exceptions = new Map<number, Set<string>>();
  for (const x of all<{ event_id: number; d: string }>(conn, `SELECT event_id, occurrence_date AS d FROM event_exceptions WHERE event_id IN (${placeholders(ids.length)})`, ...ids)) {
    (exceptions.get(x.event_id) ?? exceptions.set(x.event_id, new Set()).get(x.event_id)!).add(x.d);
  }
  const mine = new Map<string, "yes" | "no" | "maybe">(all<{ event_id: number; d: string; rsvp: "yes" | "no" | "maybe" }>(
    conn, `SELECT event_id, occurrence_date AS d, rsvp FROM event_responses WHERE membership_id = ? AND event_id IN (${placeholders(ids.length)})`, actor.membershipId, ...ids).map((r) => [`${r.event_id}:${r.d}`, r.rsvp]));
  const counts = new Map(all<{ event_id: number; n: number }>(conn, `SELECT event_id, COUNT(*) AS n FROM event_participants WHERE event_id IN (${placeholders(ids.length)}) GROUP BY event_id`, ...ids).map((r) => [r.event_id, r.n]));
  const calById = new Map(cals.map((c) => [c.id, c]));

  const out: EventOccurrence[] = [];
  for (const e of rows) {
    const cal = calById.get(e.calendar_id)!;
    for (const o of expandOccurrences({ starts_at: e.starts_at, ends_at: e.ends_at, rec: rec(e) }, f.from, f.to, exceptions.get(e.id))) {
      out.push({
        key: `${e.id}:${o.date}`, eventId: e.id, calendarId: cal.id, calendarName: cal.name, calendarKind: cal.kind, teamId: cal.team_id, title: e.title, description: e.description,
        kind: e.kind, categoryId: e.category_id, categoryName: e.cat_name, color: e.color ?? e.cat_color ?? cal.color, date: o.date, start: o.start, end: o.end,
        allDay: e.all_day === 1, location: e.location, meetingUrl: e.meeting_url, recurring: !!e.recur_freq, myRsvp: mine.get(`${e.id}:${o.date}`) ?? null,
        canEdit: cal.edit, participants: counts.get(e.id) ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

/** Scadenze personali: i task assegnati a me con una data nel periodo, mostrati accanto agli eventi. */
export function personalDeadlines(conn: Conn, actor: Actor, from: string, to: string): { taskId: number; ref: string; title: string; date: string; projectKey: string; overdue: boolean }[] {
  return queryTasks(conn, actor, {}, { assignee: ["me"], hideDone: true, from, to, sort: "due:asc" }).map((t) => ({
    taskId: t.id, ref: t.ref, title: t.title, date: t.dueDate!, projectKey: t.projectKey, overdue: t.overdue,
  }));
}

// ───────────────────────── Scrittura ─────────────────────────

export type EventInput = {
  title: string; description?: string; kind?: "event" | "meeting" | "deadline" | "activity"; categoryId?: number | null;
  startsAt: string; endsAt: string; allDay?: boolean; location?: string; meetingUrl?: string; color?: string | null;
  recurrence?: { freq: "daily" | "weekly" | "monthly"; interval?: number; byday?: string; until?: string | null; count?: number | null } | null;
  participantIds?: number[]; reminders?: number[];
};

function validateEvent(conn: Conn, orgId: number, i: Partial<EventInput>): void {
  if (i.title !== undefined) {
    const t = i.title.trim();
    if (t.length < 1 || t.length > 120) throw new ValidationError("Il titolo deve avere tra 1 e 120 caratteri.", "title");
  }
  if (i.startsAt !== undefined && !isDateTime(i.startsAt)) throw new ValidationError("Data/ora di inizio non valida.", "startsAt");
  if (i.endsAt !== undefined && !isDateTime(i.endsAt)) throw new ValidationError("Data/ora di fine non valida.", "endsAt");
  if (i.startsAt && i.endsAt && i.endsAt < i.startsAt) throw new ValidationError("La fine precede l'inizio.", "endsAt");
  if (i.meetingUrl) {
    try { if (!/^https?:$/.test(new URL(i.meetingUrl).protocol)) throw new Error(); } catch { throw new ValidationError("Il link deve essere un indirizzo http(s) valido.", "meetingUrl"); }
  }
  if (i.color && !COLOR_RE.test(i.color)) throw new ValidationError("Colore non valido.", "color");
  if (i.categoryId && !one(conn, "SELECT 1 FROM event_categories WHERE id = ? AND org_id = ?", i.categoryId, orgId)) throw new ValidationError("Categoria non valida.", "categoryId");
  const r = i.recurrence;
  if (r) {
    if (!["daily", "weekly", "monthly"].includes(r.freq)) throw new ValidationError("Ripetizione non valida.", "recurrence");
    if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52)) throw new ValidationError("L'intervallo di ripetizione deve essere tra 1 e 52.", "recurrence");
    if (r.byday && !r.byday.split(",").every((d) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(d.trim().toUpperCase()))) throw new ValidationError("Giorni della settimana non validi.", "recurrence");
    if (r.until && !/^\d{4}-\d{2}-\d{2}$/.test(r.until)) throw new ValidationError("Data di fine ripetizione non valida.", "recurrence");
    if (r.count != null && (!Number.isInteger(r.count) || r.count < 1 || r.count > 500)) throw new ValidationError("Il numero di ripetizioni deve essere tra 1 e 500.", "recurrence");
  }
  for (const m of i.reminders ?? []) if (!(REMINDER_OPTIONS as readonly number[]).includes(m)) throw new ValidationError("Promemoria non valido.", "reminders");
}

const recurCols = (r: EventInput["recurrence"]): Param[] => r ? [r.freq, r.interval ?? 1, (r.byday ?? "").toUpperCase().replace(/\s/g, ""), r.until ?? null, r.count ?? null] : [null, 1, "", null, null];

/** Inserimento senza controlli di permesso: lo usano createEvent e la conferma dei sondaggi (che ha già verificato `polls.manage`). */
export function insertEvent(conn: Conn, orgId: number, createdBy: number, calendarId: number, i: EventInput): number {
  const cal = one<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE id = ? AND org_id = ?", calendarId, orgId);
  if (!cal) throw new NotFoundError("Calendario");
  validateEvent(conn, orgId, i);
  const allDay = i.allDay ? 1 : 0;
  const id = insert(
    conn,
    `INSERT INTO events (org_id, calendar_id, title, description, kind, category_id, starts_at, ends_at, all_day, location, meeting_url, color,
                         recur_freq, recur_interval, recur_byday, recur_until, recur_count, created_by_membership_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    orgId, calendarId, i.title.trim(), (i.description ?? "").trim(), i.kind ?? "event", i.categoryId ?? null, i.startsAt, i.endsAt, allDay,
    (i.location ?? "").trim(), (i.meetingUrl ?? "").trim(), i.color ?? null, ...recurCols(i.recurrence), createdBy,
  );
  for (const m of new Set(i.participantIds ?? [])) {
    if (!eligible(conn, cal, m)) throw new ValidationError("Una delle persone invitate non ha accesso a questo calendario.", "participantIds");
    run(conn, "INSERT INTO event_participants (event_id, membership_id, org_id) VALUES (?, ?, ?)", id, m, orgId);
  }
  for (const m of new Set(i.reminders ?? [])) run(conn, "INSERT INTO event_reminders (event_id, offset_minutes) VALUES (?, ?)", id, m);
  return id;
}

const eventUrl = (cal: CalendarRow) => (cal.kind === "admin" ? "/admin/calendar" : "/app/calendar");

export function createEvent(conn: Conn, actor: Actor, calendarId: number, input: EventInput): number {
  const cal = requireCalendar(conn, actor, calendarId, "edit");
  return transaction(conn, () => {
    const id = insertEvent(conn, actor.orgId, actor.membershipId, calendarId, input);
    const ev = one<EventRow>(conn, "SELECT * FROM events WHERE id = ?", id)!;
    const audience = eventAudience(conn, ev);
    notify(conn, { orgId: actor.orgId, recipientIds: audience, actorMembershipId: actor.membershipId, kind: "event_invited", title: `Nuovo evento: ${ev.title}`, body: `${ev.starts_at.replace("T", " ")} · ${cal.name}`, url: eventUrl(cal), dedupeKey: `event_invited:${id}` });
    emit(conn, { type: "calendar.changed", calendarId, eventId: id }, [...audience, actor.membershipId]);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "event.create", entityType: "event", entityId: id, meta: { calendar: cal.name, title: ev.title } });
    return id;
  });
}

function requireEvent(conn: Conn, actor: Actor, eventId: number, need: "view" | "edit"): { ev: EventRow; cal: CalendarRow } {
  const ev = one<EventRow>(conn, "SELECT * FROM events WHERE id = ? AND org_id = ? AND deleted_at IS NULL", eventId, actor.orgId);
  if (!ev) throw new NotFoundError("Evento");
  return { ev, cal: requireCalendar(conn, actor, ev.calendar_id, need) };
}

export function updateEvent(conn: Conn, actor: Actor, eventId: number, patch: Partial<EventInput>): void {
  const { ev, cal } = requireEvent(conn, actor, eventId, "edit");
  validateEvent(conn, actor.orgId, patch);
  const startsAt = patch.startsAt ?? ev.starts_at;
  const endsAt = patch.endsAt ?? ev.ends_at;
  if (endsAt < startsAt) throw new ValidationError("La fine precede l'inizio.", "endsAt");
  transaction(conn, () => {
    const rc = patch.recurrence === undefined ? [ev.recur_freq, ev.recur_interval, ev.recur_byday, ev.recur_until, ev.recur_count] : recurCols(patch.recurrence);
    run(
      conn,
      `UPDATE events SET title = ?, description = ?, kind = ?, category_id = ?, starts_at = ?, ends_at = ?, all_day = ?, location = ?, meeting_url = ?, color = ?,
              recur_freq = ?, recur_interval = ?, recur_byday = ?, recur_until = ?, recur_count = ?, updated_at = ? WHERE id = ?`,
      (patch.title ?? ev.title).trim(), patch.description?.trim() ?? ev.description, patch.kind ?? ev.kind, patch.categoryId === undefined ? ev.category_id : patch.categoryId,
      startsAt, endsAt, patch.allDay === undefined ? ev.all_day : patch.allDay ? 1 : 0, patch.location?.trim() ?? ev.location, patch.meetingUrl?.trim() ?? ev.meeting_url,
      patch.color === undefined ? ev.color : patch.color, ...(rc as Param[]), nowISO(), eventId,
    );
    if (patch.participantIds) {
      run(conn, "DELETE FROM event_participants WHERE event_id = ?", eventId);
      for (const m of new Set(patch.participantIds)) {
        if (!eligible(conn, cal, m)) throw new ValidationError("Una delle persone invitate non ha accesso a questo calendario.", "participantIds");
        run(conn, "INSERT INTO event_participants (event_id, membership_id, org_id) VALUES (?, ?, ?)", eventId, m, actor.orgId);
      }
    }
    if (patch.reminders) {
      run(conn, "DELETE FROM event_reminders WHERE event_id = ?", eventId);
      for (const m of new Set(patch.reminders)) run(conn, "INSERT INTO event_reminders (event_id, offset_minutes) VALUES (?, ?)", eventId, m);
    }
    const after = one<EventRow>(conn, "SELECT * FROM events WHERE id = ?", eventId)!;
    const audience = eventAudience(conn, after);
    const moved = after.starts_at !== ev.starts_at || after.ends_at !== ev.ends_at || after.location !== ev.location || after.title !== ev.title || after.meeting_url !== ev.meeting_url;
    if (moved) {
      notify(conn, { orgId: actor.orgId, recipientIds: audience, actorMembershipId: actor.membershipId, kind: "event_changed", title: `Evento aggiornato: ${after.title}`, body: `${after.starts_at.replace("T", " ")}${after.location ? ` · ${after.location}` : ""}`, url: eventUrl(cal) });
    }
    emit(conn, { type: "calendar.changed", calendarId: cal.id, eventId }, [...audience, actor.membershipId]);
  });
}

export function deleteEvent(conn: Conn, actor: Actor, eventId: number): void {
  const { ev, cal } = requireEvent(conn, actor, eventId, "edit");
  transaction(conn, () => {
    const audience = eventAudience(conn, ev);
    run(conn, "UPDATE events SET deleted_at = ? WHERE id = ?", nowISO(), eventId);
    notify(conn, { orgId: actor.orgId, recipientIds: audience, actorMembershipId: actor.membershipId, kind: "event_changed", title: `Evento annullato: ${ev.title}`, url: eventUrl(cal) });
    emit(conn, { type: "calendar.changed", calendarId: cal.id, eventId }, [...audience, actor.membershipId]);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "event.delete", entityType: "event", entityId: eventId, meta: { title: ev.title } });
  });
}

/** Annulla una sola occorrenza di una serie. */
export function cancelOccurrence(conn: Conn, actor: Actor, eventId: number, date: string): void {
  const { ev, cal } = requireEvent(conn, actor, eventId, "edit");
  if (!ev.recur_freq) throw new ValidationError("L'evento non è ricorrente: eliminalo.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("Data non valida.");
  transaction(conn, () => {
    run(conn, "INSERT OR IGNORE INTO event_exceptions (event_id, occurrence_date) VALUES (?, ?)", eventId, date);
    emit(conn, { type: "calendar.changed", calendarId: cal.id, eventId }, eventAudience(conn, ev));
  });
}

// ───────────────────────── Risposte, presenze, promemoria ─────────────────────────

export function respondToEvent(conn: Conn, actor: Actor, eventId: number, date: string, rsvp: "yes" | "no" | "maybe"): void {
  const { ev, cal } = requireEvent(conn, actor, eventId, "view");
  if (!["yes", "no", "maybe"].includes(rsvp)) throw new ValidationError("Risposta non valida.");
  if (!eventAudience(conn, ev).includes(actor.membershipId)) throw new ForbiddenError("events.manage");
  transaction(conn, () => {
    run(conn, `INSERT INTO event_responses (event_id, occurrence_date, membership_id, org_id, rsvp) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (event_id, occurrence_date, membership_id) DO UPDATE SET rsvp = excluded.rsvp, responded_at = ?`, eventId, date, actor.membershipId, actor.orgId, rsvp, nowISO());
    emit(conn, { type: "calendar.changed", calendarId: cal.id, eventId }, [...eventAudience(conn, ev), actor.membershipId]);
  });
}

export type AttendanceRow = { membershipId: number; name: string; rsvp: "yes" | "no" | "maybe" | null; state: "present" | "absent" | "late" | "excused" | null };

export function eventAttendance(conn: Conn, actor: Actor, eventId: number, date: string): AttendanceRow[] {
  const { ev } = requireEvent(conn, actor, eventId, "edit");
  const ids = eventAudience(conn, ev);
  if (ids.length === 0) return [];
  return all<{ id: number; name: string; rsvp: AttendanceRow["rsvp"]; state: AttendanceRow["state"] }>(
    conn,
    `SELECT m.id, u.name, r.rsvp, a.state FROM memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN event_responses r ON r.event_id = ? AND r.occurrence_date = ? AND r.membership_id = m.id
       LEFT JOIN event_attendance a ON a.event_id = ? AND a.occurrence_date = ? AND a.membership_id = m.id
      WHERE m.id IN (${placeholders(ids.length)}) ORDER BY u.name`,
    eventId, date, eventId, date, ...ids,
  ).map((r) => ({ membershipId: r.id, name: r.name, rsvp: r.rsvp, state: r.state }));
}

/** Registra chi c'era davvero. Solo chi può modificare il calendario, e solo per le persone attese. */
export function recordAttendance(conn: Conn, actor: Actor, eventId: number, date: string, entries: { membershipId: number; state: "present" | "absent" | "late" | "excused" | null }[]): void {
  const { ev } = requireEvent(conn, actor, eventId, "edit");
  const audience = new Set(eventAudience(conn, ev));
  transaction(conn, () => {
    for (const e of entries) {
      if (!audience.has(e.membershipId)) throw new ValidationError("La persona non è tra i partecipanti attesi.");
      if (e.state === null) run(conn, "DELETE FROM event_attendance WHERE event_id = ? AND occurrence_date = ? AND membership_id = ?", eventId, date, e.membershipId);
      else if (!["present", "absent", "late", "excused"].includes(e.state)) throw new ValidationError("Stato di presenza non valido.");
      else run(conn, `INSERT INTO event_attendance (event_id, occurrence_date, membership_id, org_id, state, recorded_by_membership_id) VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT (event_id, occurrence_date, membership_id) DO UPDATE SET state = excluded.state, recorded_by_membership_id = excluded.recorded_by_membership_id, recorded_at = ?`,
        eventId, date, e.membershipId, actor.orgId, e.state, actor.membershipId, nowISO());
    }
  });
}

export function setCalendarGrant(conn: Conn, actor: Actor, calendarId: number, membershipId: number, access: "view" | "edit" | null): void {
  requireCalendar(conn, actor, calendarId, "grants");
  if (!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, actor.orgId)) throw new ValidationError("Persona non valida.");
  transaction(conn, () => {
    if (access === null) run(conn, "DELETE FROM calendar_grants WHERE calendar_id = ? AND membership_id = ?", calendarId, membershipId);
    else run(conn, `INSERT INTO calendar_grants (calendar_id, membership_id, org_id, access) VALUES (?, ?, ?, ?) ON CONFLICT (calendar_id, membership_id) DO UPDATE SET access = excluded.access`, calendarId, membershipId, actor.orgId, access);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "calendar.grant", entityType: "calendar", entityId: calendarId, meta: { membershipId, access } });
  });
}

/**
 * Invia i promemoria dovuti: per ogni occorrenza imminente con un promemoria configurato, avvisa una sola volta
 * ciascun partecipante (reminder_log). `nowLocal` = AAAA-MM-GGTHH:MM nel fuso dell'organizzazione.
 */
export function dispatchReminders(conn: Conn, nowLocal: string): number {
  const today = nowLocal.slice(0, 10);
  const events = all<EventRow & { offsets: string }>(
    conn,
    `SELECT e.*, (SELECT group_concat(offset_minutes) FROM event_reminders r WHERE r.event_id = e.id) AS offsets FROM events e
      WHERE e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id)`,
  );
  let sent = 0;
  for (const e of events) {
    const exceptions = new Set(all<{ d: string }>(conn, "SELECT occurrence_date AS d FROM event_exceptions WHERE event_id = ?", e.id).map((r) => r.d));
    const cal = one<CalendarRow>(conn, "SELECT id, org_id, kind, team_id, name, color FROM calendars WHERE id = ?", e.calendar_id)!;
    for (const o of expandOccurrences({ starts_at: e.starts_at, ends_at: e.ends_at, rec: rec(e) }, today, addDays(today, 14), exceptions)) {
      for (const off of e.offsets.split(",").map(Number)) {
        const remindAt = new Date(Date.parse(`${o.start}:00Z`) - off * 60_000).toISOString().slice(0, 16);
        if (nowLocal < remindAt || nowLocal >= o.start) continue; // non ancora dovuto, oppure l'evento è già iniziato
        transaction(conn, () => {
          for (const m of eventAudience(conn, e)) {
            const res = run(conn, "INSERT OR IGNORE INTO reminder_log (event_id, occurrence_date, membership_id, offset_minutes) VALUES (?, ?, ?, ?)", e.id, o.date, m, off);
            if (Number(res.changes)) {
              sent += notify(conn, { orgId: e.org_id, recipientIds: [m], actorMembershipId: null, kind: "event_reminder", title: `Tra poco: ${e.title}`, body: `${o.start.replace("T", " ")}${e.location ? ` · ${e.location}` : ""}`, url: eventUrl(cal), dedupeKey: `reminder:${e.id}:${o.date}:${off}` });
            }
          }
        });
      }
    }
  }
  return sent;
}

export const localNow = (timeZone = "Europe/Rome", date = new Date()): string => date.toLocaleString("sv-SE", { timeZone }).replace(" ", "T").slice(0, 16);
export { todayISO };
