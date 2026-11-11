import { NotFoundError, type Actor } from "../authz/authorize.ts";
import { ValidationError } from "./errors.ts";
import { all, one, run, type Conn } from "./sql.ts";
import { adminScope } from "./teams.ts";

export type Profile = {
  membershipId: number; name: string; title: string; role: string; email: string | null; phone: string; contactEmail: string; bio: string; avatarId: number | null;
  showPresence: boolean; directMessages: "everyone" | "team" | "requests" | "nobody"; teams: { id: number; name: string; role: "lead" | "member"; title: string }[];
};

/** Il profilo completo (email di accesso inclusa) lo vede il diretto interessato o un amministratore; i colleghi vedono nome, titolo e team. */
export function getProfile(conn: Conn, actor: Actor, membershipId = actor.membershipId): Profile {
  const r = one<{ id: number; name: string; title: string; role: string; email: string; phone: string | null; contact: string | null; bio: string | null; avatar: number | null; presence: number | null; dm: Profile["directMessages"] | null }>(
    conn, `SELECT m.id, u.name, m.title, m.role, u.email, p.phone, p.contact_email AS contact, p.bio, p.avatar_attachment_id AS avatar, p.show_presence AS presence, p.direct_messages AS dm
             FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN user_profiles p ON p.membership_id = m.id WHERE m.id = ? AND m.org_id = ? AND m.status = 'active'`, membershipId, actor.orgId);
  if (!r) throw new NotFoundError("Profilo");
  const own = membershipId === actor.membershipId;
  // Contatti: il diretto interessato, gli admin con ambito completo e, per un responsabile di team, solo chi condivide un suo team.
  const scope = adminScope(actor);
  const sharesTeam = scope === "scoped" && !!one(conn, "SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.membership_id = ? AND b.membership_id = ?", actor.membershipId, membershipId);
  const privileged = own || scope === "all" || sharesTeam;
  return {
    membershipId: r.id, name: r.name, title: r.title, role: r.role, email: privileged ? r.email : null, phone: privileged ? r.phone ?? "" : "", contactEmail: privileged ? r.contact ?? "" : "",
    bio: r.bio ?? "", avatarId: r.avatar, showPresence: (r.presence ?? 1) === 1, directMessages: r.dm ?? "team",
    teams: all<{ id: number; name: string; role: "lead" | "member"; title: string }>(conn, "SELECT t.id, t.name, tm.role, tm.title FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.membership_id = ? AND t.deleted_at IS NULL ORDER BY t.name", membershipId),
  };
}

export type ProfilePatch = Partial<{ phone: string; contactEmail: string; bio: string; showPresence: boolean; directMessages: Profile["directMessages"]; avatarAttachmentId: number | null }>;

export function updateProfile(conn: Conn, actor: Actor, patch: ProfilePatch): void {
  const cur = getProfile(conn, actor);
  const phone = patch.phone?.trim() ?? cur.phone;
  const contactEmail = patch.contactEmail?.trim() ?? cur.contactEmail;
  const bio = patch.bio?.trim() ?? cur.bio;
  if (phone && !/^[+0-9 ()-]{5,30}$/.test(phone)) throw new ValidationError("Numero di telefono non valido.", "phone");
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) throw new ValidationError("Email di contatto non valida.", "contactEmail");
  if (bio.length > 300) throw new ValidationError("La presentazione può avere al massimo 300 caratteri.", "bio");
  const dm = patch.directMessages ?? cur.directMessages;
  if (!["everyone", "team", "requests", "nobody"].includes(dm)) throw new ValidationError("Impostazione non valida.", "directMessages");
  let avatar = cur.avatarId;
  if (patch.avatarAttachmentId !== undefined) {
    if (patch.avatarAttachmentId !== null && !one(conn, "SELECT 1 FROM attachments WHERE id = ? AND org_id = ? AND uploader_membership_id = ? AND mime LIKE 'image/%' AND deleted_at IS NULL", patch.avatarAttachmentId, actor.orgId, actor.membershipId)) throw new ValidationError("Immagine non valida.", "avatar");
    avatar = patch.avatarAttachmentId;
  }
  run(conn, `INSERT INTO user_profiles (membership_id, phone, contact_email, bio, avatar_attachment_id, show_presence, direct_messages, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (membership_id) DO UPDATE SET phone = excluded.phone, contact_email = excluded.contact_email, bio = excluded.bio, avatar_attachment_id = excluded.avatar_attachment_id,
               show_presence = excluded.show_presence, direct_messages = excluded.direct_messages, updated_at = excluded.updated_at`,
    actor.membershipId, phone, contactEmail, bio, avatar, (patch.showPresence ?? cur.showPresence) ? 1 : 0, dm, new Date().toISOString());
  if (avatar) run(conn, "UPDATE attachments SET status = 'attached' WHERE id = ?", avatar);
}
