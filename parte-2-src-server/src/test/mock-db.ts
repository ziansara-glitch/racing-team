import type { DatabaseSync } from "node:sqlite";
import { migratedDb } from "./helpers";

// Sostituisce "@/server/db" nei test dei moduli che usano il database dell'app:
//   vi.mock("@/server/db", () => import("@/test/mock-db"));
// `db` è un proxy stabile verso la connessione corrente: resetDb() ne crea una nuova (migrata, vuota), così ogni test
// parte da zero senza dover cancellare righe (le chiavi esterne lo impedirebbero, giustamente).

type Param = string | number | null;

let cur: DatabaseSync = migratedDb();

export const db = new Proxy({} as DatabaseSync, {
  get(_t, prop) {
    const v = (cur as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(cur) : v;
  },
});

export const resetDb = () => { cur = migratedDb(); };

export const all = <T>(sql: string, ...p: Param[]) => cur.prepare(sql).all(...p) as T[];
export const get = <T>(sql: string, ...p: Param[]) => cur.prepare(sql).get(...p) as T | undefined;
export const run = (sql: string, ...p: Param[]) => cur.prepare(sql).run(...p);

export function tx<T>(fn: () => T): T {
  cur.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    cur.exec("COMMIT");
    return result;
  } catch (err) {
    cur.exec("ROLLBACK");
    throw err;
  }
}
