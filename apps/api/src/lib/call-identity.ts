import type { PrismaClient } from "@azvchat/database";
import type { CallerAvatarRef, CallerGroupRef } from "@azvchat/shared";

/**
 * Quem está ligando — resolvido NO BACKEND, antes de emitir o evento.
 *
 * A resolução mora aqui (e não no componente do aviso) por três motivos:
 * o frontend não tem como consultar contato e participante sem ganhar
 * rotas novas de diretório — que abririam a agenda a quem não deveria vê-la;
 * a mesma resposta serve para todas as abas da audiência de uma vez, em vez
 * de uma consulta por tela; e a regra de "o que pode virar nome" fica num
 * lugar só, testável.
 *
 * Todas as fontes são o Postgres local (consultas indexadas, milissegundos):
 * nada aqui fala com o WhatsApp, então a resolução não atrasa o aviso — a
 * chamada toca por poucos segundos e aviso atrasado é aviso inútil.
 */
export interface CallerIdentity {
  /** Nome resolvido; null = contato não identificado. Nunca é um LID. */
  name: string | null;
  /** Telefone real; null quando nenhuma fonte conhece o número. */
  phone: string | null;
  /** Grupos do sistema de que a pessoa participa, no mesmo número. */
  groups: CallerGroupRef[];
  avatar: CallerAvatarRef | null;
}

/** O que a resolução precisa saber da conversa individual já garantida. */
export interface CallConversationRef {
  id: string;
  title: string;
  customTitle: string | null;
  externalChatId: string;
  hasAvatar: boolean;
}

/** Contato já carregado por quem chamou, para não repetir a consulta. */
export interface PreloadedContact {
  name: string | null;
  pushName: string | null;
  phoneNumber: string | null;
}

/** Nome só vale se sobrar algo depois do trim — cadastro com espaço é sem nome. */
function cleanName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * O `title` de conversa criada por chamada (ou mensagem sem nome) é o próprio
 * JID ou só os dígitos dele — e dígitos de "@lid" NÃO são telefone. Título
 * assim não é nome: exibi-lo é exatamente o defeito que esta resolução veio
 * tirar da tela.
 */
function titleAsName(
  conversation: Pick<CallConversationRef, "title" | "customTitle" | "externalChatId">,
): string | null {
  const custom = cleanName(conversation.customTitle);
  if (custom) return custom;
  const title = cleanName(conversation.title);
  if (!title) return null;
  if (title === conversation.externalChatId) return null;
  const bareJid = conversation.externalChatId.split("@")[0] ?? "";
  if (title === bareJid) return null;
  // Título só de dígitos é um telefone guardado como título, não um nome.
  if (/^\d+$/.test(title)) return null;
  return title;
}

/**
 * Resolve a identidade de quem liga, parando na primeira fonte que acertar:
 *
 *   a. a conversa individual daquele chat — `customTitle` (escolha da equipe,
 *      que o sync nunca toca) e depois `title` quando ele é nome de verdade;
 *   b. o `Contact` — quem está salvo na agenda do número conectado;
 *   c. o `GroupParticipant` — `customName` antes de `name` (pushName), pela
 *      mesma razão do custom da conversa: é o que a casa controla.
 *
 * A ordem vai do que a equipe decidiu para o que veio sozinho do WhatsApp.
 *
 * Tudo é escopado ao número por onde a chamada entrou: a audiência do evento
 * é de quem tem ESSE número, e resolver por outro número revelaria contato
 * de um chip que a pessoa não enxerga.
 */
export async function resolveCallerIdentity(
  prisma: PrismaClient,
  input: {
    whatsappInstanceId: string;
    callerExternalId: string | null;
    /** Telefone extraído do JID — só existe quando ele é "@s.whatsapp.net". */
    callerPhone: string | null;
    conversation: CallConversationRef | null;
    isGroup: boolean;
    contact?: PreloadedContact | null;
  },
): Promise<CallerIdentity> {
  // Chamada de grupo: a identidade É o grupo (a conversa dele já dá nome e
  // foto). Não apontamos uma pessoa — o WhatsApp não diz quem discou.
  if (input.isGroup) {
    return {
      name: input.conversation ? titleAsName(input.conversation) : null,
      phone: null,
      groups: [],
      avatar:
        input.conversation?.hasAvatar === true
          ? { source: "conversation", id: input.conversation.id }
          : null,
    };
  }

  const contact =
    input.contact !== undefined
      ? input.contact
      : input.callerExternalId
        ? await prisma.contact.findFirst({
            where: {
              whatsappInstanceId: input.whatsappInstanceId,
              externalId: input.callerExternalId,
            },
            select: { name: true, pushName: true, phoneNumber: true },
          })
        : null;

  // Grupos de que a pessoa participa NO MESMO número: é o que responde "de
  // qual cliente é quem está ligando" quando ela nunca conversou no privado.
  const participations = input.callerExternalId
    ? await prisma.groupParticipant.findMany({
        where: {
          externalContactId: input.callerExternalId,
          group: { whatsappInstanceId: input.whatsappInstanceId },
        },
        select: {
          id: true,
          customName: true,
          name: true,
          phoneNumber: true,
          avatarUrl: true,
          group: { select: { name: true, conversationId: true } },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const participantName = participations
    .map((entry) => cleanName(entry.customName) ?? cleanName(entry.name))
    .find((value) => value != null);

  const name =
    (input.conversation ? titleAsName(input.conversation) : null) ??
    (contact ? (cleanName(contact.name) ?? cleanName(contact.pushName)) : null) ??
    participantName ??
    null;

  // Telefone SÓ quando alguma fonte o conhece de verdade. O identificador
  // "@lid" tem dígitos, mas eles não são número discável: melhor campo vazio
  // do que um "telefone" para o qual ninguém consegue retornar.
  const phone =
    cleanName(input.callerPhone) ??
    cleanName(contact?.phoneNumber) ??
    participations.map((entry) => cleanName(entry.phoneNumber)).find((value) => value != null) ??
    null;

  // Foto: a da conversa individual primeiro (é a do perfil de quem liga),
  // senão a do participante. A do Contact fica de fora porque não existe
  // rota autenticada que a sirva — chave de storage nunca viaja no payload.
  const participantWithAvatar = participations.find((entry) => entry.avatarUrl != null);
  const avatar: CallerAvatarRef | null =
    input.conversation?.hasAvatar === true
      ? { source: "conversation", id: input.conversation.id }
      : participantWithAvatar
        ? { source: "participant", id: participantWithAvatar.id }
        : null;

  return {
    name,
    phone,
    groups: participations.map((entry) => ({
      conversationId: entry.group.conversationId,
      name: entry.group.name,
    })),
    avatar,
  };
}
