"use server";

import { revalidatePath } from "next/cache";
import { guarded, int, type ActionState } from "@/server/action";
import { chats } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";

export async function updateChatPolicyAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    chats.setPolicy(actor, { editWindowMinutes: int(f, "edit") ?? (f.get("edit") === "0" ? 0 : 15), deleteWindowMinutes: int(f, "del") ?? (f.get("del") === "0" ? 0 : 60), maxUploadMb: int(f, "maxMb") ?? 25, directMessages: f.get("dm") === "on" });
    revalidatePath("/admin/settings");
    return "Regole della chat salvate.";
  });
}
