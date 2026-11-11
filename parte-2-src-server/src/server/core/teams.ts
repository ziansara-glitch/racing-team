import { can, ForbiddenError, NotFoundError, type Actor } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { ValidationError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { emit, orgAdminIds, teamMemberIds } from "./realtime.ts";
import { addDays, all, insert, nowISO, one, run, todayISO, type Conn } from "./sql.ts";
import { transaction } from "./tx.ts";

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Ambito amministrativo di chi agisce: all = tutta l'organizzazione, scoped = solo i propri team, null = non è un amministratore. */
export const adminScope = (actor: Actor) => actor.permissions["admin.access"] ?? null;
export const hasAdminAccess = (actor: Actor) => adminScope(actor) !== null;

export const isTeamMember = (actor: Actor, teamId: number) => actor.teamIds.includes(teamId);
export const isTeamLead = (conn: Conn, actor: Actor, teamId: number) =>
  !!one(conn, "SELECT 1 FROM team_members WHERE team_id = ? AND membership_id = ? AND role = 'lead'", teamId, actor.membershipId);

/** Può vedere il team: ne fa parte oppure è un amministratore con ambito su tutta l'organizzazione. */
export const canViewTeam = (actor: Actor, teamId: number) => isTeamMember(actor, teamId) || adminScope(actor) === "all";

export function requireTeam(conn: Conn, actor: Actor, teamId: number, need: "view" | "manage" = "view"): { id: number; name: string; org_id: number; description: string; color: string; parent_id: number | null } {
  const team = one<{ id: number; name: string; org_id: number; description: string; color: string; parent_id: number | null }>(
    conn, "SELECT id, name, org_id, description, color, parent_id FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL", teamId, actor.orgId);
  if (!team || !canViewTeam(actor, teamId)) throw new NotFoundError("Team");
  if (need === "manage" && !can(actor, "teams.manage", { orgId: actor.orgId, teamId })) throw new ForbiddenError("teams.manage");
  return team;
}

/** Crea calendario, chat e canale annunci di un team, se mancano. Idempotente. */
export function ensureTeamResources(conn: Conn, orgId: number, teamId: number, creatorMembershipId: number): void {
  const t = one<{ name: string; color: string }>(conn, "SELECT name, color FROM teams WHERE id = ? AND org_id = ?", teamId, orgId);
  if (!t) return;
  if (!one(conn, "SELECT 1 FROM calendars WHERE org_id = ? AND team_id = ?", orgId, teamId)) {
    run(conn, "INSERT INTO calendars (org_id, kind, team_id, name, color) VALUES (?, 'team', ?, ?, ?)", orgId, teamId, `Calendario ${t.name}`, t.color);
  }
  for (const [kind, title] of [["team_group", t.name], ["announcement", `Annunci ${t.name}`]] as const) {
    if (!one(conn, "SELECT 1 FROM conversations WHERE org_id = ? AND team_id = ? AND kind = ?", orgId, teamId, kind)) {
      run(conn, "INSERT INTO conversations (org_id, kind, team_id, title, created_by_membership_id) VALUES (?, ?, ?, ?, ?)", orgId, kind, teamId, title, creatorMembershipId);
    }
  }
}

// ───────────────────────── Elenco e dettaglio ─────────────────────────

export type TeamLeader = { membershipId: number; name: string };
export type TeamSummary = {
  id: number; name: string; description: string; color: string; parentId: number | null; parentName: string | null;
  memberCount: number; leaders: TeamLeader[]; calendarId: number | null; chatId: number | null; announcementsId: number | null; isMember: boolean;
};

/** `admin`: i team che l'amministratore può gestire (tutti, o i propri se l'ambito è ristretto). `mine`: i team di cui si fa parte. */
export function listTeams(conn: Conn, actor: Actor, view: "admin" | "mine" = "mine"): TeamSummary[] {
  let where = "t.org_id = ? AND t.deleted_at IS NULL";
  const params: (string | number)[] = [actor.orgId];
  if (view === "admin") {
    const scope = adminScope(actor);
    if (!scope) throw new ForbiddenError("admin.access");
    if (scope === "scoped") {
      if (actor.teamIds.length === 0) return [];
      where += ` AND t.id IN (${actor.teamIds.map(() => "?").join(",")})`;
      params.push(...actor.teamIds);
    }
  } else {
    if (actor.teamIds.length === 0) return [];
    where += ` AND t.id IN (${actor.teamIds.map(() => "?").join(",")})`;
    params.push(...actor.teamIds);
  }
  const rows = all<{ id: number; name: string; description: string; color: string; parent_id: number | null; parent_name: string | null; n: number; cal: number | null; chat: number | null; ann: number | null }>(
    conn,
    `SELECT t.id, t.name, t.description, t.color, t.parent_id, p.name AS parent_name,
            (SELECT COUNT(*) FROM team_members tm JOIN memberships m ON m.id = tm.membership_id WHERE tm.team_id = t.id AND m.status = 'active') AS n,
            (SELECT id FROM calendars WHERE team_id = t.id) AS cal,
            (SELECT id FROM conversations WHERE team_id = t.id AND kind = 'team_group') AS chat,
            (SELECT id FROM conversations WHERE team_id = t.id AND kind = 'announcement') AS ann
       FROM teams t LEFT JOIN teams p ON p.id = t.parent_id WHERE ${where} ORDER BY t.name`,
    ...params,
  );
  const leaders = all<{ team_id: number; membership_id: number; name: string }>(
    conn, `SELECT tm.team_id, tm.membership_id, u.name FROM team_members tm JOIN memberships m ON m.id = tm.membership_id JOIN users u ON u.id = m.user_id
            WHERE tm.org_id = ? AND tm.role = 'lead' AND m.status = 'active' ORDER BY u.name`, actor.orgId);
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, color: r.color, parentId: r.parent_id, parentName: r.parent_name, memberCount: r.n,
    leaders: leaders.filter((l) => l.team_id === r.id).map((l) => ({ membershipId: l.membership_id, name: l.name })),
    calendarId: r.cal, chatId: r.chat, announcementsId: r.ann, isMember: actor.teamIds.includes(r.id),
  }));
}

export type TeamMemberDTO = { membershipId: number; name: string; title: string; teamRole: "lead" | "member"; teamTitle: string; platformRole: string; status: string; email: string | null; phone: string | null };

export function teamMembers(conn: Conn, actor: Actor, teamId: number): TeamMemberDTO[] {
  requireTeam(conn, actor, teamId, "view");
  // Contatti: solo gli amministratori li vedono; ai colleghi arrivano nome, titolo e ruolo nel team.
  const admin = hasAdminAccess(actor);
  return all<{ membership_id: number; name: string; title: string; role: "lead" | "member"; ttitle: string; prole: string; status: string; email: string; contact: string; phone: string }>(
    conn,
    `SELECT tm.membership_id, u.name, m.title, tm.role, tm.title AS ttitle, m.role AS prole, m.status, u.email, COALESCE(p.contact_email, '') AS contact, COALESCE(p.phone, '') AS phone
       FROM team_members tm JOIN memberships m ON m.id = tm.membership_id JOIN users u ON u.id = m.user_id LEFT JOIN user_profiles p ON p.membership_id = m.id
      WHERE tm.team_id = ? AND tm.org_id = ? ORDER BY (tm.role = 'lead') DESC, u.name`,
    teamId, actor.orgId,
  ).map((r) => ({
    membershipId: r.membership_id, name: r.name, title: r.title, teamRole: r.role, teamTitle: r.ttitle, platformRole: r.prole, status: r.status,
    email: admin ? r.contact || r.email : null, phone: admin ? r.phone || null : null,
  }));
}

export type TeamStats = {
  members: number; leads: number; openPolls: number; upcomingEvents: number; messages7d: number; openTasks: number; projects: number;
  attendanceRate: number | null; attendanceRecords: number;
};

export function teamStats(conn: Conn, actor: Actor, teamId: number, today = todayISO()): TeamStats {
  requireTeam(conn, actor, teamId, "view");
  const n = (sql: string, ...p: (string | number)[]) => one<{ n: number }>(conn, sql, ...p)?.n ?? 0;
  const att = one<{ total: number; ok: number }>(
    conn,
    `SELECT COUNT(*) AS total, SUM(a.state IN ('present', 'late')) AS ok FROM event_attendance a JOIN events e ON e.id = a.event_id JOIN calendars c ON c.id = e.calendar_id
      WHERE c.team_id = ? AND a.occurrence_date >= ? AND a.occurrence_date <= ?`,
    teamId, addDays(today, -30), today,
  )!;
  return {
    members: n("SELECT COUNT(*) AS n FROM team_members tm JOIN memberships m ON m.id = tm.membership_id WHERE tm.team_id = ? AND m.status = 'active'", teamId),
    leads: n("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'lead'", teamId),
    openPolls: n("SELECT COUNT(*) AS n FROM meeting_polls WHERE team_id = ? AND status = 'open'", teamId),
    upcomingEvents: n(`SELECT COUNT(*) AS n FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.team_id = ? AND e.deleted_at IS NULL AND substr(e.starts_at, 1, 10) BETWEEN ? AND ?`, teamId, today, addDays(today, 14)),
    messages7d: n(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.team_id = ? AND m.deleted_at IS NULL AND m.kind <> 'system' AND m.created_at >= ?`, teamId, `${addDays(today, -7)}T00:00:00`),
    openTasks: n(
      `SELECT COUNT(*) AS n FROM tasks t JOIN project_statuses s ON s.id = t.status_id JOIN team_members tm ON tm.membership_id = t.assignee_membership_id
        WHERE tm.team_id = ? AND t.deleted_at IS NULL AND s.category IN ('backlog','todo','in_progress','review')`, teamId),
    projects: n("SELECT COUNT(*) AS n FROM projects WHERE team_id = ? AND deleted_at IS NULL AND status <> 'archived'", teamId),
    attendanceRate: att.total ? Math.round(((att.ok ?? 0) / att.total) * 100) : null,
    attendanceRecords: att.total,
  };
}

// ───────────────────────── Modifica ─────────────────────────

function validateTeam(conn: Conn, orgId: number, input: { name?: string; color?: string; parentId?: number | null }, selfId?: number): void {
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (n.length < 2 || n.length > 60) throw new ValidationError("Il nome del team deve avere tra 2 e 60 caratteri.", "name");
    if (one(conn, "SELECT 1 FROM teams WHERE org_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?", orgId, n, selfId ?? 0)) throw new ValidationError("Esiste già un team con questo nome.", "name");
  }
  if (input.color !== undefined && !COLOR_RE.test(input.color)) throw new ValidationError("Colore non valido.", "color");
  if (input.parentId != null) {
    if (!one(conn, "SELECT 1 FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL", input.parentId, orgId)) throw new ValidationError("Team padre non valido.", "parentId");
    // Niente cicli: il padre non può essere il team stesso né un suo discendente.
    if (selfId) {
      const cycle = one(conn, `WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT t.parent_id FROM teams t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL) SELECT 1 FROM up WHERE id = ?`, input.parentId, selfId);
      if (cycle) throw new ValidationError("Il team padre scelto è un discendente di questo team.", "parentId");
    }
  }
}

export function createTeam(conn: Conn, actor: Actor, input: { name: string; description?: string; color?: string; parentId?: number | null; leaderMembershipId?: number }): number {
  if (actor.permissions["teams.manage"] !== "all") throw new ForbiddenError("teams.manage");
  validateTeam(conn, actor.orgId, input);
  return transaction(conn, () => {
    const id = insert(conn, "INSERT INTO teams (org_id, name, description, color, kind, parent_id) VALUES (?, ?, ?, ?, 'team', ?)", actor.orgId, input.name.trim(), (input.description ?? "").trim(), input.color ?? "#6366f1", input.parentId ?? null);
    ensureTeamResources(conn, actor.orgId, id, actor.membershipId);
    if (input.leaderMembershipId) addTeamMember(conn, actor, id, input.leaderMembershipId, { role: "lead" });
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "team.create", entityType: "team", entityId: id, meta: { name: input.name.trim() } });
    return id;
  });
}

export function updateTeam(conn: Conn, actor: Actor, teamId: number, patch: { name?: string; description?: string; color?: string; parentId?: number | null }): void {
  requireTeam(conn, actor, teamId, "manage");
  validateTeam(conn, actor.orgId, patch, teamId);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name.trim()); }
  if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description.trim()); }
  if (patch.color !== undefined) { sets.push("color = ?"); params.push(patch.color); }
  if (patch.parentId !== undefined) {
    if (actor.permissions["teams.manage"] !== "all") throw new ForbiddenError("teams.manage");
    sets.push("parent_id = ?");
    params.push(patch.parentId);
  }
  if (sets.length === 0) return;
  transaction(conn, () => {
    run(conn, `UPDATE teams SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`, ...params, teamId, actor.orgId);
    if (patch.name !== undefined) {
      run(conn, "UPDATE conversations SET title = CASE kind WHEN 'announcement' THEN 'Annunci ' || ? ELSE ? END WHERE team_id = ? AND kind IN ('team_group','announcement')", patch.name.trim(), patch.name.trim(), teamId);
      run(conn, "UPDATE calendars SET name = ? WHERE team_id = ?", `Calendario ${patch.name.trim()}`, teamId);
    }
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "team.update", entityType: "team", entityId: teamId, meta: { ...patch } });
  });
}

/** Eliminazione logica: il team sparisce, le chat vengono archiviate, la storia (eventi, messaggi, sondaggi) resta. */
export function deleteTeam(conn: Conn, actor: Actor, teamId: number): void {
  if (actor.permissions["teams.manage"] !== "all") throw new ForbiddenError("teams.manage");
  const t = requireTeam(conn, actor, teamId, "view");
  transaction(conn, () => {
    run(conn, "UPDATE teams SET deleted_at = ?, name = name || ' (eliminato ' || id || ')' WHERE id = ?", nowISO(), teamId);
    run(conn, "UPDATE conversations SET archived_at = ? WHERE team_id = ? AND archived_at IS NULL", nowISO(), teamId);
    run(conn, "UPDATE meeting_polls SET status = 'cancelled' WHERE team_id = ? AND status IN ('draft','open','closed')", teamId);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "team.delete", entityType: "team", entityId: teamId, meta: { name: t.name } });
  });
}

// ───────────────────────── Membri ─────────────────────────

function requireMemberManagement(conn: Conn, actor: Actor, teamId: number) {
  const team = requireTeam(conn, actor, teamId, "view");
  if (!can(actor, "members.manage", { orgId: actor.orgId, teamId })) throw new ForbiddenError("members.manage");
  return team;
}

export function addTeamMember(conn: Conn, actor: Actor, teamId: number, membershipId: number, opts: { role?: "lead" | "member"; title?: string } = {}): void {
  const team = requireMemberManagement(conn, actor, teamId);
  if (!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, actor.orgId)) throw new ValidationError("La persona selezionata non è un membro attivo.");
  const role = opts.role ?? "member";
  if (!["lead", "member"].includes(role)) throw new ValidationError("Ruolo non valido.");
  transaction(conn, () => {
    const existed = !!one(conn, "SELECT 1 FROM team_members WHERE team_id = ? AND membership_id = ?", teamId, membershipId);
    run(conn, `INSERT INTO team_members (team_id, membership_id, org_id, role, title) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (team_id, membership_id) DO UPDATE SET role = excluded.role, title = excluded.title`, teamId, membershipId, actor.orgId, role, (opts.title ?? "").trim().slice(0, 60));
    if (!existed) {
      notify(conn, { orgId: actor.orgId, recipientIds: [membershipId], actorMembershipId: actor.membershipId, kind: "team", title: `Sei stato aggiunto al team ${team.name}`, url: `/app/team` });
      writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "team.member.add", entityType: "team", entityId: teamId, meta: { membershipId, role } });
    }
    emit(conn, { type: "team.changed", teamId }, [membershipId, ...teamMemberIds(conn, actor.orgId, teamId), ...orgAdminIds(conn, actor.orgId)]);
  });
}

export function removeTeamMember(conn: Conn, actor: Actor, teamId: number, membershipId: number): void {
  const team = requireMemberManagement(conn, actor, teamId);
  transaction(conn, () => {
    const gone = Number(run(conn, "DELETE FROM team_members WHERE team_id = ? AND membership_id = ?", teamId, membershipId).changes);
    if (!gone) return;
    notify(conn, { orgId: actor.orgId, recipientIds: [membershipId], actorMembershipId: actor.membershipId, kind: "team", title: `Sei stato rimosso dal team ${team.name}` });
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "team.member.remove", entityType: "team", entityId: teamId, meta: { membershipId } });
    // L'accesso a chat/calendario/sondaggi del team cessa subito: si rilegge l'appartenenza a ogni richiesta.
    emit(conn, { type: "team.changed", teamId }, [membershipId, ...teamMemberIds(conn, actor.orgId, teamId), ...orgAdminIds(conn, actor.orgId)]);
  });
}
