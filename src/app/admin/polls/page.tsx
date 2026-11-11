import Link from "next/link";
import { Empty, PageHead, Pill, fmtDate, linkBtn } from "@/components/kit";
import { inputCls, btnCls } from "@/components/ActionForm";
import { polls, teams } from "@/server/app";
import { requirePermission } from "@/server/auth/guards";
import { requireAdminAccess } from "@/server/auth/guards";
import type { PollStatus } from "@/server/core/polls";

const STATUS: Record<PollStatus, { label: string; tone: "neutral" | "warn" | "info" | "ok" | "danger" }> = { draft: { label: "Bozza", tone: "neutral" }, open: { label: "Aperto", tone: "warn" }, closed: { label: "Da confermare", tone: "info" }, finalized: { label: "Confermato", tone: "ok" }, cancelled: { label: "Annullato", tone: "danger" } };

export default async function PollsPage({ searchParams }: { searchParams: Promise<{ status?: string; team?: string }> }) {
  await requireAdminAccess();
  const actor = await requirePermission("polls.manage");
  const sp = await searchParams;
  const status = (Object.keys(STATUS) as PollStatus[]).find((s) => s === sp.status);
  const list = polls.listAdmin(actor, { status, teamId: Number(sp.team) || undefined });
  const myTeams = teams.list(actor, "admin");
  return (
    <>
      <PageHead title="Sondaggi di riunione" sub="Ogni settimana i membri indicano quando sono disponibili e se ci saranno. Solo tu confermi la riunione." actions={<Link href="/admin/polls/new" className={linkBtn}>Nuovo sondaggio</Link>} />
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <select name="team" defaultValue={sp.team ?? ""} aria-label="Team" className={`${inputCls} max-w-[12rem]`}><option value="">Tutti i team</option>{myTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select name="status" defaultValue={status ?? ""} aria-label="Stato" className={`${inputCls} max-w-[12rem]`}><option value="">Tutti gli stati</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        <button className={btnCls}>Filtra</button>
      </form>
      {list.length === 0 ? <Empty title="Nessun sondaggio" text="Crea un sondaggio per far scegliere al team il giorno della riunione." action={<Link href="/admin/polls/new" className={linkBtn}>Nuovo sondaggio</Link>} /> : (
        <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted"><th className="px-3 py-2.5">Sondaggio</th><th className="px-3 py-2.5">Team</th><th className="px-3 py-2.5">Settimana</th><th className="px-3 py-2.5">Risposte</th><th className="px-3 py-2.5">Stato</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-3 py-2.5"><Link href={`/admin/polls/${p.id}`} className="font-medium hover:underline">{p.title}</Link>{p.recurrence && <span className="ml-2 text-xs text-muted">↻ settimanale</span>}</td>
                  <td className="px-3 py-2.5 text-muted">{p.teamName}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtDate(p.weekStart)}</td>
                  <td className="px-3 py-2.5">{p.invitees ? <div className="flex items-center gap-2"><div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent" style={{ width: `${(p.responded / p.invitees) * 100}%` }} /></div><span className="text-xs text-muted">{p.responded}/{p.invitees}</span></div> : <span className="text-xs text-muted">—</span>}</td>
                  <td className="px-3 py-2.5"><Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
