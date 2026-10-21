/**
 * Coordena a sincronização de grupos (participantes) pedida a partir da API.
 *
 * Existe porque o provider do AstraCalls, ao contrário do Baileys, não manda
 * grupo nenhum sozinho: sem um pedido explícito, grupo criado depois da troca
 * de provider nascia só como conversa — sem linha em `WhatsAppGroup`, sem
 * participantes, sem "@". Os pedidos chegam de três lugares (mensagem de grupo
 * desconhecido, botão de atualizar do painel e o próprio provider), e cada
 * sincronização busca TODOS os grupos do número, então duas regras:
 *
 * 1. pedidos simultâneos do mesmo número viram UMA execução, mais no máximo
 *    uma de reforço — rajada de mensagens num grupo novo não pode virar uma
 *    busca da lista inteira por mensagem;
 * 2. grupo desconhecido que a sincronização NÃO trouxe (a conta saiu dele, ou
 *    o AstraCalls não o devolve) não é pedido de novo por um tempo — senão
 *    cada mensagem dele dispararia a busca da lista inteira para sempre.
 */
export const MISSING_GROUP_RETRY_MS = 10 * 60 * 1000;

export class GroupSyncCoordinator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly missingAttempts = new Map<string, number>();

  constructor(
    private readonly run: (instanceId: string) => Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Pede a sincronização do número. Devolve a promessa da execução que cobre
   * este pedido. Nunca rejeita: falha de rede do provider não pode derrubar
   * quem pediu (quem roda já loga).
   */
  request(instanceId: string): Promise<void> {
    const current = this.running.get(instanceId);
    if (current) {
      // A execução em andamento pode já ter lido a lista antes do grupo
      // existir: agenda um reforço, uma vez só. O reforço roda dentro da
      // MESMA execução (o laço abaixo), então esperar por ela cobre os dois.
      this.pending.add(instanceId);
      return current;
    }
    const execution = (async () => {
      try {
        do {
          this.pending.delete(instanceId);
          await this.run(instanceId).catch(() => undefined);
        } while (this.pending.has(instanceId));
      } finally {
        this.running.delete(instanceId);
      }
    })();
    this.running.set(instanceId, execution);
    return execution;
  }

  /**
   * Chegou mensagem de um grupo que ainda não tem registro: sincroniza, a não
   * ser que o mesmo grupo já tenha sido procurado há pouco sem sucesso.
   */
  requestForMissingGroup(instanceId: string, externalChatId: string): Promise<void> | null {
    const key = `${instanceId}:${externalChatId}`;
    const last = this.missingAttempts.get(key);
    const now = this.now();
    if (last !== undefined && now - last < MISSING_GROUP_RETRY_MS) return null;
    this.missingAttempts.set(key, now);
    return this.request(instanceId);
  }
}
