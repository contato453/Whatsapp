/**
 * Catálogo de permissões — a fonte única do que cada perfil PODE FAZER.
 *
 * Por que existe uma lista só, e por que ela mora aqui: a API decide por
 * ela e a tela de Permissões é GERADA a partir dela. Duas listas (uma no
 * servidor, outra na tela) divergem no primeiro esquecimento, e a
 * divergência aparece como botão que só dá erro — ou, muito pior, como
 * botão escondido para uma rota que continua aceitando.
 *
 * PERMISSÃO É AÇÃO, VISIBILIDADE É ALCANCE — e os dois nunca se misturam.
 * Nada aqui decide QUAIS conversas alguém enxerga: isso continua saindo
 * inteiro de `apps/api/src/lib/access.ts`, a partir dos números e
 * departamentos vinculados ao usuário. Uma chave ligada dá poder sobre o
 * que a pessoa já enxerga; nenhuma chave amplia o que ela enxerga. Por
 * isso não existe (e não pode passar a existir) chave do tipo "ver todas
 * as conversas" ou "ver conversa de outro departamento".
 *
 * ADMIN NÃO TEM CHAVE. Ele passa por cima de tudo, sempre, mesmo com o
 * catálogo inteiro desligado — senão a organização poderia se trancar do
 * lado de fora com dois cliques e não haveria quem religasse.
 */

import type { UserRole } from "./enums.js";

/** Os papéis configuráveis. `admin` fica de fora de propósito (ver acima). */
export const CONFIGURABLE_ROLES = ["agent", "supervisor"] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

export function isConfigurableRole(value: string): value is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(value);
}

/** Áreas do catálogo — viram as seções da tela, nesta ordem. */
export const PERMISSION_AREAS = ["atendimento", "ligacoes", "cadastros", "visao", "ia"] as const;
export type PermissionArea = (typeof PERMISSION_AREAS)[number];

export const PERMISSION_AREA_LABELS: Record<PermissionArea, string> = {
  atendimento: "Atendimento",
  ligacoes: "Ligações",
  cadastros: "Cadastros",
  visao: "Visão e relatórios",
  ia: "Inteligência artificial",
};

export const PERMISSION_AREA_DESCRIPTIONS: Record<PermissionArea, string> = {
  atendimento: "O que a equipe pode fazer dentro de uma conversa já em andamento.",
  ligacoes: "Quem atende ligações e quem acessa o registro e as gravações de chamadas.",
  cadastros: "Quem mexe nas listas que o escritório inteiro usa.",
  visao: "Quais números e registros do escritório cada perfil consegue consultar.",
  ia: "Quem configura e acompanha o atendimento por IA. A chave da OpenAI e o orçamento continuam só do administrador.",
};

/**
 * O catálogo. Ação nova entra aqui e já aparece na tela sozinha, sem
 * alterar a tela — e já é recusada pelo Zod da gravação se vier um nome
 * que não está nesta lista.
 */
export const PERMISSION_ACTIONS = [
  // ---------- Atendimento ----------
  {
    key: "message.delete_sent",
    label: "Apagar mensagem já enviada ao cliente",
    description:
      "Apaga no WhatsApp do cliente uma mensagem que a equipe enviou. O histórico daqui guarda a linha apagada.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "message.edit_sent",
    label: "Editar mensagem já enviada",
    description:
      "Corrige o texto (ou a legenda) de uma mensagem enviada, dentro da janela de 15 minutos do WhatsApp.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "message.pin",
    label: "Fixar e desafixar mensagem na conversa",
    description:
      "Destaca uma mensagem (ou nota interna) no topo da conversa, só para a equipe. Nunca é enviado ao WhatsApp.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "scheduled_message.cancel_other",
    label: "Cancelar agendamento feito por outra pessoa",
    description:
      "Cancela mensagem agendada que outro atendente programou. Cancelar o próprio agendamento não depende desta chave.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "conversation.transfer_user",
    label: "Transferir conversa para outra pessoa",
    description: "Passa o atendimento para outro responsável, inclusive assumindo para si.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "conversation.unassign",
    label: "Devolver conversa para a fila",
    description: "Tira o responsável da conversa e ela volta a aparecer para quem estiver livre.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "conversation.change_department",
    label: "Mudar o departamento da conversa",
    description:
      "Move a conversa de um time para outro. Muda quem enxerga o atendimento, então some da tela de quem não é do novo departamento.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "conversation.assign_all",
    label: 'Marcar conversa como "@todos"',
    description:
      "Deixa a conversa como atendimento coletivo do departamento, sem dono individual.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "conversation.archive",
    label: "Arquivar e desarquivar conversa",
    description:
      "Tira a conversa da lista principal (ou traz de volta). Mensagem nova em conversa arquivada não a desarquiva.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "note.delete_other",
    label: "Apagar nota interna de outra pessoa",
    description:
      "Edita ou apaga nota escrita por outro atendente. A própria nota cada um sempre pode mexer.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "conversation.rename",
    label: "Renomear a conversa (apelido)",
    description:
      "Define o nome que a equipe vê na lista. O nome que vem do WhatsApp continua guardado e nunca é sobrescrito.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "group_participant.rename",
    label: "Renomear participante de grupo",
    description:
      "Dá um nome próprio a quem está no grupo e marca o papel dele dentro do cliente (sócio ou administrativo).",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "azevedo_os.link",
    label: "Vincular a conversa a uma empresa do Azevedo-OS",
    description:
      "Preenche a empresa em conversa que ainda está SEM empresa. É rotina de classificação do dia a dia.",
    area: "atendimento",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "azevedo_os.relink",
    label: "Trocar ou desfazer vínculo de empresa já existente",
    description:
      "Mexe em classificação que outra pessoa já fez. Errar aqui anexa a conversa ao cliente errado, por isso é chave separada da anterior.",
    area: "atendimento",
    defaults: { agent: false, supervisor: true },
  },

  // ---------- Cadastros ----------
  {
    key: "tag.manage",
    label: "Criar e editar etiqueta",
    description: "Mexe na lista de etiquetas do escritório. Aplicar etiqueta na conversa não depende desta chave.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "tag.delete",
    label: "Excluir etiqueta",
    description: "Remove a etiqueta de todas as conversas em que ela estiver.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "quick_reply.manage",
    label: "Criar e editar resposta rápida",
    description: "Mexe nos atalhos de \"/\" do composer, dentro dos departamentos da própria pessoa.",
    area: "cadastros",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "quick_reply.create_shared",
    label: "Criar resposta rápida compartilhada com todos",
    description:
      "Cria atalho geral, que aparece para a organização inteira em vez de ficar restrito a departamentos.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "user.deactivate",
    label: "Desativar e reativar usuário",
    description:
      "Tira (ou devolve) o acesso de alguém ao sistema, derrubando a sessão aberta na hora. NÃO permite criar, editar nem redefinir senha, e nunca alcança um administrador.",
    area: "cadastros",
    defaults: { agent: false, supervisor: false },
  },
  {
    key: "department.manage",
    label: "Criar e editar departamento",
    description:
      "Mexe nos times do escritório e no responsável padrão de cada um. Excluir departamento continua sendo só do administrador.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "whatsapp_instance.manage",
    label: "Criar e editar número de WhatsApp",
    description:
      "Cadastra número, define departamento e responsável padrão dele, e faz o arquivamento em massa. Excluir número continua sendo só do administrador.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "whatsapp_instance.connection",
    label: "Conectar e desconectar número",
    description:
      "Lê o QR Code, põe o número no ar e tira do ar. Desconectar derruba o atendimento daquele número para todo mundo.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "whatsapp_instance.backup",
    label: "Marcar número como backup",
    description:
      "Número de backup nasce com toda conversa nova já arquivada. Ligar não arquiva o que já existe.",
    area: "cadastros",
    defaults: { agent: false, supervisor: true },
  },

  // ---------- Visão e relatórios ----------
  {
    key: "reports.view",
    label: "Ver relatório por atendente",
    description: "Abre a tela de Relatórios, com os números de cada pessoa da equipe.",
    area: "visao",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "dashboard.view_team",
    label: "Ver a carga de trabalho dos colegas no dashboard",
    description: "Mostra no dashboard o bloco com o volume de mensagens por pessoa da equipe.",
    area: "visao",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "audit.view",
    label: "Ver auditoria",
    description: "Consulta o registro de quem fez o quê e quando, no sistema inteiro.",
    area: "visao",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "attendance_settings.manage",
    label: "Editar os parâmetros de SLA e expediente",
    description:
      "Grava o limite de resposta, o expediente e o horário permitido de login. Consultar os parâmetros todo mundo pode.",
    area: "visao",
    defaults: { agent: false, supervisor: true },
  },
  // ---------- Ligações ----------
  {
    key: "call.answer",
    label: "Atender e fazer ligações",
    description:
      "Usar o discador: atender chamadas recebidas e iniciar chamadas para o cliente. Sem esta chave, o aviso de chamada e o botão de ligar não aparecem.",
    area: "ligacoes",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "call.view",
    label: "Ver o registro de ligações",
    description:
      "Abrir a tela de Ligações e consultar o histórico de chamadas recebidas e feitas. Não inclui ouvir a gravação.",
    area: "ligacoes",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "call.recording.play",
    label: "Ouvir a gravação das ligações",
    description:
      "Reproduzir e baixar o áudio gravado das chamadas. É conteúdo sensível — por padrão, só supervisor.",
    area: "ligacoes",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "call.recording.delete",
    label: "Excluir gravações por período",
    description:
      "Apaga em definitivo as gravações de um período para liberar espaço. Não pode ser desfeito — por padrão, ninguém além do administrador.",
    area: "ligacoes",
    defaults: { agent: false, supervisor: false },
  },
  // ---------- Inteligência artificial ----------
  // A chave do provedor (OpenAI), o orçamento e as configurações gerais são
  // FIXOS em admin, sem chave: são credencial e dinheiro. O que é configurável
  // é o dia a dia — agentes, base de conhecimento, automações, indicadores e
  // o controle do atendimento por IA dentro da conversa.
  {
    key: "ai.agent.manage",
    label: "Criar e editar agentes de IA, base de conhecimento e automações",
    description:
      "Configura o que cada IA faz, o que ela sabe e em quais conversas entra. Inclui o testador. A chave da OpenAI continua só do administrador.",
    area: "ia",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "ai.view_usage",
    label: "Ver consumo, indicadores e logs de IA",
    description:
      "Abre os números do atendimento por IA: atendimentos, taxa de resolução, tokens, custo estimado e o registro de cada chamada.",
    area: "ia",
    defaults: { agent: false, supervisor: true },
  },
  {
    key: "ai.session.stop",
    label: "Assumir ou encerrar um atendimento por IA",
    description:
      "Dentro da conversa, tira a IA do atendimento na hora — ao assumir a conversa ou pelo botão Encerrar IA. Sem esta chave a IA continua até transferir sozinha.",
    area: "ia",
    defaults: { agent: true, supervisor: true },
  },
  {
    key: "ai.session.resume",
    label: "Devolver a conversa para a IA",
    description:
      "Depois que alguém assumiu ou encerrou, coloca o mesmo agente de volta no atendimento. Ação explícita, para humano e IA não se alternarem sozinhos.",
    area: "ia",
    defaults: { agent: false, supervisor: true },
  },
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]["key"];

export interface PermissionActionDefinition {
  key: PermissionAction;
  /** Rótulo em português — o que aparece na linha da tela. */
  label: string;
  /** Frase curta com o efeito prático, para o admin decidir sem perguntar a ninguém. */
  description: string;
  area: PermissionArea;
  /** Valor de fábrica por papel. Ausência de linha no banco significa exatamente isto. */
  defaults: Record<ConfigurableRole, boolean>;
}

export const PERMISSION_ACTION_KEYS = PERMISSION_ACTIONS.map(
  (action) => action.key,
) as readonly PermissionAction[];

const ACTION_BY_KEY = new Map<string, PermissionActionDefinition>(
  PERMISSION_ACTIONS.map((action) => [action.key, action as PermissionActionDefinition]),
);

export function isPermissionAction(value: string): value is PermissionAction {
  return ACTION_BY_KEY.has(value);
}

/**
 * Definição de uma ação. Devolve `null` para chave desconhecida em vez de
 * estourar: linha gravada no banco para ação que saiu do código é ignorada
 * em silêncio, senão uma limpeza de catálogo quebraria a tela de Permissões.
 */
export function permissionActionDefinition(
  key: string,
): PermissionActionDefinition | null {
  return ACTION_BY_KEY.get(key) ?? null;
}

/** Rótulo da ação, para mensagem de erro e para a tela. */
export function permissionActionLabel(key: string): string {
  return ACTION_BY_KEY.get(key)?.label ?? key;
}

/** Ações de uma área, na ordem do catálogo. */
export function permissionActionsByArea(
  area: PermissionArea,
): readonly PermissionActionDefinition[] {
  return PERMISSION_ACTIONS.filter(
    (action) => action.area === area,
  ) as readonly PermissionActionDefinition[];
}

/** Valor de fábrica de um par (papel, ação). */
export function defaultPermission(action: PermissionAction, role: ConfigurableRole): boolean {
  return ACTION_BY_KEY.get(action)?.defaults[role] ?? false;
}

/** Chave do mapa de configuração — papel e ação sempre andam juntos. */
export function permissionOverrideKey(role: ConfigurableRole, action: string): string {
  return `${role}:${action}`;
}

/** Configuração gravada pela organização: só os pares diferentes do padrão. */
export type PermissionOverrides = ReadonlyMap<string, boolean>;

/**
 * A decisão, em uma linha só. Admin sempre pode; para os demais vale a
 * configuração da organização e, na falta dela, o padrão do catálogo.
 *
 * Pura de propósito: a mesma regra roda na API (com a configuração lida do
 * banco) e nos testes, sem subir rota.
 */
export function resolvePermission(
  role: UserRole,
  action: PermissionAction,
  overrides: PermissionOverrides,
): boolean {
  if (role === "admin") return true;
  if (!isConfigurableRole(role)) return false;
  const override = overrides.get(permissionOverrideKey(role, action));
  return override ?? defaultPermission(action, role);
}

/** Todas as ações que este papel pode executar — é o que o frontend consome. */
export function allowedPermissions(
  role: UserRole,
  overrides: PermissionOverrides,
): PermissionAction[] {
  return PERMISSION_ACTION_KEYS.filter((action) => resolvePermission(role, action, overrides));
}

/**
 * Mensagem de recusa. Nomeia a ação porque "acesso negado" genérico, num
 * sistema em que o dono liga e desliga chave, não diz a ninguém o que
 * precisa ser religado.
 */
export function permissionDeniedMessage(action: string): string {
  return `Seu perfil não tem permissão para: ${permissionActionLabel(action).toLowerCase()}`;
}

/** Código de erro devolvido pela API quando a chave está desligada. */
export const PERMISSION_DENIED_CODE = "permission_denied";

/**
 * Configuração invertida em relação à hierarquia: liberada para Usuário e
 * bloqueada para Supervisor. Não é proibida (o dono pode ter um motivo),
 * mas a tela avisa — quase sempre é engano de clique.
 */
export function isInvertedHierarchy(agentAllowed: boolean, supervisorAllowed: boolean): boolean {
  return agentAllowed && !supervisorAllowed;
}
