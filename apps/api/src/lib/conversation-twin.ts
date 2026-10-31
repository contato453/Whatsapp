import type { Conversation, PrismaClient } from "@azvchat/database";
import { brazilPhoneVariants, phoneFromChatId } from "@azvchat/shared";

/**
 * A MESMA pessoa sob outro endereço do WhatsApp, no MESMO número conectado.
 *
 * A conversa individual é única por `(número conectado, externalChatId)`, e o
 * `externalChatId` não é estável para uma pessoa: o WhatsApp a endereça ora
 * pelo telefone COM o nono dígito, ora SEM ele (conta antiga, comum fora de
 * SP), ora pelo identificador anônimo `@lid`. Quando o AZVCHAT inicia a
 * conversa (API de integração, disparo, lembrete, "conversar" a partir do
 * participante), ele só conhece o telefone digitado e monta o endereço com
 * ele; a resposta volta pelo endereço de verdade. Comparados ao pé da letra,
 * viravam duas conversas — o lead do site respondendo numa aba diferente da
 * mensagem que recebeu.
 *
 * Quem decide se é a mesma pessoa é o TELEFONE, com as duas grafias do nono
 * dígito (`brazilPhoneVariants`), nunca o nome: dois clientes com o mesmo nome
 * seriam fundidos. E só celular varia — fixo nunca teve nono dígito.
 *
 * Nada aqui encosta em `lib/access.ts`: é identidade da conversa, não alcance.
 */

/** Telefone de uma conversa individual pelo endereço, ou pelo `@lid` mapeado em `Contact`. */
export async function phoneForChatId(
  prisma: PrismaClient,
  whatsappInstanceId: string,
  externalChatId: string,
  knownPhone: string | null,
): Promise<string | null> {
  const fromJid = phoneFromChatId(externalChatId);
  if (fromJid) return fromJid;
  const fromWebhook = cleanPhone(knownPhone);
  if (fromWebhook) return fromWebhook;
  if (!externalChatId.endsWith("@lid")) return null;
  const contact = await prisma.contact.findUnique({
    where: { whatsappInstanceId_externalId: { whatsappInstanceId, externalId: externalChatId } },
    select: { phoneNumber: true },
  });
  return cleanPhone(contact?.phoneNumber);
}

/**
 * Conversas individuais do número conectado que são DESTE telefone, exceto o
 * próprio `excludeChatId`: os endereços de telefone (com e sem o nono dígito)
 * e, quando `includeLid`, os `@lid` que o `Contact` daquele número liga ao
 * telefone. Ordenadas da última mensagem para trás.
 */
export async function findPhoneTwins(
  prisma: PrismaClient,
  input: { whatsappInstanceId: string; phone: string; excludeChatId: string; includeLid: boolean },
): Promise<Conversation[]> {
  const variants = brazilPhoneVariants(input.phone);
  const chatIds = new Set(variants.map((variant) => `${variant}@s.whatsapp.net`));
  if (input.includeLid) {
    const contacts = await prisma.contact.findMany({
      where: { whatsappInstanceId: input.whatsappInstanceId, phoneNumber: { in: variants } },
      select: { externalId: true },
    });
    for (const contact of contacts) {
      if (contact.externalId.endsWith("@lid")) chatIds.add(contact.externalId);
    }
  }
  chatIds.delete(input.excludeChatId);
  if (chatIds.size === 0) return [];
  return prisma.conversation.findMany({
    where: {
      whatsappInstanceId: input.whatsappInstanceId,
      type: "individual",
      externalChatId: { in: [...chatIds] },
    },
    orderBy: { lastMessageAt: "desc" },
  });
}

/**
 * Entre várias conversas da mesma pessoa, a que o WhatsApp usa DE VERDADE: a
 * que recebeu a mensagem mais recente DO CLIENTE. É o único sinal confiável —
 * `lastMessageAt` também anda com o que nós enviamos, e um endereço montado
 * por palpite (o telefone digitado) recebe envio mas nunca recebe resposta.
 * Sem nenhuma resposta em nenhuma, fica `fallback`.
 */
export async function pickConversationWithLatestReply(
  prisma: PrismaClient,
  conversations: Conversation[],
  fallback: Conversation,
): Promise<Conversation> {
  if (conversations.length <= 1) return conversations[0] ?? fallback;
  const latest = await prisma.message.findFirst({
    where: {
      conversationId: { in: conversations.map((conversation) => conversation.id) },
      direction: "inbound",
    },
    orderBy: { timestamp: "desc" },
    select: { conversationId: true },
  });
  return conversations.find((conversation) => conversation.id === latest?.conversationId) ?? fallback;
}

function cleanPhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
