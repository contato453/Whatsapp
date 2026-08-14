import { InboxShell } from "@/components/inbox/inbox-shell";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <InboxShell conversationId={conversationId} />;
}
