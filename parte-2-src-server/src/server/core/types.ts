export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Bassa", medium: "Media", high: "Alta", urgent: "Urgente" };

export const STATUS_CATEGORIES = ["backlog", "todo", "in_progress", "review", "done", "archived"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<StatusCategory, string> = {
  backlog: "Backlog",
  todo: "Da fare",
  in_progress: "In corso",
  review: "In revisione",
  done: "Completato",
  archived: "Archiviato",
};
export const CATEGORY_COLOR: Record<StatusCategory, string> = {
  backlog: "#94a3b8",
  todo: "#3b82f6",
  in_progress: "#f59e0b",
  review: "#a855f7",
  done: "#10b981",
  archived: "#6b7280",
};

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: "In pianificazione",
  active: "Attivo",
  on_hold: "In pausa",
  completed: "Concluso",
  archived: "Archiviato",
};

export const VISIBILITIES = ["private", "team", "org"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Privato (solo membri del progetto)",
  team: "Team (membri del team e del progetto)",
  org: "Organizzazione (tutti)",
};

export const PROJECT_ROLES = ["manager", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = { manager: "Responsabile", member: "Membro", viewer: "Solo lettura" };

export const FIELD_TYPES = ["text", "number", "date", "select", "checkbox", "url"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Testo",
  number: "Numero",
  date: "Data",
  select: "Scelta singola",
  checkbox: "Casella",
  url: "Link",
};

export const VIEW_TYPES = ["table", "board", "calendar", "timeline", "gantt"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
export const VIEW_LABEL: Record<ViewType, string> = { table: "Tabella", board: "Board", calendar: "Calendario", timeline: "Timeline", gantt: "Gantt" };
