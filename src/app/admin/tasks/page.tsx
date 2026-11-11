import Link from "next/link";
import { ActionForm, btnCls, Field, inputCls, Submit } from "@/components/ActionForm";
import { Empty, Panel, PageHead, Pill, fmtDay } from "@/components/kit";
import { people, projects, tasks } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { parseTaskQuery } from "@/server/core/taskquery";
import { PRIORITY_LABEL } from "@/server/core/types";
import { createTaskAction, updateTaskAction } from "./actions";

// Compiti del team: il progetto «Attività del team» (GEN), che contiene i compiti importati dal vecchio elenco.
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireAdminAccess();
  const sp = await searchParams;
  const detail = projects.detail(actor, "GEN");
  if (!detail) return <Empty title="Il progetto «Attività del team» non è disponibile" text="Non hai accesso al progetto o è stato eliminato." />;
  const q = parseTaskQuery(sp);
  const rows = tasks.query(actor, { projectId: detail.project.id }, { ...q, showSubtasks: true });
  const reparto = detail.fields.find((f) => f.name === "Reparto");
  const members = people.search(actor, { limit: 100 });
  const canWrite = detail.access.writeTasks;
  return (
    <>
      <PageHead title="Compiti" sub={`${detail.project.name} · ${rows.length} compiti`} />
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <input name="q" defaultValue={q.q ?? ""} placeholder="Cerca per titolo o codice" aria-label="Cerca" className={`${inputCls} max-w-xs`} />
        <select name="status" defaultValue={q.status?.[0] ?? ""} aria-label="Stato" className={`${inputCls} max-w-[11rem]`}>
          <option value="">Tutti gli stati</option>
          {detail.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className={btnCls}>Filtra</button>
        {(q.q || q.status) && <Link href="/admin/tasks" className="self-center text-sm text-muted underline">Azzera</Link>}
      </form>

      {canWrite && (
        <details className="mb-5">
          <summary className="cursor-pointer text-sm font-semibold text-accent-text">+ Nuovo compito</summary>
          <Panel className="mt-3">
            <ActionForm action={createTaskAction} reset className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="projectId" value={detail.project.id} />
              {reparto && <input type="hidden" name="fieldId" value={reparto.id} />}
              <div className="sm:col-span-2"><Field label="Titolo"><input name="title" required className={inputCls} /></Field></div>
              {reparto && <Field label="Reparto"><select name="reparto" className={inputCls}><option value="">—</option>{reparto.options.map((o) => <option key={o}>{o}</option>)}</select></Field>}
              <Field label="Assegnato a"><select name="assignee" className={inputCls}><option value="">Nessuno</option>{members.map((m) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}</select></Field>
              <Field label="Scadenza"><input type="date" name="due" className={inputCls} /></Field>
              <Field label="Priorità"><select name="priority" defaultValue="medium" className={inputCls}>{Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
              <div className="sm:col-span-2"><Submit>Crea compito</Submit></div>
            </ActionForm>
          </Panel>
        </details>
      )}

      {rows.length === 0 ? <Empty title="Nessun compito" text="Cambia i filtri o crea il primo compito." /> : (
        <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted"><th className="px-3 py-2.5">Codice</th><th className="px-3 py-2.5">Titolo</th><th className="px-3 py-2.5">Reparto</th><th className="px-3 py-2.5">Assegnato</th><th className="px-3 py-2.5">Scadenza</th><th className="px-3 py-2.5">Stato</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 align-top">
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">{t.ref}</td>
                  <td className="px-3 py-2.5 font-medium">{t.title}{t.priority === "urgent" && <span className="ml-2"><Pill tone="danger">Urgente</Pill></span>}{t.blockedBy > 0 && <span className="ml-2"><Pill tone="warn">Bloccato</Pill></span>}</td>
                  <td className="px-3 py-2.5 text-muted">{reparto ? String(t.fields[reparto.id] ?? "—") : "—"}</td>
                  <td className="px-3 py-2.5 text-muted">{t.assigneeName ?? "—"}</td>
                  <td className={`whitespace-nowrap px-3 py-2.5 ${t.overdue ? "font-semibold text-danger" : "text-muted"}`}>{t.dueDate ? fmtDay(t.dueDate) : "—"}</td>
                  <td className="px-3 py-2.5">
                    {canWrite ? (
                      <ActionForm action={updateTaskAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="id" value={t.id} />
                        <select name="status" defaultValue={t.statusId} aria-label={`Stato di ${t.ref}`} className={`${inputCls} !w-auto !py-1`}>{detail.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                        <Submit className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2" pendingLabel="…">Salva</Submit>
                      </ActionForm>
                    ) : <Pill>{t.statusName}</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
