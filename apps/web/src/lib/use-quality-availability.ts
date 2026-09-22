"use client";

import { useEffect, useState } from "react";
import { qualityApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

/**
 * O módulo Quality está de pé para este escritório?
 *
 * Ele depende da IA já configurada: sem chave de provedor, o menu não aparece e
 * a tela não abre. A resposta vem de uma rota de ADMINISTRADOR, e por isso o
 * hook só pergunta quando quem está logado é admin — perguntar por todos
 * revelaria ao atendente que existe um módulo chamado Quality, que é
 * exatamente o que o sigilo desta entrega proíbe. Para os demais papéis a
 * resposta é `false` sem nenhuma requisição.
 *
 * Fica num hook, e não dentro do `layout.tsx`, pelo mesmo motivo do hook de não
 * lidas: aquele arquivo já decide menu, barra recolhida e área bloqueada.
 */
export function useQualityAvailability(): { enabled: boolean; loading: boolean } {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(isAdmin);

  useEffect(() => {
    if (!isAdmin) {
      setEnabled(false);
      setLoading(false);
      return;
    }
    let ativo = true;
    setLoading(true);
    qualityApi
      .availability()
      .then((availability) => {
        if (ativo) setEnabled(availability.enabled);
      })
      .catch(() => {
        // Falha de rede não pode transformar "não sei" em "existe": o lado
        // seguro aqui é o menu escondido, como em `loadOrganizationFeatures`.
        if (ativo) setEnabled(false);
      })
      .finally(() => {
        if (ativo) setLoading(false);
      });
    return () => {
      ativo = false;
    };
  }, [isAdmin]);

  return { enabled, loading };
}
