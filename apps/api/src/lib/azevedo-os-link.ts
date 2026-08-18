import { AZEVEDO_OS_SOURCE, type ExternalReferenceSource } from "@azvchat/shared";
import { ForbiddenError } from "./errors.js";

/**
 * Regra única de escrita em `Conversation.externalReference`.
 *
 * O campo tem dois donos: o código de cadastro digitado pela equipe
 * ("EMPRESA 001", fonte `manual`) e o ponteiro para a empresa do Azevedo-OS
 * (fonte `azevedo-os`). Um endpoint só — `PATCH /conversations/:id/reference`
 * — atende os dois, e é aqui que se decide quem pode o quê.
 *
 * Por que a permissão depende do ESTADO e não só das chaves: o campo de
 * cadastro manual é de atendente, e sem esta regra bastaria digitar
 * qualquer coisa nele para apagar o vínculo com a empresa — uma
 * desvinculação silenciosa feita por quem não tem permissão de desvincular.
 *
 * Por que VINCULAR e TROCAR são duas chaves separadas do catálogo, e não
 * uma: preencher empresa em conversa que está SEM empresa é rotina de
 * classificação, feita por quem atende. Trocar (ou desfazer) vínculo já
 * existente é mexer na classificação que outra pessoa fez, e errar ali
 * anexa a conversa ao cliente errado — o mesmo clique, com consequências
 * de tamanhos muito diferentes. Uma chave só obrigaria o escritório a
 * escolher entre travar a rotina e liberar o estrago.
 */

export const REFERENCE_AUDIT_ACTIONS = {
  manual: "conversation.reference_changed",
  linked: "conversation.azevedo_os_company_linked",
  changed: "conversation.azevedo_os_company_changed",
  unlinked: "conversation.azevedo_os_company_unlinked",
} as const;

export interface ReferenceUpdateInput {
  /** Estado atual da conversa. */
  currentReference: string | null;
  currentSource: string | null;
  /** Valor pedido, já sem espaços; `null` significa limpar. */
  nextReference: string | null;
  /** Mecanismo usado pelo pedido — validado por Zod na rota. */
  nextSource: ExternalReferenceSource;
  /** Chave `azevedo_os.link`: preencher empresa em conversa SEM empresa. */
  canLink: boolean;
  /** Chave `azevedo_os.relink`: trocar ou desfazer vínculo já existente. */
  canRelink: boolean;
}

export interface ReferenceUpdatePlan {
  reference: string | null;
  source: string | null;
  auditAction: string;
  /**
   * Confirmar a empresa no Azevedo-OS antes de gravar. Vale para vínculo e
   * troca: sem isso, o navegador registraria qualquer texto como se fosse
   * uma empresa e o card viveria pedindo uma empresa que não existe.
   */
  verifyCompany: boolean;
}

export function planReferenceUpdate(input: ReferenceUpdateInput): ReferenceUpdatePlan {
  const linked = input.currentSource === AZEVEDO_OS_SOURCE;

  // Limpar o campo: em conversa vinculada isso É a desvinculação, e por isso
  // cai na chave de TROCAR, mesmo o campo manual sendo do atendente.
  if (input.nextReference === null) {
    if (linked && !input.canRelink) {
      throw new ForbiddenError("Seu perfil não tem permissão para desfazer o vínculo com a empresa");
    }
    return {
      reference: null,
      source: null,
      auditAction: linked ? REFERENCE_AUDIT_ACTIONS.unlinked : REFERENCE_AUDIT_ACTIONS.manual,
      verifyCompany: false,
    };
  }

  if (input.nextSource === AZEVEDO_OS_SOURCE) {
    // Conversa vinculada exige a chave de TROCAR; conversa vazia, a de
    // VINCULAR. É exatamente aqui que as duas ações se separam.
    if (linked ? !input.canRelink : !input.canLink) {
      throw new ForbiddenError(
        linked
          ? "Seu perfil não tem permissão para trocar o vínculo de empresa desta conversa"
          : "Seu perfil não tem permissão para vincular a conversa a uma empresa",
      );
    }
    return {
      reference: input.nextReference,
      source: AZEVEDO_OS_SOURCE,
      auditAction: linked ? REFERENCE_AUDIT_ACTIONS.changed : REFERENCE_AUDIT_ACTIONS.linked,
      verifyCompany: true,
    };
  }

  // Código manual em conversa vinculada seria troca de mecanismo pela porta
  // dos fundos. Recusado para todo mundo, inclusive admin: desvincular é uma
  // decisão explícita, não efeito colateral de digitar num campo.
  if (linked) {
    throw new ForbiddenError(
      "Esta conversa está vinculada a uma empresa do Azevedo-OS. Desvincule antes de usar o código de cadastro manual.",
    );
  }

  return {
    reference: input.nextReference,
    source: "manual",
    auditAction: REFERENCE_AUDIT_ACTIONS.manual,
    verifyCompany: false,
  };
}
