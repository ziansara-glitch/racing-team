import { beforeEach, describe, expect, it } from "vitest";
import { migratedDb } from "@/test/helpers";
import { redact, writeAudit } from "./audit";

let conn: ReturnType<typeof migratedDb>;
beforeEach(() => {
  conn = migratedDb();
});

describe("redact()", () => {
  it("nasconde i campi sensibili a qualunque livello", () => {
    const out = redact({
      email: "a@b.it",
      password: "hunter2",
      newPassword: "x",
      nested: { sessionToken: "abc", apiKey: "k", ok: 1, deep: [{ Authorization: "Bearer z", y: 2 }] },
      password_hash: "scrypt$..",
    }) as Record<string, unknown>;
    expect(out.password).toBe("[nascosto]");
    expect(out.newPassword).toBe("[nascosto]");
    expect(out.password_hash).toBe("[nascosto]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.sessionToken).toBe("[nascosto]");
    expect(nested.apiKey).toBe("[nascosto]");
    expect(nested.ok).toBe(1);
    expect(((nested.deep as unknown[])[0] as Record<string, unknown>).Authorization).toBe("[nascosto]");
    expect(((nested.deep as unknown[])[0] as Record<string, unknown>).y).toBe(2);
    expect(out.email).toBe("a@b.it");
  });

  it("tronca stringhe, liste e profondità eccessive", () => {
    expect((redact("x".repeat(600)) as string).length).toBe(501);
    expect((redact(Array.from({ length: 80 }, (_, i) => i)) as number[]).length).toBe(50);
    expect(redact({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "[troncato]" } } } });
  });
});

describe("writeAudit()", () => {
  it("scrive una riga con meta già ripulito", () => {
    const id = writeAudit(conn, { orgId: 1, actorUserId: 7, action: "auth.password.change", entityType: "user", entityId: 7, meta: { password: "s3cret", ip: "x" } });
    const row = conn.prepare("SELECT * FROM audit_logs WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ org_id: 1, actor_user_id: 7, action: "auth.password.change", entity_type: "user", entity_id: 7 });
    expect(JSON.parse(row.meta as string)).toEqual({ password: "[nascosto]", ip: "x" });
    expect(String(row.meta)).not.toContain("s3cret");
    expect(String(row.at)).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("accetta eventi senza organizzazione né utente (login fallito su email sconosciuta)", () => {
    expect(() => writeAudit(conn, { orgId: null, actorUserId: null, action: "auth.login.failure" })).not.toThrow();
  });

  it("è append-only: UPDATE e DELETE vengono rifiutati dal database", () => {
    const id = writeAudit(conn, { orgId: 1, actorUserId: 1, action: "x" });
    expect(() => conn.prepare("UPDATE audit_logs SET action = 'y' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => conn.prepare("DELETE FROM audit_logs WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => conn.exec("DELETE FROM audit_logs")).toThrow(/append-only/);
    expect((conn.prepare("SELECT action FROM audit_logs WHERE id = ?").get(id) as { action: string }).action).toBe("x");
  });

  it("segue la transazione del chiamante: se la modifica fallisce, anche l'audit sparisce", () => {
    conn.exec("BEGIN");
    writeAudit(conn, { orgId: 1, actorUserId: 1, action: "member.create" });
    conn.exec("ROLLBACK");
    expect((conn.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n).toBe(0);
  });
});
