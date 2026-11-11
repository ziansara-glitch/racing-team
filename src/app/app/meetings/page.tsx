import Link from "next/link";
import { ActionForm, Submit } from "@/components/ActionForm";
import { LiveRefresh } from "@/components/LiveRefresh";
import { PollVote } from "@/components/PollVote";
import { Empty, Panel, PageHead, Pill, fmtDate, fmtDateTime } from "@/components/kit";
import { polls } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { attendanceAction, respondPollAction } from "./actions";

export default async function Meetings() {
  const actor = await requireActor();
  const list = polls.listMine(actor);
  const open = list.filter((p) => p.status === "open");
  const rest = list.filter((p) => p.status !== "open");
  return (
    <>
      <LiveRefresh types={["poll.updated", "calendar.changed"]} />
      <PageHead title="Riunioni" sub="Rispondi ai sondaggi del tuo team e conferma se ci sarai." />
      {list.length === 0 && <Empty title="Nessun sondaggio per ora" text="Quando un amministratore ne pubblica uno per il tuo team lo troverai qui e riceverai una notifica." />}
      <div className="grid gap-4">
        {open.map((p) => (
          <Panel key={p.id} title={p.title} action={<Pill tone={p.responded ? "ok" : "warn"}>{p.responded ? "Hai risposto" : "Da rispondere"}</Pill>}>
            <p className="mb-3 text-sm text-muted">{p.teamName} · settimana del {fmtDate(p.weekStart)}{p.deadline ? ` · rispondi entro ${fmtDateTime(p.deadline)}` : ""}{p.location ? ` · ${p.location}` : ""}</p>
            {p.description && <p className="mb-3 text-sm">{p.description}</p>}
            {p.canRespond
              ? <PollVote pollId={p.id} action={respondPollAction} attendance={p.attendance} note={p.note} options={p.options.map((o) => ({ id: o.id, label: `${fmtDate(o.date)} · ${o.startTime}–${o.endTime}`, availability: o.availability, preferred: o.preferred }))} />
              : <p className="text-sm text-muted">Le risposte per questo sondaggio sono chiuse.</p>}
          </Panel>
        ))}
        {rest.map((p) => (
          <Panel key={p.id} title={p.title} action={<Pill tone={p.status === "finalized" ? "ok" : "neutral"}>{p.status === "finalized" ? "Confermata" : "In attesa di conferma"}</Pill>}>
            {p.final ? (
              <>
                <p className="text-lg font-semibold">{fmtDate(p.final.date)} · {p.final.startTime}–{p.final.endTime}</p>
                <p className="mt-1 text-sm text-muted">{p.teamName}{p.location ? ` · ${p.location}` : ""}{p.meetingUrl ? <> · <a href={p.meetingUrl} className="underline" target="_blank" rel="noopener noreferrer">Link riunione</a></> : null}</p>
                <ActionForm action={attendanceAction} className="mt-3 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="pollId" value={p.id} />
                  <span className="mr-1 text-sm font-medium">La tua presenza:</span>
                  {([["attending", "Sono presente"], ["not_attending", "Non sono presente"], ["tentative", "Forse"]] as const).map(([v, l]) => (
                    <label key={v} className="cursor-pointer rounded-lg border border-border px-3 py-1.5 text-sm font-medium has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-on-accent"><input type="radio" name="attendance" value={v} defaultChecked={p.attendance === v} className="sr-only" />{l}</label>
                  ))}
                  <Submit className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2" pendingLabel="…">Aggiorna</Submit>
                </ActionForm>
                <Link href="/app/calendar" className="mt-3 inline-block text-sm font-medium text-accent-text">Vedi nel calendario →</Link>
              </>
            ) : <p className="text-sm text-muted">Le risposte sono chiuse. Un amministratore confermerà il giorno e riceverai una notifica.</p>}
          </Panel>
        ))}
      </div>
    </>
  );
}
