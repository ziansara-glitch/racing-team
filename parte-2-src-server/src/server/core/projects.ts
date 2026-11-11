import { ForbiddenError, type Actor } from "../authz/authorize.ts";
import { writeAudit } from "../audit.ts";
import { logActivity, projectActivity, type ActivityDTO } from "./activity.ts";
import { requireProject, visibleProjects, type Access, type ProjectRow } from "./access.ts";
import { ValidationError } from "./errors.ts";
import { notify } from "./notifications.ts";
import { indexEntity } from "./search.ts";
import { addDays, all, insert, isISODate, nowISO, one, run, todayISO, type Conn, type Param } from "./sql.ts";
import { addDependency, createTask } from "./tasks.ts";
import { BUILTIN_TEMPLATES, statusColor, type TemplateDef } from "./templates.ts";
import { transaction } from "./tx.ts";
import {
  CATEGORY_COLOR,
  FIELD_TYPES,
  PRIORITIES,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  STATUS_CATEGORIES,
  VISIBILITIES,
  type FieldType,
  type Priority,
  type ProjectRole,
  type ProjectStatus,
  type StatusCategory,
  type Visibility,
} from "./types.ts";

const KEY_RE = /^[A-Z][A-Z0-9]{1,7}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const likePattern = (s: string) => `%${s.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

function assertOrgMember(conn: Conn, orgId: number, membershipId: number, what = "La persona"): void {
  if (!one(conn, "SELECT 1 FROM memberships WHERE id = ? AND org_id = ? AND status = 'active'", membershipId, orgId)) {
    throw new ValidationError(`${what} selezionata non è un membro attivo dell'organizzazione.`);
  }
}

function assertDate(v: string | null | undefined, field: string): void {
  if (v != null && v !== "" && !isISODate(v)) throw new ValidationError("Data non valida (usa AAAA-MM-GG).", field);
}

// ───────────────────────── Lettura ─────────────────────────

export type ProjectSummary = {
  id: number;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  visibility: Visibility;
  priority: Priority;
  color: string;
  ownerName: string | null;
  teamName: string | null;
  startDate: string | null;
  dueDate: string | null;
  total: number;
  done: number;
  overdue: number;
  members: number;
  updatedAt: string;
};

export type ProjectFilter = { q?: string; status?: string; teamId?: number; mine?: boolean; archived?: boolean };

export function listProjects(conn: Conn, actor: Actor, f: ProjectFilter = {}, today = todayISO()): ProjectSummary[] {
  const vis = visibleProjects(actor, "p");
  const where = [vis.sql];
  const params: Param[] = [today, ...vis.params];
  if (!f.archived && f.status !== "archived") where.push("p.status <> 'archived'");
  if (f.status && (PROJECT_STATUSES as readonly string[]).includes(f.status)) {
    where.push("p.status = ?");
    params.push(f.status);
  }
  if (f.teamId) {
    where.push("p.team_id = ?");
    params.push(f.teamId);
  }
  if (f.mine) {
    where.push("(p.owner_membership_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.membership_id = ?))");
    params.push(actor.membershipId, actor.membershipId);
  }
  if (f.q?.trim()) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.key LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
    params.push(likePattern(f.q), likePattern(f.q), likePattern(f.q));
  }
  const count = (extra: string) =>
    `(SELECT COUNT(*) FROM tasks k JOIN project_statuses s ON s.id = k.status_id WHERE k.project_id = p.id AND k.deleted_at IS NULL AND s.category <> 'archived' ${extra})`;
  return all<{
    id: number; key: string; name: string; description: string; status: ProjectStatus; visibility: Visibility; priority: Priority; color: string;
    owner_name: string | null; team_name: string | null; start_date: string | null; due_date: string | null; total: number; done: number; overdue: number; members: number; updated_at: string;
  }>(
    conn,
    `SELECT p.id, p.key, p.name, p.description, p.status, p.visibility, p.priority, p.color, ou.name AS owner_name, t.name AS team_name,
            p.start_date, p.due_date, p.updated_at,
            ${count("")} AS total,
            ${count("AND s.category = 'done'")} AS done,
            ${count("AND s.category <> 'done' AND k.due_date IS NOT NULL AND k.due_date < ?")} AS overdue,
            (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members
       FROM projects p
       LEFT JOIN memberships om ON om.id = p.owner_membership_id
       LEFT JOIN users ou ON ou.id = om.user_id
       LEFT JOIN teams t ON t.id = p.team_id
      WHERE ${where.join(" AND ")}
      ORDER BY (p.status = 'archived'), p.name`,
    ...params,
  ).map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, status: r.status, visibility: r.visibility, priority: r.priority, color: r.color,
    ownerName: r.owner_name, teamName: r.team_name, startDate: r.start_date, dueDate: r.due_date, total: r.total, done: r.done, overdue: r.overdue,
    members: r.members, updatedAt: r.updated_at,
  }));
}

export type StatusDTO = { id: number; name: string; category: StatusCategory; color: string; position: number; taskCount: number };
export type FieldDTO = { id: number; name: string; type: FieldType; options: string[]; required: boolean; position: number };
export type MilestoneDTO = { id: number; name: string; description: string; dueDate: string | null; completedAt: string | null; position: number; total: number; done: number };
export type MemberDTO = { membershipId: number; name: string; title: string; role: ProjectRole; isOwner: boolean };

export type ProjectDetail = {
  project: ProjectRow & { ownerName: string | null; teamName: string | null };
  access: Access;
  statuses: StatusDTO[];
  fields: FieldDTO[];
  milestones: MilestoneDTO[];
  members: MemberDTO[];
  transitions: { from: number; to: number }[];
};

export function getStatuses(conn: Conn, projectId: number): StatusDTO[] {
  return all<{ id: number; name: string; category: StatusCategory; color: string; position: number; n: number }>(
    conn,
    `SELECT s.id, s.name, s.category, s.color, s.position,
            (SELECT COUNT(*) FROM tasks t WHERE t.status_id = s.id AND t.deleted_at IS NULL) AS n
       FROM project_statuses s WHERE s.project_id = ? ORDER BY s.position, s.id`,
    projectId,
  ).map((r) => ({ id: r.id, name: r.name, category: r.category, color: r.color, position: r.position, taskCount: r.n }));
}

export function getFields(conn: Conn, projectId: number): FieldDTO[] {
  return all<{ id: number; name: string; type: FieldType; options: string; required: number; position: number }>(
    conn,
    "SELECT id, name, type, options, required, position FROM custom_fields WHERE project_id = ? ORDER BY position, id",
    projectId,
  ).map((r) => ({ id: r.id, name: r.name, type: r.type, options: JSON.parse(r.options) as string[], required: r.required === 1, position: r.position }));
}

export function getMilestones(conn: Conn, projectId: number): MilestoneDTO[] {
  return all<{ id: number; name: string; description: string; due_date: string | null; completed_at: string | null; position: number; total: number; done: number }>(
    conn,
    `SELECT m.id, m.name, m.description, m.due_date, m.completed_at, m.position,
            (SELECT COUNT(*) FROM tasks t JOIN project_statuses s ON s.id = t.status_id WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND s.category <> 'archived') AS total,
            (SELECT COUNT(*) FROM tasks t JOIN project_statuses s ON s.id = t.status_id WHERE t.milestone_id = m.id AND t.deleted_at IS NULL AND s.category = 'done') AS done
       FROM milestones m WHERE m.project_id = ? ORDER BY m.due_date IS NULL, m.due_date, m.position, m.id`,
    projectId,
  ).map((r) => ({ id: r.id, name: r.name, description: r.description, dueDate: r.due_date, completedAt: r.completed_at, position: r.position, total: r.total, done: r.done }));
}

export function getMembers(conn: Conn, project: ProjectRow): MemberDTO[] {
  return all<{ membership_id: number; name: string; title: string; role: ProjectRole }>(
    conn,
    `SELECT pm.membership_id, u.name, m.title, pm.role FROM project_members pm
       JOIN memberships m ON m.id = pm.membership_id JOIN users u ON u.id = m.user_id
      WHERE pm.project_id = ? ORDER BY pm.role, u.name`,
    project.id,
  ).map((r) => ({ membershipId: r.membership_id, name: r.name, title: r.title, role: r.role, isOwner: r.membership_id === project.owner_membership_id }));
}

/** Dettaglio completo per le pagine del progetto, oppure null se non esiste o non è visibile. */
export function getProjectDetail(conn: Conn, actor: Actor, key: string): ProjectDetail | null {
  let found;
  try {
    found = requireProject(conn, actor, key, "read");
  } catch {
    return null;
  }
  const { project, access } = found;
  const names = one<{ owner_name: string | null; team_name: string | null }>(
    conn,
    `SELECT (SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.id = ?) AS owner_name,
            (SELECT t.name FROM teams t WHERE t.id = ?) AS team_name`,
    project.owner_membership_id,
    project.team_id,
  );
  return {
    project: { ...project, ownerName: names?.owner_name ?? null, teamName: names?.team_name ?? null },
    access,
    statuses: getStatuses(conn, project.id),
    fields: getFields(conn, project.id),
    milestones: getMilestones(conn, project.id),
    members: getMembers(conn, project),
    transitions: all<{ f: number; t: number }>(conn, "SELECT from_status_id AS f, to_status_id AS t FROM workflow_transitions WHERE project_id = ?", project.id).map((r) => ({ from: r.f, to: r.t })),
  };
}

// ───────────────────────── Creazione ─────────────────────────

export type CreateProjectInput = {
  key: string;
  name: string;
  description?: string;
  templateKey?: string;
  customTemplateId?: number;
  visibility?: Visibility;
  priority?: Priority;
  color?: string;
  teamId?: number | null;
  ownerMembershipId?: number;
  startDate?: string | null;
  dueDate?: string | null;
};

export function listTemplates(conn: Conn, actor: Actor): { key: string; name: string; description: string; custom: boolean; customId?: number }[] {
  const builtin = Object.entries(BUILTIN_TEMPLATES).map(([key, t]) => ({ key, name: t.name, description: t.description, custom: false }));
  const custom = all<{ id: number; name: string; description: string }>(conn, "SELECT id, name, description FROM project_templates WHERE org_id = ? ORDER BY name", actor.orgId).map((t) => ({
    key: `custom:${t.id}`, name: t.name, description: t.description, custom: true, customId: t.id,
  }));
  return [...builtin, ...custom];
}

function loadTemplate(conn: Conn, actor: Actor, input: CreateProjectInput): { def: TemplateDef; key: string } {
  if (input.customTemplateId) {
    const row = one<{ definition: string }>(conn, "SELECT definition FROM project_templates WHERE id = ? AND org_id = ?", input.customTemplateId, actor.orgId);
    if (!row) throw new ValidationError("Template non trovato.", "templateKey");
    return { def: JSON.parse(row.definition) as TemplateDef, key: `custom:${input.customTemplateId}` };
  }
  const key = input.templateKey || "standard";
  const t = BUILTIN_TEMPLATES[key];
  if (!t) throw new ValidationError("Template non trovato.", "templateKey");
  return { def: t.def, key };
}

export function createProject(conn: Conn, actor: Actor, input: CreateProjectInput): ProjectRow {
  const scope = actor.permissions["projects.create"];
  if (!scope) throw new ForbiddenError("projects.create");
  const teamId = input.teamId ?? null;
  if (scope === "scoped" && (teamId === null || !actor.teamIds.includes(teamId))) throw new ForbiddenError("projects.create");

  const key = input.key.trim().toUpperCase();
  const name = input.name.trim();
  if (!KEY_RE.test(key)) throw new ValidationError("La chiave deve avere 2–8 caratteri: lettere maiuscole e cifre, iniziando con una lettera.", "key");
  if (name.length < 2 || name.length > 80) throw new ValidationError("Il nome deve avere tra 2 e 80 caratteri.", "name");
  if (one(conn, "SELECT 1 FROM projects WHERE org_id = ? AND key = ?", actor.orgId, key)) throw new ValidationError("Esiste già un progetto con questa chiave.", "key");
  const visibility = input.visibility ?? "org";
  const priority = input.priority ?? "medium";
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) throw new ValidationError("Visibilità non valida.", "visibility");
  if (!(PRIORITIES as readonly string[]).includes(priority)) throw new ValidationError("Priorità non valida.", "priority");
  if (visibility === "team" && teamId === null) throw new ValidationError("La visibilità «Team» richiede di scegliere un team.", "teamId");
  const color = input.color && COLOR_RE.test(input.color) ? input.color : "#6366f1";
  const startDate = input.startDate || null;
  const dueDate = input.dueDate || null;
  assertDate(startDate, "startDate");
  assertDate(dueDate, "dueDate");
  if (startDate && dueDate && startDate > dueDate) throw new ValidationError("La data di fine precede quella di inizio.", "dueDate");
  if (teamId !== null && !one(conn, "SELECT 1 FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL", teamId, actor.orgId)) throw new ValidationError("Team non valido.", "teamId");
  const ownerId = input.ownerMembershipId ?? actor.membershipId;
  assertOrgMember(conn, actor.orgId, ownerId, "Il responsabile");
  const { def, key: templateKey } = loadTemplate(conn, actor, input);

  return transaction(conn, () => {
    const id = insert(
      conn,
      `INSERT INTO projects (org_id, key, name, description, visibility, priority, color, owner_membership_id, team_id, start_date, due_date, template_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      actor.orgId, key, name, (input.description ?? "").trim(), visibility, priority, color, ownerId, teamId, startDate, dueDate, templateKey,
    );
    def.statuses.forEach((s, i) => insert(conn, "INSERT INTO project_statuses (org_id, project_id, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)", actor.orgId, id, s.name, s.category, statusColor(s), i));
    def.fields.forEach((f, i) => insert(conn, "INSERT INTO custom_fields (org_id, project_id, name, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?, ?)", actor.orgId, id, f.name, f.type, JSON.stringify(f.options ?? []), f.required ? 1 : 0, i));
    const base = startDate ?? todayISO();
    const milestoneIds = def.milestones.map((m, i) => insert(conn, "INSERT INTO milestones (org_id, project_id, name, due_date, position) VALUES (?, ?, ?, ?, ?)", actor.orgId, id, m.name, addDays(base, m.offsetDays), i));
    insert(conn, "INSERT INTO project_members (project_id, membership_id, org_id, role) VALUES (?, ?, ?, 'manager')", id, ownerId, actor.orgId);
    if (ownerId !== actor.membershipId && actor.permissions["projects.manage"] !== "all") {
      insert(conn, "INSERT INTO project_members (project_id, membership_id, org_id, role) VALUES (?, ?, ?, 'manager')", id, actor.membershipId, actor.orgId);
    }

    const created = one<ProjectRow>(conn, "SELECT * FROM projects WHERE id = ?", id)!;
    indexEntity(conn, { orgId: actor.orgId, projectId: id, type: "project", id, title: name, body: created.description });

    const statusIdByName = new Map(all<{ id: number; name: string }>(conn, "SELECT id, name FROM project_statuses WHERE project_id = ?", id).map((s) => [s.name, s.id]));
    const taskIds: number[] = [];
    for (const t of def.tasks) {
      const startOffset = t.offsetDays != null ? addDays(base, t.offsetDays) : null;
      const task = createTask(conn, actor, id, {
        title: t.title,
        statusId: t.status ? statusIdByName.get(t.status) : undefined,
        priority: t.priority,
        milestoneId: t.milestone != null ? milestoneIds[t.milestone] : null,
        startDate: startOffset,
        dueDate: startOffset && t.durationDays ? addDays(startOffset, t.durationDays) : null,
      });
      taskIds.push(task.id);
      for (const sub of t.subtasks ?? []) createTask(conn, actor, id, { title: sub, parentTaskId: task.id, statusId: statusIdByName.get(t.status ?? "") });
    }
    def.tasks.forEach((t, i) => (t.dependsOn ?? []).forEach((d) => addDependency(conn, actor, taskIds[i], taskIds[d])));

    logActivity(conn, { orgId: actor.orgId, projectId: id, entityType: "project", entityId: id, actorMembershipId: actor.membershipId, verb: "project.created", meta: { template: templateKey } });
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "project.create", entityType: "project", entityId: id, meta: { key, template: templateKey, visibility } });
    return created;
  });
}

// ───────────────────────── Modifica ─────────────────────────

export type UpdateProjectInput = Partial<{
  name: string; description: string; status: ProjectStatus; visibility: Visibility; priority: Priority; color: string;
  teamId: number | null; ownerMembershipId: number; startDate: string | null; dueDate: string | null;
}>;

export function updateProject(conn: Conn, actor: Actor, projectId: number, patch: UpdateProjectInput): void {
  const { project } = requireProject(conn, actor, projectId, "manage");
  const sets: string[] = [];
  const params: Param[] = [];
  const changed: Record<string, unknown> = {};
  const set = (col: string, field: string, value: Param, before: unknown) => {
    if (value === before) return;
    sets.push(`${col} = ?`);
    params.push(value);
    changed[field] = { from: before, to: value };
  };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (n.length < 2 || n.length > 80) throw new ValidationError("Il nome deve avere tra 2 e 80 caratteri.", "name");
    set("name", "name", n, project.name);
  }
  if (patch.description !== undefined) set("description", "description", patch.description.trim(), project.description);
  if (patch.status !== undefined) {
    if (!(PROJECT_STATUSES as readonly string[]).includes(patch.status)) throw new ValidationError("Stato non valido.", "status");
    set("status", "status", patch.status, project.status);
  }
  if (patch.visibility !== undefined) {
    if (!(VISIBILITIES as readonly string[]).includes(patch.visibility)) throw new ValidationError("Visibilità non valida.", "visibility");
    set("visibility", "visibility", patch.visibility, project.visibility);
  }
  if (patch.priority !== undefined) {
    if (!(PRIORITIES as readonly string[]).includes(patch.priority)) throw new ValidationError("Priorità non valida.", "priority");
    set("priority", "priority", patch.priority, project.priority);
  }
  if (patch.color !== undefined && COLOR_RE.test(patch.color)) set("color", "color", patch.color, project.color);
  if (patch.teamId !== undefined) {
    if (patch.teamId !== null && !one(conn, "SELECT 1 FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL", patch.teamId, actor.orgId)) throw new ValidationError("Team non valido.", "teamId");
    set("team_id", "teamId", patch.teamId, project.team_id);
  }
  if (patch.ownerMembershipId !== undefined) {
    assertOrgMember(conn, actor.orgId, patch.ownerMembershipId, "Il responsabile");
    set("owner_membership_id", "owner", patch.ownerMembershipId, project.owner_membership_id);
  }
  if (patch.startDate !== undefined) { assertDate(patch.startDate, "startDate"); set("start_date", "startDate", patch.startDate || null, project.start_date); }
  if (patch.dueDate !== undefined) { assertDate(patch.dueDate, "dueDate"); set("due_date", "dueDate", patch.dueDate || null, project.due_date); }
  const start = patch.startDate !== undefined ? patch.startDate || null : project.start_date;
  const due = patch.dueDate !== undefined ? patch.dueDate || null : project.due_date;
  if (start && due && start > due) throw new ValidationError("La data di fine precede quella di inizio.", "dueDate");
  const finalVisibility = patch.visibility ?? project.visibility;
  const finalTeam = patch.teamId !== undefined ? patch.teamId : project.team_id;
  if (finalVisibility === "team" && finalTeam === null) throw new ValidationError("La visibilità «Team» richiede di scegliere un team.", "teamId");
  if (sets.length === 0) return;

  transaction(conn, () => {
    run(conn, `UPDATE projects SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND org_id = ?`, ...params, nowISO(), projectId, actor.orgId);
    if (patch.ownerMembershipId !== undefined) {
      run(conn, `INSERT INTO project_members (project_id, membership_id, org_id, role) VALUES (?, ?, ?, 'manager')
                 ON CONFLICT (project_id, membership_id) DO UPDATE SET role = 'manager'`, projectId, patch.ownerMembershipId, actor.orgId);
    }
    const after = one<ProjectRow>(conn, "SELECT * FROM projects WHERE id = ?", projectId)!;
    indexEntity(conn, { orgId: actor.orgId, projectId, type: "project", id: projectId, title: after.name, body: after.description });
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "project.updated", meta: changed });
    if (changed.visibility || changed.owner || changed.status) {
      writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "project.update", entityType: "project", entityId: projectId, meta: changed });
    }
  });
}

export function deleteProject(conn: Conn, actor: Actor, projectId: number): void {
  const { project } = requireProject(conn, actor, projectId, "manage");
  transaction(conn, () => {
    run(conn, "UPDATE projects SET deleted_at = ?, key = key || '~' || id WHERE id = ?", nowISO(), projectId);
    run(conn, "DELETE FROM search_index WHERE project_id = ?", projectId);
    writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "project.delete", entityType: "project", entityId: projectId, meta: { key: project.key, name: project.name } });
  });
}

// ───────────────────────── Membri ─────────────────────────

export function setProjectMember(conn: Conn, actor: Actor, projectId: number, membershipId: number, role: ProjectRole): void {
  const { project } = requireProject(conn, actor, projectId, "manage");
  if (!(PROJECT_ROLES as readonly string[]).includes(role)) throw new ValidationError("Ruolo non valido.", "role");
  assertOrgMember(conn, actor.orgId, membershipId);
  if (membershipId === project.owner_membership_id && role !== "manager") throw new ValidationError("Il responsabile del progetto resta sempre «Responsabile».", "role");
  transaction(conn, () => {
    const existed = !!one(conn, "SELECT 1 FROM project_members WHERE project_id = ? AND membership_id = ?", projectId, membershipId);
    run(conn, `INSERT INTO project_members (project_id, membership_id, org_id, role) VALUES (?, ?, ?, ?)
               ON CONFLICT (project_id, membership_id) DO UPDATE SET role = excluded.role`, projectId, membershipId, actor.orgId, role);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: existed ? "member.role_changed" : "member.added", meta: { membershipId, role } });
    if (!existed) {
      notify(conn, { orgId: actor.orgId, recipientIds: [membershipId], actorMembershipId: actor.membershipId, kind: "project_member", title: `Sei stato aggiunto al progetto ${project.name}`, url: `/projects/${project.key}` });
    }
  });
}

export function removeProjectMember(conn: Conn, actor: Actor, projectId: number, membershipId: number): void {
  const { project } = requireProject(conn, actor, projectId, "manage");
  if (membershipId === project.owner_membership_id) throw new ValidationError("Il responsabile del progetto non può essere rimosso: cambia prima il responsabile.");
  transaction(conn, () => {
    run(conn, "DELETE FROM project_members WHERE project_id = ? AND membership_id = ?", projectId, membershipId);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "member.removed", meta: { membershipId } });
  });
}

// ───────────────────────── Stati e workflow ─────────────────────────

/** Ogni progetto deve poter avviare e concludere il lavoro: almeno uno stato "aperto" e uno "completato". */
function assertStatusInvariants(conn: Conn, projectId: number): void {
  const counts = one<{ open: number; done: number }>(
    conn,
    `SELECT SUM(category IN ('backlog','todo','in_progress','review')) AS open, SUM(category = 'done') AS done FROM project_statuses WHERE project_id = ?`,
    projectId,
  );
  if (!counts || !counts.open) throw new ValidationError("Serve almeno uno stato «aperto» (Backlog, Da fare, In corso o In revisione).");
  if (!counts.done) throw new ValidationError("Serve almeno uno stato di categoria «Completato».");
}

export type StatusInput = { name: string; category: StatusCategory; color?: string };

function validateStatus(input: StatusInput): { name: string; color: string } {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 30) throw new ValidationError("Il nome dello stato deve avere tra 1 e 30 caratteri.", "name");
  if (!(STATUS_CATEGORIES as readonly string[]).includes(input.category)) throw new ValidationError("Categoria non valida.", "category");
  return { name, color: input.color && COLOR_RE.test(input.color) ? input.color : CATEGORY_COLOR[input.category] };
}

export function createStatus(conn: Conn, actor: Actor, projectId: number, input: StatusInput): number {
  requireProject(conn, actor, projectId, "manage");
  const v = validateStatus(input);
  if (one(conn, "SELECT 1 FROM project_statuses WHERE project_id = ? AND name = ?", projectId, v.name)) throw new ValidationError("Esiste già uno stato con questo nome.", "name");
  return transaction(conn, () => {
    const pos = (one<{ m: number | null }>(conn, "SELECT MAX(position) AS m FROM project_statuses WHERE project_id = ?", projectId)?.m ?? -1) + 1;
    const id = insert(conn, "INSERT INTO project_statuses (org_id, project_id, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)", actor.orgId, projectId, v.name, input.category, v.color, pos);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "status.created", meta: { name: v.name } });
    return id;
  });
}

export function updateStatus(conn: Conn, actor: Actor, projectId: number, statusId: number, input: StatusInput): void {
  requireProject(conn, actor, projectId, "manage");
  const v = validateStatus(input);
  if (!one(conn, "SELECT 1 FROM project_statuses WHERE id = ? AND project_id = ?", statusId, projectId)) throw new ValidationError("Stato non trovato.");
  if (one(conn, "SELECT 1 FROM project_statuses WHERE project_id = ? AND name = ? AND id <> ?", projectId, v.name, statusId)) throw new ValidationError("Esiste già uno stato con questo nome.", "name");
  transaction(conn, () => {
    const before = one<{ category: StatusCategory }>(conn, "SELECT category FROM project_statuses WHERE id = ?", statusId)!;
    run(conn, "UPDATE project_statuses SET name = ?, category = ?, color = ? WHERE id = ? AND project_id = ?", v.name, input.category, v.color, statusId, projectId);
    assertStatusInvariants(conn, projectId);
    // Se la categoria cambia da/verso "completato", i task coinvolti aggiornano la data di completamento.
    if (before.category !== input.category) {
      if (input.category === "done") run(conn, "UPDATE tasks SET completed_at = COALESCE(completed_at, ?) WHERE status_id = ?", nowISO(), statusId);
      else if (before.category === "done") run(conn, "UPDATE tasks SET completed_at = NULL WHERE status_id = ?", statusId);
    }
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "status.updated", meta: { name: v.name } });
  });
}

export function reorderStatuses(conn: Conn, actor: Actor, projectId: number, orderedIds: number[]): void {
  requireProject(conn, actor, projectId, "manage");
  const existing = all<{ id: number }>(conn, "SELECT id FROM project_statuses WHERE project_id = ?", projectId).map((r) => r.id);
  if (orderedIds.length !== existing.length || !orderedIds.every((i) => existing.includes(i))) throw new ValidationError("L'elenco degli stati non corrisponde a quelli del progetto.");
  transaction(conn, () => orderedIds.forEach((id, i) => run(conn, "UPDATE project_statuses SET position = ? WHERE id = ? AND project_id = ?", i, id, projectId)));
}

/** Elimina uno stato spostando i suoi task in `replacementId`. */
export function deleteStatus(conn: Conn, actor: Actor, projectId: number, statusId: number, replacementId: number | null): void {
  requireProject(conn, actor, projectId, "manage");
  const target = one<{ id: number }>(conn, "SELECT id FROM project_statuses WHERE id = ? AND project_id = ?", statusId, projectId);
  if (!target) throw new ValidationError("Stato non trovato.");
  const n = one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM tasks WHERE status_id = ?", statusId)!.n;
  if (n > 0) {
    if (!replacementId || replacementId === statusId || !one(conn, "SELECT 1 FROM project_statuses WHERE id = ? AND project_id = ?", replacementId, projectId)) {
      throw new ValidationError(`Lo stato contiene ${n} task: scegli uno stato in cui spostarli.`, "replacement");
    }
  }
  transaction(conn, () => {
    if (n > 0 && replacementId) {
      const cat = one<{ category: StatusCategory }>(conn, "SELECT category FROM project_statuses WHERE id = ?", replacementId)!.category;
      run(conn, "UPDATE tasks SET status_id = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END WHERE status_id = ?", replacementId, cat, nowISO(), statusId);
    }
    run(conn, "DELETE FROM project_statuses WHERE id = ? AND project_id = ?", statusId, projectId);
    assertStatusInvariants(conn, projectId);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "status.deleted", meta: { moved: n } });
  });
}

/** Con `restricted` attivo sono ammesse solo le transizioni elencate; altrimenti ogni stato può passare a ogni altro. */
export function setWorkflow(conn: Conn, actor: Actor, projectId: number, restricted: boolean, transitions: { from: number; to: number }[]): void {
  requireProject(conn, actor, projectId, "manage");
  const ids = new Set(all<{ id: number }>(conn, "SELECT id FROM project_statuses WHERE project_id = ?", projectId).map((r) => r.id));
  for (const t of transitions) if (!ids.has(t.from) || !ids.has(t.to) || t.from === t.to) throw new ValidationError("Transizione non valida.");
  transaction(conn, () => {
    run(conn, "DELETE FROM workflow_transitions WHERE project_id = ?", projectId);
    for (const t of transitions) run(conn, "INSERT OR IGNORE INTO workflow_transitions (project_id, from_status_id, to_status_id) VALUES (?, ?, ?)", projectId, t.from, t.to);
    run(conn, "UPDATE projects SET workflow_restricted = ?, updated_at = ? WHERE id = ?", restricted ? 1 : 0, nowISO(), projectId);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "workflow.updated", meta: { restricted, transitions: transitions.length } });
  });
}

// ───────────────────────── Campi personalizzati ─────────────────────────

export type FieldInput = { name: string; type: FieldType; options?: string[]; required?: boolean };

function cleanOptions(type: FieldType, options: string[] | undefined): string[] {
  if (type !== "select") return [];
  const list = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (list.length === 0) throw new ValidationError("Una scelta singola richiede almeno un'opzione.", "options");
  if (list.length > 30 || list.some((o) => o.length > 40)) throw new ValidationError("Massimo 30 opzioni di al più 40 caratteri.", "options");
  return list;
}

export function createField(conn: Conn, actor: Actor, projectId: number, input: FieldInput): number {
  requireProject(conn, actor, projectId, "manage");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw new ValidationError("Il nome del campo deve avere tra 1 e 40 caratteri.", "name");
  if (!(FIELD_TYPES as readonly string[]).includes(input.type)) throw new ValidationError("Tipo di campo non valido.", "type");
  if (one(conn, "SELECT 1 FROM custom_fields WHERE project_id = ? AND name = ?", projectId, name)) throw new ValidationError("Esiste già un campo con questo nome.", "name");
  const options = cleanOptions(input.type, input.options);
  return transaction(conn, () => {
    const pos = (one<{ m: number | null }>(conn, "SELECT MAX(position) AS m FROM custom_fields WHERE project_id = ?", projectId)?.m ?? -1) + 1;
    const id = insert(conn, "INSERT INTO custom_fields (org_id, project_id, name, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?, ?)", actor.orgId, projectId, name, input.type, JSON.stringify(options), input.required ? 1 : 0, pos);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "field.created", meta: { name, type: input.type } });
    return id;
  });
}

/** Il tipo non si cambia (i valori già inseriti perderebbero significato): si elimina e si ricrea. */
export function updateField(conn: Conn, actor: Actor, projectId: number, fieldId: number, input: { name: string; options?: string[]; required?: boolean }): void {
  requireProject(conn, actor, projectId, "manage");
  const f = one<{ type: FieldType }>(conn, "SELECT type FROM custom_fields WHERE id = ? AND project_id = ?", fieldId, projectId);
  if (!f) throw new ValidationError("Campo non trovato.");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw new ValidationError("Il nome del campo deve avere tra 1 e 40 caratteri.", "name");
  if (one(conn, "SELECT 1 FROM custom_fields WHERE project_id = ? AND name = ? AND id <> ?", projectId, name, fieldId)) throw new ValidationError("Esiste già un campo con questo nome.", "name");
  const options = cleanOptions(f.type, input.options);
  run(conn, "UPDATE custom_fields SET name = ?, options = ?, required = ? WHERE id = ? AND project_id = ?", name, JSON.stringify(options), input.required ? 1 : 0, fieldId, projectId);
}

export function deleteField(conn: Conn, actor: Actor, projectId: number, fieldId: number): void {
  requireProject(conn, actor, projectId, "manage");
  transaction(conn, () => {
    run(conn, "DELETE FROM custom_fields WHERE id = ? AND project_id = ?", fieldId, projectId);
    logActivity(conn, { orgId: actor.orgId, projectId, entityType: "project", entityId: projectId, actorMembershipId: actor.membershipId, verb: "field.deleted", meta: { fieldId } });
  });
}

// ───────────────────────── Milestone ─────────────────────────

export type MilestoneInput = { name: string; description?: string; dueDate?: string | null };

export function createMilestone(conn: Conn, actor: Actor, projectId: number, input: MilestoneInput): number {
  requireProject(conn, actor, projectId, "manage");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new ValidationError("Il nome della milestone deve avere tra 1 e 60 caratteri.", "name");
  assertDate(input.dueDate, "dueDate");
  const pos = (one<{ m: number | null }>(conn, "SELECT MAX(position) AS m FROM milestones WHERE project_id = ?", projectId)?.m ?? -1) + 1;
  return insert(conn, "INSERT INTO milestones (org_id, project_id, name, description, due_date, position) VALUES (?, ?, ?, ?, ?, ?)", actor.orgId, projectId, name, (input.description ?? "").trim(), input.dueDate || null, pos);
}

export function updateMilestone(conn: Conn, actor: Actor, projectId: number, milestoneId: number, input: MilestoneInput & { completed?: boolean }): void {
  requireProject(conn, actor, projectId, "manage");
  const m = one<{ completed_at: string | null }>(conn, "SELECT completed_at FROM milestones WHERE id = ? AND project_id = ?", milestoneId, projectId);
  if (!m) throw new ValidationError("Milestone non trovata.");
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new ValidationError("Il nome della milestone deve avere tra 1 e 60 caratteri.", "name");
  assertDate(input.dueDate, "dueDate");
  const completedAt = input.completed === undefined ? m.completed_at : input.completed ? m.completed_at ?? nowISO() : null;
  run(conn, "UPDATE milestones SET name = ?, description = ?, due_date = ?, completed_at = ? WHERE id = ? AND project_id = ?", name, (input.description ?? "").trim(), input.dueDate || null, completedAt, milestoneId, projectId);
}

export function deleteMilestone(conn: Conn, actor: Actor, projectId: number, milestoneId: number): void {
  requireProject(conn, actor, projectId, "manage");
  transaction(conn, () => {
    run(conn, "UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ? AND project_id = ?", milestoneId, projectId);
    run(conn, "DELETE FROM milestones WHERE id = ? AND project_id = ?", milestoneId, projectId);
  });
}

// ───────────────────────── Template personalizzati ─────────────────────────

export function saveAsTemplate(conn: Conn, actor: Actor, projectId: number, name: string, description = ""): number {
  const { project } = requireProject(conn, actor, projectId, "manage");
  const n = name.trim();
  if (n.length < 2 || n.length > 60) throw new ValidationError("Il nome del template deve avere tra 2 e 60 caratteri.", "name");
  if (one(conn, "SELECT 1 FROM project_templates WHERE org_id = ? AND name = ?", actor.orgId, n)) throw new ValidationError("Esiste già un template con questo nome.", "name");
  const statuses = getStatuses(conn, projectId);
  const milestones = getMilestones(conn, projectId);
  const base = project.start_date ?? todayISO();
  const diff = (d: string | null) => (d ? Math.round((Date.parse(d) - Date.parse(base)) / 86_400_000) : null);
  const rows = all<{ id: number; title: string; status: string; priority: Priority; milestone_id: number | null; start_date: string | null; due_date: string | null }>(
    conn,
    `SELECT t.id, t.title, s.name AS status, t.priority, t.milestone_id, t.start_date, t.due_date FROM tasks t JOIN project_statuses s ON s.id = t.status_id
      WHERE t.project_id = ? AND t.parent_task_id IS NULL AND t.deleted_at IS NULL ORDER BY t.number`,
    projectId,
  );
  const def: TemplateDef = {
    statuses: statuses.map((s) => ({ name: s.name, category: s.category, color: s.color })),
    fields: getFields(conn, projectId).map((f) => ({ name: f.name, type: f.type, options: f.options, required: f.required })),
    milestones: milestones.map((m) => ({ name: m.name, offsetDays: diff(m.dueDate) ?? 0 })),
    tasks: rows.map((t) => {
      const start = diff(t.start_date);
      const end = diff(t.due_date);
      return {
        title: t.title, priority: t.priority, status: undefined,
        milestone: t.milestone_id ? milestones.findIndex((m) => m.id === t.milestone_id) : undefined,
        offsetDays: start ?? undefined, durationDays: start !== null && end !== null ? end - start : undefined,
        subtasks: all<{ title: string }>(conn, "SELECT title FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL ORDER BY number", t.id).map((s) => s.title),
      };
    }).map((t) => ({ ...t, milestone: t.milestone === -1 ? undefined : t.milestone })),
  };
  const id = insert(conn, "INSERT INTO project_templates (org_id, name, description, definition, created_by_membership_id) VALUES (?, ?, ?, ?, ?)", actor.orgId, n, description.trim(), JSON.stringify(def), actor.membershipId);
  writeAudit(conn, { orgId: actor.orgId, actorUserId: actor.userId, action: "project.template.create", entityType: "project", entityId: projectId, meta: { name: n } });
  return id;
}

// ───────────────────────── Panoramica ─────────────────────────

export type Overview = {
  totals: { total: number; done: number; open: number; overdue: number; dueSoon: number; unassigned: number; progress: number; estimateMinutes: number };
  byStatus: { id: number; name: string; color: string; category: StatusCategory; count: number }[];
  workload: { membershipId: number; name: string; open: number; minutes: number }[];
  overdue: { id: number; ref: string; title: string; dueDate: string; assignee: string | null }[];
  upcoming: { id: number; ref: string; title: string; dueDate: string; assignee: string | null }[];
  milestones: MilestoneDTO[];
  activity: ActivityDTO[];
};

export function projectOverview(conn: Conn, actor: Actor, projectId: number, today = todayISO()): Overview {
  const { project } = requireProject(conn, actor, projectId, "read");
  const OPEN = "s.category IN ('backlog','todo','in_progress','review')";
  const totals = one<{ total: number; done: number; open: number; overdue: number; due_soon: number; unassigned: number; minutes: number }>(
    conn,
    `SELECT COUNT(*) AS total, SUM(s.category = 'done') AS done, SUM(${OPEN}) AS open,
            SUM(${OPEN} AND t.due_date IS NOT NULL AND t.due_date < ?) AS overdue,
            SUM(${OPEN} AND t.due_date IS NOT NULL AND t.due_date >= ? AND t.due_date <= ?) AS due_soon,
            SUM(${OPEN} AND t.assignee_membership_id IS NULL) AS unassigned,
            COALESCE(SUM(${OPEN} * COALESCE(t.estimate_minutes, 0)), 0) AS minutes
       FROM tasks t JOIN project_statuses s ON s.id = t.status_id
      WHERE t.project_id = ? AND t.deleted_at IS NULL AND s.category <> 'archived'`,
    today, today, addDays(today, 7), projectId,
  )!;
  const task = (extra: string, ...extraParams: Param[]) =>
    all<{ id: number; number: number; title: string; due_date: string; assignee: string | null }>(
      conn,
      `SELECT t.id, t.number, t.title, t.due_date, u.name AS assignee FROM tasks t
         JOIN project_statuses s ON s.id = t.status_id
         LEFT JOIN memberships m ON m.id = t.assignee_membership_id LEFT JOIN users u ON u.id = m.user_id
        WHERE t.project_id = ? AND t.deleted_at IS NULL AND ${OPEN} AND t.due_date IS NOT NULL AND ${extra} ORDER BY t.due_date LIMIT 8`,
      projectId,
      ...extraParams,
    ).map((r) => ({ id: r.id, ref: `${project.key}-${r.number}`, title: r.title, dueDate: r.due_date, assignee: r.assignee }));
  return {
    totals: {
      total: totals.total, done: totals.done ?? 0, open: totals.open ?? 0, overdue: totals.overdue ?? 0, dueSoon: totals.due_soon ?? 0,
      unassigned: totals.unassigned ?? 0, progress: totals.total ? Math.round(((totals.done ?? 0) / totals.total) * 100) : 0, estimateMinutes: totals.minutes,
    },
    byStatus: getStatuses(conn, projectId).map((s) => ({ id: s.id, name: s.name, color: s.color, category: s.category, count: s.taskCount })),
    workload: all<{ id: number; name: string; open: number; minutes: number }>(
      conn,
      `SELECT m.id, u.name, COUNT(*) AS open, COALESCE(SUM(t.estimate_minutes), 0) AS minutes FROM tasks t
         JOIN project_statuses s ON s.id = t.status_id JOIN memberships m ON m.id = t.assignee_membership_id JOIN users u ON u.id = m.user_id
        WHERE t.project_id = ? AND t.deleted_at IS NULL AND ${OPEN} GROUP BY m.id ORDER BY open DESC, u.name`,
      projectId,
    ).map((r) => ({ membershipId: r.id, name: r.name, open: r.open, minutes: r.minutes })),
    overdue: task("t.due_date < ?", today),
    upcoming: task("t.due_date >= ? AND t.due_date <= ?", today, addDays(today, 14)),
    milestones: getMilestones(conn, projectId),
    activity: projectActivity(conn, actor, projectId, 12),
  };
}
