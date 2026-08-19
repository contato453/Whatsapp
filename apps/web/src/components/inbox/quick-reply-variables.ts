"use client";

import {
  buildQuickReplyConversationContext,
  resolveQuickReplyTemplate,
  type AzevedoOsCompany,
  type QuickReplyResolution,
  type QuickReplyUnresolved,
} from "@azvchat/shared";
import type { ConversationDto, UserDto } from "@/lib/types";

/**
 * Resolução das variáveis da resposta rápida no momento da INSERÇÃO.
 *
 * ------------------------------------------------------------------
 * POR QUE NA INSERÇÃO, E NÃO NO ENVIO
 * ------------------------------------------------------------------
 * Resolvendo aqui, o texto já cai pronto no composer: a atendente LÊ o que
 * o cliente vai receber e corrige antes do Enter. Resolvendo no envio, a
 * substituição aconteceria depois do último ponto em que alguém poderia
 * revisar — razão social errada, campo em branco virando buraco na frase,
 * competência do mês trocada: tudo isso só apareceria com a mensagem já no
 * celular do cliente, onde não se desfaz. O custo da escolha é que o texto
 * envelhece entre inserir e enviar (a empresa poderia ser trocada no meio),
 * e esse custo é aceito de propósito.
 *
 * Este módulo mora fora do `inbox-shell.tsx` porque aquele arquivo já passa
 * de 1300 linhas — de lá sai só a chamada.
 */

/** Variável que não pôde ser resolvida, para o aviso do composer. */
export type { QuickReplyUnresolved };

/**
 * Resolve o texto da resposta rápida com o que a tela já tem em mãos.
 *
 * A empresa vem do MESMO carregamento que alimenta o card do painel de
 * contexto (`useConversationCompany`) — nenhuma consulta nova ao Azevedo-OS
 * por inserção. Empresa nula é o caso normal de três situações que a
 * atendente enxerga igual: conversa sem vínculo, portal fora do ar e campo
 * em branco no cadastro. Nas três, a variável fica destacada em vez de
 * sumir.
 */
export function resolveQuickReplyForConversation(
  content: string,
  input: {
    conversation: ConversationDto | null;
    company: AzevedoOsCompany | null;
    me: UserDto | null;
  },
): QuickReplyResolution {
  const { conversation, company, me } = input;
  return resolveQuickReplyTemplate(content, {
    company,
    conversation: conversation
      ? buildQuickReplyConversationContext({
          customTitle: conversation.customTitle,
          title: conversation.title,
          externalChatId: conversation.externalChatId,
          departmentName: conversation.department?.name ?? null,
          assigneeName: conversation.assignedUser?.name ?? null,
        })
      : null,
    agent: me ? { name: me.name } : null,
    now: new Date(),
  });
}

/**
 * Quais avisos ainda valem para o texto que está no composer AGORA.
 *
 * O aviso não pode ficar preso ao que aconteceu na inserção: se a atendente
 * preencheu o "[CNPJ]" na mão, não há mais nada a avisar. A conferência é
 * pelo texto porque o composer é um campo de texto puro — não há como
 * carregar marcação escondida dentro dele, e um marcador invisível acabaria
 * indo para o cliente.
 */
export function pendingUnresolved(
  draft: string,
  unresolved: QuickReplyUnresolved[],
): QuickReplyUnresolved[] {
  return unresolved.filter((item) => draft.includes(item.placeholder));
}

/** Aviso do composer, antes do envio. Avisa, nunca bloqueia. */
export function unresolvedWarning(unresolved: QuickReplyUnresolved[]): string {
  const nomes = unresolved.map((item) => item.label).join(", ");
  return unresolved.length === 1
    ? `A variável ${nomes} não foi preenchida e vai sair assim mesmo. Enviar?`
    : `As variáveis ${nomes} não foram preenchidas e vão sair assim mesmo. Enviar?`;
}
