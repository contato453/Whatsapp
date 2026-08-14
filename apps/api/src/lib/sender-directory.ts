import type { PrismaClient } from "@azvchat/database";

/**
 * Resolve nome e telefone do remetente de uma mensagem.
 *
 * Em grupos que usam endereçamento "@lid" o WhatsApp não envia o telefone
 * junto da mensagem — o identificador que chega é interno e anônimo. O
 * telefone real só aparece na lista de participantes do grupo (campo
 * `phone_number` dos metadados) e no cadastro de contatos da conexão.
 *
 * Por isso a resolução é feita na leitura, e não gravada na mensagem:
 * assim mensagens antigas passam a exibir o número assim que ele é
 * descoberto, sem precisar reprocessar histórico.
 */

export interface SenderInfo {
  phoneNumber: string | null;
  name: string | null;
}

export interface SenderLookupScope {
  whatsappInstanceId: string;
  externalChatId: string;
  type: string;
}

export type SenderDirectory = Map<string, SenderInfo>;

const EMPTY: SenderDirectory = new Map();

function merge(target: SenderDirectory, key: string, info: SenderInfo): void {
  const current = target.get(key);
  if (!current) {
    target.set(key, info);
    return;
  }
  // O primeiro que preencher cada campo prevalece — participantes do grupo
  // são consultados antes dos contatos, por serem a fonte mais específica.
  target.set(key, {
    phoneNumber: current.phoneNumber ?? info.phoneNumber,
    name: current.name ?? info.name,
  });
}

/** Procura os identificadores no cadastro de contatos da conexão. */
export async function resolveContacts(
  prisma: PrismaClient,
  whatsappInstanceId: string,
  externalIds: ReadonlyArray<string | null>,
): Promise<SenderDirectory> {
  const ids = [...new Set(externalIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return EMPTY;

  const directory: SenderDirectory = new Map();
  const contacts = await prisma.contact.findMany({
    where: { whatsappInstanceId, externalId: { in: ids } },
    select: { externalId: true, phoneNumber: true, name: true, pushName: true },
  });
  for (const contact of contacts) {
    merge(directory, contact.externalId, {
      phoneNumber: contact.phoneNumber || null,
      name: contact.name || contact.pushName || null,
    });
  }
  return directory;
}

/**
 * Monta o diretório apenas para os remetentes presentes no lote de
 * mensagens — o custo não cresce com o tamanho do grupo nem do histórico.
 */
export async function resolveSenders(
  prisma: PrismaClient,
  scope: SenderLookupScope,
  senderExternalIds: ReadonlyArray<string | null>,
): Promise<SenderDirectory> {
  const ids = [...new Set(senderExternalIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return EMPTY;

  const directory: SenderDirectory = new Map();

  if (scope.type === "group") {
    const participants = await prisma.groupParticipant.findMany({
      where: {
        externalContactId: { in: ids },
        group: {
          whatsappInstanceId: scope.whatsappInstanceId,
          externalId: scope.externalChatId,
        },
      },
      select: { externalContactId: true, phoneNumber: true, name: true },
    });
    for (const participant of participants) {
      merge(directory, participant.externalContactId, {
        phoneNumber: participant.phoneNumber || null,
        name: participant.name || null,
      });
    }
  }

  // Contatos entram depois: a lista do grupo é a fonte mais específica.
  for (const [externalId, info] of await resolveContacts(prisma, scope.whatsappInstanceId, ids)) {
    merge(directory, externalId, info);
  }

  return directory;
}
