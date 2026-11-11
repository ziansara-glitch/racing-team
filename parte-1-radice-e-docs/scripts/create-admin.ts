// Primo amministratore e recupero password, da eseguire sul server (serve accesso al file del database).
//
//   npm run admin:create -- --name "Nome Cognome" --email nome@dominio.it        primo Super Admin (database senza utenti)
//   npm run admin:create -- --name "Nome Cognome" --email nome@dominio.it --add  un altro Super Admin
//   npm run admin:create -- --reset-password --email nome@dominio.it             nuova password per un utente esistente
//   npm run admin:create -- --suspend --email nome@dominio.it                    toglie l'accesso (--reactivate lo ridà)
//
// La password si legge dalla variabile ADMIN_PASSWORD (almeno 12 caratteri). Se manca, ne viene generata una
// e mostrata UNA volta sola: non si passa mai come argomento, perché finirebbe nella cronologia della shell.
// Usa lo stesso DATABASE_FILE del servizio (default: data/racing.db).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../src/server/auth/password.ts";
import { createFirstAdmin, MIN_ADMIN_PASSWORD, resetUserPassword, setAccess } from "../src/server/core/bootstrap.ts";
import { ValidationError } from "../src/server/core/errors.ts";
import { migrate } from "../src/server/db/migrate.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const email = value("email");
const reset = flag("reset-password");
const suspend = flag("suspend");
const reactivate = flag("reactivate");
const name = value("name");
if (!email || (!reset && !suspend && !reactivate && !name)) {
  console.error('Uso: npm run admin:create -- --name "Nome Cognome" --email nome@dominio.it [--add]');
  console.error("     npm run admin:create -- --reset-password --email nome@dominio.it");
  console.error("     npm run admin:create -- --suspend --email nome@dominio.it      (toglie l'accesso, conserva lo storico)");
  console.error("     npm run admin:create -- --reactivate --email nome@dominio.it");
  process.exit(2);
}

// La password serve solo a creare un utente o a reimpostarla.
const needsPassword = !suspend && !reactivate;
let password = needsPassword ? process.env.ADMIN_PASSWORD : "";
const generated = needsPassword && !password;
if (generated) password = randomBytes(15).toString("base64url");
if (needsPassword && password!.length < MIN_ADMIN_PASSWORD) {
  console.error(`La password deve avere almeno ${MIN_ADMIN_PASSWORD} caratteri.`);
  process.exit(2);
}

const file = process.env.DATABASE_FILE ?? path.join(process.cwd(), "data", "racing.db");
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file, { timeout: 5000 });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
migrate(db, path.join(process.cwd(), "migrations"));

try {
  const passwordHash = needsPassword ? await hashPassword(password!) : "";
  if (suspend || reactivate) {
    setAccess(db, { email, active: reactivate });
    console.log(`${email.trim().toLowerCase()}: accesso ${reactivate ? "riattivato" : "sospeso, sessioni chiuse"}.`);
  } else if (reset) {
    resetUserPassword(db, { email, passwordHash });
    console.log(`Password aggiornata per ${email.trim().toLowerCase()}. Le sessioni aperte sono state chiuse.`);
  } else {
    createFirstAdmin(db, { name: name!, email, passwordHash, allowExisting: flag("add") });
    console.log(`Super Admin creato: ${email.trim().toLowerCase()}`);
  }
  if (generated) {
    console.log(`Password (mostrata una sola volta, cambiala da Profilo dopo l'accesso): ${password}`);
  }
  console.log(`Database: ${file}`);
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(`Errore: ${e.message}`);
    process.exit(1);
  }
  throw e;
} finally {
  db.close();
}
