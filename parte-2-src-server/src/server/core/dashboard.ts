import type { Actor } from "../authz/authorize.ts";
import { listConversations, type ConversationSummary } from "./chat.ts";
import { listEvents, localNow, type EventOccurrence } from "./calendar.ts";
import { listNotifications, type NotificationDTO } from "./notifications.ts";
import { listPollsAdmin, listPollsForMember, type MemberPoll, type PollSummary } from "./polls.ts";
import { addDays, all, one, todayISO, type Conn } from "./sql.ts";
import { listTeams } from "./teams.ts";
import { listProjects } from "./projects.ts";
import { myTasks, queryTasks, type TaskRow } from "./tasks.ts";
import { visibleProjects } from "./access.ts";

export type AdminDashboard = {
  kpis: { teams: number; members: number; activeProjects: number; upcomingMeetings: number; openPolls: number; pendingApplications: number; attendanceRate: number | null; attendanceRecords: number; taskCompletion: number | null; openTasks: number };
  polls: PollSummary[];
  upcoming: EventOccurrence[];
  conversations: ConversationSummary[];
  teamActivity: { id: number; at: string; action: string; actorName: string | null; meta: Record<string, unknown> }[];
  notifications: NotificationDTO[];
};

/** Centro di comando: ogni numero è calcolato dai dati nell'ambito dell'amministratore. */
export function adminDashboard(conn: Conn, actor: Actor, today = todayISO(), nowLocal = localNow()): AdminDashboard {
  const teams = listTeams(conn, actor, "admin");
  const teamIds = teams.map((t) => t.id);
  const inTeams = teamIds.length ? teamIds.map(() => "?").join(",") : "NULL";
  const scopedAll = actor.permissions["admin.access"] === "all";
  const members = scopedAll
    ? one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'", actor.orgId)!.n
    : one<{ n: number }>(conn, `SELECT COUNT(DISTINCT tm.membership_id) AS n FROM team_members tm JOIN memberships m ON m.id = tm.membership_id WHERE tm.team_id IN (${inTeams}) AND m.status = 'active'`, ...teamIds)!.n;
  const week = listEvents(conn, actor, { from: today, to: addDays(today, 7) });
  const upcoming = listEvents(conn, actor, { from: today, to: addDays(today, 14) }).filter((e) => e.end >= nowLocal).slice(0, 8);
  const polls = actor.permissions["polls.manage"] ? listPollsAdmin(conn, actor).filter((p) => p.status === "open" || p.status === "closed" || p.status === "draft").slice(0, 6) : [];
  const att = scopedAll
    ? one<{ total: number; ok: number }>(conn, "SELECT COUNT(*) AS total, SUM(state IN ('present','late')) AS ok FROM event_attendance WHERE org_id = ? AND occurrence_date >= ?", actor.orgId, addDays(today, -30))!
    : one<{ total: number; ok: number }>(conn, `SELECT COUNT(*) AS total, SUM(a.state IN ('present','late')) AS ok FROM event_attendance a JOIN events e ON e.id = a.event_id JOIN calendars c ON c.id = e.calendar_id WHERE c.team_id IN (${inTeams}) AND a.occurrence_date >= ?`, ...teamIds, addDays(today, -30))!;
  const vis = visibleProjects(actor, "p");
  const taskTotals = one<{ total: number; done: number; open: number }>(
    conn, `SELECT COUNT(*) AS total, SUM(s.category = 'done') AS done, SUM(s.category IN ('backlog','todo','in_progress','review')) AS open FROM tasks t JOIN projects p ON p.id = t.project_id JOIN project_statuses s ON s.id = t.status_id
            WHERE t.deleted_at IS NULL AND s.category <> 'archived' AND ${vis.sql}`, ...vis.params)!;
  const apps = actor.permissions["applications.manage"] === "all" ? one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM applications WHERE status = 'Nuova'")!.n : 0;
  const activity = scopedAll
    ? all<{ id: number; at: string; action: string; name: string | null; meta: string }>(
        conn, `SELECT a.id, a.at, a.action, u.name, a.meta FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
                WHERE a.org_id = ? AND (a.action LIKE 'poll.%' OR a.action LIKE 'event.%' OR a.action LIKE 'team.%' OR a.action LIKE 'chat.group.%' OR a.action LIKE 'project.%') ORDER BY a.id DESC LIMIT 8`, actor.orgId)
    : [];
  return {
    kpis: {
      teams: teams.length, members, activeProjects: listProjects(conn, actor).filter((p) => p.status === "active").length,
      upcomingMeetings: week.filter((e) => e.kind === "meeting").length, openPolls: polls.filter((p) => p.status === "open").length, pendingApplications: apps,
      attendanceRate: att.total ? Math.round(((att.ok ?? 0) / att.total) * 100) : null, attendanceRecords: att.total,
      taskCompletion: taskTotals.total ? Math.round(((taskTotals.done ?? 0) / taskTotals.total) * 100) : null, openTasks: taskTotals.open ?? 0,
    },
    polls, upcoming,
    conversations: listConversations(conn, actor).filter((c) => c.last).slice(0, 5),
    teamActivity: activity.map((a) => ({ id: a.id, at: a.at, action: a.action, actorName: a.name, meta: JSON.parse(a.meta) })),
    notifications: listNotifications(conn, actor, { unreadOnly: true, limit: 5 }).items,
  };
}

export type MemberHome = {
  meetings: EventOccurrence[];
  activities: EventOccurrence[];
  polls: MemberPoll[];
  announcements: { conversationId: number; team: string; author: string; body: string; at: string }[];
  tasks: TaskRow[];
  conversations: ConversationSummary[];
  notifications: NotificationDTO[];
  unreadNotifications: number;
};

export function memberHome(conn: Conn, actor: Actor, today = todayISO(), nowLocal = localNow()): MemberHome {
  const events = listEvents(conn, actor, { from: today, to: addDays(today, 14) }).filter((e) => e.end >= nowLocal);
  const ann = actor.teamIds.length
    ? all<{ cid: number; team: string; author: string; body: string; at: string }>(
        conn, `SELECT c.id AS cid, t.name AS team, u.name AS author, m.body, m.created_at AS at FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN teams t ON t.id = c.team_id
                JOIN memberships mm ON mm.id = m.author_membership_id JOIN users u ON u.id = mm.user_id
               WHERE c.kind = 'announcement' AND c.org_id = ? AND c.team_id IN (${actor.teamIds.map(() => "?").join(",")}) AND m.deleted_at IS NULL AND m.kind <> 'system' ORDER BY m.id DESC LIMIT 4`, actor.orgId, ...actor.teamIds)
    : [];
  const notifs = listNotifications(conn, actor, { limit: 5 });
  return {
    meetings: events.filter((e) => e.kind === "meeting").slice(0, 5),
    activities: events.filter((e) => e.kind !== "meeting").slice(0, 5),
    polls: listPollsForMember(conn, actor, nowLocal).filter((p) => p.status === "open").slice(0, 3),
    announcements: ann.map((a) => ({ conversationId: a.cid, team: a.team, author: a.author, body: a.body, at: a.at })),
    tasks: myTasks(conn, actor, { sort: "due:asc" }, today).slice(0, 6),
    conversations: listConversations(conn, actor).filter((c) => c.last && !c.incomingRequest).slice(0, 4),
    notifications: notifs.items,
    unreadNotifications: one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM notifications WHERE recipient_membership_id = ? AND read_at IS NULL", actor.membershipId)!.n,
  };
}
export { queryTasks };
