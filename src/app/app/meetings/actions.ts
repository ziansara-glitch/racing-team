"use server";

import { revalidatePath } from "next/cache";
import { guarded, int, str, type ActionState } from "@/server/action";
import { polls } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import type { Availability, AttendanceState } from "@/server/core/polls";

const AV = ["yes", "maybe", "no"];
const ATT = ["attending", "not_attending", "tentative"];

export async function respondPollAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return guarded(() => {
    const pollId = int(f, "pollId") ?? 0;
    const votes = [...f.keys()].flatMap((k) => {
      const m = /^av_(\d+)$/.exec(k);
      const v = m ? str(f, k) : "";
      return m && AV.includes(v) ? [{ optionId: Number(m[1]), availability: v as Availability }] : [];
    });
    const att = str(f, "attendance");
    polls.respond(actor, pollId, { votes, preferredOptionId: int(f, "preferred"), attendance: ATT.includes(att) ? (att as AttendanceState) : null, note: str(f, "note") });
    revalidatePath("/app/meetings");
    return "Risposta salvata.";
  });
}

export async function attendanceAction(_: ActionState, f: FormData): Promise<ActionState> {
  const actor = await requireActor();
  return guarded(() => {
    const att = str(f, "attendance");
    polls.attendance(actor, int(f, "pollId") ?? 0, ATT.includes(att) ? (att as AttendanceState) : "tentative", str(f, "note"));
    revalidatePath("/app/meetings");
    return att === "attending" ? "Presenza confermata." : att === "not_attending" ? "Assenza registrata." : "Registrato come «forse».";
  });
}
