"use client";

import { useEffect, useState } from "react";
import { fetchConversationAvatarUrl, fetchParticipantAvatarUrl } from "@/lib/api";
import { Avatar } from "@/components/ui";

/**
 * Avatar de conversa: busca a foto de perfil pelo endpoint autenticado
 * (com cache compartilhado) e cai para as iniciais quando não há foto.
 */
export function ConversationAvatar({
  conversationId,
  name,
  hasAvatar,
  size = "md",
  className,
}: {
  conversationId: string;
  name: string;
  hasAvatar: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAvatar) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchConversationAvatarUrl(conversationId)
      .then((blobUrl) => {
        if (!cancelled) setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, hasAvatar]);

  return <Avatar name={name} src={url} size={size} className={className} />;
}

/** Mesma ideia, para participantes de grupo no painel de contexto. */
export function ParticipantAvatar({
  participantId,
  name,
  hasAvatar,
  size = "sm",
  className,
}: {
  participantId: string;
  name: string;
  hasAvatar: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAvatar) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchParticipantAvatarUrl(participantId)
      .then((blobUrl) => {
        if (!cancelled) setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [participantId, hasAvatar]);

  return <Avatar name={name} src={url} size={size} className={className} />;
}
