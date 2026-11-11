# 01 — Product specification

Phase 1 · Status: draft for review · Status vocabulary (from the HTT report): **Built** (works, tested) · **To configure** (code ready, needs credentials) · **Designed** (not built)

## 1. Product

**RACING TEAM** — a cloud-based management platform for Racing Team / UniPG: one place for members, projects, tasks, documents, calendar, requests, automation, analytics and an AI assistant (**Racing AI**).

### Principles

1. **Real or absent.** No simulated successes. A feature that needs credentials ships with a settings screen, the exact requirements, and a disabled state.
2. **People decide.** AI and automations propose or notify; destructive or sensitive changes need an explicit human confirmation (from HTT: *technology absorbs repetitive work, decisions stay with people*).
3. **Server-side authority.** Every permission is enforced on the server; hiding a button is never a control.
4. **AI declares what it is** and only sees what the current user may see.
5. **Calculated ≠ estimated.** Analytics label every number as *calculated*, *estimated* or *AI-generated*.
6. **Configurable over hardcoded.** Request types, roles' permissions, automation rules, teams and statuses are data.
7. **Quiet, dense, fast.** Linear/Notion-grade clarity: few colours, strong typography, keyboard-first.

## 2. Roles and permissions

Roles are per **membership** (a user can belong to several organisations with different roles).

| Role | Intent |
| --- | --- |
| **Super Admin** | Organisation owner. Everything, plus ownership transfer, integrations/secrets, AI enablement, deleting the organisation. At least one must exist. |
| **Organisation Admin** | Day-to-day administration of the whole organisation. |
| **Team Admin** | Manages one or more teams: their members, projects, documents, requests. |
| **Project Manager** | Creates and runs projects; manages membership of their projects. |
| **Member** | Works on projects they belong to; creates tasks, uploads documents, files requests. |
| **Viewer** | Read-only on what they belong to. |

Legend: ● all in organisation · ◐ scoped (own team / projects they belong to or manage / items they own) · ○ none. These are the **defaults, defined in code**; an organisation's customisations are stored as *overrides* in `role_permission_overrides` (so a release that changes defaults never erases them). The last Super Admin cannot lose `org.manage` (anti lock-out).

| Permission | Super | Org Admin | Team Admin | PM | Member | Viewer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `org.manage` (profile, roles, settings) | ● | ●¹ | ○ | ○ | ○ | ○ |
| `integrations.manage` (credentials, AI on/off) | ● | ○ | ○ | ○ | ○ | ○ |
| `members.invite` / `members.manage` | ● | ● | ◐ | ○ | ○ | ○ |
| `teams.manage` | ● | ● | ◐ | ○ | ○ | ○ |
| `projects.create` | ● | ● | ◐ | ● | ○ | ○ |
| `projects.manage` | ● | ● | ◐ | ◐ | ○ | ○ |
| `projects.read` | ● | ● | ◐ | ◐ | ◐ | ◐ |
| `tasks.write` (create/edit/assign/status) | ● | ● | ◐ | ◐ | ◐ | ○ |
| `comments.write` | ● | ● | ◐ | ◐ | ◐ | ○ |
| `documents.upload` | ● | ● | ◐ | ◐ | ◐ | ○ |
| `documents.read` (always filtered by document ACL, see below) | ● | ● | ◐ | ◐ | ◐ | ◐ |
| `events.manage` | ● | ● | ◐ | ◐ | ◐² | ○ |
| `requests.create` | ● | ● | ● | ● | ● | ○ |
| `requests.review` | ● | ● | ◐ | ◐ | ○ | ○ |
| `request_types.configure` | ● | ● | ○ | ○ | ○ | ○ |
| `automations.manage` | ● | ● | ◐ | ○ | ○ | ○ |
| `analytics.view` (members: own work only) | ● | ● | ◐ | ◐ | ◐ | ○ |
| `audit.read` | ● | ● | ○ | ○ | ○ | ○ |
| `ai.use` (inherits the user's own access; viewers: read-only tools) | ● | ● | ● | ● | ● | ◐ |
| `finance.read` / `finance.write` | ● | ● | ○ | ○ | ○ | ○ |
| `applications.manage` (recruiting) | ● | ● | ◐ | ○ | ○ | ○ |
| `admin.access` (Racing Team Admin; team admins only see their own teams) | ● | ● | ◐ | ○ | ○ | ○ |
| `polls.manage` (weekly meeting polls) | ● | ● | ◐ | ○ | ○ | ○ |
| `chat.manage` (create and manage groups) | ● | ● | ◐ | ○ | ○ | ○ |

¹ Org Admin holds `org.manage` but the services refuse the *protected operations* (changing a Super Admin's membership, transferring ownership, deleting the organisation) unless the actor is a Super Admin. ² Members create events they own or invite others to.

The table above is parsed by `src/server/authz/permissions.test.ts` and compared with `DEFAULT_ROLE_PERMISSIONS`: editing one without the other fails the test suite.

**Migration of today's roles:** `admin → Organisation Admin` (keeps current access, including budget); `member → Member`. Admins can then downgrade individuals (e.g. department heads → Team Admin).

**Document ACL:** each document and folder has `visibility` = `private` (owner + explicit grants) · `team` · `project` · `org`, plus explicit user/team grants. Reads, search, previews, downloads, exports and AI retrieval all go through the same predicate.

## 3. Modules and feature map

| Module | Capabilities | In repo today | Phase |
| --- | --- | --- | --- |
| **A. Command Center** | Role-specific dashboards; active projects, deadlines, approvals, my tasks, team activity, recent documents, announcements, notifications, KPIs, quick actions, AI insights (labelled) | Basic admin/member home | 3 (+4 for AI insights) |
| **B. Organisation** | Profile, teams/departments, hierarchy, memberships & status, invitations, role assignment, directory, member profiles | `users` list, add member | 2–3 |
| **C. Projects** | Create from template; owner; team assignment; tasks/subtasks; milestones; dependencies; priority; progress; comments; attachments; history. Views: Kanban (drag & drop + keyboard), list, calendar, timeline, overview. Statuses: Backlog · To Do · In Progress · Review · Completed · Archived | Flat tasks, 3 statuses | 3 |
| **D. Team workspace** | Announcements, discussions, project conversations, shared notes, meeting records, decisions, action items (become tasks), mentions, activity feed | None | 3 |
| **E. Documents** | Upload, folders, categories, search, preview, download, ACL, versions + history, link to project/task. Text extraction for search/AI where supported. AI: summary, extraction, classification, Q&A | None | 3 (+4 AI) |
| **F. Calendar** | Events, meetings, deadlines (project/task), availability, reminders, participants + RSVP, meeting notes, recurrence, **ICS export/subscribe** (credential-free); Google/Microsoft sync = integration-ready | `meetings` + attendance | 3 |
| **G. Racing AI** | NL queries, summaries, report generation, deadline analysis, retrieval, workflow suggestions; permission-filtered RAG; tool calls validated and run as the user; confirmation for sensitive actions; "knowledge gaps" list | None | 4 |
| **H. Automation** | Trigger → conditions → actions; execution history; retries with backoff; error handling; permission re-validation; loop guard | None | 4 |
| **I. Requests & approvals** | Configurable request types and fields; reviewer assignment; priority; attachments; timeline; comments; approval history. States: pending → taken in charge → approved/rejected → resolved | `applications` (recruiting only) | 3 |
| **J. Analytics** | Project progress, completion, workload, deadline performance, activity trends, request processing, document activity, KPIs; CSV and PDF export; calculated vs estimated vs AI labels | Budget totals | 4 |
| **Search & palette** | Universal permission-aware search; ⌘K command palette (create task/event, open project, search document, invite member, ask Racing AI) | None | 4 (palette skeleton in 2) |
| **Platform** | Auth, sessions, audit log, notifications, rate limiting, settings, integrations page | Auth, sessions, basic throttle | 2 |
| **Preserved legacy** | Finance (budget entries), recruiting (applications) | Yes | Kept; folded into the new shell |

## 4. Navigation structure

Global chrome: org switcher · ⌘K search/palette · "+" quick create · notifications bell · theme toggle · user menu.

```
Workspace
  Home (Command Center)              /
  My work (tasks assigned to me)     /my-work
  Inbox (notifications, mentions)    /inbox
Work
  Projects                           /projects
    └ Project                        /projects/[id]  → Overview · Board · List · Calendar · Timeline · Docs · Discussion · Settings
  Calendar                           /calendar
  Documents                          /documents  (folders, search)
  Requests                           /requests   (mine · to review · all)
Team
  Workspace                          /workspace  (announcements · discussions · notes · meetings & decisions)
  Directory                          /people     → /people/[id], /teams/[id]
Intelligence
  Racing AI                          /ai
  Analytics                          /analytics  (+ export)
  Automations                        /automations  (rules · executions)
Organisation  (permission-gated)
  Members & invitations              /org/members
  Teams & hierarchy                  /org/teams
  Roles & permissions                /org/roles
  Request types                      /org/request-types
  Finance (legacy budget)            /org/finance
  Applications (legacy recruiting)   /org/applications
  Integrations                       /org/integrations
  Audit log                          /org/audit
  Settings                           /org/settings
Account                              /account  (profile, password, sessions, notifications)
```

Existing `/admin/*` and `/member/*` routes stay working during the transition and redirect to the new routes once each page is migrated (no destructive rewrite).

## 5. Quality bar (per feature)

A feature is done only when it has: a working UI · real backend logic · persisted data · server-side authorisation · loading, empty and error states · input validation with visible feedback · audit/activity where relevant · tests for its rules (authorisation always). Anything short of that is marked *Designed* or *To configure*, never *Built*.
