import { ChatApp } from "@/components/ChatApp";
import { chats } from "@/server/app";
import { requireActor } from "@/server/auth/guards";
import { BUILTIN_STICKERS } from "@/server/core/chat";

export default async function AppChat({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const actor = await requireActor();
  const c = Number((await searchParams).c) || null;
  return <ChatApp initial={chats.list(actor)} initialId={c} me={{ membershipId: actor.membershipId, name: actor.name }} canCreateGroup={false} basePath="/app/chat" stickers={[...BUILTIN_STICKERS]} />;
}
