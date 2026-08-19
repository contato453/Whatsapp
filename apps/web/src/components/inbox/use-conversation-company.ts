"use client";

import { useCallback, useEffect, useState } from "react";
import { AZEVEDO_OS_SOURCE, type AzevedoOsCompanyDto } from "@azvchat/shared";
import { ApiError, azevedoOsApi } from "@/lib/api";
import { azevedoOsErrorMessage } from "@/lib/azevedo-os";
import type { ConversationDto } from "@/lib/types";

/**
 * A empresa vinculada à conversa aberta, carregada UMA VEZ por conversa.
 *
 * Ela nasceu dentro do card do painel de contexto, mas agora tem dois
 * consumidores: o card, que a desenha, e o composer, que resolve as
 * variáveis da resposta rápida com ela. Deixar cada um buscando por conta
 * própria faria duas consultas ao Azevedo-OS por conversa aberta — e uma
 * terceira a cada `/atalho` digitado, que é justamente o que a resolução na
 * inserção não pode custar.
 *
 * Erro NÃO derruba nada: o card mostra a mensagem e as variáveis de empresa
 * ficam por resolver. Abrir conversa, ler e enviar seguem funcionando com o
 * Azevedo-OS fora do ar.
 */
export interface ConversationCompanyState {
  company: AzevedoOsCompanyDto | null;
  loading: boolean;
  /** Mensagem pronta para exibição; nula quando não houve falha. */
  error: string | null;
  reload: () => void;
}

export function useConversationCompany(
  conversation: ConversationDto | null,
): ConversationCompanyState {
  const conversationId = conversation?.id ?? null;
  const linked =
    conversation?.externalSource === AZEVEDO_OS_SOURCE && !!conversation.externalReference;
  // O ponteiro entra na dependência junto do id: trocar a empresa sem
  // recarregar deixaria o card (e as variáveis) mostrando a anterior.
  const reference = conversation?.externalReference ?? null;

  const [company, setCompany] = useState<AzevedoOsCompanyDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!conversationId || !linked) {
      setCompany(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    azevedoOsApi
      .company(conversationId)
      .then((loaded) => {
        setCompany(loaded);
        setError(null);
      })
      .catch((err) => {
        setCompany(null);
        setError(azevedoOsErrorMessage(err instanceof ApiError ? err.code : undefined));
      })
      .finally(() => setLoading(false));
  }, [conversationId, linked, reference]);

  useEffect(reload, [reload]);

  return { company, loading, error, reload };
}
