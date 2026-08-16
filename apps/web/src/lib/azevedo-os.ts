import type { AzevedoOsStatusTone } from "@azvchat/shared";

/**
 * Regras de exibição do card de cliente que não dependem de React — ficam
 * aqui para serem testadas sem montar componente (o frontend não tem
 * biblioteca de teste de UI, e não é esta entrega que vai introduzir uma).
 */

/**
 * Texto do card quando a consulta ao Azevedo-OS falha.
 *
 * O código vem da API (`ApiError.code`) e cada um pede uma frase diferente:
 * "empresa não encontrada" é problema do vínculo (alguém apagou a empresa
 * lá), "não configurada" é pendência de instalação, e o resto é o sistema
 * externo fora do ar — caso em que o card avisa e a Inbox segue inteira.
 */
export function azevedoOsErrorMessage(code: string | undefined): string {
  switch (code) {
    case "azevedo_os_company_not_found":
      return "Empresa não encontrada no Azevedo-OS. O vínculo pode ter ficado para trás.";
    case "azevedo_os_disabled":
      return "Integração com o Azevedo-OS não configurada.";
    default:
      return "Azevedo-OS temporariamente indisponível.";
  }
}

/** Cor do ponto de status. Neutro para o que o AZVCHAT não conhece. */
export function azevedoOsStatusDotClass(tone: AzevedoOsStatusTone): string {
  switch (tone) {
    case "active":
      return "bg-emerald-500";
    case "inactive":
      return "bg-rose-500";
    default:
      return "bg-slate-400";
  }
}
