import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { loadActor } from "@/server/authz/actor";
import { hit } from "@/server/rate-limit";
import { hashKey } from "@/server/rate-limit";
import { migratedDb } from "@/test/helpers";
import { createFirstAdmin, resetUserPassword, setAccess } from "./bootstrap";
import { ValidationError } from "./errors";
import { hasAdminAccess } from "./teams";

const count = (conn: ReturnType<typeof migratedDb>, sql: string, ...p: (string | number)[]) =>
  (conn.prepare(sql).get(...p) as { n: number }).n;

describe("createFirstAdmin", () => {
  it("crea un Super Admin che può entrare nell'Admin, con calendari e chat dei team", async () => {
    const conn = migratedDb();
    const passwordHash = await hashPassword("una-password-lunga-1");
    const { userId } = createFirstAdmin(conn, { name: "Edoardo Meozzi", email: " Edoardo@Example.org ", passwordHash });

    const actor = loadActor(conn, userId)!;
    expect(actor.role).toBe("super_admin");
    expect(hasAdminAccess(actor)).toBe(true);
    expect(conn.prepare("SELECT email FROM users WHERE id = ?").get(userId)).toEqual({ email: "edoardo@example.org" });
    // La password è salvata solo come hash e verificabile.
    const stored = conn.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    expect(stored.password_hash).not.toContain("una-password");
    expect(await verifyPassword("una-password-lunga-1", stored.password_hash)).toBe(true);
    // Risorse dei team e traccia di audit senza segreti.
    expect(count(conn, "SELECT COUNT(*) AS n FROM calendars WHERE kind = 'team'")).toBeGreaterThan(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM conversations WHERE kind = 'announcement'")).toBeGreaterThan(0);
    const audit = conn.prepare("SELECT action, actor_user_id, meta FROM audit_logs WHERE action = 'member.create'").get() as { action: string; actor_user_id: number | null; meta: string };
    expect(audit.actor_user_id).toBeNull();
    expect(audit.meta).not.toMatch(/scrypt|una-password/);
  });

  it("rifiuta un secondo 'primo' amministratore, salvo allowExisting", async () => {
    const conn = migratedDb();
    const passwordHash = await hashPassword("una-password-lunga-1");
    createFirstAdmin(conn, { name: "Primo Admin", email: "a@example.org", passwordHash });
    expect(() => createFirstAdmin(conn, { name: "Secondo Admin", email: "b@example.org", passwordHash })).toThrow(ValidationError);
    expect(count(conn, "SELECT COUNT(*) AS n FROM users")).toBe(1);
    createFirstAdmin(conn, { name: "Secondo Admin", email: "b@example.org", passwordHash, allowExisting: true });
    expect(count(conn, "SELECT COUNT(*) AS n FROM users")).toBe(2);
  });

  it("rifiuta email duplicate o non valide e non lascia dati a metà", async () => {
    const conn = migratedDb();
    const passwordHash = await hashPassword("una-password-lunga-1");
    expect(() => createFirstAdmin(conn, { name: "X Y", email: "non-un-email", passwordHash })).toThrow(ValidationError);
    expect(() => createFirstAdmin(conn, { name: "", email: "a@example.org", passwordHash })).toThrow(ValidationError);
    createFirstAdmin(conn, { name: "Primo Admin", email: "a@example.org", passwordHash });
    expect(() => createFirstAdmin(conn, { name: "Altro", email: "A@example.org", passwordHash, allowExisting: true })).toThrow(/Esiste già/);
    expect(count(conn, "SELECT COUNT(*) AS n FROM memberships")).toBe(1);
  });
});

describe("setAccess", () => {
  it("sospende un membro: niente più accesso né sessioni, e si può riattivare", async () => {
    const conn = migratedDb();
    const hash = await hashPassword("una-password-lunga-1");
    createFirstAdmin(conn, { name: "Primo Admin", email: "a@example.org", passwordHash: hash });
    const { userId } = createFirstAdmin(conn, { name: "Un Membro", email: "m@example.org", passwordHash: hash, allowExisting: true });
    conn.prepare("UPDATE memberships SET role = 'member' WHERE user_id = ?").run(userId);
    conn.prepare("INSERT INTO sessions (token_hash, user_id, org_id, expires_at, created_at) VALUES ('h', ?, 1, ?, ?)").run(userId, Date.now() + 1e6, new Date().toISOString());

    setAccess(conn, { email: "M@example.org", active: false });
    expect(loadActor(conn, userId)).toBeNull(); // senza membership attiva non si entra
    expect(count(conn, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId)).toBe(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'member.suspend'")).toBe(1);

    setAccess(conn, { email: "m@example.org", active: true });
    expect(loadActor(conn, userId)).not.toBeNull();
  });

  it("non sospende l'ultimo Super Admin attivo", async () => {
    const conn = migratedDb();
    createFirstAdmin(conn, { name: "Primo Admin", email: "a@example.org", passwordHash: await hashPassword("una-password-lunga-1") });
    expect(() => setAccess(conn, { email: "a@example.org", active: false })).toThrow(/ultimo Super Admin/);
    expect(count(conn, "SELECT COUNT(*) AS n FROM memberships WHERE status = 'active'")).toBe(1);
    expect(() => setAccess(conn, { email: "nessuno@example.org", active: false })).toThrow(/Nessun utente/);
  });
});

describe("resetUserPassword", () => {
  it("cambia la password, chiude le sessioni e toglie il blocco dei tentativi", async () => {
    const conn = migratedDb();
    const { userId } = createFirstAdmin(conn, { name: "Primo Admin", email: "a@example.org", passwordHash: await hashPassword("vecchia-password-1") });
    conn.prepare("INSERT INTO sessions (token_hash, user_id, org_id, expires_at, created_at) VALUES ('h', ?, 1, ?, ?)").run(userId, Date.now() + 1e6, new Date().toISOString());
    for (let i = 0; i < 5; i++) hit(conn, "login_fail", hashKey("a@example.org"), { limit: 5, windowMs: 300_000 });

    resetUserPassword(conn, { email: "A@example.org", passwordHash: await hashPassword("nuova-password-2") });

    const row = conn.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string };
    expect(await verifyPassword("nuova-password-2", row.password_hash)).toBe(true);
    expect(await verifyPassword("vecchia-password-1", row.password_hash)).toBe(false);
    expect(count(conn, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId)).toBe(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = 'login_fail'")).toBe(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'auth.password.reset_cli'")).toBe(1);
  });

  it("segnala un'email sconosciuta senza modificare nulla", async () => {
    const conn = migratedDb();
    expect(() => resetUserPassword(conn, { email: "nessuno@example.org", passwordHash: "x" })).toThrow(/Nessun utente/);
  });
});
