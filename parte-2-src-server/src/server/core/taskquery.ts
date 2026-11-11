import { PRIORITIES, type Priority } from "./types.ts";

// Filtri, ordinamento e raggruppamento di una vista task. Vivono nell'URL (così una vista si
// condivide e si salva come stringa) e sono validati qui: valori sconosciuti vengono ignorati.

export type TaskQuery = {
  q?: string;
  status?: number[];
  priority?: Priority[];
  assignee?: (number | "me" | "none")[];
  milestone?: (number | "none")[];
  due?: "overdue" | "week" | "month" | "none";
  from?: string;
  to?: string;
  hideDone?: boolean;
  showArchived?: boolean;
  showSubtasks?: boolean;
  cf?: Record<number, string>;
  sort?: string;
  group?: "status" | "assignee" | "priority" | "milestone" | "none";
};

export const SORT_KEYS = ["status", "number", "title", "priority", "assignee", "due", "start", "milestone", "updated", "created"] as const;
export const GROUP_KEYS = ["none", "status", "assignee", "priority", "milestone"] as const;

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: string | string[] | undefined) => (first(v) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ints = (v: string | string[] | undefined) => list(v).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseTaskQuery(sp: SP): TaskQuery {
  const q: TaskQuery = {};
  const text = first(sp.q)?.trim();
  if (text) q.q = text.slice(0, 100);
  const status = ints(sp.status);
  if (status.length) q.status = status;
  const priority = list(sp.priority).filter((p): p is Priority => (PRIORITIES as readonly string[]).includes(p));
  if (priority.length) q.priority = priority;
  const assignee = list(sp.assignee).flatMap((a): (number | "me" | "none")[] => (a === "me" || a === "none" ? [a] : Number.isInteger(Number(a)) && Number(a) > 0 ? [Number(a)] : []));
  if (assignee.length) q.assignee = assignee;
  const milestone = list(sp.milestone).flatMap((a): (number | "none")[] => (a === "none" ? [a] : Number.isInteger(Number(a)) && Number(a) > 0 ? [Number(a)] : []));
  if (milestone.length) q.milestone = milestone;
  const due = first(sp.due);
  if (due === "overdue" || due === "week" || due === "month" || due === "none") q.due = due;
  if (isDate(first(sp.from))) q.from = first(sp.from);
  if (isDate(first(sp.to))) q.to = first(sp.to);
  if (first(sp.hidedone) === "1") q.hideDone = true;
  if (first(sp.archived) === "1") q.showArchived = true;
  if (first(sp.subtasks) === "1") q.showSubtasks = true;
  const cf: Record<number, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const m = /^cf\.(\d+)$/.exec(k);
    const val = first(v)?.trim();
    if (m && val) cf[Number(m[1])] = val.slice(0, 100);
  }
  if (Object.keys(cf).length) q.cf = cf;
  const sort = first(sp.sort);
  if (sort && /^(?:[a-z]+|cf\.\d+):(asc|desc)$/.test(sort) && (SORT_KEYS as readonly string[]).concat([]).some((k) => sort.startsWith(`${k}:`) || /^cf\.\d+:/.test(sort))) q.sort = sort;
  const group = first(sp.group);
  if (group && (GROUP_KEYS as readonly string[]).includes(group) && group !== "none") q.group = group as TaskQuery["group"];
  return q;
}

/** Inverso di parseTaskQuery: serve per i link, le viste salvate e l'esportazione. */
export function taskQueryToString(q: TaskQuery, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  if (q.status?.length) p.set("status", q.status.join(","));
  if (q.priority?.length) p.set("priority", q.priority.join(","));
  if (q.assignee?.length) p.set("assignee", q.assignee.join(","));
  if (q.milestone?.length) p.set("milestone", q.milestone.join(","));
  if (q.due) p.set("due", q.due);
  if (q.from) p.set("from", q.from);
  if (q.to) p.set("to", q.to);
  if (q.hideDone) p.set("hidedone", "1");
  if (q.showArchived) p.set("archived", "1");
  if (q.showSubtasks) p.set("subtasks", "1");
  for (const [id, v] of Object.entries(q.cf ?? {})) p.set(`cf.${id}`, v);
  if (q.sort) p.set("sort", q.sort);
  if (q.group) p.set("group", q.group);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export const isFiltered = (q: TaskQuery) => !!(q.q || q.status || q.priority || q.assignee || q.milestone || q.due || q.hideDone || q.cf);
