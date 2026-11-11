import { LiveRefresh } from "@/components/LiveRefresh";
import { NotificationList } from "@/components/NotificationList";
import { PageHead } from "@/components/kit";
import { notifications } from "@/server/app";
import { requireActor } from "@/server/auth/guards";

export default async function Notifications() {
  const actor = await requireActor();
  const { items, total } = notifications.list(actor, { limit: 50 });
  return (<><LiveRefresh types={["notification.created"]} /><PageHead title="Notifiche" /><NotificationList items={items} total={total} /></>);
}
