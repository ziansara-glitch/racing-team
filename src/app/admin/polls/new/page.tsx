import { ActionForm, Field, inputCls } from "@/components/ActionForm";
import { OptionsEditor } from "@/components/OptionsEditor";
import { PageHead, Panel } from "@/components/kit";
import { teams } from "@/server/app";
import { requireAdminAccess, requirePermission } from "@/server/auth/guards";
import { mondayOf } from "@/server/core/recurrence";
import { addDays, todayISO } from "@/server/core/sql";
import { createPollAction } from "../actions";

export default async function NewPoll({ searchParams }: { searchParams: Promise<{ team?: string }> }) {
  await requireAdminAccess();
  const actor = await requirePermission("polls.manage");
  const myTeams = teams.list(actor, "admin");
  const team = Number((await searchParams).team) || myTeams[0]?.id;
  const nextWeek = mondayOf(addDays(todayISO(), 7));
  return (
    <>
      <PageHead title="Nuovo sondaggio di riunione" sub="Scegli il team, la settimana e i giorni/orari candidati. Alla pubblicazione ogni membro riceve una notifica." />
      <Panel>
        <ActionForm action={createPollAction} className="grid gap-4 sm:grid-cols-2">
          <Field label="Team"><select name="teamId" defaultValue={team} required className={inputCls}>{myTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Titolo"><input name="title" required minLength={2} maxLength={120} defaultValue="Riunione settimanale" className={inputCls} /></Field>
          <Field label="Settimana della riunione" hint="Scegli un giorno qualsiasi: si usa la settimana che lo contiene."><input type="date" name="weekStart" required defaultValue={nextWeek} className={inputCls} /></Field>
          <Field label="Tipo di riunione"><select name="meetingType" className={inputCls}><option value="in_person">In presenza</option><option value="online">Online</option><option value="hybrid">Ibrida</option></select></Field>
          <Field label="Luogo (facoltativo)"><input name="location" className={inputCls} placeholder="Aula T, Dip. Ingegneria" /></Field>
          <Field label="Link riunione (facoltativo)"><input name="meetingUrl" type="url" className={inputCls} placeholder="https://…" /></Field>
          <Field label="Durata (minuti)"><input name="duration" type="number" min={5} max={600} defaultValue={60} className={inputCls} /></Field>
          <Field label="Scadenza per votare"><input name="deadline" type="datetime-local" className={inputCls} /></Field>
          <div className="sm:col-span-2"><Field label="Informazioni aggiuntive"><textarea name="description" rows={2} className={inputCls} placeholder="Argomenti, cosa portare…" /></Field></div>
          <div className="sm:col-span-2"><OptionsEditor /></div>
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="recurring" /> Ripeti ogni settimana (a ogni conferma si prepara la bozza successiva)</label>
            <label className="flex items-center gap-2 text-sm text-muted">fino al <input type="date" name="recurUntil" className={`${inputCls} !w-auto !py-1`} /></label>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" name="intent" value="publish" className="inline-flex items-center rounded-[10px] bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:opacity-90">Pubblica e avvisa il team</button>
            <button type="submit" name="intent" value="draft" className="inline-flex items-center rounded-[10px] border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2">Salva come bozza</button>
          </div>
        </ActionForm>
      </Panel>
    </>
  );
}
