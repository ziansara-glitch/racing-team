import { MemberShell } from "@/components/Shells";
import { appNav } from "@/components/nav";
import { chats, notifications, polls } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { hasAdminAccess } from "@/server/core/teams";

// Racing Team APP (membri e studenti). Qualunque membro attivo può entrare; ciò che vede dipende da team e permessi.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const { nav, bottom, commands } = appNav(actor);
  return (
    <MemberShell nav={nav} bottom={bottom} commands={commands} canAdmin={hasAdminAccess(actor)} counts={{ chat: chats.unread(actor), notifications: notifications.unread(actor), polls: polls.pending(actor) }} user={{ name: actor.name, sub: actor.role === "viewer" ? "Sola lettura" : "Membro" }}>
      {children}
    </MemberShell>
  );
}
