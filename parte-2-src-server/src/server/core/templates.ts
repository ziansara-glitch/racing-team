import { CATEGORY_COLOR, type FieldType, type Priority, type StatusCategory } from "./types.ts";

export type TemplateDef = {
  statuses: { name: string; category: StatusCategory; color?: string }[];
  fields: { name: string; type: FieldType; options?: string[]; required?: boolean }[];
  milestones: { name: string; offsetDays: number }[];
  /** `milestone` e `dependsOn` sono indici nelle liste del template; le date sono offset dalla data di inizio. */
  tasks: { title: string; status?: string; priority?: Priority; milestone?: number; offsetDays?: number; durationDays?: number; subtasks?: string[]; dependsOn?: number[] }[];
};

export const DEFAULT_STATUSES: TemplateDef["statuses"] = [
  { name: "Backlog", category: "backlog" },
  { name: "Da fare", category: "todo" },
  { name: "In corso", category: "in_progress" },
  { name: "In revisione", category: "review" },
  { name: "Completato", category: "done" },
  { name: "Archiviato", category: "archived" },
];

export const statusColor = (s: { category: StatusCategory; color?: string }) => s.color ?? CATEGORY_COLOR[s.category];

export type BuiltinTemplate = { name: string; description: string; def: TemplateDef };

export const BUILTIN_TEMPLATES: Record<string, BuiltinTemplate> = {
  standard: {
    name: "Progetto standard",
    description: "Sei stati (Backlog → Archiviato), nessun campo extra. Punto di partenza neutro.",
    def: { statuses: DEFAULT_STATUSES, fields: [], milestones: [], tasks: [] },
  },
  engineering: {
    name: "Sviluppo di un componente",
    description: "Dai requisiti alla validazione: milestone, campi Sottosistema/Rischio, task con dipendenze e sottotask.",
    def: {
      statuses: DEFAULT_STATUSES,
      fields: [
        { name: "Sottosistema", type: "select", options: ["Aerodinamica", "Telaio", "Motore", "Elettronica", "Software"] },
        { name: "Rischio", type: "select", options: ["Basso", "Medio", "Alto"] },
        { name: "Documento di riferimento", type: "url" },
      ],
      milestones: [
        { name: "Requisiti approvati", offsetDays: 14 },
        { name: "Progetto concluso", offsetDays: 42 },
        { name: "Prototipo pronto", offsetDays: 84 },
        { name: "Validazione superata", offsetDays: 112 },
      ],
      tasks: [
        { title: "Raccolta requisiti", status: "Da fare", priority: "high", milestone: 0, offsetDays: 0, durationDays: 10, subtasks: ["Intervista ai reparti", "Redigere la specifica"] },
        { title: "Revisione dei requisiti", priority: "medium", milestone: 0, offsetDays: 10, durationDays: 4, dependsOn: [0] },
        { title: "Progettazione concettuale", priority: "high", milestone: 1, offsetDays: 14, durationDays: 14, dependsOn: [1] },
        { title: "Progettazione di dettaglio", priority: "high", milestone: 1, offsetDays: 28, durationDays: 14, dependsOn: [2], subtasks: ["Disegni costruttivi", "Distinta base"] },
        { title: "Realizzazione del prototipo", priority: "urgent", milestone: 2, offsetDays: 42, durationDays: 42, dependsOn: [3] },
        { title: "Piano di prova", priority: "medium", milestone: 3, offsetDays: 70, durationDays: 14, dependsOn: [3] },
        { title: "Campagna di validazione", priority: "high", milestone: 3, offsetDays: 90, durationDays: 20, dependsOn: [4, 5] },
      ],
    },
  },
  event: {
    name: "Evento o gara",
    description: "Organizzazione di un evento con luogo, budget e checklist logistica.",
    def: {
      statuses: [
        { name: "Idee", category: "backlog" },
        { name: "Da organizzare", category: "todo" },
        { name: "In preparazione", category: "in_progress" },
        { name: "Da confermare", category: "review" },
        { name: "Confermato", category: "done" },
        { name: "Annullato", category: "archived" },
      ],
      fields: [
        { name: "Luogo", type: "text" },
        { name: "Budget (€)", type: "number" },
        { name: "Confermato dal fornitore", type: "checkbox" },
      ],
      milestones: [
        { name: "Permessi e iscrizioni", offsetDays: 30 },
        { name: "Logistica pronta", offsetDays: 60 },
        { name: "Giorno dell'evento", offsetDays: 75 },
      ],
      tasks: [
        { title: "Iscrizione all'evento", priority: "urgent", milestone: 0, offsetDays: 0, durationDays: 7 },
        { title: "Prenotare trasporti e alloggio", priority: "high", milestone: 1, offsetDays: 14, durationDays: 14, dependsOn: [0] },
        { title: "Preparare il materiale", priority: "medium", milestone: 1, offsetDays: 21, durationDays: 21, subtasks: ["Divise", "Banner", "Attrezzi"] },
        { title: "Briefing finale del team", priority: "medium", milestone: 2, offsetDays: 70, durationDays: 2, dependsOn: [1, 2] },
      ],
    },
  },
  recruiting: {
    name: "Selezione nuovi membri",
    description: "Pipeline di candidature con stati dedicati e workflow limitato.",
    def: {
      statuses: [
        { name: "Candidatura", category: "backlog" },
        { name: "Colloquio da fissare", category: "todo" },
        { name: "Colloquio fatto", category: "in_progress" },
        { name: "Prova pratica", category: "review" },
        { name: "Accettato", category: "done" },
        { name: "Rifiutato", category: "archived" },
      ],
      fields: [
        { name: "Corso di studi", type: "text" },
        { name: "Anno", type: "select", options: ["1° triennale", "2° triennale", "3° triennale", "1° magistrale", "2° magistrale"] },
        { name: "Reparto di interesse", type: "select", options: ["Aerodinamica", "Telaio & Dinamica", "Motore", "Software & Telemetria", "Business", "Media & Design"] },
      ],
      milestones: [{ name: "Chiusura candidature", offsetDays: 21 }, { name: "Esiti comunicati", offsetDays: 45 }],
      tasks: [],
    },
  },
};
