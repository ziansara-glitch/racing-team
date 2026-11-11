// Bus di eventi in tempo reale, in-process (coerente con l'istanza singola: ADR-2). Gli eventi
// trasportano solo tipo e identificativi: i contenuti si rileggono dagli endpoint autorizzati.
export type RtEvent = { type: string; [key: string]: string | number | null };
type Listener = (e: RtEvent) => void;

// Singleton su globalThis: sopravvive all'hot reload e a moduli caricati più volte dal bundler.
const g = globalThis as unknown as { __rtListeners?: Map<number, Set<Listener>> };
const listeners = (g.__rtListeners ??= new Map<number, Set<Listener>>());

export function subscribe(membershipId: number, fn: Listener): () => void {
  let set = listeners.get(membershipId);
  if (!set) listeners.set(membershipId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(membershipId);
  };
}

/** Consegna `event` a ciascun destinatario collegato. Chi non è collegato semplicemente non lo riceve (lo stato è nel database). */
export function publish(event: RtEvent, recipients: Iterable<number>): void {
  for (const id of new Set(recipients)) for (const fn of listeners.get(id) ?? []) fn(event);
}

export const connectedCount = () => listeners.size;
export const isConnected = (membershipId: number) => listeners.has(membershipId);
