// Operazioni da riga di comando per mettere in servizio un'installazione: primo amministratore e
// recupero password. Servono perché l'app non ha (ancora) invio di email né un flusso di inviti.
// Core puro: riceve la connessione e l'hash della password (l'hashing è asincrono, la transazione no).
import { writeAudit } from "../audit.ts";
import { hashKey, reset as resetLimit } from "../rate-limit.ts";
import { ValidationError } from "./errors.ts";
import { all, insert, one, run, type Conn } from "./sql.ts";
import { ensureTeamResources } from "./teams.ts";
import { transaction } from "./tx.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_ADMIN_PASSWORD = 12;

function cleanEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ValidationError("Email non valida.", "email");
  return email;
}

/**
 * Crea il primo Super Admin. Rifiuta se esistono già utenti (a meno di `allowExisting`): un database in
 * produzione non deve poter ricevere per errore un secondo "primo" amministratore.
 */
export function createFirstAdmin(
  conn: Conn,
  input: { name: string; email: string; passwordHash: string; orgId?: number; allowExisting?: boolean },
): { userId: number; membershipId: number } {
  const orgId = input.orgId ?? 1;
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Il nome è obbligatorio.", "name");
  const email = cleanEmail(input.email);

  return transaction(conn, () => {
    if (!input.allowExisting && one<{ n: number }>(conn, "SELECT COUNT(*) AS n FROM users")!.n > 0) {
      throw new ValidationError("Il database contiene già degli utenti: usa --add per aggiungere un amministratore.");
    }
    if (one(conn, "SELECT 1 FROM users WHERE email = ?", email)) throw new ValidationError("Esiste già un utente con questa email.", "email");
    if (!one(conn, "SELECT 1 FROM organizations WHERE id = ? AND deleted_at IS NULL", orgId)) throw new ValidationError("Organizzazione non trovata.");

    const userId = insert(
      conn,
      "INSERT INTO users (name, email, password_hash, role, department, title) VALUES (?, ?, ?, 'admin', 'Direzione', 'Amministratore')",
      name, email, input.passwordHash,
    );
    const membershipId = insert(conn, "INSERT INTO memberships (org_id, user_id, role, title) VALUES (?, ?, 'super_admin', 'Amministratore')", orgId, userId);
    const direzione = one<{ id: number }>(conn, "SELECT id FROM teams WHERE org_id = ? AND name = 'Direzione' AND deleted_at IS NULL", orgId);
    if (direzione) run(conn, "INSERT INTO team_members (team_id, membership_id, org_id, role) VALUES (?, ?, ?, 'lead')", direzione.id, membershipId, orgId);
    // Calendari, chat di team e canali annunci dei team esistenti (idempotente).
    for (const t of all<{ id: number }>(conn, "SELECT id FROM teams WHERE org_id = ? AND deleted_at IS NULL", orgId)) {
      ensureTeamResources(conn, orgId, t.id, membershipId);
    }
    writeAudit(conn, { orgId, actorUserId: null, action: "member.create", entityType: "membership", entityId: membershipId, meta: { userId, role: "super_admin", via: "cli" } });
    return { userId, membershipId };
  });
}

/**
 * Sospende o riattiva l'accesso di un utente (membership 'suspended' / 'active'). La sospensione chiude
 * subito le sessioni; non cancella nulla (messaggi, compiti e storico restano). Non si può sospendere
 * l'ultimo Super Admin attivo: l'organizzazione resterebbe senza nessuno che la gestisca.
 */
export function setAccess(conn: Conn, input: { email: string; active: boolean }): { userId: number; membershipId: number } {
  const email = cleanEmail(input.email);
  return transaction(conn, () => {
    const m = one<{ id: number; org_id: number; user_id: number; role: string; status: string }>(
      conn,
      `SELECT m.id, m.org_id, m.user_id, m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE u.email = ? ORDER BY m.id LIMIT 1`,
      email,
    );
    if (!m) throw new ValidationError("Nessun utente con questa email.", "email");
    const status = input.active ? "active" : "suspended";
    if (!input.active && m.role === "super_admin" && m.status === "active") {
      const others = one<{ n: number }>(
        conn, "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'super_admin' AND status = 'active' AND id <> ?", m.org_id, m.id)!.n;
      if (others === 0) throw new ValidationError("È l'ultimo Super Admin attivo: creane un altro prima di sospenderlo.");
    }
    run(conn, "UPDATE memberships SET status = ? WHERE id = ?", status, m.id);
    if (!input.active) run(conn, "DELETE FROM sessions WHERE user_id = ?", m.user_id);
    writeAudit(conn, { orgId: m.org_id, actorUserId: null, action: input.active ? "member.reactivate" : "member.suspend", entityType: "membership", entityId: m.id, meta: { userId: m.user_id, via: "cli" } });
    return { userId: m.user_id, membershipId: m.id };
  });
}

/**
 * Imposta una nuova password a un utente esistente, chiude tutte le sue sessioni e toglie il blocco
 * dei tentativi di accesso. È il recupero d'emergenza per chi ha accesso al server.
 */
export function resetUserPassword(conn: Conn, input: { email: string; passwordHash: string }): { userId: number } {
  const email = cleanEmail(input.email);
  return transaction(conn, () => {
    const user = one<{ id: number; org_id: number | null }>(
      conn,
      `SELECT u.id, (SELECT m.org_id FROM memberships m WHERE m.user_id = u.id ORDER BY m.id LIMIT 1) AS org_id FROM users u WHERE u.email = ?`,
      email,
    );
    if (!user) throw new ValidationError("Nessun utente con questa email.", "email");
    run(conn, "UPDATE users SET password_hash = ? WHERE id = ?", input.passwordHash, user.id);
    run(conn, "DELETE FROM sessions WHERE user_id = ?", user.id);
    resetLimit(conn, "login_fail", hashKey(email));
    resetLimit(conn, "password_change", String(user.id));
    writeAudit(conn, { orgId: user.org_id, actorUserId: null, action: "auth.password.reset_cli", entityType: "user", entityId: user.id, meta: { via: "cli" } });
    return { userId: user.id };
  });
}
