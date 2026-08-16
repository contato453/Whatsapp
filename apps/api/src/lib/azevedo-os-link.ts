import {
  AZEVEDO_OS_SOURCE,
  canManageAzevedoOsLink,
  type ExternalReferenceSource,
  type UserRole,
} from "@azvchat/shared";
import { ForbiddenError } from "./errors.js";

/**
 * Regra única de escrita em `Conversation.externalReference`.
 *
 * O campo tem dois donos: o código de cadastro digitado pela equipe
 * ("EMPRESA 001", fonte `manual`) e o ponteiro para a empresa do Azevedo-OS
 * (fonte `azevedo-os`). Um endpoint só — `PATCH /conversations/:id/reference`
 * — atende os dois, e é aqui que se decide quem pode o quê.
 *
 * Por que a permissão depende do ESTADO e não só do papel: o campo de
 * cadastro manual é de `agent`, e sem esta regra bastaria digitar qualquer
 * coisa nele para apagar o vínculo com a empresa — uma desvinculação
 * silenciosa feita por quem não tem permissão de desvincular.
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
  role: UserRole;
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
  const canManage = canManageAzevedoOsLink(input.role);

  // Limpar o campo: em conversa vinculada isso É a desvinculação, e por
  // isso exige supervisor mesmo o campo manual sendo de `agent`.
  if (input.nextReference === null) {
    if (linked && !canManage) {
      throw new ForbiddenError("Só supervisor ou administrador pode desvincular a empresa");
    }
    return {
      reference: null,
      source: null,
      auditAction: linked ? REFERENCE_AUDIT_ACTIONS.unlinked : REFERENCE_AUDIT_ACTIONS.manual,
      verifyCompany: false,
    };
  }

  if (input.nextSource === AZEVEDO_OS_SOURCE) {
    if (!canManage) {
      throw new ForbiddenError("Só supervisor ou administrador pode vincular a empresa");
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
