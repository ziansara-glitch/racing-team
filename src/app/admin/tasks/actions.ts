"use server";

import { revalidatePath } from "next/cache";
import { guarded, int, str, type ActionState } from "@/server/action";
import { tasks } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { PRIORITIES, type Priority } from "@/server/core/types";

export async function createTaskAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    const projectId = int(f, "projectId");
    const prio = str(f, "priority");
    const fieldId = int(f, "fieldId");
    const t = tasks.create(actor, projectId ?? 0, {
      title: str(f, "title"), assigneeId: int(f, "assignee"), dueDate: str(f, "due") || null, statusId: int(f, "status") ?? undefined,
      priority: (PRIORITIES as readonly string[]).includes(prio) ? (prio as Priority) : undefined,
      fields: fieldId && str(f, "reparto") ? { [fieldId]: str(f, "reparto") } : undefined,
    });
    revalidatePath("/admin/tasks");
    return `Creato ${t.ref}.`;
  });
}

export async function updateTaskAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  return guarded(() => {
    tasks.update(actor, int(f, "id") ?? 0, { statusId: int(f, "status") ?? undefined });
    revalidatePath("/admin/tasks");
    return "Aggiornato.";
  });
}
