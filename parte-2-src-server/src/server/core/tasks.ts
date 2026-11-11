import { type Actor } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { requireProject, visibleProjects, membershipCanRead, type Access, type ProjectRow } from "./access.ts";
import { logActivity, taskActivity, type ActivityDTO } from "./activity.ts";
import { ValidationError, NotFoundError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { indexEntity, removeFromIndex } from "./search.ts";
import { addDays, all, insert, isISODate, nowISO, one, placeholders, run, todayISO, type Conn, type Param } from "./sql.ts";
import type { TaskQuery } from "./taskquery.ts";
import { transaction } from "./tx.ts";
import { PRIORITIES, type FieldType, type Priority, type StatusCategory } from "./types.ts";

const likePattern = (s: string) => `%${s.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const OPEN_CATEGORIES = ["backlog", "todo", "in_progress", "review"];

// ───────────────────────── Tipi ─────────────────────────

export type FieldValue = string | number | boolean | null;

export type TaskRow = {
  id: number;
  number: number;
  ref: string;
  title: string;
  description: string;
  projectId: number;
  projectKey: string;
  projectName: string;
  projectColor: string;
  parentTaskId: number | null;
  statusId: number;
  statusName: string;
  statusCategory: StatusCategory;
  statusColor: string;
  priority: Priority;
  assigneeId: number | null;
  assigneeName: string | null;
  reporterId: number | null;
  milestoneId: number | null;
  milestoneName: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  position: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subtaskTotal: number;
  subtaskDone: number;
  blockedBy: number;
  commentCount: number;
  overdue: boolean;
  fields: Record<number, FieldValue>;
};

type RawTask = {
  id: number; number: number; title: string; description: string; project_id: number; project_key: string; project_name: string; project_color: string;
  parent_task_id: number | null; status_id: number; status_name: string; status_category: StatusCategory; status_color: string; priority: Priority;
  assignee_membership_id: number | null; assignee_name: string | null; reporter_membership_id: number | null; milestone_id: number | null; milestone_name: string | null;
  start_date: string | null; due_date: string | null; estimate_minutes: number | null; position: number; completed_at: string | null; created_at: string; updated_at: string;
  sub_total: number; sub_done: number; blocked_by: number; comments: number;
};

const SELECT = `
  SELECT t.id, t.number, t.title, t.description, t.project_id, p.key AS project_key, p.name AS project_name, p.color AS project_color,
         t.parent_task_id, t.status_id, s.name AS status_name, s.category AS status_category, s.color AS status_color, t.priority,
         t.assignee_membership_id, au.name AS assignee_name, t.reporter_membership_id, t.milestone_id, ms.name AS milestone_name,
         t.start_date, t.due_date, t.estimate_minutes, t.position, t.completed_at, t.created_at, t.updated_at,
         (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = t.id AND c.deleted_at IS NULL) AS sub_total,
         (SELECT COUNT(*) FROM tasks c JOIN project_statuses cs ON cs.id = c.status_id WHERE c.parent_task_id = t.id AND c.deleted_at IS NULL AND cs.category = 'done') AS sub_done,
         (SELECT COUNT(*) FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id JOIN project_statuses bs ON bs.id = b.status_id
           WHERE d.task_id = t.id AND b.deleted_at IS NULL AND bs.category NOT IN ('done', 'archived')) AS blocked_by,
         (SELECT COUNT(*) FROM comments cm WHERE cm.entity_type = 'task' AND cm.entity_id = t.id AND cm.deleted_at IS NULL) AS comments
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN project_statuses s ON s.id = t.status_id
    LEFT JOIN memberships am ON am.id = t.assignee_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    LEFT JOIN milestones ms ON ms.id = t.milestone_id`;

function toRow(r: RawTask, today: string): TaskRow {
  return {
    id: r.id, number: r.number, ref: `${r.project_key}-${r.number}`, title: r.title, description: r.description, projectId: r.project_id,
    projectKey: r.project_key, projectName: r.project_name, projectColor: r.project_color, parentTaskId: r.parent_task_id, statusId: r.status_id,
    statusName: r.status_name, statusCategory: r.status_category, statusColor: r.status_color, priority: r.priority, assigneeId: r.assignee_membership_id,
    assigneeName: r.assignee_name, reporterId: r.reporter_membership_id, milestoneId: r.milestone_id, milestoneName: r.milestone_name, startDate: r.start_date,
    dueDate: r.due_date, estimateMinutes: r.estimate_minutes, position: r.position, completedAt: r.completed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    subtaskTotal: r.sub_total, subtaskDone: r.sub_done, blockedBy: r.blocked_by, commentCount: r.comments,
    overdue: !!r.due_date && r.due_date < today && OPEN_CATEGORIES.includes(r.status_category), fields: {},
  };
}

function attachFields(conn: Conn, rows: TaskRow[]): TaskRow[] {
  if (rows.length === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const v of all<{ task_id: number; field_id: number; value: string }>(conn, `SELECT task_id, field_id, value FROM task_field_values WHERE task_id IN (${placeholders(rows.length)})`, ...rows.map((r) => r.id))) {
    byId.get(v.task_id)!.fields[v.field_id] = JSON.parse(v.value) as FieldValue;
  }
  return rows;
}

// ───────────────────────── Lettura ─────────────────────────

const PRIORITY_ORDER = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

function orderBy(sort: string | undefined, crossProject: boolean): string {
  const [key, dirRaw] = (sort ?? "").split(":");
  const dir = dirRaw === "desc" ? "DESC" : "ASC";
  const cf = /^cf\.(\d+)$/.exec(key ?? "");
  if (cf) return `(SELECT json_extract(v.value, '$') FROM task_field_values v WHERE v.task_id = t.id AND v.field_id = ${Number(cf[1])}) IS NULL, (SELECT json_extract(v.value, '$') FROM task_field_values v WHERE v.task_id = t.id AND v.field_id = ${Number(cf[1])}) ${dir}, t.id`;
  switch (key) {
    case "number": return `p.key, t.number ${dir}`;
    case "title": return `t.title COLLATE NOCASE ${dir}, t.id`;
    case "priority": return `${PRIORITY_ORDER} ${dir}, t.id`;
    case "assignee": return `au.name IS NULL, au.name COLLATE NOCASE ${dir}, t.id`;
    case "due": return `t.due_date IS NULL, t.due_date ${dir}, t.id`;
    case "start": return `t.start_date IS NULL, t.start_date ${dir}, t.id`;
    case "milestone": return `ms.due_date IS NULL, ms.due_date ${dir}, t.id`;
    case "updated": return `t.updated_at ${dir}, t.id`;
    case "created": return `t.created_at ${dir}, t.id`;
    case "status": return `s.position ${dir}, t.position, t.id`;
    default: return crossProject ? "t.due_date IS NULL, t.due_date, " + PRIORITY_ORDER + ", t.id" : "s.position, t.position, t.id";
  }
}

/** Task di un progetto (`projectId`) o di tutti i progetti visibili. Filtri e ordinamento arrivano da `parseTaskQuery`. */
export function queryTasks(conn: Conn, actor: Actor, scope: { projectId?: number }, q: TaskQuery = {}, today = todayISO(), limit = 1000): TaskRow[] {
  const where: string[] = ["t.org_id = ?", "t.deleted_at IS NULL"];
  const params: Param[] = [actor.orgId];
  if (scope.projectId) {
    requireProject(conn, actor, scope.projectId, "read");
    where.push("t.project_id = ?");
    params.push(scope.projectId);
  } else {
    const vis = visibleProjects(actor, "p");
    where.push(vis.sql);
    params.push(...vis.params);
  }
  if (!q.showArchived && !q.status) where.push("s.category <> 'archived'");
  if (!q.showSubtasks) where.push("t.parent_task_id IS NULL");
  if (q.hideDone) where.push("s.category <> 'done'");
  if (q.q) {
    const p = likePattern(q.q);
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR (p.key || '-' || t.number) LIKE ? ESCAPE '\\')");
    params.push(p, p, p);
  }
  if (q.status?.length) {
    where.push(`t.status_id IN (${placeholders(q.status.length)})`);
    params.push(...q.status);
  }
  if (q.priority?.length) {
    where.push(`t.priority IN (${placeholders(q.priority.length)})`);
    params.push(...q.priority);
  }
  if (q.assignee?.length) {
    const parts: string[] = [];
    for (const a of q.assignee) {
      if (a === "none") parts.push("t.assignee_membership_id IS NULL");
      else {
        parts.push("t.assignee_membership_id = ?");
        params.push(a === "me" ? actor.membershipId : a);
      }
    }
    where.push(`(${parts.join(" OR ")})`);
  }
  if (q.milestone?.length) {
    const parts: string[] = [];
    for (const m of q.milestone) {
      if (m === "none") parts.push("t.milestone_id IS NULL");
      else {
        parts.push("t.milestone_id = ?");
        params.push(m);
      }
    }
    where.push(`(${parts.join(" OR ")})`);
  }
  if (q.due === "overdue") {
    where.push("t.due_date < ? AND s.category IN ('backlog','todo','in_progress','review')");
    params.push(today);
  } else if (q.due === "week" || q.due === "month") {
    where.push("t.due_date >= ? AND t.due_date <= ?");
    params.push(today, addDays(today, q.due === "week" ? 7 : 31));
  } else if (q.due === "none") where.push("t.due_date IS NULL");
  if (q.from) {
    where.push("t.due_date >= ?");
    params.push(q.from);
  }
  if (q.to) {
    where.push("t.due_date <= ?");
    params.push(q.to);
  }
  if (q.cf && scope.projectId) {
    const types = new Map(all<{ id: number; type: FieldType }>(conn, "SELECT id, type FROM custom_fields WHERE project_id = ?", scope.projectId).map((f) => [f.id, f.type]));
    for (const [idStr, value] of Object.entries(q.cf)) {
      const id = Number(idStr);
      const type = types.get(id);
      if (!type) continue;
      if (type === "checkbox") where.push("EXISTS (SELECT 1 FROM task_field_values v WHERE v.task_id = t.id AND v.field_id = ? AND json_extract(v.value, '$') = ?)");
      else if (type === "text" || type === "url") where.push("EXISTS (SELECT 1 FROM task_field_values v WHERE v.task_id = t.id AND v.field_id = ? AND json_extract(v.value, '$') LIKE ? ESCAPE '\\')");
      else where.push("EXISTS (SELECT 1 FROM task_field_values v WHERE v.task_id = t.id AND v.field_id = ? AND CAST(json_extract(v.value, '$') AS TEXT) = ?)");
      params.push(id, type === "checkbox" ? (value === "true" || value === "1" ? 1 : 0) : type === "text" || type === "url" ? likePattern(value) : value);
    }
  }
  const rows = all<RawTask>(conn, `${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${orderBy(q.sort, !scope.projectId)} LIMIT ?`, ...params, limit);
  return attachFields(conn, rows.map((r) => toRow(r, today)));
}

export const myTasks = (conn: Conn, actor: Actor, q: TaskQuery = {}, today = todayISO()) =>
  queryTasks(conn, actor, {}, { ...q, assignee: q.assignee ?? ["me"], hideDone: q.hideDone ?? true }, today);

export type CommentDTO = { id: number; authorId: number; authorName: string; body: string; mentions: { id: number; name: string }[]; createdAt: string; editedAt: string | null; canDelete: boolean };
export type DependencyDTO = { id: number; ref: string; title: string; statusName: string; done: boolean };

export type TaskDetail = {
  task: TaskRow;
  project: ProjectRow;
  access: Access;
  parent: { id: number; ref: string; title: string } | null;
  subtasks: TaskRow[];
  blockedBy: DependencyDTO[];
  blocking: DependencyDTO[];
  comments: CommentDTO[];
  activity: ActivityDTO[];
  /** Stati raggiungibili da quello attuale (rispetta il workflow limitato). */
  allowedStatusIds: number[];
};

function requireTask(conn: Conn, actor: Actor, taskId: number, need: "read" | "writeTasks" | "comment" | "manage" = "read") {
  const t = one<{ id: number; project_id: number; status_id: number; parent_task_id: number | null; title: string; number: number }>(
    conn, "SELECT id, project_id, status_id, parent_task_id, title, number FROM tasks WHERE id = ? AND org_id = ? AND deleted_at IS NULL", taskId, actor.orgId);
  if (!t) throw new NotFoundError("Task");
  return { task: t, ...requireProject(conn, actor, t.project_id, need) };
}

export function getTaskDetail(conn: Conn, actor: Actor, projectKey: string, number: number, today = todayISO()): TaskDetail | null {
  let found;
  try {
    found = requireProject(conn, actor, projectKey, "read");
  } catch {
    return null;
  }
  const { project, access } = found;
  const raw = one<RawTask>(conn, `${SELECT} WHERE t.project_id = ? AND t.number = ? AND t.deleted_at IS NULL`, project.id, number);
  if (!raw) return null;
  const [task] = attachFields(conn, [toRow(raw, today)]);
  const dep = (sql: string) => all<{ id: number; number: number; title: string; status: string; category: StatusCategory }>(conn, sql, task.id).map((d) => ({
    id: d.id, ref: `${project.key}-${d.number}`, title: d.title, statusName: d.status, done: d.category === "done" || d.category === "archived",
  }));
  const parent = task.parentTaskId ? one<{ id: number; number: number; title: string }>(conn, "SELECT id, number, title FROM tasks WHERE id = ?", task.parentTaskId) : undefined;
  return {
    task,
    project,
    access,
    parent: parent ? { id: parent.id, ref: `${project.key}-${parent.number}`, title: parent.title } : null,
    subtasks: attachFields(conn, all<RawTask>(conn, `${SELECT} WHERE t.parent_task_id = ? AND t.deleted_at IS NULL ORDER BY t.number`, task.id).map((r) => toRow(r, today))),
    blockedBy: dep(`SELECT b.id, b.number, b.title, s.name AS status, s.category FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id JOIN project_statuses s ON s.id = b.status_id WHERE d.task_id = ? AND b.deleted_at IS NULL ORDER BY b.number`),
    blocking: dep(`SELECT b.id, b.number, b.title, s.name AS status, s.category FROM task_dependencies d JOIN tasks b ON b.id = d.task_id JOIN project_statuses s ON s.id = b.status_id WHERE d.depends_on_task_id = ? AND b.deleted_at IS NULL ORDER BY b.number`),
    comments: listComments(conn, actor, "task", task.id),
    activity: taskActivity(conn, actor, task.id),
    allowedStatusIds: project.workflow_restricted
      ? [task.statusId, ...all<{ t: number }>(conn, "SELECT to_status_id AS t FROM workflow_transitions WHERE project_id = ? AND from_status_id = ?", project.id, task.statusId).map((r) => r.t)]
      : all<{ id: number }>(conn, "SELECT id FROM project_statuses WHERE project_id = ?", project.id).map((r) => r.id),
  };
}

export function listDependencies(conn: Conn, actor: Actor, projectId: number): { from: number; to: number }[] {
  requireProject(conn, actor, projectId, "read");
  return all<{ f: number; t: number }>(
    conn,
    `SELECT d.depends_on_task_id AS f, d.task_id AS t FROM task_dependencies d
       JOIN tasks a ON a.id = d.task_id AND a.deleted_at IS NULL JOIN tasks b ON b.id = d.depends_on_task_id AND b.deleted_at IS NULL
      WHERE d.project_id = ?`,
    projectId,
  ).map((r) => ({ from: r.f, to: r.t }));
}

// ───────────────────────── Validazione campi personalizzati ─────────────────────────

/** Restituisce, per ogni campo toccato, il JSON da salvare oppure null per cancellare il valore. */
function validateFieldValues(conn: Conn, projectId: number, input: Record<number, unknown> | undefined, creating: boolean): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const fields = all<{ id: number; name: string; type: FieldType; options: string; required: number }>(conn, "SELECT id, name, type, options, required FROM custom_fields WHERE project_id = ?", projectId);
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const id of Object.keys(input ?? {})) if (!byId.has(Number(id))) throw new ValidationError("Campo personalizzato sconosciuto.");
  for (const f of fields) {
    const provided = input !== undefined && Object.prototype.hasOwnProperty.call(input, f.id);
    if (!provided) {
      if (creating && f.required) throw new ValidationError(`Il campo «${f.name}» è obbligatorio.`, `cf_${f.id}`);
      continue;
    }
    const raw = input![f.id];
    const empty = raw === null || raw === undefined || raw === "" || (f.type === "checkbox" && raw === false && !f.required && false);
    if (empty) {
      if (f.required) throw new ValidationError(`Il campo «${f.name}» è obbligatorio.`, `cf_${f.id}`);
      out.set(f.id, null);
      continue;
    }
    const bad = (m: string) => new ValidationError(`${f.name}: ${m}`, `cf_${f.id}`);
    switch (f.type) {
      case "text": {
        const s = String(raw).trim();
        if (s.length > 500) throw bad("massimo 500 caratteri.");
        out.set(f.id, JSON.stringify(s));
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
        if (!Number.isFinite(n)) throw bad("inserisci un numero.");
        out.set(f.id, JSON.stringify(n));
        break;
      }
      case "date":
        if (!isISODate(raw)) throw bad("data non valida (AAAA-MM-GG).");
        out.set(f.id, JSON.stringify(raw));
        break;
      case "select": {
        const s = String(raw);
        if (!(JSON.parse(f.options) as string[]).includes(s)) throw bad("scegli uno dei valori previsti.");
        out.set(f.id, JSON.stringify(s));
        break;
      }
      case "checkbox":
        out.set(f.id, JSON.stringify(raw === true || raw === "true" || raw === "on" || raw === "1" || raw === 1));
        break;
      case "url": {
        const s = String(raw).trim();
        try {
          const u = new URL(s);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        } catch {
          throw bad("inserisci un link http(s) valido.");
        }
        out.set(f.id, JSON.stringify(s));
        break;
      }
    }
  }
  return out;
}

function writeFieldValues(conn: Conn, taskId: number, projectId: number, values: Map<number, string | null>): void {
  for (const [fieldId, json] of values) {
    if (json === null) run(conn, "DELETE FROM task_field_values WHERE task_id = ? AND field_id = ?", taskId, fieldId);
    else run(conn, `INSERT INTO task_field_values (task_id, field_id, project_id, value) VALUES (?, ?, ?, ?)
                    ON CONFLICT (task_id, field_id) DO UPDATE SET value = excluded.value`, taskId, fieldId, projectId, json);
  }
}

// ───────────────────────── Creazione e modifica ─────────────────────────

export type CreateTaskInput = {
  title: string;
  description?: string;
  statusId?: number;
  priority?: Priority;
  assigneeId?: number | null;
  milestoneId?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  estimateMinutes?: number | null;
  parentTaskId?: number | null;
  fields?: Record<number, unknown>;
};

function checkCommon(conn: Conn, actor: Actor, project: ProjectRow, i: { title?: string; priority?: string; startDate?: string | null; dueDate?: string | null; estimateMinutes?: number | null; milestoneId?: number | null; assigneeId?: number | null }): void {
  if (i.title !== undefined) {
    const t = i.title.trim();
    if (t.length < 1 || t.length > 200) throw new ValidationError("Il titolo deve avere tra 1 e 200 caratteri.", "title");
  }
  if (i.priority !== undefined && !(PRIORITIES as readonly string[]).includes(i.priority)) throw new ValidationError("Priorità non valida.", "priority");
  for (const [k, v] of [["startDate", i.startDate], ["dueDate", i.dueDate]] as const) if (v && !isISODate(v)) throw new ValidationError("Data non valida (usa AAAA-MM-GG).", k);
  if (i.estimateMinutes != null && (!Number.isInteger(i.estimateMinutes) || i.estimateMinutes < 0 || i.estimateMinutes > 600_000)) throw new ValidationError("Stima non valida.", "estimateMinutes");
  if (i.milestoneId != null && !one(conn, "SELECT 1 FROM milestones WHERE id = ? AND project_id = ?", i.milestoneId, project.id)) throw new ValidationError("Milestone non valida.", "milestoneId");
  if (i.assigneeId != null && !membershipCanRead(conn, actor.orgId, i.assigneeId, project)) {
    throw new ValidationError("La persona scelta non ha accesso al progetto: aggiungila prima ai membri.", "assigneeId");
  }
}

const taskUrl = (p: { key: string }, number: number) => `/projects/${p.key}/tasks/${number}`;

export function createTask(conn: Conn, actor: Actor, projectId: number, input: CreateTaskInput): { id: number; number: number; ref: string } {
  const { project } = requireProject(conn, actor, projectId, "writeTasks");
  checkCommon(conn, actor, project, input);
  const start = input.startDate || null;
  const due = input.dueDate || null;
  if (start && due && start > due) throw new ValidationError("La scadenza precede la data di inizio.", "dueDate");
  let status: { id: number; category: StatusCategory } | undefined;
  if (input.statusId) {
    status = one(conn, "SELECT id, category FROM project_statuses WHERE id = ? AND project_id = ?", input.statusId, projectId);
    if (!status) throw new ValidationError("Stato non valido.", "statusId");
  } else {
    status = one(conn, `SELECT id, category FROM project_statuses WHERE project_id = ? AND category IN ('todo','backlog','in_progress','review')
                         ORDER BY (category = 'todo') DESC, position LIMIT 1`, projectId);
  }
  if (!status) throw new ValidationError("Il progetto non ha stati utilizzabili.");
  if (input.parentTaskId) {
    const parent = one<{ parent_task_id: number | null }>(conn, "SELECT parent_task_id FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL", input.parentTaskId, projectId);
    if (!parent) throw new ValidationError("Task padre non valido.", "parentTaskId");
    if (parent.parent_task_id !== null) throw new ValidationError("I sottotask possono avere un solo livello.", "parentTaskId");
  }
  const fieldValues = validateFieldValues(conn, projectId, input.fields, true);

  return transaction(conn, () => {
    const number = one<{ n: number }>(conn, "SELECT next_task_number AS n FROM projects WHERE id = ?", projectId)!.n;
    run(conn, "UPDATE projects SET next_task_number = ?, updated_at = ? WHERE id = ?", number + 1, nowISO(), projectId);
    const position = (one<{ m: number | null }>(conn, "SELECT MAX(position) AS m FROM tasks WHERE project_id = ? AND status_id = ?", projectId, status.id)?.m ?? 0) + 1000;
    const id = insert(
      conn,
      `INSERT INTO tasks (org_id, project_id, number, parent_task_id, title, description, status_id, priority, assignee_membership_id, reporter_membership_id,
                          milestone_id, start_date, due_date, estimate_minutes, position, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      actor.orgId, projectId, number, input.parentTaskId ?? null, input.title.trim(), (input.description ?? "").trim(), status.id, input.priority ?? "medium",
      input.assigneeId ?? null, actor.membershipId, input.milestoneId ?? null, start, due, input.estimateMinutes ?? null, position, status.category === "done" ? nowISO() : null,
    );
    writeFieldValues(conn, id, projectId, fieldValues);
    indexEntity(conn, { orgId: actor.orgId, projectId, type: "task", id, title: input.title.trim(), body: (input.description ?? "").trim() });
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "task", entityId: id, actorMembershipId: actor.membershipId, verb: "task.created", meta: { ref: `${project.key}-${number}`, title: input.title.trim() } });
    if (input.assigneeId) {
      notify(conn, { orgId: actor.orgId, recipientIds: [input.assigneeId], actorMembershipId: actor.membershipId, kind: "assigned", title: `Ti è stato assegnato ${project.key}-${number}: ${input.title.trim()}`, url: taskUrl(project, number), dedupeKey: `assigned:${id}:${input.assigneeId}` });
    }
    return { id, number, ref: `${project.key}-${number}` };
  });
}

/** Controlla che il passaggio di stato sia ammesso: workflow, blocchi e sottotask aperti. */
function assertTransition(conn: Conn, project: ProjectRow, taskId: number, fromStatusId: number, to: { id: number; name: string; category: StatusCategory }): void {
  if (to.id === fromStatusId) return;
  if (project.workflow_restricted && !one(conn, "SELECT 1 FROM workflow_transitions WHERE project_id = ? AND from_status_id = ? AND to_status_id = ?", project.id, fromStatusId, to.id)) {
    const from = one<{ name: string }>(conn, "SELECT name FROM project_statuses WHERE id = ?", fromStatusId)?.name ?? "?";
    throw new ValidationError(`Transizione non consentita dal workflow: «${from}» → «${to.name}».`, "statusId");
  }
  if (to.category === "done") {
    const blockers = all<{ number: number }>(
      conn,
      `SELECT b.number FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_task_id JOIN project_statuses s ON s.id = b.status_id
        WHERE d.task_id = ? AND b.deleted_at IS NULL AND s.category NOT IN ('done', 'archived') ORDER BY b.number`,
      taskId,
    );
    if (blockers.length) throw new ValidationError(`Bloccato da ${blockers.map((b) => `${project.key}-${b.number}`).join(", ")}: completa prima le dipendenze.`, "statusId");
    const open = one<{ n: number }>(conn, `SELECT COUNT(*) AS n FROM tasks c JOIN project_statuses s ON s.id = c.status_id WHERE c.parent_task_id = ? AND c.deleted_at IS NULL AND s.category NOT IN ('done','archived')`, taskId)!.n;
    if (open > 0) throw new ValidationError(`Ci sono ${open} sottotask non completati.`, "statusId");
  }
}

export type UpdateTaskInput = Partial<{
  title: string; description: string; statusId: number; priority: Priority; assigneeId: number | null; milestoneId: number | null;
  startDate: string | null; dueDate: string | null; estimateMinutes: number | null; fields: Record<number, unknown>;
}>;

export function updateTask(conn: Conn, actor: Actor, taskId: number, patch: UpdateTaskInput): void {
  const { task: ref, project } = requireTask(conn, actor, taskId, "writeTasks");
  const cur = one<{ title: string; description: string; status_id: number; priority: Priority; assignee_membership_id: number | null; reporter_membership_id: number | null; milestone_id: number | null; start_date: string | null; due_date: string | null; estimate_minutes: number | null }>(
    conn, "SELECT title, description, status_id, priority, assignee_membership_id, reporter_membership_id, milestone_id, start_date, due_date, estimate_minutes FROM tasks WHERE id = ?", taskId)!;
  checkCommon(conn, actor, project, patch);
  const start = patch.startDate !== undefined ? patch.startDate || null : cur.start_date;
  const due = patch.dueDate !== undefined ? patch.dueDate || null : cur.due_date;
  if (start && due && start > due) throw new ValidationError("La scadenza precede la data di inizio.", "dueDate");
  let newStatus: { id: number; name: string; category: StatusCategory } | undefined;
  if (patch.statusId !== undefined && patch.statusId !== cur.status_id) {
    newStatus = one(conn, "SELECT id, name, category FROM project_statuses WHERE id = ? AND project_id = ?", patch.statusId, project.id);
    if (!newStatus) throw new ValidationError("Stato non valido.", "statusId");
    assertTransition(conn, project, taskId, cur.status_id, newStatus);
  }
  const fieldValues = patch.fields ? validateFieldValues(conn, project.id, patch.fields, false) : new Map<number, string | null>();

  const sets: string[] = [];
  const params: Param[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const set = (col: string, key: string, to: Param, from: Param) => {
    if (to === from) return;
    sets.push(`${col} = ?`);
    params.push(to);
    changes[key] = { from, to };
  };
  if (patch.title !== undefined) set("title", "title", patch.title.trim(), cur.title);
  if (patch.description !== undefined) set("description", "description", patch.description.trim(), cur.description);
  if (patch.priority !== undefined) set("priority", "priority", patch.priority, cur.priority);
  if (patch.assigneeId !== undefined) set("assignee_membership_id", "assignee", patch.assigneeId, cur.assignee_membership_id);
  if (patch.milestoneId !== undefined) set("milestone_id", "milestone", patch.milestoneId, cur.milestone_id);
  if (patch.startDate !== undefined) set("start_date", "startDate", start, cur.start_date);
  if (patch.dueDate !== undefined) set("due_date", "dueDate", due, cur.due_date);
  if (patch.estimateMinutes !== undefined) set("estimate_minutes", "estimate", patch.estimateMinutes, cur.estimate_minutes);
  if (newStatus) {
    set("status_id", "status", newStatus.id, cur.status_id);
    sets.push("completed_at = ?");
    params.push(newStatus.category === "done" ? nowISO() : null);
  }
  if (sets.length === 0 && fieldValues.size === 0) return;

  transaction(conn, () => {
    if (sets.length) run(conn, `UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND org_id = ?`, ...params, nowISO(), taskId, actor.orgId);
    else run(conn, "UPDATE tasks SET updated_at = ? WHERE id = ?", nowISO(), taskId);
    writeFieldValues(conn, taskId, project.id, fieldValues);
    if (fieldValues.size) changes.fields = { from: null, to: [...fieldValues.keys()] };
    if (changes.title || changes.description) {
      const t = one<{ title: string; description: string }>(conn, "SELECT title, description FROM tasks WHERE id = ?", taskId)!;
      indexEntity(conn, { orgId: actor.orgId, projectId: project.id, type: "task", id: taskId, title: t.title, body: t.description });
    }
    const label = `${project.key}-${ref.number}`;
    logActivity(conn, { orgId: actor.orgId, projectId: project.id, entityType: "task", entityId: taskId, actorMembershipId: actor.membershipId, verb: newStatus ? "task.status_changed" : "task.updated", meta: { ref: label, changes: { ...changes, ...(newStatus ? { status: { from: one<{ name: string }>(conn, "SELECT name FROM project_statuses WHERE id = ?", cur.status_id)?.name, to: newStatus.name } } : {}) } } });
    if (changes.assignee && patch.assigneeId) {
      notify(conn, { orgId: actor.orgId, recipientIds: [patch.assigneeId], actorMembershipId: actor.membershipId, kind: "assigned", title: `Ti è stato assegnato ${label}: ${changes.title ? patch.title!.trim() : ref.title}`, url: taskUrl(project, ref.number), dedupeKey: `assigned:${taskId}:${patch.assigneeId}` });
    }
    if (newStatus && cur.reporter_membership_id) {
      notify(conn, { orgId: actor.orgId, recipientIds: [cur.reporter_membership_id], actorMembershipId: actor.membershipId, kind: "status", title: `${label} è passato a «${newStatus.name}»`, url: taskUrl(project, ref.number) });
    }
  });
}

/** Spostamento da board: cambia colonna (con le stesse regole di updateTask) e posizione, davanti a `beforeTaskId` o in coda. */
export function moveTask(conn: Conn, actor: Actor, taskId: number, statusId: number, beforeTaskId: number | null): void {
  const { task, project } = requireTask(conn, actor, taskId, "writeTasks");
  if (!one(conn, "SELECT 1 FROM project_statuses WHERE id = ? AND project_id = ?", statusId, project.id)) throw new ValidationError("Stato non valido.", "statusId");
  transaction(conn, () => {
    if (statusId !== task.status_id) updateTask(conn, actor, taskId, { statusId });
    const column = all<{ id: number; position: number }>(conn, "SELECT id, position FROM tasks WHERE project_id = ? AND status_id = ? AND deleted_at IS NULL AND id <> ? ORDER BY position, id", project.id, statusId, taskId);
    const idx = beforeTaskId ? column.findIndex((c) => c.id === beforeTaskId) : -1;
    let pos: number;
    if (idx === -1) pos = (column.at(-1)?.position ?? 0) + 1000;
    else if (idx === 0) pos = column[0].position - 1000;
    else pos = (column[idx - 1].position + column[idx].position) / 2;
    run(conn, "UPDATE tasks SET position = ? WHERE id = ?", pos, taskId);
    // Posizioni troppo vicine: si rinumera la colonna.
    const sorted = all<{ id: number; position: number }>(conn, "SELECT id, position FROM tasks WHERE project_id = ? AND status_id = ? AND deleted_at IS NULL ORDER BY position, id", project.id, statusId);
    if (sorted.some((r, i) => i > 0 && r.position - sorted[i - 1].position < 1e-6)) sorted.forEach((r, i) => run(conn, "UPDATE tasks SET position = ? WHERE id = ?", (i + 1) * 1000, r.id));
  });
}

export function deleteTask(conn: Conn, actor: Actor, taskId: number): void {
  const { task, project } = requireTask(conn, actor, taskId, "writeTasks");
  transaction(conn, () => {
    const ids = [taskId, ...all<{ id: number }>(conn, "SELECT id FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL", taskId).map((r) => r.id)];
    for (const id of ids) {
      run(conn, "UPDATE tasks SET deleted_at = ? WHERE id = ?", nowISO(), id);
      removeFromIndex(conn, "task", id);
    }
    logActivity(conn, { orgId: actor.orgId, projectId: project.id, entityType: "task", entityId: taskId, actorMembershipId: actor.membershipId, verb: "task.deleted", meta: { ref: `${project.key}-${task.number}`, title: task.title, subtasks: ids.length - 1 } });
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "task.delete", entityType: "task", entityId: taskId, meta: { ref: `${project.key}-${task.number}` } });
  });
}

// ───────────────────────── Azioni di gruppo ─────────────────────────

export type BulkPatch = { statusId?: number; priority?: Priority; assigneeId?: number | null; milestoneId?: number | null; dueDate?: string | null; remove?: boolean };

/** Applica la stessa modifica a più task. Ogni task è indipendente: chi viola una regola viene riportato negli errori, gli altri vengono modificati. */
export function bulkUpdate(conn: Conn, actor: Actor, projectId: number, ids: number[], patch: BulkPatch): { done: number; failed: { id: number; ref: string; message: string }[] } {
  const { project } = requireProject(conn, actor, projectId, "writeTasks");
  const unique = [...new Set(ids)].slice(0, 500);
  let done = 0;
  const failed: { id: number; ref: string; message: string }[] = [];
  transaction(conn, () => {
    for (const id of unique) {
      const t = one<{ number: number }>(conn, "SELECT number FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL", id, project.id);
      const ref = t ? `${project.key}-${t.number}` : `#${id}`;
      if (!t) { failed.push({ id, ref, message: "Task non trovato." }); continue; }
      try {
        if (patch.remove) deleteTask(conn, actor, id);
        else {
          const { remove: _r, ...rest } = patch;
          void _r;
          const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
          updateTask(conn, actor, id, defined as UpdateTaskInput);
        }
        done++;
      } catch (e) {
        if (e instanceof ValidationError) failed.push({ id, ref, message: e.message });
        else throw e;
      }
    }
  });
  return { done, failed };
}

// ───────────────────────── Dipendenze ─────────────────────────

export function addDependency(conn: Conn, actor: Actor, taskId: number, dependsOnId: number): void {
  const { task, project } = requireTask(conn, actor, taskId, "writeTasks");
  if (taskId === dependsOnId) throw new ValidationError("Un task non può dipendere da se stesso.");
  const other = one<{ number: number }>(conn, "SELECT number FROM tasks WHERE id = ? AND project_id = ? AND deleted_at IS NULL", dependsOnId, project.id);
  if (!other) throw new ValidationError("Il task da cui dipendere deve esistere nello stesso progetto.");
  // C'è già un percorso dependsOn -> ... -> task? Allora aggiungere questa dipendenza chiuderebbe un ciclo.
  const cycle = one(
    conn,
    `WITH RECURSIVE reach(id) AS (
       SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
       UNION
       SELECT d.depends_on_task_id FROM task_dependencies d JOIN reach r ON d.task_id = r.id
     ) SELECT 1 FROM reach WHERE id = ?`,
    dependsOnId, taskId,
  );
  if (cycle) throw new ValidationError("Dipendenza circolare: il task scelto dipende già, direttamente o no, da questo.");
  transaction(conn, () => {
    run(conn, "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, project_id) VALUES (?, ?, ?)", taskId, dependsOnId, project.id);
    logActivity(conn, { orgId: actor.orgId, projectId: project.id, entityType: "task", entityId: taskId, actorMembershipId: actor.membershipId, verb: "dependency.added", meta: { on: `${project.key}-${other.number}`, ref: `${project.key}-${task.number}` } });
  });
}

export function removeDependency(conn: Conn, actor: Actor, taskId: number, dependsOnId: number): void {
  const { project } = requireTask(conn, actor, taskId, "writeTasks");
  run(conn, "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ? AND project_id = ?", taskId, dependsOnId, project.id);
}

// ───────────────────────── Commenti e menzioni ─────────────────────────

export function listComments(conn: Conn, actor: Actor, type: "task" | "project", id: number): CommentDTO[] {
  const project = type === "task"
    ? requireTask(conn, actor, id, "read").access
    : requireProject(conn, actor, id, "read").access;
  const byId = new Map(all<{ id: number; name: string }>(conn, "SELECT m.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?", actor.orgId).map((m) => [m.id, m.name]));
  return all<{ id: number; author: number; name: string; body: string; mentions: string; created_at: string; edited_at: string | null }>(
    conn,
    `SELECT c.id, c.author_membership_id AS author, u.name, c.body, c.mentions, c.created_at, c.edited_at FROM comments c
       JOIN memberships m ON m.id = c.author_membership_id JOIN users u ON u.id = m.user_id
      WHERE c.org_id = ? AND c.entity_type = ? AND c.entity_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`,
    actor.orgId, type, id,
  ).map((c) => ({
    id: c.id, authorId: c.author, authorName: c.name, body: c.body, createdAt: c.created_at, editedAt: c.edited_at,
    mentions: (JSON.parse(c.mentions) as number[]).filter((m) => byId.has(m)).map((m) => ({ id: m, name: byId.get(m)! })),
    canDelete: c.author === actor.membershipId || project.manage,
  }));
}

export function addComment(conn: Conn, actor: Actor, type: "task" | "project", id: number, body: string, mentionIds: number[] = []): number {
  const text = body.trim();
  if (text.length < 1 || text.length > 5000) throw new ValidationError("Il commento deve avere tra 1 e 5000 caratteri.", "body");
  const task = type === "task" ? requireTask(conn, actor, id, "comment") : null;
  const proj = task ? { project: task.project } : requireProject(conn, actor, id, "comment");
  const { project } = proj;
  // Si possono menzionare solo persone che vedono il progetto: nessuna notifica rivela un task a chi non può leggerlo.
  const mentioned = [...new Set(mentionIds)].filter((m) => m !== actor.membershipId && membershipCanRead(conn, actor.orgId, m, project));
  return transaction(conn, () => {
    const cid = insert(conn, "INSERT INTO comments (org_id, entity_type, entity_id, author_membership_id, body, mentions) VALUES (?, ?, ?, ?, ?, ?)", actor.orgId, type, id, actor.membershipId, text, JSON.stringify(mentioned));
    const url = task ? taskUrl(project, task.task.number) : `/projects/${project.key}`;
    const label = task ? `${project.key}-${task.task.number}` : project.name;
    logActivity(conn, { orgId: actor.orgId, projectId: project.id, entityType: type, entityId: id, actorMembershipId: actor.membershipId, verb: "comment.added", meta: { ref: label, mentions: mentioned.length } });
    notify(conn, { orgId: actor.orgId, recipientIds: mentioned, actorMembershipId: actor.membershipId, kind: "mention", title: `Sei stato menzionato in ${label}`, body: text.slice(0, 200), url, dedupeKey: `mention:${cid}` });
    if (task) {
      const t = one<{ a: number | null; r: number | null }>(conn, "SELECT assignee_membership_id AS a, reporter_membership_id AS r FROM tasks WHERE id = ?", id)!;
      const others = [t.a, t.r].filter((x): x is number => x !== null && !mentioned.includes(x));
      notify(conn, { orgId: actor.orgId, recipientIds: others, actorMembershipId: actor.membershipId, kind: "comment", title: `Nuovo commento su ${label}`, body: text.slice(0, 200), url, dedupeKey: `comment:${cid}` });
    }
    return cid;
  });
}

export function deleteComment(conn: Conn, actor: Actor, commentId: number): void {
  const c = one<{ entity_type: "task" | "project"; entity_id: number; author_membership_id: number }>(conn, "SELECT entity_type, entity_id, author_membership_id FROM comments WHERE id = ? AND org_id = ? AND deleted_at IS NULL", commentId, actor.orgId);
  if (!c) throw new NotFoundError("Commento");
  const access = c.entity_type === "task" ? requireTask(conn, actor, c.entity_id, "read").access : requireProject(conn, actor, c.entity_id, "read").access;
  if (c.author_membership_id !== actor.membershipId && !access.manage) throw new ValidationError("Puoi eliminare solo i tuoi commenti.");
  run(conn, "UPDATE comments SET deleted_at = ? WHERE id = ?", nowISO(), commentId);
}

