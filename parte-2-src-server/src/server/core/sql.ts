import type { DatabaseSync } from "node:sqlite";

// Helper minimi sopra node:sqlite. Il core del dominio è "puro": riceve la connessione, così i test
// usano database in memoria e gli script (seed) riusano la stessa logica. Import relativi con .ts:
// Node li esegue direttamente senza passare dal bundler.

export type Conn = DatabaseSync;
export type Param = string | number | null;
export type Row = Record<string, unknown>;

export const all = <T = Row>(c: Conn, sql: string, ...p: Param[]): T[] => c.prepare(sql).all(...p) as unknown as T[];
export const one = <T = Row>(c: Conn, sql: string, ...p: Param[]): T | undefined => c.prepare(sql).get(...p) as unknown as T | undefined;
export const run = (c: Conn, sql: string, ...p: Param[]) => c.prepare(sql).run(...p);
export const insert = (c: Conn, sql: string, ...p: Param[]): number => Number(run(c, sql, ...p).lastInsertRowid);

export const nowISO = () => new Date().toISOString();
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
