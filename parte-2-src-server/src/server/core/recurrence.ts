import { addDays } from "./sql.ts";

// Espansione delle ricorrenze: funzione pura sulle date "locali" (AAAA-MM-GG). Nessun fuso orario,
// quindi l'ora legale non sposta mai un evento: una riunione alle 18:00 resta alle 18:00.

export type Recurrence = {
  freq: "daily" | "weekly" | "monthly" | null;
  interval: number;
  /** 'MO,WE' per la ricorrenza settimanale; vuoto = giorno della settimana dell'inizio. */
  byday: string;
  until: string | null;
  count: number | null;
};

export type Occurrence = { date: string; start: string; end: string };

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const mondayIndex = (d: string) => Math.floor((dayDiff("1970-01-05", d)) / 7); // 1970-01-05 era un lunedì

export const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

/** Tutte le occorrenze di un evento che toccano [from, to] (estremi inclusi). Massimo 5000 iterazioni: nessuna serie può bloccare il server. */
export function expandOccurrences(ev: { starts_at: string; ends_at: string } & { rec: Recurrence }, from: string, to: string, exceptions: ReadonlySet<string> = new Set()): Occurrence[] {
  const startDate = ev.starts_at.slice(0, 10);
  const startTime = ev.starts_at.slice(11);
  const endDate = ev.ends_at.slice(0, 10);
  const endTime = ev.ends_at.slice(11);
  const span = dayDiff(startDate, endDate);
  const make = (d: string): Occurrence => ({ date: d, start: `${d}T${startTime}`, end: `${addDays(d, span)}T${endTime}` });
  const touches = (d: string) => d <= to && addDays(d, span) >= from;
  const r = ev.rec;
  if (!r.freq) return touches(startDate) && !exceptions.has(startDate) ? [make(startDate)] : [];

  const out: Occurrence[] = [];
  const wanted = new Set((r.byday || DAYS[weekday(startDate)]).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  const startWeek = mondayIndex(startDate);
  const startDom = Number(startDate.slice(8, 10));
  let ordinal = 0;
  let d = startDate;
  for (let i = 0; i < 5000; i++, d = addDays(d, 1)) {
    if (d > to) break;
    if (r.until && d > r.until) break;
    let hit = false;
    if (r.freq === "daily") hit = dayDiff(startDate, d) % r.interval === 0;
    else if (r.freq === "weekly") hit = wanted.has(DAYS[weekday(d)]) && (mondayIndex(d) - startWeek) % r.interval === 0 && d >= startDate;
    else {
      const months = (Number(d.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(d.slice(5, 7)) - Number(startDate.slice(5, 7));
      hit = Number(d.slice(8, 10)) === startDom && months % r.interval === 0;
    }
    if (!hit) continue;
    ordinal++;
    if (r.count && ordinal > r.count) break;
    if (touches(d) && !exceptions.has(d)) out.push(make(d));
  }
  return out;
}
