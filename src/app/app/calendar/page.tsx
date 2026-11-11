import Link from "next/link";
import { LiveRefresh } from "@/components/LiveRefresh";
import { CalendarView, calendarData } from "@/components/CalendarView";
import { PageHead, Panel, fmtDay } from "@/components/kit";
import { calendars, db_categories } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { addDays, todayISO } from "@/server/core/sql";

export default async function AppCalendar({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const today = todayISO();
  const { view, date, cals, events } = await calendarData(actor, { view: "agenda", ...sp }, today);
  const deadlines = calendars.deadlines(actor, today, addDays(today, 30));
  return (
    <>
      <LiveRefresh types={["calendar.changed"]} />
      <PageHead title="Calendario" sub="Gli eventi del tuo team, le riunioni confermate e le tue scadenze." />
      <CalendarView actor={actor} basePath="/app/calendar" view={view} date={date} today={today} events={events} sp={sp} cals={cals} categories={db_categories(actor)} selected={sp.event} />
      <Panel title="Le mie scadenze (30 giorni)" className="mt-4">
        {deadlines.length === 0 ? <p className="text-sm text-muted">Nessun compito in scadenza.</p> : (
          <ul className="divide-y divide-border">{deadlines.map((d) => <li key={d.taskId} className="flex items-center justify-between gap-3 py-2 text-sm"><span className="truncate">{d.title} <span className="text-xs text-muted">{d.ref}</span></span><span className={`shrink-0 text-xs ${d.overdue ? "font-semibold text-danger" : "text-muted"}`}>{fmtDay(d.date)}</span></li>)}</ul>
        )}
        <Link href="/app" className="sr-only">Home</Link>
      </Panel>
    </>
  );
}
