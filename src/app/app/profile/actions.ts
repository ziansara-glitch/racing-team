"use server";

import { revalidatePath } from "next/cache";
import { guarded, int, str, type ActionState } from "@/server/action";
import { notifications, profiles } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/server/core/notifications";
import type { Profile } from "@/server/core/profile";

export async function updateProfileAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return guarded(() => {
    const dm = str(f, "directMessages") as Profile["directMessages"];
    profiles.update(actor, { phone: str(f, "phone"), contactEmail: str(f, "contactEmail"), bio: str(f, "bio"), showPresence: f.get("showPresence") === "on", directMessages: dm, ...(int(f, "avatar") ? { avatarAttachmentId: int(f, "avatar")! } : {}) });
    revalidatePath("/app/profile");
    return "Profilo aggiornato.";
  });
}

export async function updateNotificationPrefsAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return guarded(() => {
    for (const k of Object.keys(NOTIFICATION_KINDS) as NotificationKind[]) notifications.setPref(actor, k, f.get(`pref_${k}`) === "on");
    revalidatePath("/app/profile");
    return "Preferenze salvate.";
  });
}
