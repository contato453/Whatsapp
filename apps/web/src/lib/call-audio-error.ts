import { ApiError } from "@/lib/api";

/**
 * Frase do painel de ligação quando o ÁUDIO não sobe (a chamada já foi
 * discada ou atendida, e o que falhou foi microfone ou a troca de SDP).
 *
 * Antes tudo virava "Falha ao conectar o áudio.", e a frase igual para quatro
 * causas diferentes deixou um computador sem microfone parecendo defeito do
 * sistema por dias (relato do Financeiro, novembro de 2026). Cada causa tem
 * remédio diferente — plugar o fone, fechar outro programa, liberar o site,
 * chamar o suporte —, então a frase precisa dizer qual é.
 */
export function callAudioErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // A troca de SDP passou pela nossa API e o provedor recusou: não é o
    // computador da pessoa, é o servidor de ligações.
    return `O servidor de ligações recusou o áudio (${err.message}). Avise o suporte.`;
  }
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permissão de microfone negada. Libere o microfone para este site no cadeado ao lado do endereço.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Nenhum microfone encontrado neste computador. Conecte o fone ou o microfone e tente de novo.";
    case "NotReadableError":
    case "AbortError":
      return "O microfone está ocupado ou bloqueado pelo Windows. Feche outros programas que usam o microfone (Teams, Meet, WhatsApp Desktop) e confira a privacidade do microfone no Windows.";
    default:
      return "Falha ao conectar o áudio.";
  }
}
