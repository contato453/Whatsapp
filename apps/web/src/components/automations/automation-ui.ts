/**
 * O aviso de que desligar (ou excluir) um fluxo alcançou o que ele já
 * estava fazendo. Mora aqui porque as DUAS telas que desligam — a lista de
 * fluxos e o próprio construtor — precisam dizer a mesma coisa: desligar
 * sem contar quantos atendimentos pararam deixa exatamente a dúvida que
 * isto veio consertar (mesmo raciocínio de `stoppedSessionsMessage`, em
 * `components/ai/ai-ui.tsx`, do lado da IA).
 */
export function stoppedExecutionsMessage(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 atendimento que estava no fluxo foi encerrado; se havia IA nele, o cliente recebeu a mensagem de contingência e a conversa foi para a fila humana."
    : `${count} atendimentos que estavam no fluxo foram encerrados; onde havia IA, os clientes receberam a mensagem de contingência e as conversas foram para a fila humana.`;
}
