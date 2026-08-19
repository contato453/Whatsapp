import type { ParticipantClientRole, PrismaClient } from "@azvchat/database";

/**
 * Identidade da pessoa no nível da ORGANIZAÇÃO (`PersonProfile`).
 *
 * A identidade saiu da linha do grupo porque a mesma pessoa participa de
 * vários grupos do mesmo cliente: editar grupo a grupo obrigava a repetir a
 * correção, e na prática ninguém repetia. Este arquivo é a fonte única de
 * como o registro da pessoa é LIDO (em lote, nunca uma consulta por linha) e
 * ESCRITO (a edição pelo lápis, que vale para o sistema inteiro).
 *
 * Regra central: LINHA EXISTENTE vale inteira, mesmo com campos nulos —
 * limpar o nome é decisão da equipe, não ausência de dado. Linha AUSENTE cai
 * no legado por grupo (`GroupParticipant.customName`/`clientRole`), que a
 * migration deixou no banco de propósito: é o fallback de quem estava em
 * conflito entre grupos e ainda não foi resolvido por uma edição humana.
 *
 * Visibilidade: nada aqui abre consulta nova para o usuário final. Os
 * perfis só são resolvidos a partir de listas de participantes/conversas que
 * JÁ passaram pelo recorte de `access.ts` — unificar identidade não vira um
 * diretório de contatos.
 */

export interface PersonProfileData {
  customName: string | null;
  clientRole: ParticipantClientRole | null;
}

export type PersonProfileDirectory = Map<string, PersonProfileData>;

const EMPTY: PersonProfileDirectory = new Map();

/** Perfis das pessoas de um grupo, em UM SELECT para a lista inteira. */
export async function resolvePersonProfiles(
  prisma: PrismaClient,
  organizationId: string,
  externalIds: ReadonlyArray<string | null>,
): Promise<PersonProfileDirectory> {
  const ids = [...new Set(externalIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return EMPTY;
  const rows = await prisma.personProfile.findMany({
    where: { organizationId, externalId: { in: ids } },
    select: { externalId: true, customName: true, clientRole: true },
  });
  return new Map(
    rows.map((row) => [row.externalId, { customName: row.customName, clientRole: row.clientRole }]),
  );
}

/**
 * Em quantos grupos da organização cada pessoa está — o número que a tela
 * mostra antes de salvar ("a alteração vale para N grupos"). Uma consulta
 * agrupada para o grupo inteiro.
 */
export async function countPersonGroups(
  prisma: PrismaClient,
  organizationId: string,
  externalIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  if (externalIds.length === 0) return new Map();
  const rows = await prisma.groupParticipant.groupBy({
    by: ["externalContactId"],
    where: {
      externalContactId: { in: [...externalIds] },
      group: { organizationId },
    },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.externalContactId, row._count._all]));
}

/** Telefone extraído de um JID "@s.whatsapp.net"; LID nunca vira telefone. */
export function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
  return digits.length > 0 ? digits : null;
}

interface ConversationRef {
  id: string;
  type: string;
  externalChatId: string;
}

/**
 * Nome da pessoa para CONVERSAS INDIVIDUAIS, em lote por página.
 *
 * É o que faz "corrigi no grupo, corrigiu no privado": a conversa individual
 * passa a exibir o nome definido pela equipe quando não há apelido próprio
 * de conversa (`customTitle` continua mais forte — é decisão explícita
 * daquela conversa).
 *
 * O casamento é primeiro pelo identificador exato e depois pelo telefone,
 * porque o mesmo número pode conversar no privado por "@s.whatsapp.net" e
 * estar no grupo por "@lid". A ponte por telefone é SÓ de exibição — nunca
 * funde registros; com mais de um perfil no mesmo telefone (alguém trocou de
 * número), vence o alterado por último, deterministicamente.
 */
export async function resolveConversationPersonNames(
  prisma: PrismaClient,
  organizationId: string,
  conversations: ReadonlyArray<ConversationRef>,
): Promise<Map<string, string | null>> {
  const individuals = conversations.filter((conversation) => conversation.type === "individual");
  if (individuals.length === 0) return new Map();

  const chatIds = [...new Set(individuals.map((conversation) => conversation.externalChatId))];
  const phones = [
    ...new Set(
      individuals
        .map((conversation) => phoneFromJid(conversation.externalChatId))
        .filter((phone): phone is string => phone != null),
    ),
  ];

  const rows = await prisma.personProfile.findMany({
    where: {
      organizationId,
      OR: [
        { externalId: { in: chatIds } },
        ...(phones.length > 0 ? [{ phoneNumber: { in: phones } }] : []),
      ],
    },
    select: { externalId: true, phoneNumber: true, customName: true, updatedAt: true },
    // Com dois perfis no mesmo telefone, o mapa fica com o mais recente
    // (o último a ser gravado vence na iteração abaixo).
    orderBy: { updatedAt: "asc" },
  });

  const byExternalId = new Map<string, string | null>();
  const byPhone = new Map<string, string | null>();
  for (const row of rows) {
    byExternalId.set(row.externalId, row.customName);
    if (row.phoneNumber) byPhone.set(row.phoneNumber, row.customName);
  }

  const result = new Map<string, string | null>();
  for (const conversation of individuals) {
    const exact = byExternalId.get(conversation.externalChatId);
    if (exact !== undefined) {
      result.set(conversation.id, exact);
      continue;
    }
    const phone = phoneFromJid(conversation.externalChatId);
    result.set(conversation.id, (phone ? byPhone.get(phone) : undefined) ?? null);
  }
  return result;
}

/** Versão de conversa única, para os pontos que publicam um DTO por vez. */
export async function resolveConversationPersonName(
  prisma: PrismaClient,
  organizationId: string,
  conversation: ConversationRef,
): Promise<string | null> {
  if (conversation.type !== "individual") return null;
  const names = await resolveConversationPersonNames(prisma, organizationId, [conversation]);
  return names.get(conversation.id) ?? null;
}

export interface ParticipantEditInput {
  customName?: string | null;
  clientRole?: ParticipantClientRole | null;
}

interface EditableParticipant {
  externalContactId: string;
  phoneNumber: string;
  customName: string | null;
  clientRole: ParticipantClientRole | null;
}

/**
 * Grava a edição do lápis NO REGISTRO DA PESSOA (upsert), valendo para todos
 * os grupos de uma vez.
 *
 * Na criação, o campo que NÃO está sendo editado é semeado com o valor da
 * linha que a pessoa está vendo na tela: sem isso, renomear alguém que tinha
 * papel marcado apagaria o chip de sócio de todos os grupos em silêncio —
 * porque a linha nova, valendo inteira, diria "sem papel".
 */
export async function upsertPersonProfile(
  prisma: PrismaClient,
  organizationId: string,
  participant: EditableParticipant,
  edit: ParticipantEditInput,
): Promise<void> {
  const phone = participant.phoneNumber.replace(/\D/g, "");
  await prisma.personProfile.upsert({
    where: {
      organizationId_externalId: {
        organizationId,
        externalId: participant.externalContactId,
      },
    },
    update: {
      ...(edit.customName !== undefined ? { customName: edit.customName } : {}),
      ...(edit.clientRole !== undefined ? { clientRole: edit.clientRole } : {}),
      // O telefone descoberto pela participação mantém a ponte da conversa
      // individual atualizada; vazio nunca apaga um telefone já conhecido.
      ...(phone.length > 0 ? { phoneNumber: phone } : {}),
    },
    create: {
      organizationId,
      externalId: participant.externalContactId,
      phoneNumber: phone.length > 0 ? phone : null,
      customName: edit.customName !== undefined ? edit.customName : participant.customName,
      clientRole: edit.clientRole !== undefined ? edit.clientRole : participant.clientRole,
    },
  });
}
