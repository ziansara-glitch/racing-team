# Racing Team

Management platform for Racing Team / UniPG (formerly *UNIPG Racing Hub*): members, teams, projects, documents, calendar, requests, automation and an AI assistant, with server-side role-based access.

**Status:** due prodotti sulla stessa base dati — **Racing Team Admin** (`/admin`, per amministratori e responsabili di team) e **Racing Team App** (`/app`, per membri e studenti, mobile-first). Funzionano team, calendari, sondaggi settimanali di riunione con presenza, chat con media e note vocali, notifiche e tempo reale. Mancano ancora documenti, viste avanzate dei progetti, editor dei ruoli, AI e automazioni: l'**inventario onesto, funzione per funzione**, è in [`docs/05-ecosystem.md`](docs/05-ecosystem.md) §9–10.

## Requirements

- **Node.js 24** (`.nvmrc`). The app uses the built-in `node:sqlite` module and runs TypeScript scripts natively.
- No external services are needed to run it.

## Quick start

```bash
npm ci
npm run db:seed            # demo data; writes demo logins to data/credentials.local.txt (git-ignored)
npm run dev                # http://localhost:3000
```

Accessi demo (nel file `data/credentials.local.txt`): un **Super Admin** (`admin@racinghub.test`, vede tutto), un **responsabile di team** (`giulia@racinghub.test`, ambito ristretto al team Aerodinamica) e un **membro** (`member@racinghub.test`, solo App).

An existing `data/racing.db` is migrated automatically on first start (additive; take a copy first — see *Backups*). Use `npm run db:seed -- --reset` to recreate a demo database from scratch.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js development, production build, production server |
| `npm test` | Vitest suite (real SQLite databases, in memory) |
| `npm run lint` | ESLint, including the "no database imports in pages/components" rule |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:seed` | Demo database |
| `npm run admin:create -- …` | Primo Super Admin di un database nuovo, `--reset-password`, `--suspend` / `--reactivate` (da server, vedi [`docs/06-deployment.md`](docs/06-deployment.md)) |
| `npm run db:backup` | Copia consistente del database con controllo di integrità e rotazione (non include i file caricati) |

Before sending a change: `npm run typecheck && npm run lint && npm test && npm run build`.

## Layout

```
migrations/        Forward-only SQL migrations (NNNN_name.sql), checksummed; see docs/03-data-model.md
src/app/admin/     Racing Team ADMIN (guardia admin.access in ogni pagina e azione)
src/app/app/       Racing Team APP (membri e studenti)
src/app/api/       SSE (realtime), chat, upload, media (autorizzati a ogni richiesta), ricerca
src/instrumentation.ts  Scheduler in-process: promemoria, sondaggi scaduti, bozze ricorrenti, file orfani
src/components/    UI components
src/server/        Server-only code
  core/            Dominio puro (riceve la connessione): team, calendari, sondaggi, chat, progetti, task, notifiche, ricerca…
  app.ts           Collega il core al database dell'app: pagine e azioni importano solo da qui
  db/              Connection, transactions, migration runner
  authz/           Roles, permissions, Actor, can()  (pure, tested)
  auth/            Passwords, sessions, route guards
  dal/             Data access layer: authorises inside, returns DTOs
  audit.ts         Append-only audit log
  rate-limit.ts    Persistent rate limiter
docs/              Discovery, product spec, architecture, data model, roadmap
```

## Security model in one paragraph

Every request resolves to an **Actor** (user + active membership + role + team ids + effective permissions). Pages and actions call `requireUser / requireActor / requirePermission` themselves; the DAL takes the Actor and scopes every query by its organisation. Defaults for the six roles live in `src/server/authz/permissions.ts` and are cross-checked against the table in `docs/01-product-spec.md` by a test; organisations store only their *overrides*. Sessions are opaque tokens whose SHA-256 is stored; login failures are rate-limited in the database; security-relevant actions are written to an append-only `audit_logs` table.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_FILE` | `data/racing.db` | SQLite file |
| `STORAGE_DIR` | `data/storage` | Cartella dei file caricati (fuori da `public/`, serviti solo da `/api/media` dopo i controlli di accesso) |
| `DEMO_DATA` | — | Obsoleto: non usato dalla nuova interfaccia |

Planned variables (AI, email, storage, monitoring) are listed in `docs/02-architecture.md` §10; each feature that needs one ships with a visible disabled state.

## Backups

`data/` is git-ignored. Before upgrading a database that holds real data, copy it consistently:

```bash
sqlite3 data/racing.db ".backup 'data/backups/racing-$(date +%F).db'"
```

## Documentation

1. [`docs/00-discovery.md`](docs/00-discovery.md) — sources, HTT analysis, existing code audit, assumptions, open questions
2. [`docs/01-product-spec.md`](docs/01-product-spec.md) — roles and permission matrix, modules, navigation
3. [`docs/02-architecture.md`](docs/02-architecture.md) — decisions (ADRs), security, AI, automation
4. [`docs/03-data-model.md`](docs/03-data-model.md) — schema map and migration plan
5. [`docs/04-roadmap.md`](docs/04-roadmap.md) — slices, integrations and credentials, risks, known limitations
6. [`docs/06-deployment.md`](docs/06-deployment.md) — messa in produzione su Google Cloud (VM + Caddy + systemd), backup, sicurezza: cosa è provato e cosa no

> This is **not** standard Next.js: version 16 renames `middleware` to `proxy` and changes other conventions. Read the guides in `node_modules/next/dist/docs/` before writing framework code (`AGENTS.md`).
