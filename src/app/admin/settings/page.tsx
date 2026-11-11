import { ActionForm, Field, inputCls, Submit } from "@/components/ActionForm";
import { PageHead, Panel, Pill } from "@/components/kit";
import { chats } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { redirect } from "next/navigation";
import { updateChatPolicyAction } from "./actions";

const INTEGRATIONS: { name: string; status: "off" | "todo" | "local"; note: string }[] = [
  { name: "Archiviazione file", status: "local", note: "Su disco locale (cartella STORAGE_DIR). Per S3 serve un'altra implementazione e le credenziali." },
  { name: "Racing AI (Gemini)", status: "todo", note: "Non ancora costruita. Richiederà GEMINI_API_KEY e il consenso dell'organizzazione." },
  { name: "Email (SMTP)", status: "todo", note: "Nessuna email parte: servono SMTP_URL e un indirizzo mittente verificato." },
  { name: "Notifiche push (telefono)", status: "off", note: "Non costruite: richiedono chiavi VAPID e un service worker." },
  { name: "Google / Microsoft Calendar", status: "off", note: "Non costruita la sincronizzazione. Servono credenziali OAuth approvate dal titolare dell'account." },
  { name: "Accesso con SSO universitario", status: "off", note: "Non assunto: richiede approvazione e registrazione da parte di UniPG." },
];

export default async function Settings() {
  const actor = await requireAdminAccess();
  if (actor.permissions["org.manage"] !== "all") redirect("/admin");
  const p = chats.policy(actor.orgId);
  return (
    <>
      <PageHead title="Impostazioni" sub="Regole dell'organizzazione e stato delle integrazioni." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Regole della chat">
          <ActionForm action={updateChatPolicyAction} className="grid gap-3">
            <Field label="Minuti per modificare un proprio messaggio" hint="0 = nessun limite."><input name="edit" type="number" min={0} max={10080} defaultValue={p.editWindowMinutes} className={inputCls} /></Field>
            <Field label="Minuti per eliminare un proprio messaggio" hint="0 = nessun limite. I moderatori possono sempre eliminare."><input name="del" type="number" min={0} max={10080} defaultValue={p.deleteWindowMinutes} className={inputCls} /></Field>
            <Field label="Dimensione massima dei file (MB)"><input name="maxMb" type="number" min={1} max={100} defaultValue={p.maxUploadMb} className={inputCls} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="dm" defaultChecked={p.directMessages} /> Consenti i messaggi diretti tra membri</label>
            <Submit>Salva regole</Submit>
          </ActionForm>
        </Panel>
        <Panel title="Integrazioni">
          <ul className="divide-y divide-border">{INTEGRATIONS.map((i) => <li key={i.name} className="py-2.5"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{i.name}</p><Pill tone={i.status === "local" ? "ok" : i.status === "todo" ? "warn" : "neutral"}>{i.status === "local" ? "Attiva" : i.status === "todo" ? "Da configurare" : "Non costruita"}</Pill></div><p className="mt-0.5 text-xs text-muted">{i.note}</p></li>)}</ul>
        </Panel>
      </div>
    </>
  );
}
