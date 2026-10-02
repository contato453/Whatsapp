import type { PrismaClient } from "@azvchat/database";

/**
 * Telefone de uma conversa INDIVIDUAL, para o cabeçalho do painel de contexto.
 *
 * O caminho óbvio é ler os dígitos do próprio endereço ("5521...@s.whatsapp.net"),
 * e era só isso que a tela fazia. Só que contas novas chegam por "@lid", cujo
 * número NÃO é telefone — e aí a equipe abria a conversa e não tinha como saber
 * para qual número ligar, mesmo com o telefone conhecido em outro lugar do banco.
 * As fontes extras são as mesmas que o aviso de chamada já consulta
 * (`lib/call-identity.ts`), na ordem do que é mais confiável:
 *
 *   1. o próprio endereço, quando é "@s.whatsapp.net";
 *   2. o `Contact` daquele chat, no MESMO número conectado;
 *   3. o registro da PESSOA (`PersonProfile.phoneNumber`), único na organização;
 *   4. a pessoa como participante de algum grupo do MESMO número.
 *
 * Nenhuma fonte devolve os dígitos do LID: melhor campo vazio do que um
 * "telefone" para o qual ninguém consegue retornar. Escopado ao número da
 * conversa (e à organização, no caso do perfil) — quem chama já passou pelo
 * `conversationScope`, então nada aqui amplia o que a pessoa enxerga.
 */
export async function resolveConversationPhone(
  prisma: PrismaClient,
  organizationId: string,
  conversation: {
    type: string;
    externalChatId: string;
    whatsappInstanceId: string;
  },
): Promise<string | null> {
  if (conversation.type !== "individual") return null;

  const fromJid = phoneFromJid(conversation.externalChatId);
  if (fromJid) return fromJid;

  const externalId = conversation.externalChatId;
  const [contact, profile, participant] = await Promise.all([
    prisma.contact.findFirst({
      where: { whatsappInstanceId: conversation.whatsappInstanceId, externalId },
      select: { phoneNumber: true },
    }),
    prisma.personProfile.findUnique({
      where: { organizationId_externalId: { organizationId, externalId } },
      select: { phoneNumber: true },
    }),
    prisma.groupParticipant.findFirst({
      where: {
        externalContactId: externalId,
        group: { whatsappInstanceId: conversation.whatsappInstanceId },
      },
      orderBy: { createdAt: "asc" },
      select: { phoneNumber: true },
    }),
  ]);

  return (
    cleanPhone(contact?.phoneNumber) ??
    cleanPhone(profile?.phoneNumber) ??
    cleanPhone(participant?.phoneNumber) ??
    null
  );
}

/** Dígitos do endereço, só quando ele é número de verdade (nunca "@lid"). */
export function phoneFromJid(externalChatId: string): string | null {
  const [numero, dominio] = externalChatId.split("@");
  if (!numero || dominio !== "s.whatsapp.net") return null;
  return /^\d{8,15}$/.test(numero) ? numero : null;
}

function cleanPhone(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
