# 04 — Roadmap, integrations, risks

Phase 1 · Status vocabulary: **Built** · **To configure** · **Designed** (from the HTT report)

## 1. Implementation roadmap (vertical slices)

Each slice ships UI + backend + persistence + authorisation + loading/empty/error states + validation + tests, or it is not marked Built.

| Phase | Slice | Exit criteria |
| --- | --- | --- |
| **0 — Environment** | Node 24 toolchain, baseline lint/build, backups | ✅ **Done.** Node 24.22.2 in `~/.local` (official tarball, SHA-256 verified); baseline lint + build passed before any change; DB + source backups in `data/backups/` |
| **1 — Discovery** | `docs/00–04` | ✅ Written; **awaiting owner review** |
| **2A — Security foundation** | Migration runner; tenancy + RBAC tables and backfill; permission catalog + `can()`; Actor + DAL conventions; audit log; DB-backed rate limits; session metadata | ✅ **Built and verified** (see below). Not yet done from the 2A plan: invitations/consents tables, role editor, typed action results (→ 2B/2C) |

**2A verification (2026-11-06):** `npm run typecheck`, `npm run lint` and `npm test` (**91 tests**, 7 files) pass; `npm run build` passes with 9 workers; three deliberate mutations (a permission default, the rate-limit window reset, audit redaction) each made tests fail, then were reverted. Migrations were applied to a copy of the real backup DB (data preserved, one membership per user, FK + integrity checks clean) and raced from 8 concurrent processes (applied exactly once). In a browser against a seeded scratch DB: super-admin login and the members/budget/applications pages; creating a member wrote user + membership + team link + audit row atomically; a plain member was bounced from all three admin pages with no data shown; five failed logins locked the correct password out, and the lock survived a server restart. **Not tested:** `next dev` mode, Safari/Firefox, the member's other pages after the refactor beyond `/member`, concurrent writers beyond the migration race, and any production deployment.
| **2B′ — Admin + App, team, calendari, sondaggi, chat** (scopo ampliato) | Due prodotti separati sulla stessa base dati; team; calendari; sondaggi con presenza; chat con media; tempo reale SSE; notifiche; profilo | ✅ **Costruito in gran parte.** Inventario completo con le lacune in [05-ecosystem.md](05-ecosystem.md) §9–10. **207 test**; flusso admin→membro→admin provato nel browser |
| **2B — Design system and shell** | Tokens, `ui/*` components (button, input, dialog, menu, table, toast, skeleton, empty/error states), new app shell, theme, ⌘K palette skeleton, typed action results (fixes silent failures) | Accessible keyboard/focus behaviour; light + dark; mobile layout; existing pages ported without behaviour loss |
| **2C — Org management** | Teams, hierarchy, members, invitations, roles & permissions editor, profiles, directory | Role changes enforced server-side; last-Super-Admin guard tested |
| **3A — Projects and tasks** (core ✅ testato; interfaccia parziale: vedi 05-ecosystem.md) | Projects, templates, tasks/subtasks, dependencies, milestones; list, Kanban (drag & drop + keyboard), overview; comments, activity | Drag-and-drop persists order; dependency cycles rejected; authorisation tests |
| **3B — Calendar** | Events, participants, reminders, recurrence, deadline overlay, ICS export | Recurrence + timezone tests; ICS validated |
| **3C — Documents** | Upload, folders, versions, ACL, preview, download, text indexing for text formats | Unauthorised download denied (test); version history works |
| **3D — Requests** | Configurable types, take-in-charge → approve/reject → resolve, timeline | Reviewer-only approval enforced (HTT-style refusal test) |
| **3E — Workspace + notifications + Command Center** | Announcements, discussions, notes, decisions/action items, notification centre, role-specific dashboards | Mentions notify only authorised users |
| **4A — Search + palette** | FTS5 index, permission-aware search, ⌘K actions | Search never returns an unauthorised hit (test) |
| **4B — Automation** | Outbox, rules UI, executions, retries, loop guard | Loop guard and idempotency tests; kill-switch |
| **4C — Racing AI** | Provider abstraction, tools, confirmation protocol, knowledge sources, document Q&A | Authorisation + prompt-injection tests; disabled state verified without a key |
| **4D — Analytics** | KPIs, CSV/PDF export, calculated vs estimated labelling | Numbers cross-checked against raw queries in tests |
| **5 — Quality** | E2E (Playwright) on critical flows, a11y pass, performance pass, error-boundary coverage | Critical flows green in CI |
| **6 — Deployment** | Production config, env docs, backup/restore drill, health + monitoring, CI/CD | Fresh-machine deploy follows the doc end-to-end. **In parte:** [06-deployment.md](06-deployment.md) scritta; script `admin:create` e `db:backup`, header di sicurezza e avvio in produzione provati in locale (2026-11-08). **Non provati su Google Cloud:** VM, DNS, Caddy, systemd, backup su Cloud Storage, ripristino. Nessuna CI/CD |

Rollout (HTT-style, with go/no-go gates): 1) verify with the owner on agreed scenarios → 2) prepare content, roles, teams → 3) pilot with one team/project → 4) extend.

## 2. External integrations and credentials

| Integration | Purpose | Status | Needs | Credential-free fallback |
| --- | --- | --- | --- | --- |
| Google Gemini | Racing AI | **To configure** | `GEMINI_API_KEY`; org AI flag + recorded consent; decision on data-policy (see discovery Q4) | Search + saved reports |
| Email (SMTP or provider) | Invitations, reminders | **To configure** | `SMTP_URL` (or provider key) | In-app notifications; invite link shown to admin |
| Google Calendar / Microsoft 365 | Two-way calendar sync | **Designed** | OAuth client id/secret and consent screen approved by the account owner | **ICS export/subscribe feed** (Built in 3B) |
| S3-compatible storage | Files and backups off-site | **To configure** | endpoint, bucket, access/secret key | Local disk + manual backup |
| Web Push | Browser notifications | **Designed** | VAPID keys | In-app notifications |
| Sentry (or similar) | Error monitoring | **To configure** | `SENTRY_DSN` | Structured logs + `/api/health` |
| University SSO (OIDC/SAML) | Login | **Not assumed** | Written approval and client registration from UniPG IT | Email + password |
| Slack / Teams / WhatsApp | Notifications out | **Designed** | Provider accounts and API keys | In-app notifications |

Each integration gets a card on `/org/integrations` showing its status, the exact variables required, and a **Test connection** action; it never reports "connected" without a real successful call.

## 3. Risk analysis

| # | Risk | L | I | Mitigation |
| --- | --- | :-: | :-: | --- |
| R1 | Scope is very large; breadth could erode quality | H | H | Vertical slices; "Built" only with tests; honest status table |
| R2 | Cross-user / cross-tenant data leak through a forgotten check | M | H | DAL requires an `Actor`; composite FKs; isolation tests over every DAL function; lint rule against `db` imports outside `src/server` |
| R3 | AI exposes unauthorised data or is steered by injected text | M | H | Tools run as the user; fenced retrieval; confirmation for writes; no destructive tools; tests with hostile document content |
| R4 | File upload abuse (malware, active content, path traversal) | M | H | Allow-list + sniffing, random keys, attachment disposition, no direct static serving; malware scanning flagged **Designed** |
| R5 | Automation loops or runaway cost | M | M | Depth limit, idempotency key, per-rule caps, kill-switch, run-as actor |
| R6 | `node:sqlite` API change or single-instance limit | M | M | Pin Node; DAL/migration tests; documented exit to PostgreSQL |
| R7 | Data loss during migrations | L | H | Backup before migrate; checksum guard; migrations tested on a copy; expand/contract |
| R8 | Sending student/member data to Google without a policy basis | M | H | AI off by default, consent record, minimisation, owner decision (Q4) |
| R9 | Next.js 16 differs from prior knowledge (`proxy`, caching, async APIs) | M | M | Read the bundled docs before each feature (`AGENTS.md`) |
| R10 | Supply-chain risk from new npm dependencies | M | M | Few, well-known packages; pinned lockfile; `npm audit` in CI |
| R11 | Misleading metrics in analytics | M | M | Calculated / estimated / AI labels; tests against raw SQL |
| R12 | Institutional claims (UniPG procedures, SSO) implied by the UI | L | M | Example request types labelled; no UniPG integration claimed anywhere |
| R13 | Demo credentials or secrets committed | L | H | `.env*` and `/data/` already git-ignored; `data/backups/` inherits that; secret scanning in CI |

## 4. Known limitations (current and planned)

- **Nuove lacune dichiarate (vedi 05-ecosystem.md §9):** nessun documento; interfaccia dei progetti limitata alla tabella «Compiti» (le viste Board/Gantt/Calendario, le impostazioni di progetto, le viste salvate e l'import/export CSV hanno il motore ma non l'interfaccia); nessun editor di ruoli e permessi; nessun flusso di inviti; nessuna gestione dei membri dei gruppi admin da interfaccia; nessuna email, push, ricerca GIF, Racing AI, automazioni.
- **Fuso orario unico:** gli orari degli eventi sono «ora locale dell'organizzazione» (default Europe/Rome), senza fuso per evento.
- **Contatti e presenza:** i contatti li vedono admin con ambito completo e, per un responsabile di team, solo chi condivide un suo team; gli admin possono sempre scrivere ai membri (salvo blocco).
- **Tempo reale a istanza singola:** il bus è in memoria del processo (vedi ADR-2). Gli eventi portano solo gli identificativi; chi viene rimosso da un team smette subito di poter leggere, ma può ricevere ancora per pochi istanti un evento senza contenuto.

- Repository has **no commits**; history starts when the owner commits. A pre-change DB backup and source tarball are in `data/backups/` (git-ignored).
- Legacy tables (`tasks`, `meetings`, `attendance`, `entries`, `applications`) are not organisation-scoped yet: **a second organisation must not be created** until slices 3A/3B/… migrate them.
- Server actions still return silently on invalid input (no error message shown); fixed with typed action results in slice 2B.
- `users.role / department / title` are still written for compatibility; authorisation now reads `memberships`. Removed in the contract migration (0013).
- `npm audit`: 0 vulnerabilities in production dependencies; 8 moderate findings in dev-only lint tooling (`minimatch` via `eslint-config-next`). The suggested `npm audit fix --force` would downgrade `eslint-config-next` to 15.x, so it was not applied.
- The `db:*` and `admin:create` scripts run with `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` (the warning is harmless; adding `"type": "module"` was avoided to keep the Next/ESLint configs untouched). Running `node scripts/x.ts` directly still prints it.
- Operations without UI (until built): suspending a member, resetting a password and creating the first admin are command-line only (`npm run admin:create`); there is no 2FA, no email recovery and no forced password change. Full list in [06-deployment.md](06-deployment.md) §3.
- Single app instance; no live updates yet; no malware scanning; no SSO.
- PDF/Office text extraction deferred; those files are stored but flagged "not indexed".
- Email, AI, external calendars, off-site backup are **To configure**.
- Report figures from the HTT PDF (costs, ROI) are HTT's estimates and are not used as Racing Team data.
- The HTT report's figures and UML diagrams were not inspected (images).
