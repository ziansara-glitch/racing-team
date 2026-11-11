import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { db } from "@/server/db";
import * as chat from "./core/chat";
import * as calendar from "./core/calendar";
import * as dash from "./core/dashboard";
import * as notif from "./core/notifications";
import * as polls_ from "./core/polls";
import * as profile_ from "./core/profile";
import * as projects_ from "./core/projects";
import * as tasks_ from "./core/tasks";
import * as teams_ from "./core/teams";
import { listAudit } from "./core/audit-query";
import { searchPeople } from "./core/people";
import { search } from "./core/search";
import { presenceFor } from "./core/presence";
import { registerAttachment } from "./core/media";

// Il core del dominio è puro (riceve la connessione). Qui si lega al database dell'app: pagine e azioni importano SOLO da qui
// (mai "@/server/db"), così nessuna pagina scrive SQL e ogni funzione richiede un Actor.
const b = <A extends unknown[], R>(fn: (c: DatabaseSync, ...a: A) => R) => (...a: A): R => fn(db, ...a);

export const teams = {
  list: b(teams_.listTeams), members: b(teams_.teamMembers), stats: b(teams_.teamStats), get: b(teams_.requireTeam), create: b(teams_.createTeam), update: b(teams_.updateTeam),
  remove: b(teams_.deleteTeam), addMember: b(teams_.addTeamMember), removeMember: b(teams_.removeTeamMember),
};
export const calendars = {
  list: b(calendar.listCalendars), events: b(calendar.listEvents), deadlines: b(calendar.personalDeadlines), create: b(calendar.createEvent), update: b(calendar.updateEvent),
  remove: b(calendar.deleteEvent), cancelOccurrence: b(calendar.cancelOccurrence), respond: b(calendar.respondToEvent), attendance: b(calendar.eventAttendance),
  recordAttendance: b(calendar.recordAttendance), grant: b(calendar.setCalendarGrant), forTeam: b(calendar.teamCalendar),
};
export const polls = {
  create: b(polls_.createPoll), update: b(polls_.updatePoll), publish: b(polls_.publishPoll), close: b(polls_.closePoll), cancel: b(polls_.cancelPoll),
  respond: b(polls_.respondToPoll), attendance: b(polls_.setPollAttendance), results: b(polls_.pollResults), finalize: b(polls_.finalizePoll),
  listAdmin: b(polls_.listPollsAdmin), listMine: b(polls_.listPollsForMember), pending: b(polls_.pendingPollCount), detail: b(polls_.getPollDetail),
};
export const chats = {
  policy: b(chat.getChatPolicy), setPolicy: b(chat.setChatPolicy), list: b(chat.listConversations), unread: b(chat.totalUnread), messages: b(chat.getMessages), send: b(chat.sendMessage),
  edit: b(chat.editMessage), remove: b(chat.deleteMessage), react: b(chat.toggleReaction), pin: b(chat.setPinned), forward: b(chat.forwardMessage), read: b(chat.markRead),
  prefs: b(chat.setConversationPrefs), createGroup: b(chat.createAdminGroup), updateConversation: b(chat.updateConversation), groupMembers: b(chat.groupMembers),
  addMember: b(chat.addGroupMember), removeMember: b(chat.removeGroupMember), setRole: b(chat.setGroupRole), openDirect: b(chat.openDirect), respondRequest: b(chat.respondToRequest),
  block: b(chat.blockUser), typing: b(chat.announceTyping), blocked: b(chat.blockedByMe), canReadAttachment: b(chat.canReadAttachment), attachment: b(chat.readableAttachment),
};
export const notifications = {
  list: b(notif.listNotifications), unread: b(notif.unreadCount), markRead: b(notif.markRead), remove: b(notif.deleteNotifications), prefs: b(notif.getPreferences), setPref: b(notif.setPreference),
};
export const projects = { list: b(projects_.listProjects), detail: b(projects_.getProjectDetail), create: b(projects_.createProject), overview: b(projects_.projectOverview), templates: b(projects_.listTemplates) };
export const tasks = { query: b(tasks_.queryTasks), mine: b(tasks_.myTasks), create: b(tasks_.createTask), update: b(tasks_.updateTask), detail: b(tasks_.getTaskDetail), bulk: b(tasks_.bulkUpdate) };
export const dashboards = { admin: b(dash.adminDashboard), member: b(dash.memberHome) };
export const profiles = { get: b(profile_.getProfile), update: b(profile_.updateProfile) };
export const audit = { list: b(listAudit) };
export const people = { search: b(searchPeople) };
export const globalSearch = b(search);
export const presence = b(presenceFor);
export const media = { register: b(registerAttachment) };
export const db_categories = (actor: { orgId: number }): { id: number; name: string }[] =>
  db.prepare("SELECT id, name FROM event_categories WHERE org_id = ? ORDER BY name").all(actor.orgId) as { id: number; name: string }[];
export { db as _db };
