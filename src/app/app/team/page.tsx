import Link from "next/link";
import { Avatar, Empty, Panel, PageHead, Pill } from "@/components/kit";
import { teams } from "@/server/app";
import { requireActor } from "@/server/auth/guards";

export default async function MyTeams() {
  const actor = await requireActor();
  const mine = teams.list(actor, "mine");
  return (
    <>
      <PageHead title="Team" sub="I team di cui fai parte e le persone con cui lavori." />
      {mine.length === 0 && <Empty title="Non fai ancora parte di nessun team" text="Un responsabile o un amministratore può aggiungerti." />}
      <div className="grid gap-4">
        {mine.map((t) => (
          <Panel key={t.id} title={t.name} action={<div className="flex gap-3 text-xs font-medium text-accent-text">{t.chatId && <Link href={`/app/chat?c=${t.chatId}`}>Chat →</Link>}<Link href="/app/calendar">Calendario →</Link></div>}>
            {t.description && <p className="mb-3 text-sm text-muted">{t.description}</p>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {teams.members(actor, t.id).map((m) => (
                <li key={m.membershipId} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"><Avatar name={m.name} size={30} /><div className="min-w-0"><p className="truncate text-sm font-medium">{m.name}</p><p className="truncate text-xs text-muted">{m.teamTitle || m.title}</p></div>{m.teamRole === "lead" && <Pill tone="accent">Responsabile</Pill>}</li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}
