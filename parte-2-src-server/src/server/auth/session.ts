import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { loadActor } from "@/server/authz/actor";
import type { Actor } from "@/server/authz/authorize";
import { isAdminRole } from "@/server/authz/permissions";
import { db, get, run } from "@/server/db";

const COOKIE = "rh_session";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
// last_seen_at si aggiorna al massimo ogni 10 minuti: niente scrittura a ogni richiesta.
const SEEN_EVERY_MS = 10 * 60 * 1000;

/** Forma storica usata dalla UI esistente. `role` deriva dalla membership, non più da users.role. */
export type CurrentUser = {
  id: number;
  name: string;
  email: string;
  role: "admin" | "member";
  department: string;
  title: string;
};

// Nel database finisce solo l'hash del token: una copia del file non permette di entrare.
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: number, orgId: number | null) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expires = now + TTL_MS;
  const userAgent = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  run("DELETE FROM sessions WHERE expires_at < ?", now);
  run(
    `INSERT INTO sessions (token_hash, user_id, org_id, expires_at, created_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    hashToken(token),
    userId,
    orgId,
    expires,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    userAgent,
  );
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expires),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
  jar.delete(COOKIE);
}

/** Chiude tutte le altre sessioni dell'utente (es. dopo un cambio password), tenendo quella corrente. */
export async function destroyOtherSessions(userId: number) {
  const token = (await cookies()).get(COOKIE)?.value;
  run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", userId, token ? hashToken(token) : "");
}

type SessionContext = { user: CurrentUser; actor: Actor };

// Una sessione vale solo se l'utente ha una membership attiva: senza, è come non essere autenticati.
const getContext = cache(async (): Promise<SessionContext | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = Date.now();

  const s = get<{ user_id: number; org_id: number | null; last_seen_at: string | null; department: string; title: string }>(
    `SELECT s.user_id, s.org_id, s.last_seen_at, u.department, u.title
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    now,
  );
  if (!s) return null;

  const actor = loadActor(db, s.user_id, s.org_id);
  if (!actor) return null;

  if (!s.last_seen_at || Date.parse(s.last_seen_at) < now - SEEN_EVERY_MS) {
    run("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", new Date(now).toISOString(), tokenHash);
  }

  return {
    actor,
    user: {
      id: actor.userId,
      name: actor.name,
      email: actor.email,
      role: isAdminRole(actor.role) ? "admin" : "member",
      department: s.department,
      title: s.title,
    },
  };
});

/** La sessione (hash del token) è ancora valida e la persona ha ancora una membership attiva? Serve alle connessioni SSE di lunga durata. */
export function sessionStillValid(membershipId: number, tokenHash: string): boolean {
  return !!get(
    `SELECT 1 FROM sessions s JOIN memberships m ON m.user_id = s.user_id AND m.id = ? AND m.status = 'active' WHERE s.token_hash = ? AND s.expires_at > ?`,
    membershipId, tokenHash, Date.now(),
  );
}

/** Hash del token della sessione corrente (per riverificarla mentre una connessione SSE resta aperta). */
export async function currentSessionHash(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? hashToken(token) : null;
}

export const getCurrentUser = async (): Promise<CurrentUser | null> => (await getContext())?.user ?? null;
export const getActor = async (): Promise<Actor | null> => (await getContext())?.actor ?? null;
