import "server-only";
import { redirect } from "next/navigation";
import { hasAny, type Actor } from "@/server/authz/authorize";
import { hasAdminAccess } from "@/server/core/teams";
import type { Permission } from "@/server/authz/permissions";
import { getActor, getCurrentUser } from "@/server/auth/session";

// Vanno chiamati in ogni pagina e in ogni server action: i layout non si rieseguono a ogni navigazione.

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** L'Actor (ruolo, organizzazione, permessi) di chi sta facendo la richiesta. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}

/** Accesso al pannello /admin (UI legacy). I dati sensibili richiedono comunque `requirePermission`. */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/member");
  return user;
}

/**
 * Richiede un permesso (con qualunque scope). Lo scope "scoped" va poi applicato dal DAL/servizio
 * sulla singola risorsa; qui si decide solo se la persona può accedere alla funzione.
 */
export async function requirePermission(permission: Permission): Promise<Actor> {
  const actor = await requireActor();
  if (!hasAny(actor, permission)) redirect("/");
  return actor;
}

/**
 * Ingresso a Racing Team ADMIN. Va chiamato in ogni pagina e azione admin (i layout non si rieseguono a ogni navigazione):
 * un membro viene portato all'App, e una chiamata diretta a un'azione admin viene respinta dal server.
 */
export async function requireAdminAccess(): Promise<Actor> {
  const actor = await requireActor();
  if (!hasAdminAccess(actor)) redirect("/app");
  return actor;
}

/** Come requirePermission, ma richiede l'ambito COMPLETO. Per i dati non ancora legati ai team (budget, candidature) uno scope ristretto non basta. */
export async function requireOrgWide(permission: Permission): Promise<Actor> {
  const actor = await requireActor();
  if (actor.permissions[permission] !== "all") redirect("/");
  return actor;
}
