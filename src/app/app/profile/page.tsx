import { ActionForm, Field, ghostCls, inputCls, Submit } from "@/components/ActionForm";
import { AvatarUpload } from "@/components/AvatarUpload";
import { PasswordForm } from "@/components/PasswordForm";
import { Panel, PageHead, Pill } from "@/components/kit";
import { logout } from "@/app/actions/auth";
import { notifications, profiles } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { NOTIFICATION_KINDS } from "@/server/core/notifications";
import { updateNotificationPrefsAction, updateProfileAction } from "./actions";

const ROLE: Record<string, string> = { super_admin: "Super Admin", org_admin: "Amministratore", team_admin: "Responsabile di team", project_manager: "Project Manager", member: "Membro", viewer: "Sola lettura" };

export default async function ProfilePage() {
  const actor = await requireActor();
  const p = profiles.get(actor);
  const prefs = notifications.prefs(actor);
  return (
    <>
      <PageHead title="Profilo" sub={`${p.name} · ${ROLE[p.role] ?? p.role}`} actions={<form action={logout}><button className={ghostCls}>Esci</button></form>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Il tuo profilo">
          <ActionForm action={updateProfileAction} className="grid gap-3">
            <AvatarUpload name={p.name} currentId={p.avatarId} />
            <div className="flex flex-wrap gap-1.5">{p.teams.map((t) => <Pill key={t.id} tone={t.role === "lead" ? "accent" : "neutral"}>{t.name}{t.role === "lead" ? " · responsabile" : ""}</Pill>)}{p.teams.length === 0 && <Pill>Nessun team</Pill>}</div>
            <Field label="Email di accesso"><input value={p.email ?? ""} readOnly className={`${inputCls} opacity-70`} aria-readonly="true" /></Field>
            <Field label="Telefono" hint="Visibile solo agli amministratori."><input name="phone" defaultValue={p.phone} className={inputCls} inputMode="tel" /></Field>
            <Field label="Email di contatto" hint="Visibile solo agli amministratori."><input name="contactEmail" type="email" defaultValue={p.contactEmail} className={inputCls} /></Field>
            <Field label="Presentazione"><textarea name="bio" defaultValue={p.bio} rows={3} maxLength={300} className={inputCls} /></Field>
            <fieldset className="grid gap-2 rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted">Privacy</legend>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="showPresence" defaultChecked={p.showPresence} /> Mostra quando sono online ai colleghi del mio team</label>
              <Field label="Chi può scrivermi in privato"><select name="directMessages" defaultValue={p.directMessages} className={inputCls}><option value="everyone">Tutti</option><option value="team">Solo chi è nel mio team</option><option value="requests">Gli altri devono prima inviare una richiesta</option><option value="nobody">Nessuno (gli amministratori possono sempre)</option></select></Field>
            </fieldset>
            <Submit>Salva profilo</Submit>
          </ActionForm>
        </Panel>
        <div className="grid content-start gap-4">
          <Panel title="Notifiche nell'app">
            <ActionForm action={updateNotificationPrefsAction} className="grid gap-2">
              {Object.entries(NOTIFICATION_KINDS).map(([k, label]) => <label key={k} className="flex items-start gap-2 text-sm"><input type="checkbox" name={`pref_${k}`} defaultChecked={prefs[k as keyof typeof prefs]} className="mt-1" />{label}</label>)}
              <p className="text-xs text-muted">Email e notifiche push del telefono non sono attive: richiedono un server di posta e il servizio push (vedi docs/04-roadmap.md).</p>
              <Submit>Salva preferenze</Submit>
            </ActionForm>
          </Panel>
          <Panel title="Cambia password"><PasswordForm /></Panel>
        </div>
      </div>
    </>
  );
}
