"use client";

import { useEffect, useState } from "react";
import { fetchUserAvatarUrl } from "@/lib/api";
import { Avatar } from "@/components/ui";

/**
 * Foto de perfil interna do usuário do sistema.
 *
 * Não tem relação com a foto dos números de WhatsApp: serve só para a
 * equipe se reconhecer dentro do sistema. Sem foto, cai nas iniciais.
 */
export function UserAvatar({
  userId,
  name,
  hasAvatar,
  size = "md",
  className,
}: {
  userId: string;
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
    fetchUserAvatarUrl(userId)
      .then((blobUrl) => {
        if (!cancelled) setUrl(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, hasAvatar]);

  return <Avatar name={name} src={url} size={size} className={className} />;
}
