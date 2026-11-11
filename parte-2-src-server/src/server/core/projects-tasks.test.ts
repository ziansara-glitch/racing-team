import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/authorize";
import { world } from "@/test/world";
import { ValidationError } from "./errors";
import { listNotifications, markRead, setPreference, unreadCount } from "./notifications";
import { createField, createMilestone, createProject, createStatus, deleteMilestone, deleteProject, deleteStatus, getProjectDetail, listProjects, projectOverview, removeProjectMember, saveAsTemplate, setProjectMember, setWorkflow, updateProject, updateStatus } from "./projects";
import { search } from "./search";
import { addComment, addDependency, bulkUpdate, createTask, deleteComment, deleteTask, getTaskDetail, listComments, moveTask, myTasks, queryTasks, updateTask } from "./tasks";
import { parseTaskQuery } from "./taskquery";

let w: ReturnType<typeof world>;
let admin: ReturnType<typeof w.person>;
let pm: typeof admin;
let member: typeof admin;
let member2: typeof admin;
let viewer: typeof admin;

beforeEach(() => {
  w = world();
  admin = w.person("Admin", "org_admin");
  pm = w.person("Paola PM", "project_manager", ["Motore"]);
  member = w.person("Mario Membro", "member", ["Motore"]);
  member2 = w.person("Marta Membro", "member", ["Aerodinamica"]);
  viewer = w.person("Vera Viewer", "viewer");
});

const mkProject = (over: Partial<Parameters<typeof createProject>[2]> = {}) =>
  createProject(w.conn, admin, { key: "PRJ", name: "Progetto Prova", ...over });
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("creazione progetto e template", () => {
  it("dal template 'engineering' crea stati, campi, milestone, task, sottotask e dipendenze", () => {
    const p = mkProject({ templateKey: "engineering", startDate: "2026-03-02" });
    const d = getProjectDetail(w.conn, admin, "PRJ")!;
    expect(d.statuses).toHaveLength(6);
    expect(d.fields.map((f) => f.name)).toEqual(["Sottosistema", "Rischio", "Documento di riferimento"]);
    expect(d.milestones.map((m) => m.name)).toHaveLength(4);
    expect(d.milestones[0].dueDate).toBe("2026-03-16");
    const all = queryTasks(w.conn, admin, { projectId: p.id }, { showSubtasks: true });
    expect(all).toHaveLength(7 + 2 + 2);
    expect(queryTasks(w.conn, admin, { projectId: p.id }).every((t) => t.parentTaskId === null)).toBe(true);
    const deps = w.conn.prepare("SELECT COUNT(*) AS n FROM task_dependencies WHERE project_id = ?").get(p.id) as { n: number };
    expect(deps.n).toBe(7);
    expect(all.find((t) => t.title === "Raccolta requisiti")!.startDate).toBe("2026-03-02");
  });

  it("valida chiave, nome e unicità; scrive audit e attività", () => {
    expect(() => mkProject({ key: "x" })).toThrow(ValidationError);
    expect(() => mkProject({ key: "1AB" })).toThrow(/chiave/);
    mkProject();
    expect(() => mkProject()).toThrow(/già un progetto/);
    expect(() => mkProject({ key: "TMT", name: "x" })).toThrow(/nome/);
    expect((w.conn.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'project.create'").get() as { n: number }).n).toBe(1);
  });

  it("chi non ha projects.create non può creare; il team admin solo per il proprio team", () => {
    expect(() => createProject(w.conn, member, { key: "AAA", name: "Prova" })).toThrow(ForbiddenError);
    const ta = w.person("Tea Team", "team_admin", ["Motore"]);
    expect(() => createProject(w.conn, ta, { key: "AAA", name: "Prova" })).toThrow(ForbiddenError);
    expect(() => createProject(w.conn, ta, { key: "AAA", name: "Prova", teamId: w.teamId("Aerodinamica") })).toThrow(ForbiddenError);
    expect(createProject(w.conn, ta, { key: "AAA", name: "Prova", teamId: w.teamId("Motore"), visibility: "team" }).key).toBe("AAA");
  });

  it("un template personalizzato si salva da un progetto e si riusa", () => {
    const p = mkProject({ templateKey: "engineering", startDate: "2026-03-02" });
    saveAsTemplate(w.conn, admin, p.id, "Il mio template");
    const q = createProject(w.conn, admin, { key: "NEW", name: "Nuovo", customTemplateId: 1, startDate: "2026-09-01" });
    expect(queryTasks(w.conn, admin, { projectId: q.id }, { showSubtasks: true })).toHaveLength(11);
    expect(getProjectDetail(w.conn, admin, "NEW")!.milestones[0].dueDate).toBe("2026-09-15");
  });
});

describe("visibilità e isolamento", () => {
  it("un progetto privato è invisibile a chi non ne fa parte, in lista, dettaglio, task e ricerca", () => {
    const p = mkProject({ visibility: "private", name: "Segreto Aerodinamico" });
    createTask(w.conn, admin, p.id, { title: "Galleria del vento riservata" });
    expect(getProjectDetail(w.conn, member, "PRJ")).toBeNull();
    expect(ids(listProjects(w.conn, member))).not.toContain(p.id);
    expect(queryTasks(w.conn, member, {})).toHaveLength(0);
    expect(search(w.conn, member, "galleria")).toEqual([]);
    expect(search(w.conn, member, "segreto")).toEqual([]);
    expect(() => queryTasks(w.conn, member, { projectId: p.id })).toThrow();
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    expect(getProjectDetail(w.conn, member, "PRJ")).not.toBeNull();
    expect(search(w.conn, member, "galleria")).toHaveLength(1);
  });

  it("visibilità 'team': la vedono solo i membri del team (e del progetto)", () => {
    const p = mkProject({ visibility: "team", teamId: w.teamId("Motore") });
    expect(getProjectDetail(w.conn, member, "PRJ")).not.toBeNull();
    expect(getProjectDetail(w.conn, member2, "PRJ")).toBeNull();
    expect(ids(listProjects(w.conn, member2))).not.toContain(p.id);
  });

  it("un'altra organizzazione non vede nulla, nemmeno col ruolo più alto", () => {
    const p = mkProject({ templateKey: "engineering" });
    const foreign = w.otherOrg("beta");
    expect(getProjectDetail(w.conn, foreign, "PRJ")).toBeNull();
    expect(listProjects(w.conn, foreign)).toEqual([]);
    expect(queryTasks(w.conn, foreign, {})).toEqual([]);
    expect(search(w.conn, foreign, "requisiti")).toEqual([]);
    expect(() => updateProject(w.conn, foreign, p.id, { name: "Hack" })).toThrow();
    expect(() => createTask(w.conn, foreign, p.id, { title: "x" })).toThrow();
  });

  it("senza ruoli di scrittura non si modifica: il viewer legge soltanto", () => {
    const p = mkProject();
    expect(getProjectDetail(w.conn, viewer, "PRJ")).not.toBeNull();
    expect(() => createTask(w.conn, viewer, p.id, { title: "x" })).toThrow(ForbiddenError);
    expect(() => addComment(w.conn, viewer, "project", p.id, "ciao")).toThrow(ForbiddenError);
  });

  it("un membro legge un progetto 'org' ma scrive solo se è membro del progetto", () => {
    const p = mkProject();
    expect(() => createTask(w.conn, member2, p.id, { title: "x" })).toThrow(ForbiddenError);
    setProjectMember(w.conn, admin, p.id, member2.membershipId, "member");
    expect(createTask(w.conn, member2, p.id, { title: "x" }).ref).toBe("PRJ-1");
    setProjectMember(w.conn, admin, p.id, member2.membershipId, "viewer");
    expect(() => createTask(w.conn, member2, p.id, { title: "y" })).toThrow(ForbiddenError);
  });

  it("un progetto archiviato è in sola lettura con un messaggio chiaro", () => {
    const p = mkProject();
    updateProject(w.conn, admin, p.id, { status: "archived" });
    expect(() => createTask(w.conn, admin, p.id, { title: "x" })).toThrow(/archiviato/);
    expect(ids(listProjects(w.conn, admin))).not.toContain(p.id);
    expect(ids(listProjects(w.conn, admin, { archived: true }))).toContain(p.id);
  });

  it("solo chi gestisce il progetto lo modifica; il responsabile (PM) gestisce i propri", () => {
    const own = createProject(w.conn, pm, { key: "PMP", name: "Del PM" });
    const other = mkProject();
    expect(() => updateProject(w.conn, member, own.id, { name: "Hack" })).toThrow();
    updateProject(w.conn, pm, own.id, { name: "Rinominato" });
    expect(() => updateProject(w.conn, pm, other.id, { name: "Hack" })).toThrow(ForbiddenError);
  });

  it("l'eliminazione è logica: sparisce da liste e ricerca e libera la chiave", () => {
    const p = mkProject();
    createTask(w.conn, admin, p.id, { title: "Alfabeto" });
    deleteProject(w.conn, admin, p.id);
    expect(getProjectDetail(w.conn, admin, "PRJ")).toBeNull();
    expect(search(w.conn, admin, "alfabeto")).toEqual([]);
    expect(mkProject().key).toBe("PRJ");
  });
});

describe("stati e workflow", () => {
  it("non si può eliminare l'ultimo stato 'completato' né lasciare il progetto senza stati aperti", () => {
    const p = mkProject();
    const st = getProjectDetail(w.conn, admin, "PRJ")!.statuses;
    const done = st.find((s) => s.category === "done")!;
    expect(() => deleteStatus(w.conn, admin, p.id, done.id, null)).toThrow(/Completato/);
    expect(() => updateStatus(w.conn, admin, p.id, done.id, { name: "Fatto", category: "archived" })).toThrow(/Completato/);
  });

  it("eliminando uno stato con task, questi passano allo stato scelto", () => {
    const p = mkProject();
    const st = getProjectDetail(w.conn, admin, "PRJ")!.statuses;
    const review = st.find((s) => s.category === "review")!;
    const todo = st.find((s) => s.category === "todo")!;
    const t = createTask(w.conn, admin, p.id, { title: "T", statusId: review.id });
    expect(() => deleteStatus(w.conn, admin, p.id, review.id, null)).toThrow(/sposta|scegli/i);
    deleteStatus(w.conn, admin, p.id, review.id, todo.id);
    expect(getTaskDetail(w.conn, admin, "PRJ", t.number)!.task.statusId).toBe(todo.id);
  });

  it("con il workflow limitato sono ammesse solo le transizioni elencate", () => {
    const p = mkProject();
    const st = getProjectDetail(w.conn, admin, "PRJ")!.statuses;
    const [backlog, todo, doing, , done] = st;
    const t = createTask(w.conn, admin, p.id, { title: "T", statusId: backlog.id });
    setWorkflow(w.conn, admin, p.id, true, [{ from: backlog.id, to: todo.id }, { from: todo.id, to: doing.id }, { from: doing.id, to: done.id }]);
    expect(() => updateTask(w.conn, admin, t.id, { statusId: done.id })).toThrow(/Transizione non consentita/);
    updateTask(w.conn, admin, t.id, { statusId: todo.id });
    expect(() => moveTask(w.conn, admin, t.id, backlog.id, null)).toThrow(/Transizione non consentita/);
    setWorkflow(w.conn, admin, p.id, false, []);
    updateTask(w.conn, admin, t.id, { statusId: done.id });
    expect(getTaskDetail(w.conn, admin, "PRJ", t.number)!.task.completedAt).not.toBeNull();
  });

  it("un nuovo stato personalizzato è usabile subito e compare nell'ordine voluto", () => {
    const p = mkProject();
    const id = createStatus(w.conn, admin, p.id, { name: "Bloccato", category: "in_progress", color: "#ef4444" });
    expect(() => createStatus(w.conn, admin, p.id, { name: "Bloccato", category: "todo" })).toThrow(/già/);
    const t = createTask(w.conn, admin, p.id, { title: "T", statusId: id });
    expect(getTaskDetail(w.conn, admin, "PRJ", t.number)!.task.statusName).toBe("Bloccato");
  });
});

describe("task: creazione, regole, dipendenze", () => {
  it("numera in sequenza, ordina per colonna e ammette un solo livello di sottotask", () => {
    const p = mkProject();
    const a = createTask(w.conn, admin, p.id, { title: "A" });
    const b = createTask(w.conn, admin, p.id, { title: "B" });
    expect([a.ref, b.ref]).toEqual(["PRJ-1", "PRJ-2"]);
    const sub = createTask(w.conn, admin, p.id, { title: "A.1", parentTaskId: a.id });
    expect(() => createTask(w.conn, admin, p.id, { title: "A.1.1", parentTaskId: sub.id })).toThrow(/un solo livello/);
    expect(queryTasks(w.conn, admin, { projectId: p.id }).map((t) => t.title)).toEqual(["A", "B"]);
    expect(queryTasks(w.conn, admin, { projectId: p.id })[0].subtaskTotal).toBe(1);
  });

  it("non si assegna un task a chi non vede il progetto", () => {
    const p = mkProject({ visibility: "private" });
    expect(() => createTask(w.conn, admin, p.id, { title: "T", assigneeId: member.membershipId })).toThrow(/non ha accesso/);
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    expect(createTask(w.conn, admin, p.id, { title: "T", assigneeId: member.membershipId }).id).toBeGreaterThan(0);
  });

  it("valida date, stima, priorità e milestone", () => {
    const p = mkProject();
    const other = mkProject({ key: "OTH", name: "Altro" });
    const m = createMilestone(w.conn, admin, other.id, { name: "M" });
    expect(() => createTask(w.conn, admin, p.id, { title: "T", startDate: "2026-05-10", dueDate: "2026-05-01" })).toThrow(/precede/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", dueDate: "domani" })).toThrow(/Data non valida/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", estimateMinutes: -5 })).toThrow(/Stima/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", priority: "mega" as never })).toThrow(/Priorità/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", milestoneId: m })).toThrow(/Milestone/);
  });

  it("dipendenze: niente cicli, niente self, niente altri progetti; un task bloccato non si completa", () => {
    const p = mkProject();
    const q = mkProject({ key: "OTH", name: "Altro" });
    const [a, b, c] = ["A", "B", "C"].map((title) => createTask(w.conn, admin, p.id, { title }));
    const x = createTask(w.conn, admin, q.id, { title: "X" });
    addDependency(w.conn, admin, b.id, a.id);
    addDependency(w.conn, admin, c.id, b.id);
    expect(() => addDependency(w.conn, admin, a.id, c.id)).toThrow(/circolare/);
    expect(() => addDependency(w.conn, admin, a.id, a.id)).toThrow(/se stesso/);
    expect(() => addDependency(w.conn, admin, a.id, x.id)).toThrow(/stesso progetto/);
    const done = getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "done")!;
    expect(() => updateTask(w.conn, admin, b.id, { statusId: done.id })).toThrow(/Bloccato da PRJ-1/);
    updateTask(w.conn, admin, a.id, { statusId: done.id });
    updateTask(w.conn, admin, b.id, { statusId: done.id });
    expect(getTaskDetail(w.conn, admin, "PRJ", c.number)!.blockedBy).toEqual([expect.objectContaining({ ref: "PRJ-2", done: true })]);
  });

  it("un padre con sottotask aperti non si completa; completati i figli sì", () => {
    const p = mkProject();
    const par = createTask(w.conn, admin, p.id, { title: "Padre" });
    const kid = createTask(w.conn, admin, p.id, { title: "Figlio", parentTaskId: par.id });
    const done = getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "done")!;
    expect(() => updateTask(w.conn, admin, par.id, { statusId: done.id })).toThrow(/sottotask non completati/);
    updateTask(w.conn, admin, kid.id, { statusId: done.id });
    updateTask(w.conn, admin, par.id, { statusId: done.id });
  });

  it("riaprire un task completato azzera la data di completamento", () => {
    const p = mkProject();
    const t = createTask(w.conn, admin, p.id, { title: "T" });
    const st = getProjectDetail(w.conn, admin, "PRJ")!.statuses;
    updateTask(w.conn, admin, t.id, { statusId: st.find((s) => s.category === "done")!.id });
    updateTask(w.conn, admin, t.id, { statusId: st.find((s) => s.category === "in_progress")!.id });
    expect(getTaskDetail(w.conn, admin, "PRJ", t.number)!.task.completedAt).toBeNull();
  });

  it("l'eliminazione è logica e porta con sé i sottotask", () => {
    const p = mkProject();
    const par = createTask(w.conn, admin, p.id, { title: "Padre" });
    createTask(w.conn, admin, p.id, { title: "Figlio", parentTaskId: par.id });
    deleteTask(w.conn, admin, par.id);
    expect(queryTasks(w.conn, admin, { projectId: p.id }, { showSubtasks: true })).toEqual([]);
    expect(getTaskDetail(w.conn, admin, "PRJ", par.number)).toBeNull();
  });
});

describe("board: spostamenti e azioni di gruppo", () => {
  it("moveTask mette il task davanti a quello indicato e supporta lo spostamento tra colonne", () => {
    const p = mkProject();
    const [a, b, c] = ["A", "B", "C"].map((title) => createTask(w.conn, admin, p.id, { title }));
    moveTask(w.conn, admin, c.id, getTaskDetail(w.conn, admin, "PRJ", a.number)!.task.statusId, a.id);
    expect(queryTasks(w.conn, admin, { projectId: p.id }).map((t) => t.title)).toEqual(["C", "A", "B"]);
    moveTask(w.conn, admin, a.id, getTaskDetail(w.conn, admin, "PRJ", a.number)!.task.statusId, null);
    expect(queryTasks(w.conn, admin, { projectId: p.id }).map((t) => t.title)).toEqual(["C", "B", "A"]);
    const doing = getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "in_progress")!;
    moveTask(w.conn, admin, b.id, doing.id, null);
    expect(getTaskDetail(w.conn, admin, "PRJ", b.number)!.task.statusName).toBe(doing.name);
  });

  it("molti spostamenti nello stesso punto non producono posizioni identiche", () => {
    const p = mkProject();
    const t = Array.from({ length: 4 }, (_, i) => createTask(w.conn, admin, p.id, { title: `T${i}` }));
    const statusId = getTaskDetail(w.conn, admin, "PRJ", 1)!.task.statusId;
    for (let i = 0; i < 40; i++) {
      moveTask(w.conn, admin, t[3].id, statusId, t[0].id);
      moveTask(w.conn, admin, t[2].id, statusId, t[0].id);
    }
    const pos = queryTasks(w.conn, admin, { projectId: p.id }).map((x) => x.position);
    expect(new Set(pos).size).toBe(pos.length);
  });

  it("bulkUpdate applica le modifiche ai task validi e riporta gli altri", () => {
    const p = mkProject();
    const [a, b, c] = ["A", "B", "C"].map((title) => createTask(w.conn, admin, p.id, { title }));
    addDependency(w.conn, admin, c.id, a.id);
    const done = getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "done")!;
    // C dipende da A: se A viene completata prima, C passa; messa per prima, resta bloccata.
    const res = bulkUpdate(w.conn, admin, p.id, [c.id, a.id, b.id, 9999], { statusId: done.id });
    expect(res.done).toBe(2);
    expect(res.failed.map((f) => f.ref).sort()).toEqual(["#9999", "PRJ-3"]);
    expect(res.failed.find((f) => f.ref === "PRJ-3")!.message).toMatch(/Bloccato/);
    expect(bulkUpdate(w.conn, admin, p.id, [a.id, b.id], { priority: "urgent" }).done).toBe(2);
    expect(bulkUpdate(w.conn, admin, p.id, [a.id], { remove: true }).done).toBe(1);
    expect(queryTasks(w.conn, admin, { projectId: p.id }, { showArchived: true }).map((t) => t.title).sort()).toEqual(["B", "C"]);
  });
});

describe("filtri, ordinamenti, campi personalizzati", () => {
  it("filtra per stato, priorità, assegnatario, scadenza e testo", () => {
    const p = mkProject({ visibility: "org" });
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    const today = "2026-06-15";
    createTask(w.conn, admin, p.id, { title: "Vecchio", dueDate: "2026-06-01", priority: "urgent", assigneeId: member.membershipId });
    createTask(w.conn, admin, p.id, { title: "Questa settimana", dueDate: "2026-06-18", priority: "high" });
    createTask(w.conn, admin, p.id, { title: "Senza data", priority: "low", description: "contiene la parola carbonio" });
    const q = (s: string) => queryTasks(w.conn, member, { projectId: p.id }, parseTaskQuery(Object.fromEntries(new URLSearchParams(s))), today).map((t) => t.title);
    expect(q("due=overdue")).toEqual(["Vecchio"]);
    expect(q("due=week")).toEqual(["Questa settimana"]);
    expect(q("due=none")).toEqual(["Senza data"]);
    expect(q("priority=urgent,low").sort()).toEqual(["Senza data", "Vecchio"]);
    expect(q("assignee=me")).toEqual(["Vecchio"]);
    expect(q("assignee=none").sort()).toEqual(["Questa settimana", "Senza data"]);
    expect(q("q=carbonio")).toEqual(["Senza data"]);
    expect(q("q=PRJ-2")).toEqual(["Questa settimana"]);
    expect(q("sort=due:desc")).toEqual(["Questa settimana", "Vecchio", "Senza data"]);
    expect(q("sort=priority:asc")).toEqual(["Vecchio", "Questa settimana", "Senza data"]);
    expect(q("sort=injection;DROP:asc")).toHaveLength(3);
  });

  it("i campi personalizzati sono validati, filtrabili e ordinabili", () => {
    const p = mkProject();
    const rischio = createField(w.conn, admin, p.id, { name: "Rischio", type: "select", options: ["Basso", "Alto"] });
    const ore = createField(w.conn, admin, p.id, { name: "Ore", type: "number", required: true });
    const url = createField(w.conn, admin, p.id, { name: "Link", type: "url" });
    expect(() => createField(w.conn, admin, p.id, { name: "Rischio", type: "text" })).toThrow(/già/);
    expect(() => createField(w.conn, admin, p.id, { name: "Scelta", type: "select", options: [] })).toThrow(/almeno/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T" })).toThrow(/obbligatorio/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", fields: { [ore]: "tanto" } })).toThrow(/numero/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", fields: { [ore]: 1, [rischio]: "Medio" } })).toThrow(/valori previsti/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", fields: { [ore]: 1, [url]: "javascript:alert(1)" } })).toThrow(/http/);
    expect(() => createTask(w.conn, admin, p.id, { title: "T", fields: { 9999: 1 } })).toThrow(/sconosciuto/);
    createTask(w.conn, admin, p.id, { title: "Alto", fields: { [ore]: "2,5", [rischio]: "Alto" } });
    createTask(w.conn, admin, p.id, { title: "Basso", fields: { [ore]: 10, [rischio]: "Basso", [url]: "https://example.com/doc" } });
    const q = (qs: string) => queryTasks(w.conn, admin, { projectId: p.id }, parseTaskQuery(Object.fromEntries(new URLSearchParams(qs)))).map((t) => t.title);
    expect(q(`cf.${rischio}=Alto`)).toEqual(["Alto"]);
    expect(q(`sort=cf.${ore}:desc`)).toEqual(["Basso", "Alto"]);
    expect(q(`sort=cf.${ore}:asc`)).toEqual(["Alto", "Basso"]);
    const t = queryTasks(w.conn, admin, { projectId: p.id }).find((x) => x.title === "Alto")!;
    expect(t.fields[ore]).toBe(2.5);
    updateTask(w.conn, admin, t.id, { fields: { [rischio]: null } });
    expect(queryTasks(w.conn, admin, { projectId: p.id }).find((x) => x.title === "Alto")!.fields[rischio]).toBeUndefined();
    expect(() => updateTask(w.conn, admin, t.id, { fields: { [ore]: null } })).toThrow(/obbligatorio/);
  });

  it("le milestone mostrano l'avanzamento e, se eliminate, liberano i task", () => {
    const p = mkProject();
    const m = createMilestone(w.conn, admin, p.id, { name: "M1", dueDate: "2026-07-01" });
    const t = createTask(w.conn, admin, p.id, { title: "T", milestoneId: m });
    updateTask(w.conn, admin, t.id, { statusId: getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "done")!.id });
    expect(getProjectDetail(w.conn, admin, "PRJ")!.milestones[0]).toMatchObject({ total: 1, done: 1 });
    deleteMilestone(w.conn, admin, p.id, m);
    expect(getTaskDetail(w.conn, admin, "PRJ", t.number)!.task.milestoneId).toBeNull();
  });

  it("my work: solo i miei task, solo da progetti visibili, ordinati per scadenza", () => {
    const open = mkProject();
    const hidden = mkProject({ key: "HID", name: "Nascosto", visibility: "private" });
    setProjectMember(w.conn, admin, open.id, member.membershipId, "member");
    createTask(w.conn, admin, open.id, { title: "Tardi", dueDate: "2026-08-01", assigneeId: member.membershipId });
    createTask(w.conn, admin, open.id, { title: "Presto", dueDate: "2026-07-01", assigneeId: member.membershipId });
    createTask(w.conn, admin, open.id, { title: "Di altri", assigneeId: pm.membershipId });
    createTask(w.conn, admin, hidden.id, { title: "Non mio progetto" });
    expect(myTasks(w.conn, member).map((t) => t.title)).toEqual(["Presto", "Tardi"]);
    expect(myTasks(w.conn, admin, { assignee: [member.membershipId] }).map((t) => t.title)).toEqual(["Presto", "Tardi"]);
  });
});

describe("panoramica del progetto", () => {
  it("riporta totali, scaduti, carico per persona e avanzamento calcolati dai dati", () => {
    const p = mkProject();
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    const done = getProjectDetail(w.conn, admin, "PRJ")!.statuses.find((s) => s.category === "done")!;
    const a = createTask(w.conn, admin, p.id, { title: "A", dueDate: "2026-06-01", assigneeId: member.membershipId, estimateMinutes: 120 });
    createTask(w.conn, admin, p.id, { title: "B", dueDate: "2026-06-20", assigneeId: member.membershipId, estimateMinutes: 60 });
    createTask(w.conn, admin, p.id, { title: "C" });
    const d = createTask(w.conn, admin, p.id, { title: "D" });
    updateTask(w.conn, admin, d.id, { statusId: done.id });
    const o = projectOverview(w.conn, admin, p.id, "2026-06-15");
    expect(o.totals).toMatchObject({ total: 4, done: 1, open: 3, overdue: 1, unassigned: 1, progress: 25, estimateMinutes: 180 });
    expect(o.workload).toEqual([{ membershipId: member.membershipId, name: "Mario Membro", open: 2, minutes: 180 }]);
    expect(o.overdue.map((t) => t.ref)).toEqual(["PRJ-1"]);
    expect(o.upcoming.map((t) => t.ref)).toEqual(["PRJ-2"]);
    expect(listProjects(w.conn, admin, {}, "2026-06-15").find((x) => x.key === "PRJ")).toMatchObject({ total: 4, done: 1, overdue: 1 });
    void a;
  });
});

describe("commenti, menzioni e notifiche", () => {
  it("notifica assegnatario e chi ha creato, le menzioni solo a chi vede il progetto, mai l'autore", () => {
    const p = mkProject({ visibility: "private" });
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    const t = createTask(w.conn, admin, p.id, { title: "Task", assigneeId: member.membershipId });
    expect(unreadCount(w.conn, member)).toBe(2); // aggiunta al progetto + assegnazione
    addComment(w.conn, member, "task", t.id, "Ci penso io @Paola @Admin", [pm.membershipId, admin.membershipId, member.membershipId]);
    // pm non vede il progetto privato: nessuna notifica; l'admin riceve la menzione; l'autore nessuna
    expect(unreadCount(w.conn, pm)).toBe(0);
    expect(listNotifications(w.conn, admin).items.map((n) => n.kind)).toEqual(["mention"]);
    expect(unreadCount(w.conn, member)).toBe(2);
    expect(listComments(w.conn, admin, "task", t.id)[0].mentions.map((m) => m.name)).toEqual(["Admin"]);
  });

  it("assegnatario e creatore ricevono il commento (una volta sola, anche se menzionati)", () => {
    const p = mkProject();
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    const t = createTask(w.conn, admin, p.id, { title: "Task", assigneeId: member.membershipId });
    markRead(w.conn, member, "all");
    addComment(w.conn, pm, "task", t.id, "Aggiornamento", []);
    expect(listNotifications(w.conn, member, { unreadOnly: true }).items.map((n) => n.kind)).toEqual(["comment"]);
    addComment(w.conn, pm, "task", t.id, "@Admin guarda", [admin.membershipId]);
    expect(listNotifications(w.conn, admin).items.filter((n) => n.kind === "comment")).toHaveLength(1);
    expect(listNotifications(w.conn, admin).items.filter((n) => n.kind === "mention")).toHaveLength(1);
  });

  it("le preferenze spengono una categoria; le notifiche si leggono solo se proprie", () => {
    const p = mkProject();
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    setPreference(w.conn, member, "assigned", false);
    const t = createTask(w.conn, admin, p.id, { title: "Task", assigneeId: member.membershipId });
    expect(listNotifications(w.conn, member).items.map((n) => n.kind)).toEqual(["project_member"]);
    const mine = listNotifications(w.conn, member).items[0].id;
    expect(markRead(w.conn, admin, [mine])).toBe(0);
    expect(markRead(w.conn, member, [mine])).toBe(1);
    void t;
  });

  it("si eliminano solo i propri commenti, salvo i responsabili del progetto", () => {
    const p = mkProject();
    setProjectMember(w.conn, admin, p.id, member.membershipId, "member");
    setProjectMember(w.conn, admin, p.id, pm.membershipId, "member");
    const t = createTask(w.conn, admin, p.id, { title: "T" });
    const c = addComment(w.conn, member, "task", t.id, "Mio");
    expect(() => deleteComment(w.conn, pm, c)).toThrow(/solo i tuoi/);
    deleteComment(w.conn, member, c);
    const c2 = addComment(w.conn, member, "task", t.id, "Mio 2");
    deleteComment(w.conn, admin, c2);
    expect(listComments(w.conn, admin, "task", t.id)).toEqual([]);
  });
});

describe("ricerca", () => {
  it("trova task e progetti per parole (anche senza accenti) e resta allineata a modifiche ed eliminazioni", () => {
    const p = mkProject({ name: "Aerodinamica anteriore" });
    const t = createTask(w.conn, admin, p.id, { title: "Verifica profilo", description: "Galleria del vento a Perugia" });
    expect(search(w.conn, admin, "aerodinamica").map((h) => h.type)).toEqual(["project"]);
    expect(search(w.conn, admin, "gallerìa vent")[0].url).toBe("/projects/PRJ/tasks/1");
    updateTask(w.conn, admin, t.id, { title: "Verifica ala", description: "" });
    expect(search(w.conn, admin, "galleria")).toEqual([]);
    expect(search(w.conn, admin, "ala")).toHaveLength(1);
    deleteTask(w.conn, admin, t.id);
    expect(search(w.conn, admin, "ala")).toEqual([]);
    updateProject(w.conn, admin, p.id, { name: "Telaio posteriore" });
    expect(search(w.conn, admin, "telaio")).toHaveLength(1);
    expect(search(w.conn, admin, "aerodinamica")).toEqual([]);
  });

  it("gestisce input ostili senza errori di sintassi FTS e trova le persone dell'organizzazione", () => {
    for (const bad of ['"', "'", "AND OR NOT", "( ) *", "col:val", "%", "\\", "a".repeat(500), "  "]) expect(() => search(w.conn, admin, bad)).not.toThrow();
    expect(search(w.conn, admin, "marta").map((h) => h.type)).toEqual(["member"]);
  });
});

describe("membri del progetto", () => {
  it("il responsabile non si può rimuovere né declassare", () => {
    const p = mkProject();
    expect(() => removeProjectMember(w.conn, admin, p.id, admin.membershipId)).toThrow(/responsabile/i);
    expect(() => setProjectMember(w.conn, admin, p.id, admin.membershipId, "viewer")).toThrow(/Responsabile/);
  });
});
