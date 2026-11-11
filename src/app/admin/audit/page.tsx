import Link from "next/link";
import { btnCls, inputCls } from "@/components/ActionForm";
import { describeAudit } from "@/components/format";
import { Empty, PageHead, fmtStamp } from "@/components/kit";
import { audit } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { ForbiddenError } from "@/server/authz/authorize";
import { redirect } from "next/navigation";

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireAdminAccess();
  const sp = await searchParams;
  const page = Math.max(Number(sp.page) || 1, 1);
  let data;
  try { data = audit.list(actor, { action: sp.action, from: sp.from, to: sp.to, page }); } catch (e) { if (e instanceof ForbiddenError) redirect("/admin"); throw e; }
  const pages = Math.max(Math.ceil(data.total / data.pageSize), 1);
  const link = (p: number) => `?${new URLSearchParams({ ...(sp.action ? { action: sp.action } : {}), ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), page: String(p) })}`;
  return (
    <>
      <PageHead title="Registro attività" sub="Chi ha fatto cosa, e quando. Le voci non si possono né modificare né cancellare." />
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <select name="action" defaultValue={sp.action ?? ""} aria-label="Tipo di azione" className={`${inputCls} max-w-[13rem]`}>
          <option value="">Tutte le azioni</option>{["auth", "team", "poll", "event", "chat", "project", "task", "member", "finance", "application", "calendar"].map((a) => <option key={a} value={`${a}.`}>{a}</option>)}
        </select>
        <input type="date" name="from" defaultValue={sp.from} aria-label="Dal" className={`${inputCls} max-w-[10rem]`} /><input type="date" name="to" defaultValue={sp.to} aria-label="Al" className={`${inputCls} max-w-[10rem]`} />
        <button className={btnCls}>Filtra</button>
      </form>
      {data.rows.length === 0 ? <Empty title="Nessuna voce" /> : (
        <div className="overflow-x-auto rounded-[14px] border border-border bg-surface"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted"><th className="px-3 py-2.5">Quando</th><th className="px-3 py-2.5">Chi</th><th className="px-3 py-2.5">Azione</th><th className="px-3 py-2.5">Dettagli</th></tr></thead><tbody>
          {data.rows.map((r) => <tr key={r.id} className="border-b border-border align-top last:border-0"><td className="whitespace-nowrap px-3 py-2.5 text-muted">{fmtStamp(r.at)}</td><td className="px-3 py-2.5 font-medium">{r.actorName ?? "Sistema"}</td><td className="px-3 py-2.5">{describeAudit(r.action, r.meta)}<br /><span className="text-xs text-muted">{r.action}</span></td><td className="max-w-xs truncate px-3 py-2.5 font-mono text-xs text-muted" title={JSON.stringify(r.meta)}>{Object.keys(r.meta).length ? JSON.stringify(r.meta) : "—"}</td></tr>)}
        </tbody></table></div>
      )}
      <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagine"><span className="text-muted">{data.total} voci · pagina {page} di {pages}</span><span className="flex gap-3">{page > 1 && <Link href={link(page - 1)} className="font-medium text-accent-text">← Precedente</Link>}{page < pages && <Link href={link(page + 1)} className="font-medium text-accent-text">Successiva →</Link>}</span></nav>
    </>
  );
}
