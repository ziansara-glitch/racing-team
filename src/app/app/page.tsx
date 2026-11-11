import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Empty, Panel, PageHead, Pill, fmtDate, fmtDay, fmtTime, linkBtn, relTime } from "@/components/kit";
import { dashboards } from "@/server/app";
import { requireActor } from "@/server/auth/guards";

export default async function Home() {
  const actor = await requireActor();
  const h = dashboards.member(actor);
  const first = actor.name.split(" ")[0];
  const pending = h.polls.filter((p) => !p.responded);
  return (
    <>
      <LiveRefresh types={["poll.updated", "calendar.changed", "notification.created", "message.created"]} />
      <PageHead title={`Ciao ${first}`} sub={h.unreadNotifications ? `Hai ${h.unreadNotifications} ${h.unreadNotifications === 1 ? "notifica" : "notifiche"} da leggere` : "Tutto in ordine"} />
      {pending.length > 0 && (
        <Link href="/app/meetings" className="mb-4 flex items-center justify-between gap-3 rounded-[14px] border border-warn bg-warn/10 px-4 py-3.5">
          <div><p className="font-semibold">C&apos;è un sondaggio per la riunione della settimana</p><p className="text-sm text-muted">{pending[0].title} · {pending[0].teamName}</p></div>
          <span className={linkBtn}>Rispondi</span>
        </Link>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Prossime riunioni" action={<Link href="/app/calendar" className="text-xs font-medium text-accent-text">Calendario →</Link>}>
          {h.meetings.length === 0 ? <Empty title="Nessuna riunione in programma" /> : (
            <ul className="divide-y divide-border">{h.meetings.map((e) => (
              <li key={e.key} className="flex items-center gap-3 py-2.5"><div className="w-12 shrink-0 text-center"><p className="text-xs uppercase text-muted">{fmtDate(e.date).split(" ")[0]}</p><p className="text-lg font-semibold leading-none">{fmtDay(e.date).split(" ")[0]}</p></div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{e.title}</p><p className="text-xs text-muted">{fmtTime(e.start)}–{fmtTime(e.end)}{e.location ? ` · ${e.location}` : ""}</p></div>
                {e.myRsvp && <Pill tone={e.myRsvp === "yes" ? "ok" : e.myRsvp === "no" ? "danger" : "warn"}>{e.myRsvp === "yes" ? "Ci sono" : e.myRsvp === "no" ? "Assente" : "Forse"}</Pill>}</li>
            ))}</ul>
          )}
        </Panel>
        <Panel title="Annunci" action={<Link href="/app/chat" className="text-xs font-medium text-accent-text">Chat →</Link>}>
          {h.announcements.length === 0 ? <Empty title="Nessun annuncio" /> : (
            <ul className="divide-y divide-border">{h.announcements.map((a, i) => <li key={i} className="py-2.5"><p className="text-sm">{a.body}</p><p className="mt-0.5 text-xs text-muted">{a.author} · {a.team} · {relTime(a.at)}</p></li>)}</ul>
          )}
        </Panel>
        <Panel title="I miei compiti">
          {h.tasks.length === 0 ? <Empty title="Nessun compito assegnato" /> : (
            <ul className="divide-y divide-border">{h.tasks.map((t) => <li key={t.id} className="flex items-center gap-3 py-2.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p><p className="text-xs text-muted">{t.ref} · {t.statusName}</p></div>{t.dueDate && <span className={`shrink-0 text-xs ${t.overdue ? "font-semibold text-danger" : "text-muted"}`}>{fmtDay(t.dueDate)}</span>}</li>)}</ul>
          )}
        </Panel>
        <Panel title="Attività del team">
          {h.activities.length === 0 ? <Empty title="Nessuna attività in calendario" /> : (
            <ul className="divide-y divide-border">{h.activities.map((e) => <li key={e.key} className="py-2.5"><p className="text-sm font-medium">{e.title}</p><p className="text-xs text-muted">{fmtDate(e.date)} · {e.allDay ? "tutto il giorno" : `${fmtTime(e.start)}–${fmtTime(e.end)}`}{e.location ? ` · ${e.location}` : ""}</p></li>)}</ul>
          )}
        </Panel>
        <Panel title="Messaggi recenti">
          {h.conversations.length === 0 ? <Empty title="Ancora nessun messaggio" /> : (
            <ul className="divide-y divide-border">{h.conversations.map((c) => <li key={c.id}><Link href={`/app/chat?c=${c.id}`} className="flex items-center gap-3 py-2.5"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{c.title}</p><p className="truncate text-xs text-muted">{c.last!.author}: {c.last!.kind === "text" ? c.last!.body : `[${c.last!.kind}]`}</p></div>{c.unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-bold text-on-accent">{c.unread}</span>}</Link></li>)}</ul>
          )}
        </Panel>
        <Panel title="Notifiche" action={<Link href="/app/notifications" className="text-xs font-medium text-accent-text">Tutte →</Link>}>
          {h.notifications.length === 0 ? <Empty title="Nessuna notifica" /> : (
            <ul className="divide-y divide-border">{h.notifications.map((n) => <li key={n.id} className="py-2.5"><p className={`text-sm ${n.read ? "" : "font-semibold"}`}>{n.title}</p><p className="text-xs text-muted">{relTime(n.createdAt)}</p></li>)}</ul>
          )}
        </Panel>
      </div>
    </>
  );
}
