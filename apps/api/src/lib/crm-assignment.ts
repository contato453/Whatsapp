import type { PrismaClient } from "@azvchat/database";
import {
  crmLeastOpenPick,
  crmRoundRobinPick,
  type CrmAssignmentMode,
} from "@azvchat/shared";
import type { Logger } from "pino";
import { conversationAssigneeWhere } from "./access.js";

/**
 * DISTRIBUIÇÃO AUTOMÁTICA — quem fica com a oportunidade nova.
 *
 * Existe porque no funil comercial o lead chega sem dono, e "quem pegar
 * primeiro" na prática significa que ninguém pega: a conversa fica na fila
 * até o cliente desistir ou cobrar. Dar dono na hora resolve isso, e o
 * histórico registra que foi o sistema quem escolheu.
 *
 * TRÊS REGRAS QUE NÃO PODEM CAIR:
 *
 * 1. **só recebe quem ENXERGA a conversa.** É a mesma
 *    `conversationAssigneeWhere` da transferência manual (CLAUDE.md §13):
 *    distribuir para quem não tem o número grava um responsável que nunca vai
 *    abrir o card, e a oportunidade some da tela de todo mundo sem erro
 *    nenhum. O rodízio é o pior lugar possível para essa falha, porque ela
 *    aconteceria de forma intermitente — só nas vezes em que a vez fosse
 *    daquela pessoa;
 * 2. **o rodízio conta no BANCO, não na memória.** O cursor é incrementado
 *    atomicamente e o índice sai do valor devolvido: duas oportunidades
 *    criadas no mesmo instante recebem números diferentes. Ler "o último que
 *    recebeu" e calcular o próximo aqui perderia a corrida em silêncio, e o
 *    rodízio entregaria dois leads seguidos para a mesma pessoa;
 * 3. **falha na distribuição não impede a criação.** Sem candidato elegível
 *    (ninguém no rodízio enxerga aquele número, a pessoa fixa foi desativada),
 *    a oportunidade nasce SEM responsável e aparece para todos que enxergam o
 *    funil — que é o estado que a equipe percebe e conserta. Recusar a criação
 *    faria o clique do atendente falhar por causa de uma configuração.
 */

export interface AssignmentDeps {
  prisma: PrismaClient;
  logger: Logger;
}

/** O funil, na medida em que ele decide a distribuição. */
export interface AssignmentPipeline {
  id: string;
  assignmentMode: CrmAssignmentMode;
  assignmentFixedUserId: string | null;
  /** Pool explícito do rodízio; vazio = todo mundo que enxerga a conversa. */
  assignees?: Array<{ userId: string }>;
}

/** A conversa vinculada, ou `null` para o lead avulso. */
export interface AssignmentConversation {
  whatsappInstanceId: string;
  departmentId: string | null;
}

export interface AssignmentResult {
  /** Quem ficou com a oportunidade; `null` = ninguém. */
  userId: string | null;
  /** Modo que decidiu — vai para o histórico e para a auditoria. */
  mode: CrmAssignmentMode;
  /** Por que não houve escolha, quando não houve. Só para log. */
  reason?: "sem_candidatos" | "fixo_indisponivel" | "modo_none";
}

export async function resolveCrmAssignee(
  deps: AssignmentDeps,
  input: {
    organizationId: string;
    pipeline: AssignmentPipeline;
    conversation: AssignmentConversation | null;
    /** Responsável da conversa — a herança do modo padrão. */
    conversationAssigneeId: string | null;
  },
): Promise<AssignmentResult> {
  const mode = input.pipeline.assignmentMode;

  if (mode === "none") return { userId: null, mode, reason: "modo_none" };

  if (mode === "inherit_conversation") {
    // O comportamento de sempre: quem atende o cliente fica com a venda. Não
    // passa pela checagem de alcance porque o responsável da conversa,
    // por definição, enxerga a conversa.
    return { userId: input.conversationAssigneeId, mode };
  }

  if (mode === "fixed") {
    const alvo = input.pipeline.assignmentFixedUserId;
    if (!alvo) return { userId: null, mode, reason: "fixo_indisponivel" };
    const elegivel = await elegiveis(deps, input.organizationId, input.conversation, [alvo]);
    if (elegivel.length === 0) {
      // A pessoa fixa saiu do cadastro, foi desativada ou perdeu o número.
      // O card nasce órfão e alguém do time o puxa — melhor do que gravar um
      // dono que não vai abri-lo.
      deps.logger.warn({
        event: "crm_assignment_fixed_unavailable",
        pipelineId: input.pipeline.id,
        userId: alvo,
      });
      return { userId: null, mode, reason: "fixo_indisponivel" };
    }
    return { userId: alvo, mode };
  }

  // Rodízio e menor carga partem do mesmo pool.
  const pool = (input.pipeline.assignees ?? []).map((item) => item.userId);
  const candidatos = await elegiveis(deps, input.organizationId, input.conversation, pool);
  if (candidatos.length === 0) {
    deps.logger.warn({
      event: "crm_assignment_without_candidates",
      pipelineId: input.pipeline.id,
      mode,
      poolConfigurado: pool.length,
    });
    return { userId: null, mode, reason: "sem_candidatos" };
  }

  // O incremento é a parte atômica: o número devolvido é só desta chamada.
  const { assignmentCursor } = await deps.prisma.crmPipeline.update({
    where: { id: input.pipeline.id },
    data: { assignmentCursor: { increment: 1 } },
    select: { assignmentCursor: true },
  });

  if (mode === "round_robin") {
    return { userId: crmRoundRobinPick(candidatos, assignmentCursor - 1), mode };
  }

  // `least_open`: a carga é contada NESTE funil, e só o que está em aberto —
  // oportunidade fechada não ocupa ninguém. Uma consulta agrupada, não uma
  // por pessoa.
  const cargas = await deps.prisma.crmOpportunity.groupBy({
    by: ["assignedUserId"],
    where: {
      organizationId: input.organizationId,
      pipelineId: input.pipeline.id,
      status: "open",
      assignedUserId: { in: candidatos },
    },
    _count: { _all: true },
  });
  const porUsuario = new Map(
    cargas.map((linha) => [linha.assignedUserId ?? "", linha._count._all]),
  );
  return {
    userId: crmLeastOpenPick(
      candidatos.map((userId) => ({ userId, openCount: porUsuario.get(userId) ?? 0 })),
      assignmentCursor - 1,
    ),
    mode,
  };
}

/**
 * Os candidatos de verdade: ativos, da organização, que ENXERGAM a conversa —
 * e, quando o funil tem pool configurado, que estejam nele.
 *
 * Ordenados por id: o rodízio precisa de ordem estável, senão "o próximo"
 * mudaria a cada consulta e deixaria de ser rodízio.
 *
 * Lead avulso (sem conversa) não tem número a conferir; sobra o critério de
 * pessoa ativa, que é o que dele existe.
 */
async function elegiveis(
  deps: AssignmentDeps,
  organizationId: string,
  conversation: AssignmentConversation | null,
  pool: string[],
): Promise<string[]> {
  const usuarios = await deps.prisma.user.findMany({
    where: {
      ...(conversation
        ? conversationAssigneeWhere(organizationId, conversation)
        : { organizationId, status: "active" as const }),
      ...(pool.length > 0 ? { id: { in: pool } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return usuarios.map((usuario) => usuario.id);
}
