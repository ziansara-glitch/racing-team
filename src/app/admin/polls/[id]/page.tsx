import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, Submit, ghostCls } from "@/components/ActionForm";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Panel, PageHead, Pill, Stat, fmtDate, fmtDateTime, linkGhost } from "@/components/kit";
import { polls } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import type { Person, PollStatus } from "@/server/core/polls";
import { cancelPollAction, closePollAction, finalizePollAction, publishPollAction } from "../actions";

const STATUS: Record<PollStatus, { label: string; tone: "neutral" | "warn" | "info" | "ok" | "danger" }> = { draft: { label: "Bozza", tone: "neutral" }, open: { label: "Aperto", tone: "warn" }, closed: { label: "Chiuso — da confermare", tone: "info" }, finalized: { label: "Confermato", tone: "ok" }, cancelled: { label: "Annullato", tone: "danger" } };
const names = (p: Person[]) => (p.length ? p.map((x) => x.name).join(", ") : "—");

export default async function PollPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdminAccess();
  const id = Number((await params).id);
  let poll;
  try { poll = polls.detail(actor, id); } catch (e) { if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound(); throw e; }
  const hasResults = poll.status !== "draft";
  const r = hasResults ? polls.results(actor, id) : null;
  const options = r ? r.options : [];
  const ranked = r ? r.ranking.map((oid) => options.find((o) => o.id === oid)!) : [];
  const pct = (n: number) => (r && r.invitees ? Math.round((n / r.invitees) * 100) : 0);
  const canFinalize = poll.status === "open" || poll.status === "closed";
  return (
    <>
      <LiveRefresh types={["poll.updated"]} match={{ key: "pollId", value: id }} />
      <PageHead title={poll.title} sub={`${poll.teamName} · settimana del ${fmtDate(poll.weekStart)}${poll.deadline ? ` · scade ${fmtDateTime(poll.deadline)}` : ""}`}
        actions={<><Pill tone={STATUS[poll.status].tone}>{STATUS[poll.status].label}</Pill>
          {poll.status === "draft" && <ActionForm action={publishPollAction} className="inline"><input type="hidden" name="id" value={id} /><Submit>Pubblica e avvisa il team</Submit></ActionForm>}
          {poll.status === "open" && <ActionForm action={closePollAction} className="inline"><input type="hidden" name="id" value={id} /><Submit className={ghostCls}>Chiudi le risposte</Submit></ActionForm>}
          {poll.eventId && <Link href="/admin/calendar" className={linkGhost}>Vedi nel calendario</Link>}</>} />

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>{poll.meetingType === "online" ? "Online" : poll.meetingType === "hybrid" ? "Ibrida" : "In presenza"} · {poll.durationMinutes} min</span>
        {poll.location && <span>📍 {poll.location}</span>}{poll.meetingUrl && <a href={poll.meetingUrl} className="underline" target="_blank" rel="noopener noreferrer">Link riunione</a>}
        {poll.recurrence && <span>↻ Si ripete ogni settimana{poll.recurUntil ? ` fino al ${fmtDate(poll.recurUntil)}` : ""}</span>}
      </div>
      {poll.description && <p className="mb-4 max-w-2xl text-sm">{poll.description}</p>}

      {!r ? (
        <Panel title="Giorni e orari candidati"><p className="text-sm text-muted">È una bozza: i membri non la vedono. Pubblicala per avviare le risposte.</p></Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Invitati" value={r.invitees} />
            <Stat label="Hanno risposto" value={`${r.responseRate}%`} hint={`${r.responded} su ${r.invitees}`} />
            <Stat label="Disponibili" value={r.summary.available} tone="ok" />
            <Stat label="Non disponibili" value={r.summary.unavailable} />
            <Stat label="Senza risposta" value={r.summary.noResponse} tone={r.summary.noResponse ? "warn" : undefined} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Panel title="Disponibilità per opzione">
              <ul className="grid gap-3">
                {ranked.map((o, i) => (
                  <li key={o.id} className={`rounded-xl border p-3 ${r.best?.optionId === o.id ? "border-accent" : "border-border"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">{fmtDate(o.date)} · {o.startTime}–{o.endTime} {i === 0 && r.best && <Pill tone="accent">Più votata</Pill>} {poll.finalOptionId === o.id && <Pill tone="ok">Scelta</Pill>}</p>
                      <span className="text-xs text-muted">{o.yes.length} sì · {o.maybe.length} forse · {o.no.length} no · punteggio {o.score}</span>
                    </div>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${o.yes.length} sì, ${o.maybe.length} forse, ${o.no.length} no`}>
                      <div className="bg-ok" style={{ width: `${pct(o.yes.length)}%` }} /><div className="bg-warn" style={{ width: `${pct(o.maybe.length)}%` }} /><div className="bg-danger/70" style={{ width: `${pct(o.no.length)}%` }} />
                    </div>
                    <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">Chi ha risposto</summary>
                      <p className="mt-1"><b className="text-foreground">Sì:</b> {names(o.yes)}</p><p><b className="text-foreground">Forse:</b> {names(o.maybe)}</p><p><b className="text-foreground">No:</b> {names(o.no)}</p>{o.preferredBy.length > 0 && <p><b className="text-foreground">Preferita da:</b> {names(o.preferredBy)}</p>}
                    </details>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">Punteggio = 2 per ogni «sì» + 1 per ogni «forse» + 1 per ogni preferenza. {r.preferredDay && <>Giorno con più disponibilità: <b>{fmtDate(r.preferredDay.date)}</b> ({r.preferredDay.available}). </>}{r.preferredTime && <>Orario più gradito: <b>{r.preferredTime.startTime}</b> ({r.preferredTime.available}).</>}</p>
            </Panel>

            <div className="grid content-start gap-4">
              {canFinalize && (
                <Panel title="Conferma la riunione">
                  <p className="mb-3 text-xs text-muted">Scegli l&apos;opzione definitiva: verrà creato l&apos;evento nel calendario del team e tutti i {r.invitees} invitati riceveranno una notifica. Le risposte restano salvate. Nulla viene confermato automaticamente.</p>
                  <ActionForm action={finalizePollAction} className="grid gap-2">
                    <input type="hidden" name="id" value={id} />
                    {ranked.map((o, i) => (
                      <label key={o.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/8">
                        <input type="radio" name="optionId" value={o.id} required defaultChecked={i === 0 && !!r.best} /> <span className="flex-1">{fmtDate(o.date)} · {o.startTime}</span><span className="text-xs text-muted">{o.yes.length} sì</span>
                      </label>
                    ))}
                    <Submit>Conferma e notifica il team</Submit>
                  </ActionForm>
                  <ActionForm action={cancelPollAction} className="mt-3"><input type="hidden" name="id" value={id} /><Submit className="text-xs font-medium text-danger hover:underline" pendingLabel="…">Annulla il sondaggio</Submit></ActionForm>
                </Panel>
              )}
              <Panel title="Presenza dichiarata">
                <dl className="grid gap-2 text-sm">
                  <div><dt className="font-medium text-ok">Sono presente ({r.attendance.attending.length})</dt><dd className="text-muted">{names(r.attendance.attending)}</dd></div>
                  <div><dt className="font-medium text-danger">Non sono presente ({r.attendance.notAttending.length})</dt><dd className="text-muted">{names(r.attendance.notAttending)}</dd></div>
                  <div><dt className="font-medium text-warn">Forse ({r.attendance.tentative.length})</dt><dd className="text-muted">{names(r.attendance.tentative)}</dd></div>
                  <div><dt className="font-medium">Non ancora risposto ({r.attendance.notAnswered.length})</dt><dd className="text-muted">{names(r.attendance.notAnswered)}</dd></div>
                </dl>
              </Panel>
              {r.nonResponders.length > 0 && <Panel title="Non hanno risposto affatto"><p className="text-sm text-muted">{names(r.nonResponders)}</p></Panel>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
