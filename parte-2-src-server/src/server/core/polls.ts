import { can, ForbiddenError, NotFoundError, type Actor } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { insertEvent, localNow, teamCalendar } from "./calendar.ts";
import { ValidationError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { mondayOf } from "./recurrence.ts";
import { emit, orgAdminIds, teamMemberIds } from "./realtime.ts";
import { addDays, all, insert, nowISO, one, placeholders, run, type Conn } from "./sql.ts";
import { adminScope } from "./teams.ts";
import { transaction } from "./tx.ts";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export type PollStatus = "draft" | "open" | "closed" | "finalized" | "cancelled";
export type Availability = "yes" | "maybe" | "no";
export type AttendanceState = "attending" | "not_attending" | "tentative";

type PollRow = {
  id: number; org_id: number; team_id: number; title: string; description: string; week_start: string; meeting_type: "in_person" | "online" | "hybrid";
  location: string; meeting_url: string; duration_minutes: number; deadline: string | null; status: PollStatus; recurrence: "weekly" | null; recur_until: string | null;
  parent_poll_id: number | null; final_option_id: number | null; event_id: number | null; finalized_at: string | null; created_by_membership_id: number; created_at: string; published_at: string | null;
};

export type PollOptionInput = { date: string; startTime: string; endTime: string };
export type PollInput = {
  teamId: number; title: string; description?: string; weekStart: string; meetingType?: PollRow["meeting_type"]; location?: string; meetingUrl?: string;
  durationMinutes?: number; deadline?: string | null; recurrence?: "weekly" | null; recurUntil?: string | null; options: PollOptionInput[];
};

// ───────────────────────── Accesso ─────────────────────────

/** Carica il sondaggio. Chi non può vederlo (altro team, o bozza per un membro) ottiene "non trovato". */
function loadPoll(conn: Conn, actor: Actor, pollId: number, need: "view" | "manage"): PollRow {
  const poll = one<PollRow>(conn, "SELECT * FROM meeting_polls WHERE id = ? AND org_id = ?", pollId, actor.orgId);
  if (!poll) throw new NotFoundError("Sondaggio");
  const manages = can(actor, "polls.manage", { orgId: actor.orgId, teamId: poll.team_id });
  const isInvitee = !!one(conn, "SELECT 1 FROM poll_invitees WHERE poll_id = ? AND membership_id = ?", pollId, actor.membershipId);
  const seesTeam = actor.teamIds.includes(poll.team_id) || adminScope(actor) === "all";
  const canSee = manages || (poll.status !== "draft" && (isInvitee || actor.teamIds.includes(poll.team_id)));
  if (!canSee || !seesTeam && !isInvitee) throw new NotFoundError("Sondaggio");
  if (need === "manage" && !manages) throw new ForbiddenError("polls.manage");
  return poll;
}

const audienceOf = (conn: Conn, p: PollRow) => [...new Set([...teamMemberIds(conn, p.org_id, p.team_id), ...orgAdminIds(conn, p.org_id), p.created_by_membership_id])];

// ───────────────────────── Creazione e ciclo di vita ─────────────────────────

function validateOptions(weekStart: string, options: PollOptionInput[]): void {
  if (options.length < 1) throw new ValidationError("Aggiungi almeno un giorno/orario candidato.", "options");
  if (options.length > 40) throw new ValidationError("Massimo 40 opzioni.", "options");
  const seen = new Set<string>();
  for (const o of options) {
    if (!DATE_RE.test(o.date) || Number.isNaN(Date.parse(o.date))) throw new ValidationError("Data candidata non valida.", "options");
    if (!TIME_RE.test(o.startTime) || !TIME_RE.test(o.endTime)) throw new ValidationError("Orario candidato non valido (HH:MM).", "options");
    if (o.endTime <= o.startTime) throw new ValidationError("L'orario di fine deve seguire quello di inizio.", "options");
    if (o.date < weekStart || o.date > addDays(weekStart, 6)) throw new ValidationError("Le date candidate devono cadere nella settimana scelta.", "options");
    const key = `${o.date}|${o.startTime}`;
    if (seen.has(key)) throw new ValidationError("Ci sono due opzioni uguali.", "options");
    seen.add(key);
  }
}

function validateCommon(i: Partial<PollInput>): void {
  if (i.title !== undefined && (i.title.trim().length < 2 || i.title.trim().length > 120)) throw new ValidationError("Il titolo deve avere tra 2 e 120 caratteri.", "title");
  if (i.deadline && !DT_RE.test(i.deadline)) throw new ValidationError("Scadenza non valida.", "deadline");
  if (i.meetingType && !["in_person", "online", "hybrid"].includes(i.meetingType)) throw new ValidationError("Tipo di riunione non valido.", "meetingType");
  if (i.meetingUrl) {
    try { if (!/^https?:$/.test(new URL(i.meetingUrl).protocol)) throw new Error(); } catch { throw new ValidationError("Il link deve essere un indirizzo http(s) valido.", "meetingUrl"); }
  }
  if (i.durationMinutes !== undefined && (!Number.isInteger(i.durationMinutes) || i.durationMinutes < 5 || i.durationMinutes > 600)) throw new ValidationError("Durata non valida.", "durationMinutes");
  if (i.recurUntil && !DATE_RE.test(i.recurUntil)) throw new ValidationError("Data di fine ripetizione non valida.", "recurUntil");
}

export function createPoll(conn: Conn, actor: Actor, input: PollInput, nowLocal = localNow()): number {
  if (!can(actor, "polls.manage", { orgId: actor.orgId, teamId: input.teamId })) throw new ForbiddenError("polls.manage");
  if (!one(conn, "SELECT 1 FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL", input.teamId, actor.orgId)) throw new ValidationError("Team non valido.", "teamId");
  if (!DATE_RE.test(input.weekStart) || Number.isNaN(Date.parse(input.weekStart))) throw new ValidationError("Settimana non valida.", "weekStart");
  validateCommon(input);
  const weekStart = mondayOf(input.weekStart);
  validateOptions(weekStart, input.options);
  if (input.deadline && input.deadline < nowLocal) throw new ValidationError("La scadenza è già passata.", "deadline");
  return transaction(conn, () => {
    const id = insert(
      conn,
      `INSERT INTO meeting_polls (org_id, team_id, title, description, week_start, meeting_type, location, meeting_url, duration_minutes, deadline, recurrence, recur_until, created_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      actor.orgId, input.teamId, input.title.trim(), (input.description ?? "").trim(), weekStart, input.meetingType ?? "in_person", (input.location ?? "").trim(),
      (input.meetingUrl ?? "").trim(), input.durationMinutes ?? 60, input.deadline ?? null, input.recurrence ?? null, input.recurUntil ?? null, actor.membershipId,
    );
    input.options.forEach((o, i) => insert(conn, "INSERT INTO poll_options (poll_id, org_id, date, start_time, end_time, position) VALUES (?, ?, ?, ?, ?, ?)", id, actor.orgId, o.date, o.startTime, o.endTime, i));
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "poll.create", entityType: "poll", entityId: id, meta: { teamId: input.teamId, week: weekStart } });
    return id;
  });
}

/** Modifica: una bozza si cambia tutta; un sondaggio aperto solo nei testi e nella scadenza (le opzioni hanno già dei voti). */
export function updatePoll(conn: Conn, actor: Actor, pollId: number, patch: Partial<PollInput>, nowLocal = localNow()): void {
  const poll = loadPoll(conn, actor, pollId, "manage");
  if (poll.status !== "draft" && poll.status !== "open") throw new ValidationError("Questo sondaggio non è più modificabile.");
  validateCommon(patch);
  if (patch.deadline && patch.deadline < nowLocal) throw new ValidationError("La scadenza è già passata.", "deadline");
  if (poll.status === "open" && (patch.options || patch.weekStart || patch.teamId)) throw new ValidationError("Opzioni, settimana e team non si cambiano dopo la pubblicazione.");
  transaction(conn, () => {
    const weekStart = patch.weekStart ? mondayOf(patch.weekStart) : poll.week_start;
    if (patch.options) validateOptions(weekStart, patch.options);
    run(conn, `UPDATE meeting_polls SET title = ?, description = ?, week_start = ?, meeting_type = ?, location = ?, meeting_url = ?, duration_minutes = ?, deadline = ?, recurrence = ?, recur_until = ? WHERE id = ?`,
      (patch.title ?? poll.title).trim(), patch.description?.trim() ?? poll.description, weekStart, patch.meetingType ?? poll.meeting_type, patch.location?.trim() ?? poll.location,
      patch.meetingUrl?.trim() ?? poll.meeting_url, patch.durationMinutes ?? poll.duration_minutes, patch.deadline === undefined ? poll.deadline : patch.deadline,
      patch.recurrence === undefined ? poll.recurrence : patch.recurrence, patch.recurUntil === undefined ? poll.recur_until : patch.recurUntil, pollId);
    if (patch.options) {
      run(conn, "DELETE FROM poll_options WHERE poll_id = ?", pollId);
      patch.options.forEach((o, i) => insert(conn, "INSERT INTO poll_options (poll_id, org_id, date, start_time, end_time, position) VALUES (?, ?, ?, ?, ?, ?)", pollId, actor.orgId, o.date, o.startTime, o.endTime, i));
    }
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, audienceOf(conn, poll));
  });
}

/** Pubblica: fotografa i membri del team come invitati a votare e li avvisa tutti. */
export function publishPoll(conn: Conn, actor: Actor, pollId: number): void {
  const poll = loadPoll(conn, actor, pollId, "manage");
  if (poll.status !== "draft") throw new ValidationError("Solo una bozza può essere pubblicata.");
  const members = teamMemberIds(conn, actor.orgId, poll.team_id);
  if (members.length === 0) throw new ValidationError("Il team non ha membri attivi: nessuno potrebbe votare.");
  if (!one(conn, "SELECT 1 FROM poll_options WHERE poll_id = ?", pollId)) throw new ValidationError("Aggiungi almeno un'opzione prima di pubblicare.");
  transaction(conn, () => {
    for (const m of members) run(conn, "INSERT OR IGNORE INTO poll_invitees (poll_id, membership_id, org_id) VALUES (?, ?, ?)", pollId, m, actor.orgId);
    run(conn, "UPDATE meeting_polls SET status = 'open', published_at = ? WHERE id = ?", nowISO(), pollId);
    notify(conn, { orgId: actor.orgId, recipientIds: members, actorMembershipId: actor.membershipId, kind: "poll_published", title: `Nuovo sondaggio: ${poll.title}`, body: poll.deadline ? `Rispondi entro ${poll.deadline.replace("T", " ")}` : "Indica quando sei disponibile", url: `/app/meetings`, dedupeKey: `poll_published:${pollId}` });
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, audienceOf(conn, poll));
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "poll.publish", entityType: "poll", entityId: pollId, meta: { invitees: members.length } });
  });
}

export function closePoll(conn: Conn, actor: Actor, pollId: number): void {
  const poll = loadPoll(conn, actor, pollId, "manage");
  if (poll.status !== "open") throw new ValidationError("Solo un sondaggio aperto può essere chiuso.");
  transaction(conn, () => {
    run(conn, "UPDATE meeting_polls SET status = 'closed', closed_at = ? WHERE id = ?", nowISO(), pollId);
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, audienceOf(conn, poll));
  });
}

export function cancelPoll(conn: Conn, actor: Actor, pollId: number): void {
  const poll = loadPoll(conn, actor, pollId, "manage");
  if (poll.status === "finalized") throw new ValidationError("Una riunione già confermata non si annulla da qui: elimina l'evento dal calendario.");
  transaction(conn, () => {
    run(conn, "UPDATE meeting_polls SET status = 'cancelled' WHERE id = ?", pollId);
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, audienceOf(conn, poll));
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "poll.cancel", entityType: "poll", entityId: pollId, meta: {} });
  });
}

/** Chiude i sondaggi aperti la cui scadenza è passata. Non pubblica né conferma nulla: lo scheduler non decide al posto degli amministratori. */
export function closeExpiredPolls(conn: Conn, nowLocal: string): number {
  const expired = all<PollRow>(conn, "SELECT * FROM meeting_polls WHERE status = 'open' AND deadline IS NOT NULL AND deadline < ?", nowLocal);
  for (const p of expired) {
    transaction(conn, () => {
      run(conn, "UPDATE meeting_polls SET status = 'closed', closed_at = ? WHERE id = ?", nowISO(), p.id);
      notify(conn, { orgId: p.org_id, recipientIds: [p.created_by_membership_id], actorMembershipId: null, kind: "poll_closed", title: `Il sondaggio «${p.title}» è scaduto`, body: "Controlla i risultati e conferma la riunione.", url: `/admin/polls/${p.id}`, dedupeKey: `poll_closed:${p.id}` });
      emit(conn, { type: "poll.updated", pollId: p.id, teamId: p.team_id }, audienceOf(conn, p));
    });
  }
  return expired.length;
}

// ───────────────────────── Risposte dei membri ─────────────────────────

export type VoteInput = { optionId: number; availability: Availability };

function assertCanRespond(conn: Conn, actor: Actor, poll: PollRow, nowLocal: string): void {
  if (!one(conn, "SELECT 1 FROM poll_invitees WHERE poll_id = ? AND membership_id = ?", poll.id, actor.membershipId)) throw new ForbiddenError("polls.manage");
  if (poll.status !== "open") throw new ValidationError("Il sondaggio non è aperto ai voti.");
  if (poll.deadline && poll.deadline < nowLocal) throw new ValidationError("Il sondaggio è scaduto.");
}

/**
 * Risposta del membro: disponibilità per ciascuna opzione (+ una opzione preferita) e, facoltativamente, la presenza
 * esplicita («Sono presente» / «Non sono presente» / «Forse»). Tutto in una transazione; sostituisce le risposte precedenti.
 */
export function respondToPoll(conn: Conn, actor: Actor, pollId: number, r: { votes?: VoteInput[]; preferredOptionId?: number | null; attendance?: AttendanceState | null; note?: string }, nowLocal = localNow()): void {
  const poll = loadPoll(conn, actor, pollId, "view");
  assertCanRespond(conn, actor, poll, nowLocal);
  const options = new Set(all<{ id: number }>(conn, "SELECT id FROM poll_options WHERE poll_id = ?", pollId).map((o) => o.id));
  if (r.votes) {
    const seen = new Set<number>();
    for (const v of r.votes) {
      if (!options.has(v.optionId)) throw new ValidationError("Opzione non valida.");
      if (seen.has(v.optionId)) throw new ValidationError("Opzione ripetuta.");
      if (!["yes", "maybe", "no"].includes(v.availability)) throw new ValidationError("Disponibilità non valida.");
      seen.add(v.optionId);
    }
    if (r.preferredOptionId != null) {
      const pv = r.votes.find((v) => v.optionId === r.preferredOptionId);
      if (!pv || pv.availability !== "yes") throw new ValidationError("L'opzione preferita deve essere una in cui sei disponibile.");
    }
  }
  if (r.attendance != null && !["attending", "not_attending", "tentative"].includes(r.attendance)) throw new ValidationError("Risposta di presenza non valida.");
  if (r.note && r.note.length > 300) throw new ValidationError("La nota può avere al massimo 300 caratteri.");
  transaction(conn, () => {
    if (r.votes) {
      run(conn, "DELETE FROM poll_votes WHERE poll_id = ? AND membership_id = ?", pollId, actor.membershipId);
      for (const v of r.votes) {
        run(conn, "INSERT INTO poll_votes (poll_id, option_id, membership_id, org_id, availability, preferred) VALUES (?, ?, ?, ?, ?, ?)", pollId, v.optionId, actor.membershipId, actor.orgId, v.availability, v.optionId === r.preferredOptionId ? 1 : 0);
      }
    }
    if (r.attendance != null) writeAttendance(conn, actor, poll, r.attendance, r.note ?? "");
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, [...orgAdminIds(conn, poll.org_id), poll.created_by_membership_id, actor.membershipId]);
  });
}

function writeAttendance(conn: Conn, actor: Actor, poll: PollRow, state: AttendanceState, note: string): void {
  run(conn, `INSERT INTO poll_attendance (poll_id, membership_id, org_id, state, note) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (poll_id, membership_id) DO UPDATE SET state = excluded.state, note = excluded.note, responded_at = ?`, poll.id, actor.membershipId, actor.orgId, state, note.trim(), nowISO());
  // Dopo la conferma la risposta di presenza aggiorna direttamente l'evento creato.
  if (poll.status === "finalized" && poll.event_id && poll.final_option_id) {
    const opt = one<{ date: string }>(conn, "SELECT date FROM poll_options WHERE id = ?", poll.final_option_id)!;
    run(conn, `INSERT INTO event_responses (event_id, occurrence_date, membership_id, org_id, rsvp) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (event_id, occurrence_date, membership_id) DO UPDATE SET rsvp = excluded.rsvp, responded_at = ?`,
      poll.event_id, opt.date, actor.membershipId, actor.orgId, state === "attending" ? "yes" : state === "not_attending" ? "no" : "maybe", nowISO());
  }
}

/** «Sono presente» / «Non sono presente»: consentita anche a sondaggio chiuso o confermato (la presenza può cambiare). */
export function setPollAttendance(conn: Conn, actor: Actor, pollId: number, state: AttendanceState, note = ""): void {
  const poll = loadPoll(conn, actor, pollId, "view");
  if (!one(conn, "SELECT 1 FROM poll_invitees WHERE poll_id = ? AND membership_id = ?", pollId, actor.membershipId)) throw new ForbiddenError("polls.manage");
  if (!["open", "closed", "finalized"].includes(poll.status)) throw new ValidationError("Il sondaggio non accetta risposte.");
  if (!["attending", "not_attending", "tentative"].includes(state)) throw new ValidationError("Risposta di presenza non valida.");
  transaction(conn, () => {
    writeAttendance(conn, actor, poll, state, note);
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, [...orgAdminIds(conn, poll.org_id), poll.created_by_membership_id, actor.membershipId]);
  });
}

// ───────────────────────── Risultati ─────────────────────────

export type Person = { membershipId: number; name: string };
export type OptionResult = { id: number; date: string; startTime: string; endTime: string; yes: Person[]; maybe: Person[]; no: Person[]; preferredBy: Person[]; score: number };
export type PollResults = {
  poll: { id: number; title: string; teamId: number; status: PollStatus; weekStart: string; deadline: string | null; finalOptionId: number | null; eventId: number | null };
  invitees: number; responded: number; responseRate: number;
  options: OptionResult[];
  ranking: number[];
  best: { optionId: number; date: string; startTime: string } | null;
  preferredDay: { date: string; available: number } | null;
  preferredTime: { startTime: string; available: number } | null;
  attendance: { attending: Person[]; notAttending: Person[]; tentative: Person[]; notAnswered: Person[] };
  summary: { available: number; unavailable: number; tentative: number; noResponse: number };
  nonResponders: Person[];
};

/** Risultati completi (con i nomi): solo per chi gestisce i sondaggi del team. */
export function pollResults(conn: Conn, actor: Actor, pollId: number): PollResults {
  const poll = loadPoll(conn, actor, pollId, "manage");
  const people = new Map(all<{ id: number; name: string }>(conn, `SELECT i.membership_id AS id, u.name FROM poll_invitees i JOIN memberships m ON m.id = i.membership_id JOIN users u ON u.id = m.user_id WHERE i.poll_id = ? ORDER BY u.name`, pollId).map((p) => [p.id, { membershipId: p.id, name: p.name }]));
  const opts = all<{ id: number; date: string; start_time: string; end_time: string }>(conn, "SELECT id, date, start_time, end_time FROM poll_options WHERE poll_id = ? ORDER BY date, start_time", pollId);
  const votes = all<{ option_id: number; membership_id: number; availability: Availability; preferred: number }>(conn, "SELECT option_id, membership_id, availability, preferred FROM poll_votes WHERE poll_id = ?", pollId);
  const att = new Map(all<{ membership_id: number; state: AttendanceState }>(conn, "SELECT membership_id, state FROM poll_attendance WHERE poll_id = ?", pollId).map((a) => [a.membership_id, a.state]));
  const who = (id: number) => people.get(id)!;

  const options: OptionResult[] = opts.map((o) => {
    const v = votes.filter((x) => x.option_id === o.id);
    const yes = v.filter((x) => x.availability === "yes").map((x) => who(x.membership_id));
    const maybe = v.filter((x) => x.availability === "maybe").map((x) => who(x.membership_id));
    const no = v.filter((x) => x.availability === "no").map((x) => who(x.membership_id));
    const preferredBy = v.filter((x) => x.preferred === 1).map((x) => who(x.membership_id));
    return { id: o.id, date: o.date, startTime: o.start_time, endTime: o.end_time, yes, maybe, no, preferredBy, score: yes.length * 2 + maybe.length + preferredBy.length };
  });
  const ranked = [...options].sort((a, b) => b.score - a.score || b.yes.length - a.yes.length || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const best = ranked[0] && ranked[0].score > 0 ? { optionId: ranked[0].id, date: ranked[0].date, startTime: ranked[0].startTime } : null;

  const tally = (key: (o: OptionResult) => string) => {
    const m = new Map<string, Set<number>>();
    for (const o of options) for (const p of o.yes) (m.get(key(o)) ?? m.set(key(o), new Set()).get(key(o))!).add(p.membershipId);
    return [...m.entries()].map(([k, s]) => ({ k, n: s.size })).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k))[0];
  };
  const day = tally((o) => o.date);
  const time = tally((o) => o.startTime);

  const voted = new Set(votes.map((v) => v.membership_id));
  const respondedIds = [...people.keys()].filter((id) => voted.has(id) || att.has(id));
  const attendance = {
    attending: [...people.keys()].filter((id) => att.get(id) === "attending").map(who),
    notAttending: [...people.keys()].filter((id) => att.get(id) === "not_attending").map(who),
    tentative: [...people.keys()].filter((id) => att.get(id) === "tentative").map(who),
    notAnswered: [...people.keys()].filter((id) => !att.has(id)).map(who),
  };
  const availableIds = new Set(votes.filter((v) => v.availability !== "no").map((v) => v.membership_id));
  const unavailable = [...people.keys()].filter((id) => att.get(id) === "not_attending" || (voted.has(id) && !availableIds.has(id)));
  return {
    poll: { id: poll.id, title: poll.title, teamId: poll.team_id, status: poll.status, weekStart: poll.week_start, deadline: poll.deadline, finalOptionId: poll.final_option_id, eventId: poll.event_id },
    invitees: people.size, responded: respondedIds.length, responseRate: people.size ? Math.round((respondedIds.length / people.size) * 100) : 0,
    options, ranking: ranked.map((o) => o.id), best,
    preferredDay: day ? { date: day.k, available: day.n } : null, preferredTime: time ? { startTime: time.k, available: time.n } : null,
    attendance,
    summary: {
      available: [...people.keys()].filter((id) => availableIds.has(id) && att.get(id) !== "not_attending").length,
      unavailable: unavailable.length,
      tentative: attendance.tentative.length,
      noResponse: people.size - respondedIds.length,
    },
    nonResponders: [...people.keys()].filter((id) => !voted.has(id) && !att.has(id)).map(who),
  };
}

// ───────────────────────── Conferma ─────────────────────────

/**
 * L'amministratore sceglie l'opzione definitiva. Solo qui nasce l'evento nel calendario del team; non c'è alcun
 * percorso automatico che confermi al suo posto. I voti restano salvati.
 */
export function finalizePoll(conn: Conn, actor: Actor, pollId: number, optionId: number): { eventId: number } {
  const poll = loadPoll(conn, actor, pollId, "manage");
  if (poll.status !== "open" && poll.status !== "closed") throw new ValidationError(poll.status === "finalized" ? "La riunione è già stata confermata." : "Il sondaggio non è in uno stato confermabile.");
  const opt = one<{ id: number; date: string; start_time: string; end_time: string }>(conn, "SELECT id, date, start_time, end_time FROM poll_options WHERE id = ? AND poll_id = ?", optionId, pollId);
  if (!opt) throw new ValidationError("L'opzione scelta non appartiene al sondaggio.");
  const cal = teamCalendar(conn, actor, poll.team_id);
  return transaction(conn, () => {
    const invitees = all<{ id: number }>(conn, "SELECT membership_id AS id FROM poll_invitees WHERE poll_id = ?", pollId).map((r) => r.id);
    const category = one<{ id: number }>(conn, "SELECT id FROM event_categories WHERE org_id = ? AND name = 'Riunione'", actor.orgId)?.id ?? null;
    const eventId = insertEvent(conn, actor.orgId, actor.membershipId, cal.id, {
      title: poll.title, description: poll.description, kind: "meeting", categoryId: category, startsAt: `${opt.date}T${opt.start_time}`, endsAt: `${opt.date}T${opt.end_time}`,
      location: poll.location, meetingUrl: poll.meeting_url, participantIds: invitees, reminders: [60],
    });
    // Le risposte di presenza già date diventano le risposte all'evento.
    for (const a of all<{ membership_id: number; state: AttendanceState }>(conn, "SELECT membership_id, state FROM poll_attendance WHERE poll_id = ?", pollId)) {
      run(conn, "INSERT INTO event_responses (event_id, occurrence_date, membership_id, org_id, rsvp) VALUES (?, ?, ?, ?, ?)", eventId, opt.date, a.membership_id, actor.orgId, a.state === "attending" ? "yes" : a.state === "not_attending" ? "no" : "maybe");
    }
    run(conn, "UPDATE meeting_polls SET status = 'finalized', final_option_id = ?, event_id = ?, finalized_by_membership_id = ?, finalized_at = ? WHERE id = ?", optionId, eventId, actor.membershipId, nowISO(), pollId);
    notify(conn, { orgId: actor.orgId, recipientIds: invitees, actorMembershipId: actor.membershipId, kind: "poll_finalized", title: `Riunione confermata: ${poll.title}`, body: `${opt.date} ${opt.start_time}–${opt.end_time}${poll.location ? ` · ${poll.location}` : ""}`, url: "/app/meetings", dedupeKey: `poll_finalized:${pollId}` });
    emit(conn, { type: "poll.updated", pollId, teamId: poll.team_id }, [...audienceOf(conn, poll), ...invitees]);
    emit(conn, { type: "calendar.changed", calendarId: cal.id, eventId }, invitees);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "poll.finalize", entityType: "poll", entityId: pollId, meta: { optionId, eventId, date: opt.date } });
    if (poll.recurrence === "weekly") spawnNextWeeklyPoll(conn, poll);
    return { eventId };
  });
}

/** Crea la bozza della settimana successiva (opzioni spostate di 7 giorni). Mai pubblicata automaticamente. */
function spawnNextWeeklyPoll(conn: Conn, parent: PollRow): number | null {
  const nextWeek = addDays(parent.week_start, 7);
  if (parent.recur_until && nextWeek > parent.recur_until) return null;
  if (one(conn, "SELECT 1 FROM meeting_polls WHERE parent_poll_id = ?", parent.id)) return null;
  const id = insert(
    conn,
    `INSERT INTO meeting_polls (org_id, team_id, title, description, week_start, meeting_type, location, meeting_url, duration_minutes, deadline, recurrence, recur_until, parent_poll_id, created_by_membership_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'weekly', ?, ?, ?)`,
    parent.org_id, parent.team_id, parent.title, parent.description, nextWeek, parent.meeting_type, parent.location, parent.meeting_url, parent.duration_minutes,
    parent.deadline ? `${addDays(parent.deadline.slice(0, 10), 7)}${parent.deadline.slice(10)}` : null, parent.recur_until, parent.id, parent.created_by_membership_id,
  );
  for (const o of all<{ date: string; start_time: string; end_time: string; position: number }>(conn, "SELECT date, start_time, end_time, position FROM poll_options WHERE poll_id = ? ORDER BY position", parent.id)) {
    insert(conn, "INSERT INTO poll_options (poll_id, org_id, date, start_time, end_time, position) VALUES (?, ?, ?, ?, ?, ?)", id, parent.org_id, addDays(o.date, 7), o.start_time, o.end_time, o.position);
  }
  notify(conn, { orgId: parent.org_id, recipientIds: [parent.created_by_membership_id], actorMembershipId: null, kind: "poll_draft", title: `Bozza pronta: ${parent.title} (settimana del ${nextWeek})`, body: "Controlla le opzioni e pubblica il sondaggio.", url: `/admin/polls/${id}`, dedupeKey: `poll_draft:${id}` });
  return id;
}

/** Per i sondaggi ricorrenti già chiusi/annullati senza figlio (es. non confermati): prepara la bozza successiva. */
export function generateRecurringPolls(conn: Conn): number {
  let n = 0;
  for (const p of all<PollRow>(conn, `SELECT * FROM meeting_polls WHERE recurrence = 'weekly' AND status IN ('closed') AND NOT EXISTS (SELECT 1 FROM meeting_polls c WHERE c.parent_poll_id = meeting_polls.id)`)) {
    if (transaction(conn, () => spawnNextWeeklyPoll(conn, p))) n++;
  }
  return n;
}

// ───────────────────────── Elenchi ─────────────────────────

export type PollSummary = { id: number; teamId: number; teamName: string; title: string; weekStart: string; status: PollStatus; deadline: string | null; options: number; invitees: number; responded: number; eventId: number | null; recurrence: "weekly" | null };

export function listPollsAdmin(conn: Conn, actor: Actor, f: { teamId?: number; status?: PollStatus } = {}): PollSummary[] {
  const scope = adminScope(actor);
  if (!scope || !actor.permissions["polls.manage"]) throw new ForbiddenError("polls.manage");
  const where = ["p.org_id = ?"];
  const params: (string | number)[] = [actor.orgId];
  if (actor.permissions["polls.manage"] === "scoped") {
    if (actor.teamIds.length === 0) return [];
    where.push(`p.team_id IN (${placeholders(actor.teamIds.length)})`);
    params.push(...actor.teamIds);
  }
  if (f.teamId) { where.push("p.team_id = ?"); params.push(f.teamId); }
  if (f.status) { where.push("p.status = ?"); params.push(f.status); }
  return all<{ id: number; team_id: number; team: string; title: string; week_start: string; status: PollStatus; deadline: string | null; options: number; invitees: number; responded: number; event_id: number | null; recurrence: "weekly" | null }>(
    conn,
    `SELECT p.id, p.team_id, t.name AS team, p.title, p.week_start, p.status, p.deadline, p.event_id, p.recurrence,
            (SELECT COUNT(*) FROM poll_options o WHERE o.poll_id = p.id) AS options,
            (SELECT COUNT(*) FROM poll_invitees i WHERE i.poll_id = p.id) AS invitees,
            (SELECT COUNT(*) FROM poll_invitees i WHERE i.poll_id = p.id AND (EXISTS (SELECT 1 FROM poll_votes v WHERE v.poll_id = p.id AND v.membership_id = i.membership_id)
                                                                              OR EXISTS (SELECT 1 FROM poll_attendance a WHERE a.poll_id = p.id AND a.membership_id = i.membership_id))) AS responded
       FROM meeting_polls p JOIN teams t ON t.id = p.team_id WHERE ${where.join(" AND ")} ORDER BY p.week_start DESC, p.id DESC`,
    ...params,
  ).map((r) => ({ id: r.id, teamId: r.team_id, teamName: r.team, title: r.title, weekStart: r.week_start, status: r.status, deadline: r.deadline, options: r.options, invitees: r.invitees, responded: r.responded, eventId: r.event_id, recurrence: r.recurrence }));
}

export type MemberPollOption = { id: number; date: string; startTime: string; endTime: string; availability: Availability | null; preferred: boolean };
export type MemberPoll = {
  id: number; teamId: number; teamName: string; title: string; description: string; weekStart: string; meetingType: PollRow["meeting_type"]; location: string; meetingUrl: string;
  deadline: string | null; status: PollStatus; canRespond: boolean; options: MemberPollOption[]; attendance: AttendanceState | null; note: string;
  final: { date: string; startTime: string; endTime: string; eventId: number } | null; responded: boolean;
};

/** Sondaggi del mio team (pubblicati), con le mie risposte. Nessun nome o voto altrui. */
export function listPollsForMember(conn: Conn, actor: Actor, nowLocal = localNow()): MemberPoll[] {
  if (actor.teamIds.length === 0) return [];
  const polls = all<PollRow & { team_name: string }>(
    conn,
    `SELECT p.*, t.name AS team_name FROM meeting_polls p JOIN teams t ON t.id = p.team_id JOIN poll_invitees i ON i.poll_id = p.id AND i.membership_id = ?
      WHERE p.org_id = ? AND p.status IN ('open','closed','finalized') ORDER BY (p.status = 'open') DESC, p.week_start DESC, p.id DESC LIMIT 50`,
    actor.membershipId, actor.orgId,
  );
  return polls.map((p) => {
    const mine = new Map(all<{ option_id: number; availability: Availability; preferred: number }>(conn, "SELECT option_id, availability, preferred FROM poll_votes WHERE poll_id = ? AND membership_id = ?", p.id, actor.membershipId).map((v) => [v.option_id, v]));
    const att = one<{ state: AttendanceState; note: string }>(conn, "SELECT state, note FROM poll_attendance WHERE poll_id = ? AND membership_id = ?", p.id, actor.membershipId);
    const options = all<{ id: number; date: string; start_time: string; end_time: string }>(conn, "SELECT id, date, start_time, end_time FROM poll_options WHERE poll_id = ? ORDER BY date, start_time", p.id)
      .map((o) => ({ id: o.id, date: o.date, startTime: o.start_time, endTime: o.end_time, availability: mine.get(o.id)?.availability ?? null, preferred: mine.get(o.id)?.preferred === 1 }));
    const finalOpt = p.final_option_id ? options.find((o) => o.id === p.final_option_id) : undefined;
    return {
      id: p.id, teamId: p.team_id, teamName: p.team_name, title: p.title, description: p.description, weekStart: p.week_start, meetingType: p.meeting_type, location: p.location, meetingUrl: p.meeting_url,
      deadline: p.deadline, status: p.status, canRespond: p.status === "open" && !(p.deadline && p.deadline < nowLocal), options, attendance: att?.state ?? null, note: att?.note ?? "",
      final: finalOpt && p.event_id ? { date: finalOpt.date, startTime: finalOpt.startTime, endTime: finalOpt.endTime, eventId: p.event_id } : null,
      responded: mine.size > 0 || !!att,
    };
  });
}

/** Sondaggi aperti ai quali non ho ancora risposto (per Home e notifiche). */
export const pendingPollCount = (conn: Conn, actor: Actor, nowLocal = localNow()): number => listPollsForMember(conn, actor, nowLocal).filter((p) => p.canRespond && !p.responded).length;

export type PollDetail = { id: number; teamId: number; teamName: string; title: string; description: string; weekStart: string; meetingType: PollRow["meeting_type"]; location: string; meetingUrl: string; durationMinutes: number; deadline: string | null; status: PollStatus; recurrence: "weekly" | null; recurUntil: string | null; eventId: number | null; finalOptionId: number | null };

/** Dati di testata di un sondaggio, per chi lo gestisce. */
export function getPollDetail(conn: Conn, actor: Actor, pollId: number): PollDetail {
  const p = loadPoll(conn, actor, pollId, "manage");
  const team = one<{ name: string }>(conn, "SELECT name FROM teams WHERE id = ?", p.team_id)!;
  return { id: p.id, teamId: p.team_id, teamName: team.name, title: p.title, description: p.description, weekStart: p.week_start, meetingType: p.meeting_type, location: p.location, meetingUrl: p.meeting_url,
    durationMinutes: p.duration_minutes, deadline: p.deadline, status: p.status, recurrence: p.recurrence, recurUntil: p.recur_until, eventId: p.event_id, finalOptionId: p.final_option_id };
}
