// Uso: npm run db:seed [-- --reset]
// Crea il database con dati dimostrativi e scrive le password generate in data/credentials.local.txt.
// I contenuti (task, eventi, sondaggio, messaggi) passano dal core del dominio, come farebbe l'applicazione:
// così la demo rispetta le stesse regole (permessi, notifiche, isolamento) e non può divergere dal codice.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadActor } from "../src/server/authz/actor.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { createEvent, teamCalendar, listCalendars } from "../src/server/core/calendar.ts";
import { listConversations, sendMessage } from "../src/server/core/chat.ts";
import { migrate } from "../src/server/db/migrate.ts";
import { createPoll, publishPoll, respondToPoll } from "../src/server/core/polls.ts";
import { createProject, setProjectMember } from "../src/server/core/projects.ts";
import { addDays, all, one, todayISO } from "../src/server/core/sql.ts";
import { ensureTeamResources } from "../src/server/core/teams.ts";
import { createTask, addComment } from "../src/server/core/tasks.ts";
import { mondayOf } from "../src/server/core/recurrence.ts";

const root = process.cwd();
const file = process.env.DATABASE_FILE ?? path.join(root, "data", "racing.db");
fs.mkdirSync(path.dirname(file), { recursive: true });

if (process.argv.includes("--reset")) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

const db = new DatabaseSync(file);
db.exec("PRAGMA foreign_keys = ON;");
migrate(db, path.join(root, "migrations"));

const existing = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
if (existing.n > 0) {
  console.error("Il database contiene già degli utenti. Usa --reset per ricrearlo.");
  process.exit(1);
}

// role = ruolo legacy del form; platform = ruolo di piattaforma. I responsabili di reparto sono Team Admin:
// vedono nell'Admin solo il proprio team (ambito ristretto). Direzione = amministratori dell'organizzazione.
const people = [
  { name: "Edoardo Meozzi", email: "admin@racinghub.test", role: "admin", platform: "super_admin", department: "Direzione", title: "Team Leader & Technical Director", login: true },
  { name: "Alessandro Gambelunghe", email: "alessandro@racinghub.test", role: "admin", platform: "org_admin", department: "Direzione", title: "CFO" },
  { name: "Giulia Rossi", email: "giulia@racinghub.test", role: "admin", platform: "team_admin", department: "Aerodinamica", title: "Responsabile reparto", login: true },
  { name: "Marco Bianchi", email: "member@racinghub.test", role: "member", platform: "member", department: "Aerodinamica", title: "Membro", login: true },
  { name: "Sara Conti", email: "sara@racinghub.test", role: "admin", platform: "team_admin", department: "Business", title: "Responsabile reparto" },
  { name: "Luca Ferri", email: "luca@racinghub.test", role: "member", platform: "member", department: "Telaio & Dinamica", title: "Membro" },
  { name: "Chiara Neri", email: "chiara@racinghub.test", role: "admin", platform: "team_admin", department: "Software & Telemetria", title: "Responsabile reparto" },
  { name: "Paolo Gori", email: "paolo@racinghub.test", role: "member", platform: "member", department: "Motore", title: "Membro" },
  { name: "Elena Moretti", email: "elena@racinghub.test", role: "admin", platform: "team_admin", department: "Media & Design", title: "Responsabile reparto" },
];

const insertUser = db.prepare("INSERT INTO users (name, email, password_hash, role, department, title) VALUES (?, ?, ?, ?, ?, ?)");
const insertMembership = db.prepare("INSERT INTO memberships (org_id, user_id, role, title) VALUES (1, ?, ?, ?)");
const insertTeamMember = db.prepare(
  "INSERT INTO team_members (team_id, membership_id, org_id, role) SELECT t.id, ?, 1, ? FROM teams t WHERE t.org_id = 1 AND t.name = ?",
);
const userIds = new Map<string, number>();
const credentials: string[] = [];

for (const p of people) {
  // Gli account senza `login` ricevono una password casuale che non viene salvata: l'admin ne imposta una vera.
  const password = randomBytes(12).toString("base64url");
  const res = insertUser.run(p.name, p.email, await hashPassword(password), p.role, p.department, p.title);
  const userId = Number(res.lastInsertRowid);
  userIds.set(p.name, userId);
  const membershipId = Number(insertMembership.run(userId, p.platform, p.title).lastInsertRowid);
  insertTeamMember.run(membershipId, p.title.startsWith("Responsabile") ? "lead" : "member", p.department);
  if (p.login) credentials.push(`${p.platform.padEnd(11)} ${p.email}  ${password}`);
}

const A = (name: string) => loadActor(db, userIds.get(name)!)!;
const mid = (name: string) => A(name).membershipId;
const admin = A("Edoardo Meozzi");
const today = todayISO();
const at = (days: number, time: string) => `${addDays(today, days)}T${time}`;

// Calendari, chat e canali annunci per ogni team.
for (const t of all<{ id: number }>(db, "SELECT id FROM teams WHERE org_id = 1 AND deleted_at IS NULL")) ensureTeamResources(db, 1, t.id, admin.membershipId);

// ───── Compiti (progetto GEN, importato dalla vecchia lista) ─────
const gen = one<{ id: number }>(db, "SELECT id FROM projects WHERE org_id = 1 AND key = 'GEN'")!;
const reparto = one<{ id: number }>(db, "SELECT id FROM custom_fields WHERE project_id = ? AND name = 'Reparto'", gen.id)!;
const statusId = (name: string) => one<{ id: number }>(db, "SELECT id FROM project_statuses WHERE project_id = ? AND name = ?", gen.id, name)!.id;
for (const [title, dep, who, due, status] of [
  ["Simulazione CFD ala posteriore", "Aerodinamica", "Giulia Rossi", 6, "In corso"],
  ["Report prove in galleria del vento", "Aerodinamica", "Marco Bianchi", 14, "Da fare"],
  ["Aggiornare business plan", "Business", "Sara Conti", 9, "In corso"],
  ["Contattare nuovi sponsor", "Business", "Sara Conti", 24, "Da fare"],
  ["Analisi strutturale telaio", "Telaio & Dinamica", "Luca Ferri", 12, "Da fare"],
  ["Dashboard telemetria live", "Software & Telemetria", "Chiara Neri", 4, "In corso"],
  ["Calibrazione centralina", "Motore", "Paolo Gori", -1, "Completato"],
  ["Post social: galleria del vento", "Media & Design", "Elena Moretti", -3, "Completato"],
] as const) {
  createTask(db, admin, gen.id, { title, assigneeId: mid(who), dueDate: addDays(today, due), statusId: statusId(status), fields: { [reparto.id]: dep } });
}

// ───── Un progetto da template ─────
const aero = createProject(db, admin, { key: "AERO", name: "Ala anteriore 2027", description: "Sviluppo del nuovo profilo dell'ala anteriore.", templateKey: "engineering", visibility: "org", startDate: addDays(today, -10), teamId: one<{ id: number }>(db, "SELECT id FROM teams WHERE name = 'Aerodinamica'")!.id, ownerMembershipId: mid("Giulia Rossi"), color: "#3b82f6" });
for (const n of ["Giulia Rossi", "Marco Bianchi"]) setProjectMember(db, admin, aero.id, mid(n), n === "Giulia Rossi" ? "manager" : "member");
const firstTask = one<{ id: number }>(db, "SELECT id FROM tasks WHERE project_id = ? AND number = 1", aero.id)!;
addComment(db, A("Marco Bianchi"), "task", firstTask.id, "Ho raccolto i requisiti dal reparto telaio, li carico oggi. @Giulia", [mid("Giulia Rossi")]);

// ───── Calendari ─────
const adminCal = listCalendars(db, admin).find((c) => c.kind === "admin")!;
createEvent(db, admin, adminCal.id, { title: "Riunione direttivo", kind: "meeting", categoryId: 1, startsAt: at(2, "18:30"), endsAt: at(2, "20:00"), location: "Dip. Ingegneria, Sala riunioni", recurrence: { freq: "weekly" }, reminders: [60] });
createEvent(db, admin, adminCal.id, { title: "Scadenza iscrizione Formula SAE", kind: "deadline", categoryId: 2, startsAt: at(20, "00:00"), endsAt: at(20, "23:59"), allDay: true });
const aeroTeam = one<{ id: number }>(db, "SELECT id FROM teams WHERE name = 'Aerodinamica'")!.id;
const aeroCal = teamCalendar(db, A("Giulia Rossi"), aeroTeam);
createEvent(db, A("Giulia Rossi"), aeroCal.id, { title: "Prove in galleria del vento", kind: "activity", categoryId: 3, startsAt: at(5, "09:00"), endsAt: at(5, "17:00"), location: "Laboratorio di aerodinamica", reminders: [1440] });
createEvent(db, A("Giulia Rossi"), aeroCal.id, { title: "Revisione tecnica reparto", kind: "meeting", categoryId: 1, startsAt: at(1, "17:30"), endsAt: at(1, "19:00"), location: "Officina", reminders: [60] });
const bizCal = teamCalendar(db, A("Sara Conti"), one<{ id: number }>(db, "SELECT id FROM teams WHERE name = 'Business'")!.id);
createEvent(db, A("Sara Conti"), bizCal.id, { title: "Incontro sponsor", kind: "meeting", categoryId: 1, startsAt: at(8, "15:00"), endsAt: at(8, "16:00"), meetingUrl: "https://meet.example.org/sponsor-demo" });

// ───── Sondaggio settimanale del team Aerodinamica (aperto, con un voto) ─────
const nextMonday = addDays(mondayOf(today), 7);
const pollId = createPoll(db, A("Giulia Rossi"), {
  teamId: aeroTeam, title: "Riunione settimanale Aerodinamica", description: "Portate i risultati delle simulazioni CFD.", weekStart: nextMonday, meetingType: "hybrid",
  location: "Aula T", meetingUrl: "https://meet.example.org/aero-demo", durationMinutes: 90, deadline: `${addDays(today, 3)}T20:00`, recurrence: "weekly",
  options: [
    { date: addDays(nextMonday, 1), startTime: "18:00", endTime: "19:30" },
    { date: addDays(nextMonday, 2), startTime: "18:00", endTime: "19:30" },
    { date: addDays(nextMonday, 3), startTime: "21:00", endTime: "22:30" },
  ],
});
publishPoll(db, A("Giulia Rossi"), pollId);
const options = all<{ id: number }>(db, "SELECT id FROM poll_options WHERE poll_id = ? ORDER BY date, start_time", pollId);
respondToPoll(db, A("Giulia Rossi"), pollId, { votes: [{ optionId: options[0].id, availability: "yes" }, { optionId: options[1].id, availability: "yes" }, { optionId: options[2].id, availability: "no" }], preferredOptionId: options[1].id, attendance: "attending" });

// ───── Chat ─────
const chatOf = (who: string, kind: string, teamName: string) => listConversations(db, A(who)).find((c) => c.kind === kind && c.title.includes(teamName))!.id;
sendMessage(db, A("Giulia Rossi"), chatOf("Giulia Rossi", "team_group", "Aerodinamica"), { body: "Ricordo a tutti di caricare i dati delle prove entro venerdì." });
sendMessage(db, A("Marco Bianchi"), chatOf("Marco Bianchi", "team_group", "Aerodinamica"), { body: "Ricevuto! Carico i file stasera." });
sendMessage(db, A("Giulia Rossi"), chatOf("Giulia Rossi", "announcement", "Aerodinamica"), { body: "Le prove in galleria del vento sono confermate: portate il casco e le scarpe antinfortunistiche." });

// ───── Budget e candidature (invariati) ─────
const entry = db.prepare("INSERT INTO entries (label, kind, category, amount, date) VALUES (?, ?, ?, ?, ?)");
entry.run("Sponsorizzazione azienda locale", "Entrata", "Sponsor", 3000, addDays(today, -32));
entry.run("Contributo Università", "Entrata", "Sponsor", 2000, addDays(today, -25));
entry.run("Fibra di carbonio", "Uscita", "Materiali", 1450, addDays(today, -19));
entry.run("Iscrizione Formula SAE Italy", "Uscita", "Iscrizioni", 1200, addDays(today, -15));

const app = db.prepare("INSERT INTO applications (name, course, year, interests, status) VALUES (?, ?, ?, ?, ?)");
app.run("Anna Verdi", "Ingegneria Meccanica", "Secondo anno triennale", "Telaio & Dinamica", "Nuova");
app.run("Davide Russo", "Economia Aziendale", "Primo anno magistrale", "Business", "Colloquio");
app.run("Marta Gallo", "Design", "Terzo anno triennale", "Media & Design,Officina", "Nuova");

const out = path.join(path.dirname(file), "credentials.local.txt");
fs.writeFileSync(out, `Account dimostrativi (solo sviluppo locale)\n\n${credentials.join("\n")}\n`, { mode: 0o600 });
console.log(`Database creato in ${file}\nCredenziali scritte in ${out}`);
