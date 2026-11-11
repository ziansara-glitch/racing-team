import type { Conn } from "./sql.ts";

// Transazione per connessione. Le chiamate annidate si uniscono a quella esterna; la funzione deve
// essere sincrona (una sola connessione: un `await` lascerebbe la transazione aperta).
const depth = new WeakMap<Conn, number>();
const queued = new WeakMap<Conn, (() => void)[]>();

/**
 * Esegue `fn` dopo il COMMIT della transazione in corso (o subito, se non ce n'è una). Se la
 * transazione fa ROLLBACK, `fn` non viene mai eseguita: gli eventi in tempo reale non annunciano
 * mai modifiche che non sono state salvate.
 */
export function afterCommit(conn: Conn, fn: () => void): void {
  if ((depth.get(conn) ?? 0) === 0) return fn();
  const list = queued.get(conn) ?? [];
  list.push(fn);
  queued.set(conn, list);
}

export function transaction<T>(conn: Conn, fn: () => T): T {
  const d = depth.get(conn) ?? 0;
  if (d > 0) return fn();
  conn.exec("BEGIN IMMEDIATE");
  depth.set(conn, 1);
  queued.set(conn, []);
  let result: T;
  try {
    result = fn();
    if (result instanceof Promise) throw new Error("transaction(): la funzione deve essere sincrona");
    conn.exec("COMMIT");
  } catch (err) {
    conn.exec("ROLLBACK");
    queued.delete(conn);
    throw err;
  } finally {
    depth.set(conn, 0);
  }
  const callbacks = queued.get(conn) ?? [];
  queued.delete(conn);
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      /* un ascoltatore difettoso non deve far fallire una scrittura già salvata */
    }
  }
  return result;
}
