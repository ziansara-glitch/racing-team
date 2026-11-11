"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guarded, int, str, type ActionState } from "@/server/action";
import { polls } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { ValidationError } from "@/server/core/errors";

function parseOptions(raw: string): { date: string; startTime: string; endTime: string }[] {
  try {
    const v = JSON.parse(raw) as { date?: unknown; start?: unknown; end?: unknown }[];
    if (!Array.isArray(v)) throw new Error();
    return v.map((o) => ({ date: String(o.date ?? ""), startTime: String(o.start ?? ""), endTime: String(o.end ?? "") }));
  } catch {
    throw new ValidationError("Opzioni non valide.", "options");
  }
}

export async function createPollAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireAdminAccess();
  let id: number | undefined;
  const res = await guarded(() => {
    id = polls.create(actor, {
      teamId: int(f, "teamId") ?? 0, title: str(f, "title"), description: str(f, "description"), weekStart: str(f, "weekStart"),
      meetingType: (str(f, "meetingType") || "in_person") as "in_person" | "online" | "hybrid", location: str(f, "location"), meetingUrl: str(f, "meetingUrl"),
      durationMinutes: int(f, "duration") ?? 60, deadline: str(f, "deadline") || null, recurrence: f.get("recurring") ? "weekly" : null, recurUntil: str(f, "recurUntil") || null,
      options: parseOptions(str(f, "options")),
    });
    if (str(f, "intent") === "publish") polls.publish(actor, id);
    revalidatePath("/admin/polls");
    return "ok";
  });
  if (res?.ok && id) redirect(`/admin/polls/${id}`);
  return res;
}

const act = (fn: (a: Awaited<ReturnType<typeof requireAdminAccess>>, id: number, f: FormData) => void, msg: string) =>
  async (_: ActionState, f: FormData): Promise<ActionState> => {
    const actor = await requireAdminAccess();
    return guarded(() => { const id = int(f, "id") ?? 0; fn(actor, id, f); revalidatePath(`/admin/polls/${id}`); revalidatePath("/admin/polls"); return msg; });
  };

export const publishPollAction = act((a, id) => polls.publish(a, id), "Sondaggio pubblicato: il team è stato avvisato.");
export const closePollAction = act((a, id) => polls.close(a, id), "Sondaggio chiuso.");
export const cancelPollAction = act((a, id) => polls.cancel(a, id), "Sondaggio annullato.");
export const finalizePollAction = act((a, id, f) => polls.finalize(a, id, int(f, "optionId") ?? 0), "Riunione confermata: evento creato e team avvisato.");
