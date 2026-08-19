/**
 * Contrato dos filtros do Dashboard de Atendimento.
 *
 * ## A regra de combinação
 *
 * **DENTRO de um filtro os valores marcados somam (OU); ENTRE filtros
 * diferentes eles cruzam (E).** Marcar o chip Comercial e o chip RH mostra os
 * dois somados; marcar o Comercial e o status "Aberto" mostra só as abertas
 * do Comercial. Filtro sem nada marcado é "todos" naquele filtro, nunca
 * "nenhum" — é o estado inicial da tela.
 *
 * ## POR QUE AQUI DEPARTAMENTO E RESPONSÁVEL FICAM SEPARADOS
 *
 * É uma divergência PROPOSITAL em relação à Inbox, e ela vai parecer
 * inconsistência para quem olhar as duas telas de longe. Na Inbox os dois
 * viraram um filtro só que SOMA (`@azvchat/shared/inbox-filters`), porque lá
 * a pergunta é de triagem: "quero ver o Contábil inteiro MAIS a fulana", e a
 * lista é um monte de linhas que a pessoa vai varrendo.
 *
 * Aqui a pergunta é de ANÁLISE, e o resultado é um número só. Somar recortes
 * diferentes dentro do mesmo total produz um número sem significado: "as
 * conversas do CS mais as da Tatiana" não responde nenhuma pergunta que
 * alguém faça de verdade, e ainda conta duas vezes o trabalho da Tatiana
 * dentro do CS quando o leitor tenta comparar com outro recorte. Cruzando,
 * "CS + Tatiana" é "os números dela dentro do CS", que é exatamente o que a
 * supervisão pergunta.
 *
 * Consequência aceita: marcar um departamento e alguém que não é dele devolve
 * ZERO. Está correto pela regra do E, e por isso a tela precisa dizer que o
 * vazio veio do cruzamento — senão parece defeito.
 */

import { FILTER_ALL_USERS, FILTER_NONE } from "./attendance.js";

/** Um uuid do jeito que o resto do sistema gera. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aceita o id de um departamento ou o sentinela "sem departamento". */
export function dashboardDepartmentValueIsValid(value: string): boolean {
  return value === FILTER_NONE || UUID.test(value);
}

/**
 * Aceita o id de uma pessoa, "sem responsável" ou o coletivo "@todos". Os
 * dois sentinelas continuam separados: conversa órfã e conversa coletiva têm
 * `assignedUserId` nulo, mas só uma delas está esperando alguém pegar.
 */
export function dashboardAssigneeValueIsValid(value: string): boolean {
  return value === FILTER_NONE || value === FILTER_ALL_USERS || UUID.test(value);
}

/** Rótulos dos sentinelas, escritos uma vez só para os dois lados do muro. */
export const DASHBOARD_NO_DEPARTMENT_LABEL = "Sem departamento";
export const DASHBOARD_UNASSIGNED_LABEL = "Sem responsável";

/** Rótulo de cada filtro, usado na barra e no resumo do recorte ativo. */
export const DASHBOARD_FILTER_LABELS = {
  period: "Período",
  status: "Status",
  department: "Departamento",
  assignee: "Responsável",
  instance: "Número",
} as const;

/**
 * Aviso do recorte que não devolveu nada. O texto muda quando departamento e
 * responsável estão marcados ao mesmo tempo: aí o zero é o cruzamento, e não
 * ausência de atendimento — sem essa distinção a pessoa acha que quebrou.
 */
export const DASHBOARD_EMPTY_FILTER_MESSAGE =
  "Nenhum atendimento no recorte filtrado. Os números estão zerados por causa do filtro, não por falta de movimento.";
export const DASHBOARD_EMPTY_CROSS_MESSAGE =
  "Nenhum atendimento no cruzamento de departamento e responsável. Aqui os dois filtros se cruzam (e não somam, como nas Conversas): marcar um departamento junto de alguém que não atende nele devolve zero.";
