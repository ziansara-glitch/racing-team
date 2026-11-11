# 02 — Architecture

Phase 1 · Status: accepted by the owner for ADR-2 on 2026-11-06; the rest is a proposal for review.

## 1. Decision log

| ADR | Decision | Status |
| --- | --- | --- |
| 1 | Next.js 16 App Router, React 19, TypeScript, Tailwind 4. Server Components + Server Actions. **`proxy.ts`** (not `middleware.ts`). No `cacheComponents` (every page is session-bound). | Accepted (existing) |
| 2 | **SQLite via `node:sqlite`**, one app instance with a persistent disk. | **Accepted by owner** |
| 3 | Keep the custom session auth; extend it (see §4). | Proposed |
| 4 | Org-scoped RBAC + resource scopes, enforced inside a Data Access Layer. | Proposed |
| 5 | `proxy.ts` does only optimistic redirects and security headers. | Proposed |
| 6 | AI behind an `AiProvider` interface; Gemini first; off by default. | Proposed |
| 7 | Files on a `StorageProvider` (local disk first, S3-compatible later). | Proposed |
| 8 | Search with SQLite FTS5 behind a `SearchIndex` interface. | Proposed |
| 9 | Automation: transactional outbox + in-process scheduler + secured tick endpoint. | Proposed |
| 10 | UI: token-based design system; Radix primitives, `lucide-react`, `cmdk`, `@dnd-kit`. | Proposed |
| 11 | `zod` at every trust boundary. | Proposed |
| 12 | Vitest against real temp SQLite databases; Playwright later for critical flows. | Proposed |

### ADR-2 — Data platform

Options weighed on 2026-11-06 (the owner chose the first):

| | **SQLite (`node:sqlite`)** | Firebase + Cloudflare (HTT's stack) | PostgreSQL + ORM |
| --- | --- | --- | --- |
| Fit with existing repo | Already in use; incremental | Replaces the data layer | Replaces the data layer |
| Testable on the dev machine today | **Yes** | Needs a Firebase project or emulator (Java) | No Postgres instance available |
| Relational integrity, transactions, ad-hoc reports | **Yes** (FKs, composite FKs, `BEGIN IMMEDIATE`) | Weaker; denormalisation; reports are hard | Yes |
| Per-document permissions + search | SQL predicate + FTS5 | Needs a separate search service | Yes (`tsvector`) |
| Live updates | Not built in (SSE/polling) | Built in | Not built in |
| Horizontal scale / multi-instance | **No** (single writer, one disk) | Yes | Yes |
| Runs on Cloudflare Workers | **No** (no `node:sqlite`, no disk) | Yes (HTT did) | Via a connection proxy |
| Ops burden | Lowest | Low (managed) | Medium |

**Verified here (2026-11-06):** Node 24.22.2 bundles SQLite 3.53.4; FTS5 with `bm25()` works; native TypeScript type-stripping works (needed by `scripts/seed.ts`).

**Consequences**
- Deploy to a Node host with a **persistent volume** (a small VPS, or a platform with volumes). Cloudflare may still sit in front as DNS/CDN/WAF; it cannot run the app.
- One app process owns the database file. WAL mode, `busy_timeout`, and short transactions. Scheduler runs in that same process.
- `node:sqlite` is a built-in module whose API can change across Node majors: pin Node (`engines`, `.nvmrc`) and keep DAL/migration tests as the safety net.
- **Exit path:** only the DAL and `SearchIndex` touch SQL. If usage outgrows one instance, port the DAL to PostgreSQL (schema is ANSI-leaning; FTS5 → `tsvector`).
- Live updates: server-sent events from a route handler can be added in Phase 3; until then pages revalidate on navigation/actions. *Designed*, not built.

## 2. Layers

```
Browser ── RSC pages / client islands
            │  (props are DTOs only; no db import in pages or components)
            ▼
Server Actions / Route Handlers   ← zod validation, rate limit, CSRF (Origin checks built into Server Actions)
            ▼
Services (use cases)              ← business rules, one transaction per use case,
            │                       emit domain events, write audit log
            ▼
Data Access Layer (DAL)           ← authorisation inside every function: (actor, input) → DTO
            ▼                       org_id scoping is mandatory, never optional
SQLite  (node:sqlite, WAL)        + FTS5 index + StorageProvider (files)
```

Rules (enforced by lint/test where possible):
1. Pages and components never import the DB — **enforced by an ESLint rule** (`no-restricted-imports`, verified to fire). Modules that touch the DB, cookies or secrets start with `import "server-only"`. Pure modules (`authz/*`, `audit`, `rate-limit`, `db/migrate`) take a connection as a parameter so tests can run them on throwaway databases. *Legacy exception:* server actions in `src/app/actions/` still run SQL directly; they move behind services module by module.
2. A DAL function **cannot be called without an `Actor`**; it returns DTOs, never raw rows with secrets (`password_hash`, tokens).
3. `org_id` is derived from the actor, never from request input.
4. Foreign keys between tenant tables are **composite** `(x_id, org_id)` so a cross-tenant reference is impossible at the database level.
5. Pages and actions call `requireUser()`/`requirePermission()` themselves — layouts are not re-run on every navigation (the existing code already documents this).

## 3. Authorisation

- `Actor = { userId, orgId, membershipId, role, teamIds, projectRoles }`, built once per request (cached) from the session.
- `can(actor, permission, resource?)`: permission from `role_permissions` (defaults in code, editable per org), then scope check (`all` vs. `scoped` → team/project membership).
- Document, project and request visibility are SQL predicates shared by **reads, search, export, notifications and AI retrieval**, so there is exactly one definition of "may see".
- Denied lookups return "not found" for resources the actor cannot know exist (uniform error — pattern from HTT's guest links).
- Super Admin lock-out guard: the last Super Admin cannot be demoted, suspended or removed.

## 4. Authentication and sessions

Keep: scrypt hashing, 256-bit opaque token with only SHA-256 stored, httpOnly + SameSite=lax + Secure (prod) cookie, constant-time verify, dummy hash for unknown email.
**Built (slice 2A, verified end to end in a browser against a scratch database):** `created_at / last_seen_at / user_agent / org_id` on sessions; a session is valid only while the user has an **active membership**; other sessions are revoked on password change; **DB-backed rate limits** (`rate_limits`, keys stored as hashes) for login failures (5 per 5 min per email) and for current-password guesses on the account page — the lockout survives a server restart; audit entries for login success/failure/denied, logout, password change, member creation, budget entries, application status changes.
**Designed, not built:** password policy (≥ 12 chars + deny-list); invitation flow with hashed, expiring, single-use tokens; audit of role changes (no role editor exists yet); "sign out other devices" button. No email is sent unless SMTP is configured — until then the invite page shows the link to the admin.
**Known trade-offs:** the login lock is keyed by email, so someone who knows an address can lock that account for 5 minutes (the previous in-memory design had the same property). There is no per-IP limit yet because the client IP comes from forgeable headers until a trusted proxy is configured. Blocked attempts are not written to the audit log (to avoid log flooding); failures are.
**Not assumed:** university SSO. An OIDC provider can be added later behind `AuthProvider`; it would be *To configure*, never claimed.

## 5. Security controls

| Threat | Control |
| --- | --- |
| IDOR / cross-tenant read | DAL requires `Actor`; composite FKs; tests assert a user of org A cannot read or write org B objects across every DAL function |
| Privilege escalation | Server-side `can()` on every action; role changes audited; Super Admin guard; no permission trusted from the client |
| CSRF | Server Actions' built-in Origin check; `SameSite=lax`; no state-changing GET |
| SQL injection | Prepared statements only; dynamic identifiers only from allow-lists |
| XSS | React escaping; no `dangerouslySetInnerHTML` without a sanitiser; CSP via `proxy.ts` (nonce) |
| Brute force / abuse | Persisted rate limits (login, uploads, AI, invites) |
| File upload abuse | Size cap, MIME allow-list + magic-byte sniff, storage outside `public/`, authenticated download route, `nosniff`, SVG/HTML only as attachment, random storage keys. **Malware scanning: Designed** (hook only) |
| SSRF via automation webhooks | Webhook action disabled by default; allow-listed hosts; no private IP ranges |
| Prompt injection | Retrieved text is fenced as data; tools run as the user; no tool widens access; mutating tools need confirmation (§6) |
| Secrets exposure | Secrets only in server env; `integrations` stores the *name* of the env var and status, never the value; nothing secret in client bundles or logs |
| Data leaks via exports / notifications / search | Same visibility predicate as reads; exports run through the DAL |
| Tampering with history | `audit_logs` and `request_events` are append-only (triggers reject UPDATE/DELETE) |
| Money errors | Integer cents; status changes only through audited services |

## 6. Racing AI

```
user question
   → Racing AI service (checks: org ai_enabled, user ai.use, rate/budget, consent)
   → AiProvider.generate({system, messages, tools})       # Gemini adapter; OpenAI-compatible adapter possible
   → model proposes tool calls  (zod-validated args)
   → each tool runs through the DAL AS THE USER            # the AI never receives a DB handle
   → results returned to the model as fenced, size-limited data
   → answer + citations (links to the entities used) + "AI-generated" label
   → ai_messages / ai_tool_calls persisted (audit)
```

- **Retrieval (RAG):** candidate generation is a permission-filtered SQL/FTS5 query, *then* ranking. Embeddings, if added, store the visibility fingerprint and are filtered before similarity.
- **Tools (read):** `list_projects`, `list_my_tasks`, `list_overdue_tasks`, `search_documents`, `get_document_excerpt`, `list_meetings`, `get_decisions`, `activity_report`. **Tools (write):** `create_task`, `update_task_status`, `create_event`, … — these return a **proposal**; a `ai_pending_actions` row bound to user + argument hash + expiry; execution only after the user clicks Confirm in the UI. Destructive tools are not exposed at all.
- **Honest states:** no `GEMINI_API_KEY`, or org flag off → the panel shows "Racing AI is not configured" with the exact variable to set, and search keeps working. If the provider errors, a deterministic fallback (search results / saved reports) is shown and labelled as such (HTT pattern).
- **Knowledge sources** (admin-approved text, scoped to all or a team) and a **knowledge-gaps list** of questions the assistant could not answer (HTT pattern).
- **Privacy:** org-level consent recorded with date and policy version; AI off by default; documents flagged `private` are only used for their owner; card/ID-like numbers are stripped from prompts.
- Model identifiers are configuration, resolved at integration time — none are hardcoded in this document.

## 7. Automation engine

`domain_events` (transactional **outbox**, written in the same transaction as the change) → matcher → `automation_executions` → action runners.
- **Triggers:** event (task assigned, request created, document uploaded, status changed…) or schedule (offset relative to a date: "N days before `due_date`").
- **Conditions:** JSON predicate validated against a schema (field/op/value).
- **Actions (allow-list):** notify, create task, create follow-up, request approval, add comment, generate report, send email (*To configure*: SMTP), call webhook (*disabled by default*).
- **Reliability:** `UNIQUE(rule_id, event_id)` idempotency; attempts with exponential backoff (max 3) then `dead` + admin notification; every run recorded with input, result, error.
- **Permission validation:** each rule has `run_as_membership_id`; actions execute through the DAL with that actor, re-checked at run time (a demoted creator's rule stops being able to do what they can no longer do).
- **Loop guard:** events carry `origin_execution_id` and `depth`; depth > 3 is dropped and logged; a rule cannot trigger itself; per-rule and per-org hourly caps; global kill-switch.
- **Runtime:** `instrumentation.ts` starts the scheduler (single process, so no double-run); `POST /api/internal/jobs/tick` guarded by `CRON_SECRET` lets an external scheduler drive it too.

## 8. Files (documents)

`StorageProvider` (put/get/delete/stream). Local driver stores at `storage/<org_id>/<sha256[0:2]>/<sha256>` outside `public/`; metadata and versions live in the DB. Download/preview go through `GET /api/documents/[id]/versions/[n]` which runs the same visibility predicate as the UI. Text extraction for search/AI: plain text, Markdown, CSV first; PDF/DOCX/XLSX/PPTX when an extraction library is added and vetted — until then those files are stored and downloadable but marked **"not indexed"** in the UI.

## 9. Search

`search_index` FTS5 table (`title`, `body`; unindexed `org_id`, `entity_type`, `entity_id`). Query = FTS5 MATCH → join to each entity table's **visibility predicate** → limit. Result counts are computed after the join, never before. Index maintenance happens in the service layer inside the same transaction as the write.

## 10. Observability and operations

- Structured JSON logs with a request id; no secrets or PII in logs.
- `error.tsx` / `not-found.tsx` boundaries per section; typed error results from actions (fixes today's silent failures).
- `GET /api/health` (DB reachable, migrations current).
- **Backups:** SQLite online backup on a schedule (`.backup` / `VACUUM INTO`) + copy off-site to S3-compatible storage; restore drill documented. (Litestream is an option; not tested here.)
- **CI:** lint, typecheck, test, build on every push (GitHub Actions workflow in Phase 6).
- **Environment variables (names only):** `DATABASE_FILE`, `STORAGE_DIR`, `APP_URL`, `SESSION_SECRET` (if signing is added), `CRON_SECRET`, `GEMINI_API_KEY`, `SMTP_URL`, `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY`, `SENTRY_DSN`. All optional except the first three; missing optional ones produce a visible disabled state.

## 11. Known architectural limits (accepted)

Single instance; no built-in live updates yet; PDF/Office text extraction deferred; no malware scanning; no SSO; email only when SMTP is configured; FTS5 is SQLite-specific.
