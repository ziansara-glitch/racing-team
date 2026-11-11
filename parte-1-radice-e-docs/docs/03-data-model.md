# 03 — Data model

Phase 1 · Status: proposal. Full DDL lives in `migrations/*.sql` as each slice is built; this file is the map.

> **Implementation status:** migrations **0001–0009 are built and tested**: baseline; tenancy/RBAC/audit/rate limits; teams; projects & tasks engine (`tasks` replaced the legacy table, which is kept as `legacy_tasks`); collaboration (comments, activity, notifications, saved views, templates, invitations, FTS5 search); profiles/attachments/event categories; calendars & events; meeting polls; chat. Still planned: documents, automation, AI, requests/approvals. Tables not yet organisation-scoped: legacy `meetings`/`attendance` (unused), `entries`, `applications` — **do not create a second organisation until they are migrated** (see `src/server/dal/legacy.ts`).

## 1. Conventions

- `INTEGER PRIMARY KEY AUTOINCREMENT` ids (as in the existing schema). Ids are not secrets; authorisation is, so every lookup is scoped by `org_id`.
- Every tenant table has `org_id NOT NULL REFERENCES organizations(id)`. Parent tables expose `UNIQUE (id, org_id)` and children use **composite FKs** `(parent_id, org_id)` → a cross-tenant reference is impossible even if a service has a bug.
- Timestamps: ISO-8601 UTC `TEXT` (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`). All-day dates: `YYYY-MM-DD`. Legacy tables keep their `datetime('now')` format until contracted.
- Money: integer **cents**. JSON columns: `TEXT CHECK (json_valid(col))`.
- Enumerations: `CHECK (col IN (...))`; the list is also exported as a TS constant and a zod enum from one source.
- Soft delete: `deleted_at TEXT NULL` on user-authored content; DAL filters it by default. Append-only (triggers block UPDATE/DELETE): `audit_logs`, `request_events`. Hard purge by a retention job (policy to be set by the owner).
- Polymorphic links (`entity_type`, `entity_id`) cannot carry a DB foreign key; they use a `CHECK` on `entity_type` and are validated in the DAL, with delete-cascade done by services.
- Derived values (project progress, workload) are **computed, not stored**, to avoid inconsistent state.

## 2. Entity map

### Identity, tenancy, security

| Table | Key columns / constraints |
| --- | --- |
| `organizations` | `name`, `slug UNIQUE`, `locale`, `timezone`, `ai_enabled DEFAULT 0`, `settings JSON`, `deleted_at` |
| `users` *(exists)* | `name`, `email UNIQUE`, `password_hash`, `last_login_at`, `disabled_at`. Legacy `role`, `department`, `title` kept until the contract migration |
| `memberships` | `org_id`, `user_id`, `role IN (super_admin, org_admin, team_admin, project_manager, member, viewer)`, `status IN (invited, active, suspended, left)`, `title`; `UNIQUE (org_id, user_id)` |
| `invitations` | `org_id`, `email`, `role`, `team_id?`, `token_hash UNIQUE`, `expires_at`, `accepted_at`, `revoked_at` |
| `role_permission_overrides` | `PK (org_id, role, permission)`, `scope IN (all, scoped, none)`. Only the org's *deviations*; the defaults live in code (`authz/permissions.ts`) and are checked against `docs/01-product-spec.md` by a test |
| `sessions` *(exists)* | `token_hash PK`, `user_id`, `expires_at` **+** `org_id`, `created_at`, `last_seen_at`, `user_agent` *(built)* |
| `rate_limits` | `PK (bucket, key)`, `window_start`, `count` |
| `consents` | `org_id`, `user_id`, `kind` (e.g. `ai_processing`), `policy_version`, `granted_at`, `revoked_at` |
| `audit_logs` | `org_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `meta JSON`, `request_id`, `at` — append-only |

### Organisation

| Table | Key columns |
| --- | --- |
| `teams` | `org_id`, `parent_id` (hierarchy), `name`, `kind IN (department, team)`, `responsibilities`, `lead_membership_id` |
| `team_members` | `PK (team_id, membership_id)`, `role IN (lead, member)` |

### Projects and tasks

| Table | Key columns |
| --- | --- |
| `project_templates` | `org_id`, `name`, `definition JSON` (milestones, starter tasks) |
| `projects` | `org_id`, `key`, `name`, `status IN (planning, active, on_hold, completed, archived)`, `owner_membership_id`, `team_id?`, `visibility IN (private, team, org)`, `priority`, `start_date`, `due_date`, `template_id?`, `deleted_at` |
| `project_members` | `PK (project_id, membership_id)`, `role IN (manager, member, viewer)` |
| `milestones` | `project_id`, `name`, `due_date`, `completed_at` |
| `tasks` | `org_id`, `project_id?`, `parent_task_id?`, `title`, `description`, `status IN (backlog, todo, in_progress, review, completed, archived)`, `priority IN (low, medium, high, urgent)`, `assignee_membership_id?`, `milestone_id?`, `start_date`, `due_date`, `position REAL` (fractional ordering for drag & drop), `completed_at`, `source_type/source_id?` (e.g. action item from a meeting), `deleted_at` |
| `task_dependencies` | `PK (task_id, depends_on_task_id)`, `CHECK (task_id <> depends_on_task_id)`; cycles rejected in the service |
| `comments` | `entity_type IN (project, task, document, request, event, conversation)`, `entity_id`, `author`, `body`, `mentions JSON`, `edited_at`, `deleted_at` |
| `activity` | user-facing feed: `entity_type`, `entity_id`, `actor`, `verb`, `meta JSON`, `at` (distinct from the security `audit_logs`) |

### Workspace

`announcements` (audience team?, pinned, expires) · `conversations` (`kind IN (discussion, project, direct)`, `project_id?`, `team_id?`) + `messages` · `notes` (`project_id?`, `team_id?`, `event_id?`, visibility) · `decisions` (`event_id?`, `project_id?`, `decided_by`, `decided_at`). Action items are ordinary `tasks` with `source_type = 'decision' | 'event'`.

### Calendar and resources

| Table | Key columns |
| --- | --- |
| `events` | `kind IN (meeting, event, deadline, reminder)`, `starts_at`, `ends_at`, `all_day`, `tz`, `rrule?`, `project_id?`, `task_id?`, `organizer`, `visibility`, `ics_uid UNIQUE` |
| `event_participants` | `PK (event_id, membership_id)`, `rsvp IN (invited, yes, no, maybe)` |
| `event_reminders` | `event_id`, `membership_id?`, `offset_minutes`, `sent_at` |
| `resources`, `resource_bookings` | HTT's "no overlap, adjacent allowed" rule (`new.start < existing.end AND new.end > existing.start` ⇒ conflict) checked inside `BEGIN IMMEDIATE`. Optional; used by *resource* request types |

### Documents

| Table | Key columns |
| --- | --- |
| `folders` | `parent_id`, `name`, `visibility`, `owner` |
| `documents` | `folder_id?`, `title`, `category`, `mime`, `current_version_id`, `project_id?`, `task_id?`, `visibility IN (private, team, project, org)`, `owner`, `indexed_at`, `deleted_at` |
| `document_versions` | `document_id`, `version_no`, `storage_key`, `sha256`, `size_bytes`, `mime`, `original_name`, `uploaded_by`, `note`; `UNIQUE (document_id, version_no)` |
| `document_grants` | `document_id` or `folder_id`, `subject_type IN (user, team)`, `subject_id`, `access IN (read, write)` |
| `document_text` | `version_id`, `text` (feeds FTS and AI) |
| `attachments` | links `documents` to any entity (`entity_type`, `entity_id`) |

### Requests and approvals

| Table | Key columns |
| --- | --- |
| `request_types` | `key`, `name`, `fields_schema JSON` (validated field list), `workflow JSON` (reviewer rule: role / team lead / specific member), `active`, `is_example` |
| `requests` | `type_id`, `requester`, `title`, `description`, `data JSON`, `status IN (pending, in_review, approved, rejected, resolved, cancelled)`, `priority`, `reviewer_membership_id?`, `project_id?`, `deleted_at` |
| `request_events` | append-only timeline = approval history: `action IN (created, taken, approved, rejected, commented, reassigned, resolved, cancelled)`, `actor`, `note`, `at` |

### Notifications, AI, automation, search, integrations

| Table | Key columns |
| --- | --- |
| `notifications` | `recipient_membership_id`, `kind`, `title`, `body`, `entity_type/id`, `read_at`, `dedupe_key` (`UNIQUE` per recipient) · `notification_preferences` |
| `ai_conversations`, `ai_messages` | per-member; messages store `role`, `content`, `tool_name`, `tool_args`, `citations`, token counts |
| `ai_pending_actions` | `tool`, `args_hash`, `args JSON`, `expires_at`, `confirmed_at`, `executed_at` |
| `knowledge_sources`, `ai_unanswered` | admin-approved text (scope all/team); questions the assistant could not answer |
| `ai_usage` | `(org_id, day)` token/request counters for budgets |
| `automation_rules` | `trigger JSON`, `conditions JSON`, `actions JSON`, `enabled`, `run_as_membership_id`, `max_runs_per_hour` |
| `domain_events` | outbox: `type`, `entity_type/id`, `payload`, `origin_execution_id?`, `depth`, `processed_at` |
| `automation_executions` | `rule_id`, `event_id`, `status IN (pending, running, succeeded, failed, skipped, dead)`, `attempts`, `next_attempt_at`, `error`; `UNIQUE (rule_id, event_id)` |
| `search_index` | FTS5 `(title, body)` + unindexed `org_id, entity_type, entity_id` |
| `integrations` | `key`, `status IN (disabled, configured, error)`, `public_config JSON`, `secret_env_name`, `last_checked_at`, `last_error` (**never** the secret value) |
| `finance_entries` *(legacy `entries`)* | + `org_id`, `amount_cents`, `created_by`, `deleted_at` |
| `applications` *(exists)* | + `org_id`, `reviewer_membership_id?`, `notes` |

## 3. Key indexes

`memberships(org_id, user_id)` · `tasks(org_id, project_id, status, position)` · `tasks(org_id, assignee_membership_id, status, due_date)` · `tasks(org_id, due_date) WHERE status NOT IN ('completed','archived') AND deleted_at IS NULL` · `projects(org_id, status)` · `events(org_id, starts_at)` · `event_participants(membership_id)` · `documents(org_id, folder_id)` · `document_versions(document_id, version_no)` · `requests(org_id, status, reviewer_membership_id)` · `notifications(recipient_membership_id, read_at, created_at)` · `comments(entity_type, entity_id, created_at)` · `audit_logs(org_id, at)` · `domain_events(processed_at) WHERE processed_at IS NULL` · `automation_executions(status, next_attempt_at)`.

## 4. Migration plan (expand → backfill → contract)

A runner (`schema_migrations(version, name, checksum, applied_at)`) applies `migrations/NNNN_name.sql` in order, each in a transaction, and **refuses to start if an applied file's checksum changed**. Migrations are forward-only and are exercised in tests against a copy of the pre-change backup database.

| # | Migration | Backfill from the existing database |
| --- | --- | --- |
| 0001 | Legacy baseline (today's `schema.sql`, idempotent) | none — adopts existing DBs unchanged |
| 0002 | Tenancy, RBAC, audit, rate limits, session columns | default organisation "Recent Team" (renamed "Racing Team" by the as-built migration 0010, which only touches it while it still has the original name); one membership per user: legacy `admin → org_admin`, `member → member`; the **earliest-created admin becomes `super_admin`** (changeable in the UI) |
| 0003 | Teams | distinct legacy `department` values → `teams`; users → `team_members` |
| 0004 | Projects, tasks v2, comments, activity | legacy tasks → `tasks` (`Da fare → todo`, `In corso → in_progress`, `Fatto → completed`); department → team |
| 0005 | Events, participants, reminders | `meetings` → `events(kind=meeting)`; `attendance → event_participants (going 1/0 → yes/no)` |
| 0006 | Documents, versions, grants, FTS | — |
| 0007 | Requests and types (+ clearly labelled **example** types) | `applications` stay a separate recruiting table |
| 0008 | Notifications | — |
| 0009 | Workspace | — |
| 0010 | Automation | — |
| 0011 | AI | — |
| 0012 | Search index backfill | index existing tasks/events/members |
| 0013 | Contract | drop legacy columns (`users.role/department/title`), convert `entries.amount` → cents; SQLite may need a table rebuild; runs only after the app no longer reads the old columns |

**Safety:** a dated backup of `data/racing.db` and a source snapshot were taken in `data/backups/` before any change (2026-11-06). The migration runner also takes a pre-migration `.backup` automatically in production.
