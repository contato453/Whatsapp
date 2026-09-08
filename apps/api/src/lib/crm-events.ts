import type { PrismaClient } from "@azvchat/database";
import { RealtimeEvents } from "@azvchat/shared";
import type { Server } from "socket.io";
import { conversationAudience, NO_INSTANCE } from "../realtime/socket.js";
import { loadOpportunityForSystem, type OpportunityWithRelations } from "./crm-access.js";
import { serializeCrmOpportunity } from "./crm-serialize.js";

/**
 * Publicação em tempo real do Kanban.
 *
 * A audiência é a MESMA função do atendimento (`conversationAudience`), e não
 * um esquema de salas próprio do CRM. O motivo é o de sempre: duas réguas de
 * quem-recebe-o-quê divergem na primeira manutenção, e a divergência aqui
 * apareceria como card com valor do cliente na tela de quem não pode ver
 * aquele número.
 *
 * Duas peças montam a chamada:
 *
 *   - o NÚMERO é o da conversa vinculada; oportunidade avulsa usa a chave
 *     `"none"`, e o socket já entra nessas salas na conexão;
 *   - o DEPARTAMENTO e o RESPONSÁVEL são os DA OPORTUNIDADE, nunca os da
 *     conversa. Um card pode estar com a Marina enquanto o atendimento está
 *     com o João: quem precisa ver o card se mexer é a Marina.
 */
export function crmAudience(
  organizationId: string,
  opportunity: {
    departmentId: string | null;
    assignedUserId: string | null;
    conversation?: { whatsappInstanceId: string } | null;
  },
): string[] {
  return conversationAudience(organizationId, {
    whatsappInstanceId: opportunity.conversation?.whatsappInstanceId ?? NO_INSTANCE,
    departmentId: opportunity.departmentId,
    assignedUserId: opportunity.assignedUserId,
  });
}

interface EmitDeps {
  io: Server;
  prisma: PrismaClient;
}

/**
 * Publica o card já carregado. Um evento só (`crm:opportunity`) para criação,
 * movimentação, edição, ganho, perda e reabertura: o quadro precisa da mesma
 * coisa em todos os casos — a versão atual do card.
 */
export function emitCrmOpportunity(
  deps: EmitDeps,
  organizationId: string,
  opportunity: OpportunityWithRelations,
): void {
  deps.io
    .to(crmAudience(organizationId, opportunity))
    .emit(RealtimeEvents.CrmOpportunity, serializeCrmOpportunity(opportunity));
}

/**
 * Recarrega e publica. Usado depois de escritas que mexem em relações (etapa,
 * responsável, etiquetas, atividade), quando o registro em mãos já não é o
 * que a tela precisa desenhar.
 *
 * Falha aqui não derruba a operação: a mudança já está gravada e aparece ao
 * recarregar — mesmo tratamento que o publish de mensagem recebe no
 * `instance-manager`.
 */
export async function emitCrmOpportunityById(
  deps: EmitDeps,
  organizationId: string,
  opportunityId: string,
): Promise<void> {
  try {
    const opportunity = await loadOpportunityForSystem(deps.prisma, organizationId, opportunityId);
    if (opportunity) emitCrmOpportunity(deps, organizationId, opportunity);
  } catch {
    // Publicação é acessório; a gravação já aconteceu.
  }
}
