import { ChatApp } from "@/components/ChatApp";
import { PageHead } from "@/components/kit";
import { chats } from "@/server/app";
import { requireAdminAccess } from "@/server/auth/guards";
import { BUILTIN_STICKERS } from "@/server/core/chat";

export default async function AdminChat({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const actor = await requireAdminAccess();
  const c = Number((await searchParams).c) || null;
  return (
    <>
      <PageHead title="Chat" sub="Gruppi riservati agli amministratori, chat dei team, annunci e messaggi diretti." />
      <ChatApp initial={chats.list(actor)} initialId={c} me={{ membershipId: actor.membershipId, name: actor.name }} canCreateGroup={!!actor.permissions["chat.manage"]} basePath="/admin/chat" stickers={[...BUILTIN_STICKERS]} />
    </>
  );
}
