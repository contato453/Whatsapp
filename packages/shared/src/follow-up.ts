/**
 * Follow-up automático — automações por tempo sem resposta do cliente.
 *
 * O vínculo com departamento é o MESMO desenho de `Tag`/`QuickReply`
 * (`department-resource.ts`, na API): a flag `isGeneral` vale para a
 * organização inteira, ou a regra tem uma ou mais linhas de departamento —
 * nunca as duas coisas. É o que permite UMA regra ser usada por vários
 * departamentos (Comercial + Financeiro) sem duplicar cadastro nenhum.
 */

export const FOLLOW_UP_RULE_STATUSES = ["active", "inactive"] as const;
export type FollowUpRuleStatus = (typeof FOLLOW_UP_RULE_STATUSES)[number];

export const FOLLOW_UP_RULE_STATUS_LABELS: Record<FollowUpRuleStatus, string> = {
  active: "Ativo",
  inactive: "Inativo",
};

export const FOLLOW_UP_TIME_UNITS = ["minutes", "hours", "days"] as const;
export type FollowUpTimeUnit = (typeof FOLLOW_UP_TIME_UNITS)[number];

export const FOLLOW_UP_TIME_UNIT_LABELS: Record<FollowUpTimeUnit, string> = {
  minutes: "minutos",
  hours: "horas",
  days: "dias",
};

/**
 * "Encaminhar" e "webhook/API" (citados no pedido original como possíveis)
 * ficaram de fora desta entrega — ver o comentário no `schema.prisma`.
 */
export const FOLLOW_UP_STEP_ACTIONS = [
  "send_message",
  "add_tag",
  "remove_tag",
  "change_status",
] as const;
export type FollowUpStepAction = (typeof FOLLOW_UP_STEP_ACTIONS)[number];

export const FOLLOW_UP_STEP_ACTION_LABELS: Record<FollowUpStepAction, string> = {
  send_message: "Enviar mensagem",
  add_tag: "Adicionar etiqueta",
  remove_tag: "Remover etiqueta",
  change_status: "Alterar status",
};

/**
 * Gatilho que inicia a régua. Só existe um hoje — status = aguardando
 * cliente, exatamente o pedido como prioridade — mas já é enum (e não um
 * booleano fixo) para os demais gatilhos "citados se compatíveis" (tag,
 * departamento, fila) entrarem sem migration de novo.
 */
export const FOLLOW_UP_TRIGGERS = ["waiting_client"] as const;
export type FollowUpTrigger = (typeof FOLLOW_UP_TRIGGERS)[number];

export const FOLLOW_UP_TRIGGER_LABELS: Record<FollowUpTrigger, string> = {
  waiting_client: "Status = Aguardando cliente",
};

export const FOLLOW_UP_EXECUTION_STATUSES = [
  "active",
  "paused",
  "canceled",
  "completed",
  "failed",
] as const;
export type FollowUpExecutionStatus = (typeof FOLLOW_UP_EXECUTION_STATUSES)[number];

export const FOLLOW_UP_EXECUTION_STATUS_LABELS: Record<FollowUpExecutionStatus, string> = {
  active: "Ativo",
  paused: "Pausado",
  canceled: "Cancelado",
  completed: "Concluído",
  failed: "Falhou",
};

export const FOLLOW_UP_LOG_EVENT_TYPES = [
  "started",
  "step_executed",
  "step_failed",
  "restarted",
  "canceled",
  "paused",
  "resumed",
  "postponed",
  "completed",
] as const;
export type FollowUpLogEventType = (typeof FOLLOW_UP_LOG_EVENT_TYPES)[number];

export const FOLLOW_UP_LOG_EVENT_LABELS: Record<FollowUpLogEventType, string> = {
  started: "Follow-up iniciado",
  step_executed: "Etapa executada",
  step_failed: "Falha ao executar etapa",
  restarted: "Contagem reiniciada",
  canceled: "Cancelado",
  paused: "Pausado",
  resumed: "Retomado",
  postponed: "Adiado",
  completed: "Concluído",
};

/** Motivo de encerramento — texto livre, mas as chaves conhecidas têm rótulo pronto. */
export const FOLLOW_UP_FINISH_REASON_LABELS: Record<string, string> = {
  client_replied: "Cliente respondeu",
  completed_no_reply: "Sem retorno do cliente",
  canceled_manual: "Cancelado pelo atendente",
  canceled_status_change: "Status mudou",
  canceled_department_change: "Departamento mudou e a regra deixou de valer",
  rule_deactivated: "Regra foi desativada",
  conversation_archived: "Conversa foi arquivada",
  conversation_resolved: "Conversa foi concluída",
  send_failed: "Falha ao enviar mensagem",
};

export function followUpFinishReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return FOLLOW_UP_FINISH_REASON_LABELS[reason] ?? reason;
}

/** Etiqueta padrão sugerida ao encerrar por inatividade (seção 32 do pedido). */
export const FOLLOW_UP_DEFAULT_CLOSE_TAG_NAME = "ENCERRADO POR INATIVIDADE";

/** Motivo padrão de encerramento automático (seção 13/31/41 do pedido). */
export const FOLLOW_UP_DEFAULT_FINISH_REASON = "Sem retorno do cliente";

/** Duração em milissegundos, para os cálculos de agendamento. */
export function followUpWaitMs(amount: number, unit: FollowUpTimeUnit): number {
  const perUnit: Record<FollowUpTimeUnit, number> = {
    minutes: 60_000,
    hours: 60 * 60_000,
    days: 24 * 60 * 60_000,
  };
  return amount * perUnit[unit];
}

/** Frase "Após 2 horas" / "Após 24 horas", para a listagem e a tela de edição. */
export function followUpWaitLabel(amount: number, unit: FollowUpTimeUnit): string {
  return `${amount} ${FOLLOW_UP_TIME_UNIT_LABELS[unit]}`;
}
