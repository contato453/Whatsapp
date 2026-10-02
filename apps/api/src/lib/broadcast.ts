import type { PrismaClient } from "@azvchat/database";
import {
  BROADCAST_LIMITS,
  formatPhone,
  isOptOutMessage,
  normalizeBrazilPhone,
  type BroadcastCampaignCountsDto,
  type BroadcastCampaignDto,
  type BroadcastCampaignStatus,
  type BroadcastContactDto,
  type BroadcastCrmMode,
  type BroadcastDeliveryDto,
  type BroadcastDeliveryStatus,
  type BroadcastOptOutDto,
  type BroadcastPauseReason,
  type BroadcastSkipReason,
} from "@azvchat/shared";

/**
 * FONTE ÚNICA dos disparos: serialização, contadores, descadastro e a
 * geração da fila.
 *
 * Tudo que responde "quantos faltam" sai daqui. A tela do disparo, a lista
 * de campanhas e o worker perguntam a MESMA função — se cada um contasse do
 * seu jeito, o painel diria "faltam 300" enquanto a fila tem 280, e é esse
 * tipo de divergência que faz a equipe parar de confiar no número (o mesmo
 * motivo de `lib/report-slice.ts` existir para o relatório).
 */

// ============================================================
// Leitura de campos JSON
// ============================================================

/** Colunas extras da planilha, sempre como mapa de string → string. */
export function readContactFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    result[key] = String(raw);
  }
  return result;
}

/** Variações do texto, sempre como lista de string não vazia. */
export function readMessageVariants(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

// ============================================================
// Contadores
// ============================================================

const EMPTY_COUNTS: BroadcastCampaignCountsDto = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  replied: 0,
};

/**
 * Os contadores de UMA campanha, derivados das entregas.
 *
 * **Nada disso é gravado na campanha**, de propósito: um contador
 * denormalizado que o worker incrementa sai de sincronia no primeiro
 * reinício no meio de um envio, e aí o painel mente para sempre. Derivar
 * custa um `groupBy` sobre um índice `(campaignId, status)` — barato até em
 * campanha de 10.000 contatos, que é o teto do módulo.
 */
export async function loadCampaignCounts(
  prisma: PrismaClient,
  campaignId: string,
): Promise<BroadcastCampaignCountsDto> {
  const [grouped, replied] = await Promise.all([
    prisma.broadcastDelivery.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { _all: true },
    }),
    prisma.broadcastDelivery.count({ where: { campaignId, repliedAt: { not: null } } }),
  ]);

  const counts: BroadcastCampaignCountsDto = { ...EMPTY_COUNTS, replied };
  for (const row of grouped) {
    const quantidade = row._count._all;
    counts.total += quantidade;
    const status = row.status as BroadcastDeliveryStatus;
    counts[status] += quantidade;
  }
  return counts;
}

/** Os contadores de VÁRIAS campanhas, numa consulta só (a lista do painel). */
export async function loadCountsForCampaigns(
  prisma: PrismaClient,
  campaignIds: string[],
): Promise<Map<string, BroadcastCampaignCountsDto>> {
  const mapa = new Map<string, BroadcastCampaignCountsDto>();
  for (const id of campaignIds) mapa.set(id, { ...EMPTY_COUNTS });
  if (campaignIds.length === 0) return mapa;

  const [grouped, replied] = await Promise.all([
    prisma.broadcastDelivery.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.broadcastDelivery.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: campaignIds }, repliedAt: { not: null } },
      _count: { _all: true },
    }),
  ]);

  for (const row of grouped) {
    const atual = mapa.get(row.campaignId);
    if (!atual) continue;
    const quantidade = row._count._all;
    atual.total += quantidade;
    atual[row.status as BroadcastDeliveryStatus] += quantidade;
  }
  for (const row of replied) {
    const atual = mapa.get(row.campaignId);
    if (atual) atual.replied = row._count._all;
  }
  return mapa;
}

// ============================================================
// Descadastro
// ============================================================

/** Os telefones da lista que estão descadastrados nesta organização. */
export async function loadOptedOutPhones(
  prisma: PrismaClient,
  organizationId: string,
  phones: string[],
): Promise<Set<string>> {
  if (phones.length === 0) return new Set();
  const linhas = await prisma.broadcastOptOut.findMany({
    where: { organizationId, phone: { in: phones } },
    select: { phone: true },
  });
  return new Set(linhas.map((linha) => linha.phone));
}

/**
 * Registra o descadastro. Idempotente: pedir para sair duas vezes não é
 * erro, e a segunda não sobrescreve o motivo da primeira.
 */
export async function registerOptOut(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    phone: string;
    reason: string;
    conversationId?: string | null;
    createdById?: string | null;
  },
): Promise<void> {
  await prisma.broadcastOptOut.upsert({
    where: { organizationId_phone: { organizationId: input.organizationId, phone: input.phone } },
    create: {
      organizationId: input.organizationId,
      phone: input.phone,
      reason: input.reason,
      conversationId: input.conversationId ?? null,
      createdById: input.createdById ?? null,
    },
    update: {},
  });
}

// ============================================================
// Serialização
// ============================================================

export interface AudienceRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeAudience(
  row: AudienceRow,
  contactCount: number,
  optedOutCount: number,
) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    contactCount,
    optedOutCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ContactRow {
  id: string;
  name: string | null;
  company: string | null;
  phone: string;
  fields: unknown;
  source: string;
  createdAt: Date;
}

export function serializeContact(row: ContactRow, optedOut: boolean): BroadcastContactDto {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    phone: row.phone,
    phoneLabel: formatPhone(row.phone),
    fields: readContactFields(row.fields),
    source: row.source === "import" ? "import" : "manual",
    optedOut,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  pausedReason: string | null;
  audienceId: string;
  whatsappInstanceId: string;
  message: string;
  messageVariants: unknown;
  scheduledFor: Date | null;
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  dailyLimit: number | null;
  respectBusinessHours: boolean;
  crmMode: string;
  crmPipelineId: string | null;
  crmStageId: string | null;
  tagId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextSendAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  audience?: { name: string } | null;
  instance?: { name: string } | null;
  pipeline?: { name: string } | null;
  stage?: { name: string } | null;
  tag?: { name: string } | null;
}

export function serializeCampaign(
  row: CampaignRow,
  counts: BroadcastCampaignCountsDto,
): BroadcastCampaignDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status as BroadcastCampaignStatus,
    pausedReason: (row.pausedReason as BroadcastPauseReason | null) ?? null,
    audienceId: row.audienceId,
    audienceName: row.audience?.name ?? "",
    whatsappInstanceId: row.whatsappInstanceId,
    instanceName: row.instance?.name ?? null,
    message: row.message,
    messageVariants: readMessageVariants(row.messageVariants),
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    minIntervalSeconds: row.minIntervalSeconds,
    maxIntervalSeconds: row.maxIntervalSeconds,
    dailyLimit: row.dailyLimit,
    respectBusinessHours: row.respectBusinessHours,
    crmMode: row.crmMode as BroadcastCrmMode,
    crmPipelineId: row.crmPipelineId,
    crmStageId: row.crmStageId,
    crmPipelineName: row.pipeline?.name ?? null,
    crmStageName: row.stage?.name ?? null,
    tagId: row.tagId,
    tagName: row.tag?.name ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    nextSendAt: row.nextSendAt?.toISOString() ?? null,
    counts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DeliveryRow {
  id: string;
  contactName: string | null;
  contactCompany: string | null;
  phone: string;
  status: string;
  skipReason: string | null;
  failureReason: string | null;
  content: string | null;
  sentAt: Date | null;
  repliedAt: Date | null;
  conversationId: string | null;
  attempts: number;
}

export function serializeDelivery(row: DeliveryRow): BroadcastDeliveryDto {
  return {
    id: row.id,
    contactName: row.contactName,
    contactCompany: row.contactCompany,
    phone: row.phone,
    phoneLabel: formatPhone(row.phone),
    status: row.status as BroadcastDeliveryStatus,
    skipReason: (row.skipReason as BroadcastSkipReason | null) ?? null,
    failureReason: row.failureReason,
    content: row.content,
    sentAt: row.sentAt?.toISOString() ?? null,
    repliedAt: row.repliedAt?.toISOString() ?? null,
    conversationId: row.conversationId,
    attempts: row.attempts,
  };
}

export function serializeOptOut(row: {
  id: string;
  phone: string;
  reason: string;
  createdAt: Date;
}): BroadcastOptOutDto {
  return {
    id: row.id,
    phone: row.phone,
    phoneLabel: formatPhone(row.phone),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

// ============================================================
// Geração da fila
// ============================================================

export interface GenerateDeliveriesResult {
  queued: number;
  skippedOptOut: number;
  skippedInvalid: number;
}

/**
 * Materializa a fila da campanha — uma entrega por contato da audiência.
 *
 * **Gerar tudo de uma vez, no início, é decisão.** A alternativa (descobrir o
 * próximo contato a cada mensagem) tornaria "quantos faltam" uma conta
 * diferente a cada consulta e faria a audiência editada NO MEIO do disparo
 * mudar quem recebe — a pessoa configurou o envio para a lista que existia
 * quando apertou o botão, não para o que a lista virar às três da manhã.
 * Com a fila materializada, retomar depois de um reinício é continuar de
 * onde parou, sem pular nem repetir ninguém.
 *
 * Quem já está descadastrado entra como `skipped`/`opted_out` em vez de
 * ficar de fora: o relatório precisa mostrar que a pessoa ESTAVA na lista e
 * não recebeu, senão o total da campanha não fecha com o tamanho da
 * audiência e ninguém entende a diferença.
 */
export async function generateDeliveries(
  prisma: PrismaClient,
  campaign: { id: string; organizationId: string; audienceId: string },
): Promise<GenerateDeliveriesResult> {
  const contatos = await prisma.broadcastContact.findMany({
    where: { audienceId: campaign.audienceId },
    orderBy: { createdAt: "asc" },
    take: BROADCAST_LIMITS.MAX_AUDIENCE_SIZE,
  });
  if (contatos.length === 0) return { queued: 0, skippedOptOut: 0, skippedInvalid: 0 };

  const descadastrados = await loadOptedOutPhones(
    prisma,
    campaign.organizationId,
    contatos.map((contato) => contato.phone),
  );

  let queued = 0;
  let skippedOptOut = 0;
  let skippedInvalid = 0;

  const linhas = contatos.map((contato) => {
    const normalizado = normalizeBrazilPhone(contato.phone);
    let status: BroadcastDeliveryStatus = "pending";
    let skipReason: BroadcastSkipReason | null = null;

    if (!normalizado.ok) {
      status = "skipped";
      skipReason = "invalid_phone";
      skippedInvalid += 1;
    } else if (descadastrados.has(contato.phone)) {
      status = "skipped";
      skipReason = "opted_out";
      skippedOptOut += 1;
    } else {
      queued += 1;
    }

    return {
      organizationId: campaign.organizationId,
      campaignId: campaign.id,
      contactId: contato.id,
      phone: contato.phone,
      contactName: contato.name,
      contactCompany: contato.company,
      status,
      skipReason,
    };
  });

  // `skipDuplicates` cobre a retomada: gerar a fila de novo numa campanha que
  // já tem entregas não duplica ninguém (o único `(campaignId, contactId)`
  // recusa, e o resto entra).
  await prisma.broadcastDelivery.createMany({ data: linhas, skipDuplicates: true });
  return { queued, skippedOptOut, skippedInvalid };
}

// ============================================================
// Resposta do contato
// ============================================================

export interface BroadcastInboundResult {
  /** A conversa era de um disparo e a resposta foi registrada agora. */
  replied: boolean;
  /** A mensagem era um pedido de descadastro. */
  optedOut: boolean;
  /** Entrega marcada, quando houve — o chamador decide o que fazer com ela. */
  delivery: {
    id: string;
    campaignId: string;
    phone: string;
    contactName: string | null;
    conversationId: string | null;
  } | null;
}

/**
 * O que uma mensagem RECEBIDA significa para os disparos.
 *
 * Duas coisas, e as duas são sobre não perder o número:
 *   1. **taxa de resposta** — a única métrica que diz se o disparo funcionou
 *      (entregue não é lido, lido não é interessado);
 *   2. **descadastro automático** — quem responde "SAIR" para de receber na
 *      hora, em TODA campanha da organização. Receber depois de pedir para
 *      sair é o que transforma cliente irritado em denúncia, e denúncia é o
 *      que derruba um chip mais rápido que volume.
 *
 * Nunca lança: é chamada do caminho de ingestão de mensagem, e disparo é
 * acessório — mensagem de cliente não pode se perder porque o módulo de
 * campanha tropeçou. Quem chama trata o `null`.
 */
export async function handleBroadcastInbound(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    conversationId: string;
    content: string | null;
  },
): Promise<BroadcastInboundResult> {
  const vazio: BroadcastInboundResult = { replied: false, optedOut: false, delivery: null };

  // A entrega mais recente desta conversa que ainda não foi respondida. Sem
  // `repliedAt: null` a segunda mensagem do cliente sobrescreveria a hora da
  // primeira resposta, e a métrica passaria a medir a última mensagem dele.
  const delivery = await prisma.broadcastDelivery.findFirst({
    where: {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      repliedAt: null,
      status: "sent",
    },
    orderBy: { sentAt: "desc" },
    select: {
      id: true,
      campaignId: true,
      phone: true,
      contactName: true,
      conversationId: true,
    },
  });

  const pediuSaida = isOptOutMessage(input.content);

  if (delivery) {
    await prisma.broadcastDelivery.update({
      where: { id: delivery.id },
      data: { repliedAt: new Date() },
    });
  }

  if (pediuSaida) {
    // O telefone sai da entrega quando ela existe; sem entrega, a conversa
    // ainda pode ser de um disparo antigo, então o telefone vem do JID.
    let phone = delivery?.phone ?? null;
    if (!phone) {
      const conversa = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
        select: { externalChatId: true },
      });
      const normalizado = normalizeBrazilPhone(conversa?.externalChatId ?? null);
      phone = normalizado.ok ? normalizado.phone : null;
    }
    if (phone) {
      await registerOptOut(prisma, {
        organizationId: input.organizationId,
        phone,
        reason: "keyword",
        conversationId: input.conversationId,
      });
    }
  }

  if (!delivery && !pediuSaida) return vazio;
  return { replied: Boolean(delivery), optedOut: pediuSaida, delivery };
}
