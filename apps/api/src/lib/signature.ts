import { bold } from "@azvchat/shared";

/**
 * Assinatura do atendente nas mensagens enviadas.
 *
 * Quando ligada no cadastro do usuário, o texto sai prefixado com o nome
 * dele em negrito — "*Fernanda Oliveira:*\nBoa tarde" —, do mesmo jeito que
 * o WhatsApp Business assina respostas de equipe. Serve para o cliente
 * saber com quem está falando quando várias pessoas usam o mesmo número.
 */

export interface Signer {
  name: string;
  signMessages: boolean;
}

/**
 * Já assinada? Evita duplicar quando o atendente digita o próprio nome.
 * Aceita com e sem os asteriscos: mensagens assinadas antes de a
 * assinatura virar negrito continuam sendo reconhecidas.
 */
function alreadySigned(content: string, name: string): boolean {
  const firstLine = content.split("\n", 1)[0]?.trim().toLowerCase() ?? "";
  const expected = `${name.trim().toLowerCase()}:`;
  return firstLine === expected || firstLine === `*${expected}*`;
}

/**
 * Devolve o conteúdo assinado. Não assina texto vazio — legenda ausente
 * continua ausente, para não criar legenda só com o nome.
 */
export function applySignature(
  content: string | null | undefined,
  signer: Signer | null | undefined,
): string | null {
  if (content == null) return null;
  if (!signer?.signMessages) return content;
  const name = signer.name.trim();
  if (!name || content.trim().length === 0) return content;
  if (alreadySigned(content, name)) return content;
  // Negrito do WhatsApp: destaca quem está atendendo, separando a
  // assinatura do texto da mensagem.
  return `${bold(`${name}:`)}\n${content}`;
}
