// Copia consistente del database (anche mentre l'app è in uso) con controllo di integrità e rotazione.
//
//   npm run db:backup
//
// Variabili: DATABASE_FILE (default data/racing.db), BACKUP_DIR (default data/backups),
// BACKUP_KEEP_DAYS (default 14). I file caricati (STORAGE_DIR) NON sono inclusi: vanno copiati a parte
// (vedi docs/06-deployment.md). Una copia che resta sullo stesso disco non protegge da un guasto del disco:
// carica anche la cartella dei backup fuori dal server.
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const file = process.env.DATABASE_FILE ?? path.join(process.cwd(), "data", "racing.db");
const dir = process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
const keepDays = Number(process.env.BACKUP_KEEP_DAYS ?? 14);

if (!fs.existsSync(file)) {
  console.error(`Database non trovato: ${file}`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const dest = path.join(dir, `racing-${stamp}.db`);

const source = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
try {
  await backup(source, dest);
} finally {
  source.close();
}

// La copia nasce in modalità WAL: la si riporta a file singolo, così non lascia file -wal/-shm accanto
// e si ripristina copiandola e basta.
const copy = new DatabaseSync(dest);
const check = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
if (check === "ok") copy.exec("PRAGMA journal_mode = DELETE;");
copy.close();
if (check !== "ok") {
  fs.rmSync(dest, { force: true });
  console.error(`Backup scartato: controllo di integrità fallito (${check}).`);
  process.exit(1);
}
fs.chmodSync(dest, 0o600);
console.log(`Backup creato: ${dest} (${fs.statSync(dest).size} byte, integrità ok)`);

// Rotazione: elimina solo i file con il nostro nome più vecchi di BACKUP_KEEP_DAYS, mai l'ultimo creato.
const limit = Date.now() - keepDays * 86_400_000;
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f);
  if (p !== dest && /^racing-\d{8}-\d{6}\.db$/.test(f) && fs.statSync(p).mtimeMs < limit) {
    fs.rmSync(p);
    console.log(`Rimosso backup vecchio: ${f}`);
  }
}
