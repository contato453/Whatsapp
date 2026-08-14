/**
 * Assinatura do atendente nas mensagens enviadas.
 *
 * Quando ligada no cadastro do usuário, o texto sai prefixado com o nome
 * dele — "Fernanda Oliveira:\nBoa tarde" —, do mesmo jeito que o WhatsApp
 * Business assina respostas de equipe. Serve para o cliente saber com quem
 * está falando quando várias pessoas atendem pelo mesmo número.
 */

export interface Signer {
  name: string;
  signMessages: boolean;
}

/** Já assinada? Evita duplicar quando o atendente digita o próprio nome. */
function alreadySigned(content: string, name: string): boolean {
  const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.toLowerCase() === `${name.trim().toLowerCase()}:`;
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
  return `${name}:\n${content}`;
}
