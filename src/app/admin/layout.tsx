import { AdminShell } from "@/components/Shells";
import { adminNav } from "@/components/nav";
import { chats, notifications } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";

// Racing Team ADMIN. Il layout NON basta come difesa (non si riesegue a ogni navigazione): ogni pagina e azione chiama requireAdminAccess.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireAdminAccess();
  const { nav, commands } = adminNav(actor);
  const scope = actor.permissions["admin.access"] === "all" ? "Amministratore" : "Responsabile di team";
  return (
    <AdminShell nav={nav} commands={commands} counts={{ chat: chats.unread(actor), notifications: notifications.unread(actor), polls: 0 }} user={{ name: actor.name, sub: scope }}>
      {children}
    </AdminShell>
  );
}
