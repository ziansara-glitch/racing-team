import { LiveRefresh } from "@/components/LiveRefresh";
import { CalendarView, calendarData, EventForm } from "@/components/CalendarView";
import { PageHead, Panel } from "@/components/kit";
import { createEventAction } from "@/app/calendar-actions";
import { db_categories } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { todayISO } from "@/server/core/sql";

export default async function AdminCalendar({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireAdminAccess();
  const sp = await searchParams;
  const today = todayISO();
  const { view, date, cals, events } = await calendarData(actor, sp, today);
  const categories = db_categories(actor);
  const canCreate = cals.some((c) => c.edit);
  return (
    <>
      <LiveRefresh types={["calendar.changed"]} />
      <PageHead title="Calendario" sub="Calendario degli amministratori e calendari dei team. Ogni persona vede solo ciò a cui ha accesso." />
      {canCreate && (
        <details className="mb-5" open={sp.new === "1"}>
          <summary className="cursor-pointer text-sm font-semibold text-accent-text">+ Nuovo evento</summary>
          <Panel className="mt-2"><EventForm action={createEventAction} cals={cals} categories={categories} everyone={[]} submit="Crea evento" defaultDate={today} /></Panel>
        </details>
      )}
      <CalendarView actor={actor} basePath="/admin/calendar" view={view} date={date} today={today} events={events} sp={sp} cals={cals} categories={categories} selected={sp.event} />
    </>
  );
}
