import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Field, ghostCls, inputCls, Submit } from "@/components/ActionForm";
import { Avatar, Empty, Panel, PageHead, Pill, Stat, Tabs, fmtDate, linkBtn, linkGhost } from "@/components/kit";
import { people, polls, teams } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { NotFoundError } from "@/server/authz/authorize";
import { deleteTeamAction, removeMemberAction, setMemberAction, updateTeamAction } from "../actions";

export default async function TeamWorkspace({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await requireAdminAccess();
  const id = Number((await params).id);
  const tab = (await searchParams).tab ?? "overview";
  let team;
  try { team = teams.get(actor, id, "view"); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }
  const members = teams.members(actor, id);
  const stats = teams.stats(actor, id);
  const canManage = actor.permissions["teams.manage"] === "all" || (actor.permissions["teams.manage"] === "scoped" && actor.teamIds.includes(id));
  const canMembers = actor.permissions["members.manage"] === "all" || (actor.permissions["members.manage"] === "scoped" && actor.teamIds.includes(id));
  const canPolls = !!actor.permissions["polls.manage"];
  const summary = teams.list(actor, "admin").find((t) => t.id === id);
  const t = (k: string, label: string) => ({ href: `/admin/teams/${id}?tab=${k}`, label, active: tab === k });
  const candidates = canMembers && tab === "members" ? people.search(actor, { limit: 100 }).filter((p) => !members.some((m) => m.membershipId === p.membershipId)) : [];
  const teamPolls = canPolls && tab === "polls" ? polls.listAdmin(actor, { teamId: id }) : [];
  return (
    <>
      <PageHead title={team.name} sub={team.description || "Spazio di lavoro del team"} actions={<>{summary?.chatId && <Link href={`/admin/chat?c=${summary.chatId}`} className={linkGhost}>Chat</Link>}{canPolls && <Link href={`/admin/polls/new?team=${id}`} className={linkBtn}>Nuovo sondaggio</Link>}</>} />
      <Tabs items={[t("overview", "Panoramica"), t("members", "Membri"), ...(canPolls ? [t("polls", "Sondaggi")] : []), ...(canManage ? [t("settings", "Impostazioni")] : [])]} />

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Membri" value={stats.members} hint={`${stats.leads} ${stats.leads === 1 ? "responsabile" : "responsabili"}`} />
            <Stat label="Sondaggi aperti" value={stats.openPolls} tone={stats.openPolls ? "warn" : undefined} />
            <Stat label="Eventi (14 giorni)" value={stats.upcomingEvents} />
            <Stat label="Messaggi (7 giorni)" value={stats.messages7d} />
            <Stat label="Compiti aperti" value={stats.openTasks} />
            <Stat label="Progetti" value={stats.projects} />
            <Stat label="Presenze (30 giorni)" value={stats.attendanceRate === null ? "—" : `${stats.attendanceRate}%`} hint={stats.attendanceRecords ? `${stats.attendanceRecords} rilevazioni` : "Nessuna ancora"} />
          </div>
          <Panel title="Responsabili" className="mt-4">
            {members.filter((m) => m.teamRole === "lead").length === 0 ? <Empty title="Nessun responsabile assegnato" /> : (
              <ul className="flex flex-wrap gap-3">{members.filter((m) => m.teamRole === "lead").map((m) => <li key={m.membershipId} className="flex items-center gap-2"><Avatar name={m.name} /><span className="text-sm font-medium">{m.name}</span></li>)}</ul>
            )}
          </Panel>
        </>
      )}

      {tab === "members" && (
        <>
          <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted"><th className="px-3 py-2.5">Persona</th><th className="px-3 py-2.5">Ruolo nel team</th><th className="px-3 py-2.5">Contatti</th>{canMembers && <th className="px-3 py-2.5" />}</tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.membershipId} className="border-b border-border align-top last:border-0">
                    <td className="px-3 py-2.5"><div className="flex items-center gap-2.5"><Avatar name={m.name} size={28} /><div><p className="font-medium">{m.name}</p><p className="text-xs text-muted">{m.title}</p></div></div></td>
                    <td className="px-3 py-2.5">
                      {canMembers ? (
                        <ActionForm action={setMemberAction} className="flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="teamId" value={id} /><input type="hidden" name="membershipId" value={m.membershipId} />
                          <select name="role" defaultValue={m.teamRole} aria-label="Ruolo" className={`${inputCls} !w-auto !py-1`}><option value="member">Membro</option><option value="lead">Responsabile</option></select>
                          <input name="title" defaultValue={m.teamTitle} placeholder="Titolo (es. Aerodinamico)" aria-label="Titolo nel team" className={`${inputCls} !w-40 !py-1`} />
                          <Submit className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2" pendingLabel="…">Salva</Submit>
                        </ActionForm>
                      ) : <><Pill tone={m.teamRole === "lead" ? "accent" : "neutral"}>{m.teamRole === "lead" ? "Responsabile" : "Membro"}</Pill> <span className="text-xs text-muted">{m.teamTitle}</span></>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">{m.email ?? "—"}{m.phone ? <><br />{m.phone}</> : null}</td>
                    {canMembers && <td className="px-3 py-2.5 text-right"><ActionForm action={removeMemberAction} className="inline"><input type="hidden" name="teamId" value={id} /><input type="hidden" name="membershipId" value={m.membershipId} /><Submit className="text-xs font-medium text-danger hover:underline" pendingLabel="…">Rimuovi</Submit></ActionForm></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canMembers && (
            <Panel title="Aggiungi una persona" className="mt-4">
              <ActionForm action={setMemberAction} reset className="grid gap-3 sm:grid-cols-4">
                <input type="hidden" name="teamId" value={id} />
                <div className="sm:col-span-2"><Field label="Persona"><select name="membershipId" required className={inputCls}><option value="">Scegli…</option>{candidates.map((p) => <option key={p.membershipId} value={p.membershipId}>{p.name} — {p.department}</option>)}</select></Field></div>
                <Field label="Ruolo"><select name="role" className={inputCls}><option value="member">Membro</option><option value="lead">Responsabile</option></select></Field>
                <Field label="Titolo"><input name="title" className={inputCls} /></Field>
                <div className="sm:col-span-4"><Submit>Aggiungi al team</Submit></div>
              </ActionForm>
            </Panel>
          )}
        </>
      )}

      {tab === "polls" && (teamPolls.length === 0 ? <Empty title="Nessun sondaggio per questo team" action={<Link href={`/admin/polls/new?team=${id}`} className={linkBtn}>Nuovo sondaggio</Link>} /> : (
        <ul className="divide-y divide-border rounded-[14px] border border-border bg-surface">
          {teamPolls.map((p) => <li key={p.id}><Link href={`/admin/polls/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{p.title}</p><p className="text-xs text-muted">Settimana del {fmtDate(p.weekStart)} · {p.responded}/{p.invitees} risposte</p></div><Pill tone={p.status === "open" ? "warn" : p.status === "finalized" ? "ok" : "neutral"}>{p.status}</Pill></Link></li>)}
        </ul>
      ))}

      {tab === "settings" && canManage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Dati del team">
            <ActionForm action={updateTeamAction} className="grid gap-3">
              <input type="hidden" name="id" value={id} />
              <Field label="Nome"><input name="name" defaultValue={team.name} required className={inputCls} /></Field>
              <Field label="Colore"><input name="color" type="color" defaultValue={team.color} className="h-10 w-full rounded-[10px] border border-border bg-surface-2" /></Field>
              <Field label="Descrizione e responsabilità"><textarea name="description" defaultValue={team.description} rows={3} className={inputCls} /></Field>
              <Submit>Salva modifiche</Submit>
            </ActionForm>
          </Panel>
          {actor.permissions["teams.manage"] === "all" && (
            <Panel title="Elimina il team">
              <p className="mb-3 text-sm text-muted">Il team sparisce dagli elenchi, la sua chat viene archiviata e i sondaggi aperti annullati. Eventi e messaggi restano nello storico.</p>
              <ActionForm action={deleteTeamAction} className="grid gap-3"><input type="hidden" name="id" value={id} /><Field label="Scrivi «elimina» per confermare"><input name="confirm" className={inputCls} autoComplete="off" /></Field><Submit className={`${ghostCls} !border-danger !text-danger`}>Elimina il team</Submit></ActionForm>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
