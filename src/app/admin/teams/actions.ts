"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guarded, int, str, type ActionState } from "@/server/action";
import { teams } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";

export async function createTeamAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  let id: number | undefined;
  const res = await guarded(() => {
    id = teams.create(actor, { name: str(f, "name"), description: str(f, "description"), color: str(f, "color") || undefined, parentId: int(f, "parentId"), leaderMembershipId: int(f, "leader") ?? undefined });
    revalidatePath("/admin/teams");
    return "Team creato.";
  });
  if (id) redirect(`/admin/teams/${id}`);
  return res;
}

export async function updateTeamAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    const id = int(f, "id") ?? 0;
    teams.update(actor, id, { name: str(f, "name"), description: str(f, "description"), color: str(f, "color") || undefined, ...(f.has("parentId") ? { parentId: int(f, "parentId") } : {}) });
    revalidatePath(`/admin/teams/${id}`);
    return "Team aggiornato.";
  });
}

export async function deleteTeamAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  if (str(f, "confirm").toLowerCase() !== "elimina") return { error: "Per eliminare il team scrivi «elimina» nel campo di conferma." };
  const res = await guarded(() => { teams.remove(actor, int(f, "id") ?? 0); return "ok"; });
  if (res?.ok) redirect("/admin/teams");
  return res;
}

export async function setMemberAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    const teamId = int(f, "teamId") ?? 0;
    teams.addMember(actor, teamId, int(f, "membershipId") ?? 0, { role: str(f, "role") === "lead" ? "lead" : "member", title: str(f, "title") });
    revalidatePath(`/admin/teams/${teamId}`);
    return "Salvato.";
  });
}

export async function removeMemberAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    const teamId = int(f, "teamId") ?? 0;
    teams.removeMember(actor, teamId, int(f, "membershipId") ?? 0);
    revalidatePath(`/admin/teams/${teamId}`);
    return "Rimosso.";
  });
}
