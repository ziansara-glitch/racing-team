# 00 — Discovery

Phase 1 · 2026-11-06 · Status: draft for review

## 1. What was inspected

| Source | How it was read | Limits |
| --- | --- | --- |
| **HTT project report** — `HTT_Tavolo10_Relazione_Hackcortona2026.pdf` (24 pp., Hackcortona 2026, Tavolo 10, dated 16 Oct 2026) | Read in full. Text extracted with macOS PDFKit (no `poppler` on this machine). | Figures, screenshots and the UML diagrams (Annex B) are images: **only their captions were read**. The live systems it links to were **not visited or tested**; statements about HTT's behaviour come from the report's text. |
| `~/Downloads/HTT Smart Luxury/` | Skimmed (`ops.js` 1–330, `ai.js` 1–100, `core.js` 1–80, section map of all files). | An earlier client-side prototype (all state in `localStorage`). Secondary evidence only; the report supersedes it. |
| This repository (`racing-hub`) | Read: DB layer, auth/session, server actions, queries, schema, seed, layouts, styles. Page components skimmed. | — |
| Next.js 16.4.3 docs in `node_modules/next/dist/docs` | Read `proxy.md`, `middleware.md`, `data-security.md`. Further guides are read per feature before code is written (`AGENTS.md`). | — |

The demo credentials printed in the report's Annex A were deliberately **not** copied into this repository.

## 2. HTT analysis

### 2.1 What HTT is

Three connected tools for a tour operator with ≈32,000 guests/year, ≈4,000 groups and 170 staff (report §1.1): a guest-facing site and personal page, a staff **gestionale**, and a compliance automation for police/ISTAT registration. The report's guiding principle (p. 3): *technology absorbs repetitive work; decisions stay with people; AI changes nothing and nothing leaves without an operator.*

### 2.2 Reusable management patterns

| HTT pattern (report ref.) | Racing Team adaptation |
| --- | --- |
| **Request lifecycle**: pending → taken in charge → approved / rejected → resolved; requester sees the outcome live; an approved change that conflicts with another booking is blocked and leaves data unchanged (§4.2, Fig. 26) | **Request & Approval module** with the same states, a "take in charge" step, and conflict guards on resource bookings |
| **Three-tier handoff** — AI assistant / operator / administrator — with permissions *verified on the server at every request*, and a demonstrable refusal (operator tries to approve → rejected) (§4.3, §6.1) | **RBAC** with six roles (see `01-product-spec.md`) and permission tests that assert refusals |
| **Resource calendar** as a Gantt (one row per villa); overlapping dates rejected, adjacent allowed (leave on the 24th vs arrive on the 24th); maintenance blocks assignment (§4.1) | **Calendar + Timeline** views, and optional **resource bookings** (workshop, vehicle, equipment) with the same overlap rule |
| **Staff-editable knowledge base**, scoped to all properties or one; a list of **questions the assistant could not answer** tells staff what to add (§3.4, §4.4) | **Racing AI knowledge sources** editable by admins, plus a "knowledge gaps" report |
| **AI with declared limits**: always says what it is, answers only from approved content, cannot modify data, strips card/ID numbers, escalates to a human, stops when staff take over (§2.1, §3.4) | **Racing AI rules**: authorised-data-only retrieval, mutating tools return a *proposal* that the user must confirm, visible "AI-generated" labelling, handoff to a person |
| **Provider-swappable AI** through an OpenAI-compatible API; chat keeps working from FAQs when the AI is down (§3.4, §6) | `AiProvider` interface with a Gemini adapter, a deterministic fallback, and a clearly shown disabled state |
| **Scheduled communications** with editable texts (welcome, reminder 7 days before arrival, message 3 days after return) (§4.4) | **Automation engine**: triggers with relative-date offsets, editable templates |
| **Personal link**: random token, only its hash stored, expires, revocable, neutral error for invalid links (§3.2, §6.1) | Invitation tokens and document share links built the same way |
| **Rate limiting** on repeated requests (§6.1) | Persisted (DB-backed) rate limiter, replacing today's in-memory `Map` |
| **Money integrity**: a payment is "paid" only after admin confirmation or a signed provider notification, never on a user's claim; amounts in integer cents (§6.1) | Finance entries move to integer cents; webhook signature verification is the pattern for any future provider |
| **Consent record** with date and policy version, revocable (§6.1) | `consents` table; needed for AI processing consent |
| **Honest status vocabulary**: *Realizzato* (built, testable now) / *Da configurare* (code ready, credentials missing) / *Progettato* (designed only); expected benefits are labelled hypotheses (p. 2, §7.1, §8) | Same three labels on the Integrations page and in `04-roadmap.md`; Analytics separates **calculated** metrics from **estimated / AI** insights |
| **Tests on the most delicate rules** — 30 tests covering date overlap, roles, guest link, rate limits, approvals/conflicts, payments, webhook signatures, AI escalation (§6.2) | Test priorities for Phase 5 start from the same list, adapted to authorisation, tenant isolation, automation loops, AI authorisation |
| **Phased adoption with go/no-go conditions**, start before peak season (§7.2) | Rollout plan in `04-roadmap.md` |
| **Cost-benefit with three scenarios, declared assumptions and measurable KPIs** (§8.3, §8.5) | KPI definitions for the Analytics module; estimates always labelled as estimates |

### 2.3 HTT-specific (deliberately not reused)

Villa search and comparison, guest personal page and portal (Today/Program/Villa/Chat/More/Help), tourist tax, Questura/ISTAT/Alloggiati Web automation (Playwright + local OCR), Revolut/Numia payments, Periskope WhatsApp groups (only the "integration-ready, disabled until configured" pattern is kept), five-language guest content, the sales-uplift model.

### 2.4 HTT's technology (report §6) — the reference stack in the master prompt

Next.js/React/TypeScript on **Cloudflare**; **Firebase** (Firestore, Authentication, Storage); server-sent event streams for live updates; **Gemini Flash** behind an OpenAI-compatible API; Playwright + RapidOCR for compliance. This is the stack the master prompt lists as "preferred", which makes the data-platform choice a real decision rather than a default — see `02-architecture.md`, ADR-2.

### 2.5 Where Racing Team differs from HTT

- HTT's users are mostly **external guests without accounts**; Racing Team's users are **members with accounts, teams and projects**.
- The report describes no project management, document management, org structure, analytics or automation builder. Those are new here.
- HTT is effectively a single organisation; Racing Team should be able to host several (`org_id` everywhere).

## 3. Existing repository inventory

A small, carefully built Next.js 16 app (≈1,600 lines), Italian UI, **no git commits yet** (everything untracked).

| Area | What exists | Verdict |
| --- | --- | --- |
| Stack | Next 16.4.3, React 19.3, TS 5, Tailwind 4, `node:sqlite` (WAL, FK on) | Keep, subject to ADR-2 |
| Auth | scrypt hashing; opaque session token with only its SHA-256 stored; httpOnly + SameSite=lax cookie; timing-safe verify; dummy hash for unknown emails | **Keep, extend** (sound design) |
| Authorisation | `requireUser` / `requireAdmin` in every page and action; two roles (`admin`, `member`) | **Replace with org-scoped RBAC**; keep the check-in-every-action discipline |
| Data | `users, sessions, tasks, meetings, attendance, entries (budget), applications` | Migrate additively (`03-data-model.md`) |
| UI | Custom sidebar shell, light/dark via `data-theme`, CSS-variable tokens, red accent, Inter/Barlow/JetBrains | Keep tokens and shell; grow into a design system |
| Seed | `scripts/seed.ts` — demo users; generated passwords written to git-ignored `data/credentials.local.txt` | Dev only; production seed creates just the first admin |
| Tests / CI / docs | None; README is the create-next-app boilerplate | Add |

### Defects found (to fix in Phase 2)

1. `src/lib/queries.ts` states its queries do **not** check permissions and rely on callers. Next's data-security guide recommends the opposite: a Data Access Layer that authorises inside and returns minimal DTOs. One forgotten call is a leak.
2. Server actions `return;` silently on validation failure — no user feedback.
3. Login throttling is an in-process `Map`: lost on restart, per instance, keyed by email only.
4. Role and department live on `users`; departments and statuses are TypeScript constants (`data.ts`), not data.
5. Tasks have no project, priority, subtasks, comments or history.
6. No audit trail, notifications, document storage or search.
7. Budget amounts are whole euros (`INTEGER`), not cents.
8. `npm run db:seed` runs `node scripts/seed.ts` directly, which needs a Node with native TypeScript type-stripping.

**Next.js 16 facts that differ from older conventions** (verified in the bundled docs): `middleware.ts` is deprecated and renamed **`proxy.ts`**; the DAL + DTO pattern is the recommended default for new projects.

## 4. Assumptions (explicit)

| # | Assumption | If wrong |
| --- | --- | --- |
| A1 | "Racing Team" is the name of the organisation this repo models (the UniPG student racing team). The first brief called it "Recent Team"; the owner corrected the name on 2026-11-11 (UI, docs and migration 0010 follow). | Existing departments/seed data are just demo data; schema stays generic. |
| A2 | Current DB contents are demonstration data (seed script says so; `.env.local` has a `DEMO_DATA` key — its value was not inspected). The DB is **backed up before any migration** regardless. | Migrations are expand/contract so real data survives anyway. |
| A3 | One organisation first; every tenant table carries `org_id`. | Cheap now, expensive later. |
| A4 | Italian primary UI language, English secondary; strings go through a dictionary from the start. | — |
| A5 | **No UniPG integrations or procedures are assumed** (no university SSO, calendar, official forms). Request types are admin-configurable; shipped ones are labelled "example". | Nothing implies institutional endorsement. |
| A6 | Scale: tens to low hundreds of users. | Decides SQLite vs. Firestore vs. PostgreSQL (ADR-2). |
| A7 | **Super Admin = organisation owner**, not a cross-tenant platform operator. | A cross-tenant superuser is a data-leak risk; out of scope. |
| A8 | HTT figures (users, costs, ROI) are the report's own estimates; none are reused as Racing Team data. | — |

## 5. Missing organisational requirements (questions for the owner)

1. How many users/teams now, and how many organisations in the next year?
2. Which approval flows are real today (budget, travel, material purchases)? They become the first configured request types.
3. Who may see finance (`entries`)? Today only admins.
4. Is sending data to Google (Gemini) acceptable under the team's/university's data policy? AI ships **off by default per organisation**.
5. Retention: how long to keep documents, audit logs, ex-member data?
6. Should applicants (non-members) apply through a public form?
7. Must the product follow UniPG rules for using the university name/logo?
