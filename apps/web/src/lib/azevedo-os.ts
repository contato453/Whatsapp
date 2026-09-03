import type { AzevedoOsStatusTone } from "@azvchat/shared";

/**
 * Regras de exibição do card de cliente que não dependem de React — ficam
 * aqui para serem testadas sem montar componente (o frontend não tem
 * biblioteca de teste de UI, e não é esta entrega que vai introduzir uma).
 */

/**
 * `details.missingVars` só chega preenchido quando quem pediu é admin (a
 * API decide isso — ver `withAdminDetails` em `azevedo-os-client.ts`).
 * Aqui é só leitura defensiva: um `details` de outro tipo de erro, sem essa
 * chave, não pode virar exceção nem "any" solto.
 */
function missingVarsFrom(details: Record<string, unknown> | undefined): string[] | undefined {
  const value = details?.missingVars;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

/**
 * Texto do card quando a consulta ao Azevedo-OS falha.
 *
 * O código vem da API (`ApiError.code`) e cada um pede uma frase diferente:
 * "empresa não encontrada" é problema do vínculo (alguém apagou a empresa
 * lá), "não configurada" é pendência de instalação, e o resto é o sistema
 * externo fora do ar — caso em que o card avisa e a Inbox segue inteira.
 *
 * "Não configurada" tem DOIS textos, de propósito. Quem atende só precisa
 * saber que não é problema dele; quem administra precisa saber QUAL
 * variável falta, senão vai abrir o `.env` para adivinhar entre
 * `AZEVEDO_OS_API_URL` e `AZEVEDO_OS_API_TOKEN`. `isAdmin` decide qual
 * mostrar — nunca o inverso, e nunca com base em algo que o navegador
 * calcula sozinho.
 */
export function azevedoOsErrorMessage(
  code: string | undefined,
  context?: { isAdmin: boolean; details?: Record<string, unknown> },
): string {
  switch (code) {
    case "azevedo_os_company_not_found":
      return "Empresa não encontrada no Azevedo-OS. O vínculo pode ter ficado para trás.";
    case "azevedo_os_disabled": {
      const missingVars = context?.isAdmin ? missingVarsFrom(context.details) : undefined;
      if (missingVars && missingVars.length > 0) {
        return `Integração com o Azevedo-OS não configurada. Falta definir: ${missingVars.join(", ")}.`;
      }
      return "Integração com o Azevedo-OS não configurada. Avise o administrador do sistema.";
    }
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
