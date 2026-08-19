import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@azvchat/database";
import { z } from "zod";
import {
  AZEVEDO_OS_SOURCE,
  assignmentTokenIsValid,
  azevedoOsFacetValueIsValid,
  CONVERSATION_TYPE_FILTERS,
  parseAssignmentTokens,
  canManageInternalNote,
  CONVERSATION_STATUSES,
  EXTERNAL_REFERENCE_SOURCES,
  FILTER_NONE,
  PARTICIPANT_CLIENT_ROLES,
  RealtimeEvents,
} from "@azvchat/shared";
import { planReferenceUpdate } from "../../lib/azevedo-os-link.js";
import {
  companyReferenceWhere,
  resolveCompanyIds,
  unlinkedCompanyWhere,
} from "../../lib/azevedo-os-company-filter.js";
import { AzevedoOsError } from "../../services/azevedo-os-client.js";
import {
  accessibleDepartmentIds,
  canAssignBeyondConversationReach,
  conversationAssigneeWhere,
  conversationScope,
  departmentResourceScope,
  groupScope,
  loadConversationAccess,
} from "../../lib/access.js";
import { authenticate, type AuthTokenPayload } from "../../lib/auth.js";
import { loadPermissions, requirePermission } from "../../lib/permissions.js";
import {
  accessibleConversationWhere,
} from "../../lib/conversation-access.js";
import {
  assignmentFilterWhere,
  assignToAllData,
  assignToUserData,
  clearAssignmentData,
} from "../../lib/conversation-assignment.js";
import {
  fullyReadConversationIds,
  loadUnreadCount,
  loadUnreadCounts,
  markConversationRead,
  markConversationUnread,
  unreadConversationWhere,
} from "../../lib/conversation-reads.js";
import { assertKnownFilterIds, listaDe } from "../../lib/conversation-filters.js";
import { reportFilterConditions, resolvedInPeriodWhere } from "../../lib/report-slice.js";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { scanOverdueConversations } from "../../lib/overdue.js";
import { canApplyToConversation } from "../../lib/department-resource.js";
import { AppError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import {
  serializeConversation,
  serializeConversationDetail,
  serializeGroupParticipant,
  serializeUserDirectory,
} from "../../lib/serialize.js";
import { countPendingScheduled } from "../../lib/scheduled-pending.js";
import {
  conversationInclude,
  emitConversationUpdated as publishConversationUpdated,
} from "../../lib/conversation-events.js";
import { resolveContacts, type SenderInfo } from "../../lib/sender-directory.js";
import {
  countPersonGroups,
  resolveConversationPersonName,
  resolveConversationPersonNames,
  resolvePersonProfiles,
  upsertPersonProfile,
} from "../../lib/person-profile.js";
import { conversationAudience, userRoom } from "../../realtime/socket.js";
import type { AppDeps } from "../../types.js";

/**
 * Filtros da lista de conversas.
 *
 * **OU dentro do filtro, E entre filtros** (a regra completa e o porquê estão
 * em `@azvchat/shared/inbox-filters`). Cada campo abaixo é uma lista de
 * valores que somam entre si, e as listas cruzam umas com as outras.
 *
 * Item inválido é RECUSADO, não ignorado: uuid torto ou status fora do enum
 * derruba a requisição com 400. Ignorar em silêncio devolveria uma lista
 * plausível recortada por um critério diferente do que a pessoa marcou, que
 * é pior do que um erro.
 */
const listQuerySchema = z.object({
  status: listaDe(z.enum(CONVERSATION_STATUSES)),
  type: listaDe(z.enum(CONVERSATION_TYPE_FILTERS)),
  /**
   * O filtro unificado de departamento e responsável. Os tokens (`none`,
   * `all_users`, `no_department`, `dept:<uuid>`, `user:<uuid>`) somam entre
   * si, atravessando os três blocos da lista: marcar o Contábil junto com
   * uma pessoa de outro departamento mostra os dois conjuntos, e não a
   * interseção deles. É por isso que os dois filtros viraram um só.
   */
  assignment: listaDe(z.string().refine(assignmentTokenIsValid, "filtro de atendimento inválido")),
  instanceId: listaDe(z.string().uuid()),
  tagId: listaDe(z.string().uuid()),
  unread: z.coerce.boolean().optional(),
  /**
   * `false` (padrão) lista só as não arquivadas; `true`, só as arquivadas.
   * Não existe "todas misturadas" de propósito: a lista da Inbox e a visão
   * de arquivadas são recortes disjuntos, e misturar traria a conversa
   * arquivada de volta pela porta dos fundos. Por isso este continua sendo
   * um booleano, e não uma lista.
   */
  archived: z.coerce.boolean().default(false),
  q: z.string().max(120).optional(),
  /**
   * Recorte por característica do cliente no Azevedo-OS. O valor é a chave
   * do enum de lá; `none` é o sentinela de cadastro em branco.
   *
   * A validação é de FORMATO, e não contra uma lista de valores: copiar os
   * valores do Azevedo-OS para cá criaria o dicionário duplicado que a
   * integração existe para evitar, e ele envelheceria calado no dia em que
   * um regime novo fosse cadastrado lá. Valor bem formado que não existe no
   * portal devolve zero conversas, que é resultado e não erro.
   */
  taxRegime: listaDe(z.string().refine(azevedoOsFacetValueIsValid, "valor de filtro inválido")),
  payroll: listaDe(z.string().refine(azevedoOsFacetValueIsValid, "valor de filtro inválido")),
  /**
   * Só as conversas SEM empresa vinculada. É o atalho do aviso "N ficaram de
   * fora", e o caminho natural para a equipe ir vinculando o que falta.
   */
  unlinked: z.coerce.boolean().optional(),
  /**
   * Conversas CONCLUÍDAS por uma pessoa dentro de um intervalo.
   *
   * É o recorte da coluna "Concluídas" do relatório de atendimentos, e é o
   * único da tela que a lista ainda não sabia responder: os outros três são
   * status mais responsável, que os filtros acima já cobrem. Ele mora aqui,
   * e não numa rota nova de listagem, porque duas listagens de conversa
   * divergiriam na primeira mudança de escopo, de serializer ou de
   * paginação — e a que quase ninguém abre seria a que passaria a mostrar
   * demais.
   *
   * Repare que ele NÃO olha o status atual: mede o evento de conclusão, e a
   * conversa concluída ontem e reaberta hoje continua sendo trabalho fechado
   * ontem. É a mesma definição que a célula conta.
   */
  resolvedBy: z.string().uuid().optional(),
  resolvedFrom: z.string().datetime().optional(),
  resolvedTo: z.string().datetime().optional(),
  /**
   * Departamento que **CRUZA** com os demais filtros, em vez de somar.
   *
   * **Não confunda com o `dept:<uuid>` de `assignment`**, logo acima: aquele
   * é o da triagem da Inbox, onde departamento e responsável viraram um
   * filtro só que SOMA ("quero ver o Contábil inteiro MAIS a fulana"). Este
   * é o da análise, onde a pergunta é "os números dela DENTRO do Contábil" —
   * a mesma divergência que o Dashboard já carrega, e pelo mesmo motivo
   * (seção 13 do CLAUDE.md).
   *
   * Existe porque o painel do relatório precisa listar exatamente o que a
   * célula conta, e a célula cruza. A Inbox nunca manda este parâmetro; se
   * um dia mandar, a multisseleção dela passa a devolver vazio em quase toda
   * marcação múltipla — é o erro que este comentário existe para impedir.
   *
   * `none` é "sem departamento", igual ao do Dashboard.
   */
  departmentId: listaDe(z.union([z.string().uuid(), z.literal(FILTER_NONE)])),
  /**
   * Só as ATRASADAS: não resolvidas, com a última mensagem do cliente,
   * esperando há mais que o limite em tempo de expediente. É o atalho do card
   * "Atrasados agora" do dashboard, e a conta é a MESMA (`lib/overdue.ts`) —
   * um número que abre uma lista diferente dele não serve para nada.
   *
   * Continua booleano, e não vira lista: é uma pergunta sobre o estado agora,
   * não um valor que some com outro.
   */
  overdue: z.coerce.boolean().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
})
  // Pedir "sem empresa" e "regime X" ao mesmo tempo é contradição: a conversa
  // sem vínculo não tem regime nenhum. Recusar é melhor do que devolver a
  // lista sempre vazia que essa combinação produziria.
  .refine((query) => !(query.unlinked && (query.taxRegime.length > 0 || query.payroll.length > 0)), {
    message: "O filtro de conversas sem empresa não combina com regime ou folha.",
  })
  // Os três andam juntos: sem o intervalo, "concluídas por fulano" viraria
  // "de sempre", que é um recorte diferente do que a célula conta. Recusar é
  // melhor do que assumir um período por conta própria.
  .refine(
    (query) =>
      [query.resolvedBy, query.resolvedFrom, query.resolvedTo].filter(Boolean).length % 3 === 0,
    { message: "O filtro de concluídas exige responsável, data inicial e data final." },
  );

export async function conversationRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  /**
   * Além da organização, respeita as conexões liberadas para o usuário:
   * conversa de um número sem acesso responde 404, como se não existisse.
   */
  async function findConversationOr404(id: string, user: FastifyRequest["user"]) {
    const conversation = await deps.prisma.conversation.findFirst({
      // O mesmo recorte que os outros módulos usam para chegar a uma
      // conversa pelo id — inclusive a integração com o Azevedo-OS.
      where: await accessibleConversationWhere(deps.prisma, user, id),
      include: conversationInclude,
    });
    if (!conversation) throw new NotFoundError("Conversa");
    return conversation;
  }

  async function emitConversationUpdated(id: string, organizationId: string): Promise<void> {
    await publishConversationUpdated(deps.prisma, deps.io, id, organizationId);
  }

  app.get("/conversations", { preHandler: authenticate }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const assignment = parseAssignmentTokens(query.assignment);

    // Id que não existe na organização é RECUSADO, não ignorado: ignorar
    // devolveria uma lista plausível recortada por um critério diferente do
    // que a pessoa marcou. A tela poda o item extinto antes de mandar, então
    // chegar aqui um id desconhecido significa link torto ou estado corrompido.
    await assertKnownFilterIds(deps.prisma, request.user.organizationId, {
      departmentIds: [
        ...assignment.departmentIds,
        // O filtro que cruza passa pela mesma conferência do que soma.
        ...query.departmentId.filter((value) => value !== FILTER_NONE),
      ],
      // O responsável do recorte de concluídas passa pela mesma conferência:
      // id que não existe é recusado, nunca ignorado em silêncio.
      userIds: [...assignment.userIds, ...(query.resolvedBy ? [query.resolvedBy] : [])],
      tagIds: query.tagId,
      instanceIds: query.instanceId,
    });

    const where: Prisma.ConversationWhereInput = {
      organizationId: request.user.organizationId,
      ...conversationScope(access),
      // Arquivamento é um filtro POR CIMA do escopo de acesso, nunca no
      // lugar dele: `conversationScope` continua valendo inteiro acima.
      archivedAt: query.archived ? { not: null } : null,
      // Busca pelo nome ou pelo código do cadastro ("EMPRESA 001")
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" as const } },
              { customTitle: { contains: query.q, mode: "insensitive" as const } },
              { externalReference: { contains: query.q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };
    if (query.unread) {
      // "Não lidas" passou a ser pergunta pessoal: o que ESTE usuário ainda
      // não leu. Vai por cima do escopo de acesso, nunca no lugar dele.
      Object.assign(
        where,
        unreadConversationWhere(await fullyReadConversationIds(deps.prisma, request.user.sub)),
      );
    }

    /**
     * **OU dentro de cada filtro, E entre filtros diferentes.**
     *
     * Cada item desta lista é um filtro inteiro, e eles entram todos no mesmo
     * `AND`: por isso departamento e status cruzam. Dentro de um item os
     * valores marcados somam, seja pelo `in` (status, tipo, número, etiqueta)
     * seja pelo `OR` do filtro unificado de atendimento. Lista vazia não gera
     * item nenhum, que é o "todos" daquele filtro.
     *
     * Inverter isso para E dentro do filtro deixaria a Inbox vazia em quase
     * toda marcação múltipla, porque uma conversa não está em dois
     * departamentos ao mesmo tempo. É o erro que este comentário existe para
     * impedir.
     */
    const filtros: Prisma.ConversationWhereInput[] = [];
    if (query.status.length > 0) filtros.push({ status: { in: query.status } });
    if (query.type.length > 0) filtros.push({ type: { in: query.type } });
    if (query.instanceId.length > 0) filtros.push({ whatsappInstanceId: { in: query.instanceId } });
    // A etiqueta é N:N, então o `some` já é o OU: a conversa entra se tiver
    // QUALQUER uma das marcadas.
    if (query.tagId.length > 0) filtros.push({ tags: { some: { tagId: { in: query.tagId } } } });
    const atendimento = assignmentFilterWhere(assignment);
    if (atendimento) filtros.push(atendimento);
    // Os filtros da barra do relatório (departamento que cruza, e o chip já
    // coberto por `instanceId` acima). Mesmo construtor da contagem da
    // célula, para o painel nunca listar um conjunto diferente.
    filtros.push(...reportFilterConditions({ departmentId: query.departmentId, instanceId: [] }));

    // O predicado sai de `lib/report-slice.ts`, o mesmo arquivo que a
    // contagem da célula usa: é assim que o número e a lista não divergem.
    if (query.resolvedBy && query.resolvedFrom && query.resolvedTo) {
      filtros.push(
        resolvedInPeriodWhere(
          query.resolvedBy,
          new Date(query.resolvedFrom),
          new Date(query.resolvedTo),
        ),
      );
    }

    /**
     * Atrasadas: a lista do card do dashboard. O recorte sai de
     * `lib/overdue.ts` sobre o `where` JÁ escopado por `access.ts` — a função
     * só estreita o conjunto, e nunca traz de volta conversa que a pessoa não
     * enxergaria. Entra como mais um item do `AND`, por cima do escopo.
     */
    if (query.overdue) {
      const settings = await loadAttendanceSettings(deps.prisma, request.user.organizationId);
      const atrasadas = await scanOverdueConversations(
        deps.prisma,
        request.user.organizationId,
        { ...where, AND: Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [] },
        settings,
        new Date(),
      );
      // Lista vazia devolve `in: []`, que é "nenhuma" — e não "todas". Sem
      // atraso nenhum a lista tem que vir vazia mesmo.
      filtros.push({ id: { in: atrasadas.ids } });
    }

    /**
     * Recorte por característica do cliente (regime tributário e folha), que
     * moram no Azevedo-OS. Ele é montado por ÚLTIMO e entra por cima: `where`
     * já carrega `conversationScope(access)` e os demais filtros, e o recorte
     * por empresa só sabe TIRAR conversa da lista, nunca trazer uma que a
     * pessoa não enxergaria. Filtrar pelo regime de uma conversa de outro
     * atendente não a revela: o escopo continua valendo inteiro acima.
     *
     * Vai em `AND`, e não espalhado no objeto, porque o filtro de conversa
     * sem empresa é um `OR` e a busca por texto também: fundir os dois no
     * mesmo nível faria um sobrescrever o outro em silêncio.
     */
    const criteria = {
      ...(query.taxRegime.length > 0 ? { taxRegime: query.taxRegime } : {}),
      ...(query.payroll.length > 0 ? { payroll: query.payroll } : {}),
    };
    const companyFilterActive = Object.keys(criteria).length > 0;
    /**
     * O escopo de acesso JÁ OCUPA o `AND` do `where`: `conversationScope`
     * devolve `{ AND: [...] }` com o recorte de números, departamentos e
     * "só as minhas". Atribuir um `AND` novo aqui apagaria esse recorte, e o
     * filtro por regime passaria a revelar ao atendente a conversa de outra
     * pessoa — o filtro viraria uma porta de saída do controle de acesso.
     * Por isso o recorte por empresa é ACRESCENTADO à lista existente, nunca
     * posto no lugar dela. Há teste fixando exatamente isso.
     */
    const scopeAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    const baseWhere: Prisma.ConversationWhereInput = { ...where };
    const extras: Prisma.ConversationWhereInput[] = [];
    let unavailable = false;
    let truncated = false;
    let unlinkedExcluded = 0;

    if (query.unlinked) {
      extras.push(unlinkedCompanyWhere());
    } else if (companyFilterActive) {
      try {
        const resolved = await resolveCompanyIds(deps.azevedoOs, criteria);
        truncated = resolved.truncated;
        extras.push(companyReferenceWhere(resolved.ids));
        // Quantas o recorte deixou de fora por não terem empresa vinculada.
        // Sem esse número a lista encurta sem explicação e o filtro parece
        // quebrado — e é ele que vira o atalho para a equipe ir vinculando.
        unlinkedExcluded = await deps.prisma.conversation.count({
          where: { ...baseWhere, AND: [...scopeAnd, ...filtros, unlinkedCompanyWhere()] },
        });
      } catch (err) {
        // Azevedo-OS fora do ar não derruba a Inbox: a lista volta SEM o
        // recorte e a tela avisa, em letras suficientes para ninguém ler uma
        // lista completa achando que ela está filtrada. Erro que não seja da
        // integração continua subindo — engolir tudo esconderia defeito nosso.
        if (!(err instanceof AzevedoOsError)) throw err;
        unavailable = true;
        deps.logger.warn(
          { event: "conversation_company_filter_unavailable" },
          "conversation_company_filter_unavailable",
        );
      }
    }
    where.AND = [...scopeAnd, ...filtros, ...extras];

    const [conversations, total] = await Promise.all([
      deps.prisma.conversation.findMany({
        where,
        include: conversationInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      deps.prisma.conversation.count({ where }),
    ]);
    // O contador vai num mapa à parte, e não dentro do DTO: o mesmo DTO é
    // publicado por socket para a audiência inteira da conversa, e um número
    // pessoal ali vazaria de uma pessoa para a outra. Uma consulta só para a
    // página inteira — nunca uma por linha.
    const [unread, personNames] = await Promise.all([
      loadUnreadCounts(
        deps.prisma,
        request.user.sub,
        conversations.map((conversation) => conversation.id),
      ),
      // Nome da PESSOA nas conversas individuais — uma consulta para a
      // página inteira, nunca uma por linha.
      resolveConversationPersonNames(deps.prisma, request.user.organizationId, conversations),
    ]);
    return {
      conversations: conversations.map((conversation) =>
        serializeConversation(conversation, personNames.get(conversation.id) ?? null),
      ),
      total,
      unread: Object.fromEntries(unread),
      companyFilter: companyFilterActive ? { unavailable, truncated, unlinkedExcluded } : null,
    };
  });

  app.get("/conversations/:id", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);

    // Painel de contexto: grupo + participantes + histórico de atribuição
    const [group, history, notes, scheduledPendingCount] = await Promise.all([
      conversation.type === "group"
        ? deps.prisma.whatsAppGroup.findFirst({
            where: {
              whatsappInstanceId: conversation.whatsappInstanceId,
              externalId: conversation.externalChatId,
            },
            include: { participants: { orderBy: { name: "asc" } } },
          })
        : Promise.resolve(null),
      deps.prisma.conversationAssignmentHistory.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { performedBy: true },
      }),
      deps.prisma.internalNote.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: true },
      }),
      // Valor inicial do contador de agendamentos do composer. Vem junto da
      // conversa para o badge já aparecer certo na abertura, sem consulta extra.
      countPendingScheduled(deps.prisma, id),
    ]);

    // Busca as fotos dos participantes em segundo plano; o frontend é
    // avisado por WebSocket quando houver novidade.
    if (group) {
      void deps.instanceManager.syncParticipantAvatars(id, request.user.organizationId);
    }

    // Em grupos "@lid" os metadados nem sempre trazem nome e telefone de
    // cada participante. Completamos com duas fontes: o cadastro de
    // contatos e o nome que o WhatsApp envia junto das mensagens (pushName).
    const participantIds = group?.participants.map((p) => p.externalContactId) ?? [];
    const [participantContacts, namesFromMessages, personProfiles, personGroupCounts, personName] =
      await Promise.all([
        group
          ? resolveContacts(deps.prisma, conversation.whatsappInstanceId, participantIds)
          : Promise.resolve(new Map<string, SenderInfo>()),
        group
          ? deps.prisma.message.findMany({
              where: {
                conversationId: id,
                senderExternalId: { in: participantIds },
                senderName: { not: null },
              },
              distinct: ["senderExternalId"],
              orderBy: { timestamp: "desc" },
              select: { senderExternalId: true, senderName: true },
            })
          : Promise.resolve([]),
        // O que a equipe sabe da PESSOA (vale em todos os grupos) e em
        // quantos grupos ela está — tudo em lote, junto das outras fontes.
        group
          ? resolvePersonProfiles(deps.prisma, request.user.organizationId, participantIds)
          : Promise.resolve(new Map()),
        group
          ? countPersonGroups(deps.prisma, request.user.organizationId, participantIds)
          : Promise.resolve(new Map<string, number>()),
        // Conversa individual: o título carrega o nome corrigido da pessoa.
        resolveConversationPersonName(deps.prisma, request.user.organizationId, conversation),
      ]);
    const pushNames = new Map(
      namesFromMessages
        .filter((entry) => entry.senderExternalId)
        .map((entry) => [entry.senderExternalId as string, entry.senderName]),
    );

    return {
      conversation: serializeConversationDetail(conversation, scheduledPendingCount, personName),
      group: group
        ? {
            id: group.id,
            name: group.name,
            description: group.description,
            participantCount: group.participantCount,
            // As fontes extras são resolvidas em lote (um SELECT cada para
            // o grupo inteiro) — grupo grande não vira consulta por pessoa.
            participants: group.participants.map((participant) =>
              serializeGroupParticipant(participant, {
                contact: participantContacts.get(participant.externalContactId) ?? null,
                pushName: pushNames.get(participant.externalContactId) ?? null,
                profile: personProfiles.get(participant.externalContactId) ?? null,
                groupCount: personGroupCounts.get(participant.externalContactId) ?? 1,
              }),
            ),
          }
        : null,
      assignmentHistory: history.map((entry) => ({
        id: entry.id,
        action: entry.action,
        performedBy: entry.performedBy ? serializeUserDirectory(entry.performedBy) : null,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
      notes: notes.map((note) => ({
        id: note.id,
        content: note.content,
        user: note.user ? serializeUserDirectory(note.user) : null,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  });

  /** Foto de perfil da conversa (contato ou grupo), autenticada. */
  app.get("/conversations/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const conversation = await deps.prisma.conversation.findFirst({
      where: { id, organizationId: request.user.organizationId, ...conversationScope(access) },
      select: { profilePicture: true },
    });
    if (!conversation?.profilePicture) throw new NotFoundError("Foto de perfil");
    const data = await deps.storage.read(conversation.profilePicture);
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.send(data);
  });

  /** Foto de perfil de um participante de grupo, autenticada. */
  app.get("/group-participants/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const participant = await deps.prisma.groupParticipant.findFirst({
      where: {
        id,
        group: { organizationId: request.user.organizationId, ...groupScope(access) },
      },
      select: { avatarUrl: true },
    });
    if (!participant?.avatarUrl) throw new NotFoundError("Foto de perfil");
    const data = await deps.storage.read(participant.avatarUrl);
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "private, max-age=86400");
    return reply.send(data);
  });

  /**
   * Abre a conversa individual com um participante do grupo, criando-a se
   * ainda não existir. É o "chamar no privado": tirar um assunto do grupo
   * sem sair do sistema e sem procurar o número na mão.
   */
  app.post(
    "/group-participants/:id/conversation",
    { preHandler: authenticate },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const access = await loadConversationAccess(deps.prisma, request.user);
      const participant = await deps.prisma.groupParticipant.findFirst({
        where: {
          id,
          group: { organizationId: request.user.organizationId, ...groupScope(access) },
        },
        select: {
          name: true,
          phoneNumber: true,
          group: { select: { whatsappInstanceId: true } },
        },
      });
      if (!participant) throw new NotFoundError("Participante");

      // Sem telefone não há para onde abrir: em grupo anônimo o WhatsApp
      // só entrega o número de quem já escreveu.
      const phone = participant.phoneNumber?.replace(/\D/g, "") ?? "";
      if (!phone) {
        throw new AppError(
          "O WhatsApp não informou o número desta pessoa, então não dá para abrir a conversa.",
          400,
          "participant_without_phone",
        );
      }

      const conversation = await deps.ingest.ensureConversation(
        {
          instanceId: participant.group.whatsappInstanceId,
          externalChatId: `${phone}@s.whatsapp.net`,
          isGroup: false,
          callerName: participant.name,
          callerPhone: phone,
        },
        request.user.organizationId,
      );
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "conversation.opened_from_group",
        entityType: "Conversation",
        entityId: conversation.id,
      });
      return reply.status(201).send({ conversationId: conversation.id });
    },
  );

  /**
   * Força nova busca das fotos (da conversa e, em grupos, dos participantes).
   * Útil quando alguém troca a imagem ou quando uma consulta anterior falhou.
   */
  app.post("/conversations/:id/avatar/refresh", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    const group = await deps.prisma.whatsAppGroup.findFirst({
      where: { conversationId: id, organizationId: request.user.organizationId },
      select: { id: true },
    });

    await deps.instanceManager.resetAvatarChecks(id, group?.id);
    const updated = await deps.instanceManager.syncConversationAvatar(
      {
        id: conversation.id,
        whatsappInstanceId: conversation.whatsappInstanceId,
        externalChatId: conversation.externalChatId,
      },
      { force: true },
    );
    if (updated) {
      await emitConversationUpdated(id, request.user.organizationId);
    }
    if (group) {
      // Participantes são buscados em segundo plano (pode levar alguns segundos).
      void deps.instanceManager.syncParticipantAvatars(id, request.user.organizationId);
    }
    return { updated };
  });

  /**
   * Avisa as outras abas DESTA pessoa que a leitura mudou. Vai para a sala
   * pessoal, e não para a audiência da conversa: mandar leitura para a
   * audiência zeraria o aviso de quem não leu — o defeito que esta entrega
   * conserta. Por isso também não há `conversation:updated` aqui: o DTO da
   * conversa não mudou em nada para os outros.
   */
  async function emitConversationRead(
    userId: string,
    conversationId: string,
    unreadCount: number,
  ): Promise<void> {
    deps.io.to(userRoom(userId)).emit(RealtimeEvents.ConversationRead, {
      conversationId,
      unreadCount,
    });
  }

  /**
   * Marca a conversa como lida SÓ PARA QUEM ABRIU. A marca avança até a
   * última mensagem e nunca retrocede sozinha — rolar para cima e reler
   * mensagens antigas não faz a conversa voltar a ter não lidas.
   */
  app.post("/conversations/:id/read", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await markConversationRead(deps.prisma, {
      organizationId: request.user.organizationId,
      conversationId: id,
      userId: request.user.sub,
    });
    const unreadCount = await loadUnreadCount(deps.prisma, request.user.sub, id);
    await emitConversationRead(request.user.sub, id, unreadCount);
    return { ok: true, unreadCount };
  });

  /**
   * "Marcar como não lida": recua a marca de propósito, para a pessoa
   * reservar a conversa para depois. Vale só para ela — ninguém mais vê o
   * aviso voltar. Sem auditoria: leitura é estado pessoal de interface, e
   * registrar cada abertura de conversa geraria volume sem valor.
   */
  app.post("/conversations/:id/unread", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await markConversationUnread(deps.prisma, {
      organizationId: request.user.organizationId,
      conversationId: id,
      userId: request.user.sub,
    });
    const unreadCount = await loadUnreadCount(deps.prisma, request.user.sub, id);
    await emitConversationRead(request.user.sub, id, unreadCount);
    return { ok: true, unreadCount };
  });

  // ---------------- Atribuição de atendimento ----------------

  const assignSchema = z.object({
    userId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    note: z.string().max(500).optional(),
  });

  /**
   * Os candidatos a responsável desta conversa: quem enxerga o número e,
   * quando ela está classificada, atua no departamento dela.
   *
   * A tela oferece exatamente o que a API aceita — mas a lista existe para
   * a pessoa escolher bem, e não para controlar acesso: a recusa de verdade
   * está no `POST .../assign`, logo abaixo, porque chamar a rota direto com
   * um id de fora é trivial.
   *
   * Para supervisor e admin a resposta traz também `others`: os ativos que
   * NÃO enxergam esta conversa. Eles podem transferir para lá (é decisão de
   * supervisão), e a tela usa a separação para confirmar antes de gravar,
   * em vez de deixar a conversa virar órfã em silêncio.
   */
  app.get(
    "/conversations/:id/assignees",
    { preHandler: requirePermission(deps, "conversation.transfer_user") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const conversation = await findConversationOr404(id, request.user);
      const candidates = await deps.prisma.user.findMany({
        where: conversationAssigneeWhere(request.user.organizationId, conversation),
        orderBy: { name: "asc" },
      });
      const beyondReach = canAssignBeyondConversationReach(request.user.role);
      const others = beyondReach
        ? await deps.prisma.user.findMany({
            where: {
              organizationId: request.user.organizationId,
              status: "active",
              id: { notIn: candidates.map((candidate) => candidate.id) },
            },
            orderBy: { name: "asc" },
          })
        : [];
      return {
        users: candidates.map(serializeUserDirectory),
        others: others.map(serializeUserDirectory),
        canAssignBeyondReach: beyondReach,
      };
    },
  );

  /**
   * Recusa a transferência para quem não enxergaria a conversa.
   *
   * Vale só para o atendente: supervisor e admin passam, porque a tela já
   * pediu confirmação explícita ("esta pessoa não vai ver a conversa") e a
   * decisão é deles.
   *
   * O departamento avaliado é o do ESTADO FINAL da conversa — a mesma rota
   * aceita `departmentId` no corpo, e conferir contra o departamento antigo
   * validaria um cenário que não vai existir depois da gravação.
   *
   * Conversa cujo departamento mudou depois de atribuída NÃO é desfeita por
   * aqui: o responsável atual continua onde está, e a regra só vale para
   * transferências novas. Desatribuir sozinho tiraria o atendimento de quem
   * já estava conversando com o cliente, sem ninguém pedir.
   */
  async function assertAssignable(
    user: AuthTokenPayload,
    conversation: { whatsappInstanceId: string; departmentId: string | null },
    targetUserId: string,
  ) {
    if (canAssignBeyondConversationReach(user.role)) {
      // A supervisão escapa do alcance da conversa, mas não do básico: a
      // pessoa continua tendo de existir, estar ativa e ser DESTA
      // organização. Sem esta conferência a rota aceitaria o id de um
      // usuário de outro tenant, que é o pior tipo de conversa órfã.
      const existe = await deps.prisma.user.findFirst({
        where: { id: targetUserId, organizationId: user.organizationId, status: "active" },
        select: { id: true },
      });
      if (!existe) throw new ForbiddenError("Usuário indisponível para receber a conversa.");
      return;
    }
    const target = await deps.prisma.user.findFirst({
      where: {
        id: targetUserId,
        ...conversationAssigneeWhere(user.organizationId, conversation),
      },
      select: { id: true },
    });
    if (!target) {
      throw new ForbiddenError(
        "Esta pessoa não atende esta conversa: transfira para alguém do departamento da conversa que também tenha este número.",
      );
    }
  }

  app.post(
    "/conversations/:id/assign",
    { preHandler: requirePermission(deps, "conversation.transfer_user") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = assignSchema.parse(request.body);
    // Esta rota também aceita departamento no mesmo corpo — seria a porta
    // lateral para o campo que decide quem enxerga a conversa. A recusa é do
    // CAMPO, não da rota: sem `departmentId`, quem pode atribuir atribui
    // normalmente.
    if (body.departmentId) {
      const permissions = await loadPermissions(deps.prisma, request.user);
      permissions.assert("conversation.change_department");
    }
    const conversation = await findConversationOr404(id, request.user);

    // Sem corpo: o próprio usuário assume o atendimento.
    const targetUserId = body.userId ?? request.user.sub;
    await assertAssignable(
      request.user,
      {
        whatsappInstanceId: conversation.whatsappInstanceId,
        // Estado final: se o corpo troca o departamento, é ele que decide
        // quem passa a enxergar a conversa.
        departmentId: body.departmentId ?? conversation.departmentId,
      },
      targetUserId,
    );
    const isTransfer = conversation.assignedUserId != null && conversation.assignedUserId !== targetUserId;

    /**
     * Assumir uma conversa coletiva DESLIGA a marcação — é a forma natural de
     * sair do @todos, e a exclusão mútua é obrigatória (o banco recusaria o
     * par marcação + responsável). O histórico ganha as duas linhas: sair do
     * coletivo e a atribuição em si.
     *
     * A saída recebe um instante anterior de propósito: as duas linhas nascem
     * na mesma transação, e o `now()` do Postgres as empataria — o painel, que
     * ordena por data, mostraria "assumiu" antes de "saiu de @todos" na
     * metade das vezes.
     */
    const leftAllUsers = conversation.assignedToAll;

    await deps.prisma.$transaction([
      deps.prisma.conversation.update({
        where: { id },
        data: {
          ...assignToUserData(targetUserId),
          ...(body.departmentId ? { departmentId: body.departmentId } : {}),
        },
      }),
      ...(leftAllUsers
        ? [
            deps.prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: request.user.organizationId,
                conversationId: id,
                action: "unassigned_from_all" as const,
                performedByUserId: request.user.sub,
                createdAt: new Date(Date.now() - 1),
              },
            }),
          ]
        : []),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: isTransfer ? "transferred_user" : "assigned",
          fromUserId: conversation.assignedUserId,
          toUserId: targetUserId,
          performedByUserId: request.user.sub,
          note: body.note,
        },
      }),
    ]);
    if (leftAllUsers) {
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "conversation.unassigned_from_all",
        entityType: "Conversation",
        entityId: id,
      });
    }
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: isTransfer ? "conversation.transferred" : "conversation.assigned",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
    },
  );

  /**
   * Trocar o departamento da conversa é decisão de supervisão, e não de
   * atendimento: o campo é o que define quem enxerga a conversa, então o
   * atendente que o alterasse tiraria o atendimento do campo de visão de um
   * time inteiro — inclusive do dele próprio, sem entender o motivo.
   *
   * A chave `conversation.change_department` do catálogo decide quem pode
   * (padrão: supervisor para cima), e o admin passa por cima como sempre.
   * Status e responsável seguem em rotas e chaves próprias, ao lado.
   */
  app.post(
    "/conversations/:id/transfer-department",
    { preHandler: requirePermission(deps, "conversation.change_department") },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ departmentId: z.string().uuid(), note: z.string().max(500).optional() })
        .parse(request.body);
      const conversation = await findConversationOr404(id, request.user);
      const department = await deps.prisma.department.findFirst({
        where: { id: body.departmentId, organizationId: request.user.organizationId },
      });
      if (!department) throw new NotFoundError("Departamento");

      await deps.prisma.$transaction([
        deps.prisma.conversation.update({
          where: { id },
          // A marcação de @todos NÃO é tocada de propósito: ela é do
          // atendimento, não do departamento. Conversa coletiva que muda de
          // time continua coletiva, agora para o time novo.
          data: { departmentId: body.departmentId, assignedUserId: null },
        }),
        deps.prisma.conversationAssignmentHistory.create({
          data: {
            organizationId: request.user.organizationId,
            conversationId: id,
            action: "transferred_department",
            fromUserId: conversation.assignedUserId,
            fromDepartmentId: conversation.departmentId,
            toDepartmentId: body.departmentId,
            performedByUserId: request.user.sub,
            note: body.note,
          },
        }),
      ]);
      await emitConversationUpdated(id, request.user.organizationId);
      return { ok: true };
    },
  );

  /**
   * Marca o atendimento como coletivo ("@todos"): a conversa passa a ser de
   * todo o departamento em vez de ficar com uma pessoa.
   *
   * Papel mínimo `agent`, o mesmo de atribuir e desatribuir — e por um motivo
   * concreto: o atendente já produz esse efeito hoje simplesmente removendo o
   * responsável. Exigir supervisor aqui travaria por fora o que continua
   * permitido por dentro, e o único ganho da marcação (saber que o coletivo
   * foi decidido, e não esquecido) se perderia.
   *
   * Vale para grupo e para conversa individual, com ou sem departamento: sem
   * departamento, "todos" são todos os que enxergam aquele número — que é
   * exatamente o alcance que a conversa órfã já tinha.
   *
   * O não lido da conversa coletiva é de cada pessoa, como em qualquer
   * outra: quem abrir não apaga o aviso dos colegas (ver
   * `lib/conversation-reads.ts`).
   */
  app.post(
    "/conversations/:id/assign-all",
    { preHandler: requirePermission(deps, "conversation.assign_all") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});
    const conversation = await findConversationOr404(id, request.user);
    // Clique repetido não vira segunda linha de histórico.
    if (conversation.assignedToAll) return { ok: true };

    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: assignToAllData() }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "assigned_to_all",
          // Quem estava com a conversa antes: a marcação tira o responsável
          // no mesmo movimento, e o histórico precisa dizer de quem saiu.
          fromUserId: conversation.assignedUserId,
          toDepartmentId: conversation.departmentId,
          performedByUserId: request.user.sub,
          note: body.note,
        },
      }),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.assigned_to_all",
      entityType: "Conversation",
      entityId: id,
    });
    // A conversa muda de sala ao perder o responsável (de `mine` para `free`):
    // quem passa a enxergá-la recebe a linha aqui, sem reload.
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post(
    "/conversations/:id/unassign",
    { preHandler: requirePermission(deps, "conversation.unassign") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    // Sair do coletivo tem ação própria: "removeu o responsável" descreveria
    // errado uma conversa que não tinha responsável nenhum.
    const leftAllUsers = conversation.assignedToAll;
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: clearAssignmentData() }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: leftAllUsers ? "unassigned_from_all" : "unassigned",
          fromUserId: conversation.assignedUserId,
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    if (leftAllUsers) {
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "conversation.unassigned_from_all",
        entityType: "Conversation",
        entityId: id,
      });
    }
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /**
   * Arquivar: a conversa some da Inbox e deixa de contar em todos os números
   * do sistema, sem apagar nada — mensagens, notas, etiquetas e histórico
   * ficam intactos. É ORTOGONAL ao status (não é um quinto status): o status
   * congela como está e volta a valer no desarquivamento. Papel mínimo:
   * agent, o mesmo que já muda status e atribui — quem enxerga, arquiva.
   */
  app.post(
    "/conversations/:id/archive",
    { preHandler: requirePermission(deps, "conversation.archive") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    // Já arquivada: não regrava data nem autor, senão o registro de quem
    // arquivou primeiro seria sobrescrito por um clique repetido.
    if (conversation.archivedAt) return { ok: true };

    await deps.prisma.conversation.update({
      where: { id },
      data: {
        archivedAt: new Date(),
        archivedByUserId: request.user.sub,
        // Não lidas não são mais zeradas aqui: elas são por usuário e a
        // conversa arquivada já não conta para ninguém (a contagem descarta
        // arquivada). Zerar a marca de cada pessoa, além de caro, faria o
        // desarquivamento voltar sem aviso nenhum.
      },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.archived",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /** Desarquivar: volta com o status que tinha e volta a contar em tudo. */
  app.post(
    "/conversations/:id/unarchive",
    { preHandler: requirePermission(deps, "conversation.archive") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    if (!conversation.archivedAt) return { ok: true };

    await deps.prisma.conversation.update({
      where: { id },
      data: { archivedAt: null, archivedByUserId: null },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.unarchived",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post("/conversations/:id/resolve", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status: "resolved" } }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "resolved",
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.resolved",
      entityType: "Conversation",
      entityId: id,
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.post("/conversations/:id/reopen", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status: "open" } }),
      deps.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: id,
          action: "reopened",
          performedByUserId: request.user.sub,
        },
      }),
    ]);
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  const statusSchema = z.object({
    status: z.enum(CONVERSATION_STATUSES),
  });

  app.post("/conversations/:id/status", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = statusSchema.parse(request.body);
    const conversation = await findConversationOr404(id, request.user);
    if (conversation.status === status) return { ok: true };

    // Concluir e reabrir continuam aparecendo no histórico da conversa; as
    // trocas entre os status de espera são registradas só na auditoria.
    const historyAction =
      status === "resolved" ? "resolved" : conversation.status === "resolved" ? "reopened" : null;

    await deps.prisma.$transaction([
      deps.prisma.conversation.update({ where: { id }, data: { status } }),
      ...(historyAction
        ? [
            deps.prisma.conversationAssignmentHistory.create({
              data: {
                organizationId: request.user.organizationId,
                conversationId: id,
                action: historyAction,
                performedByUserId: request.user.sub,
              },
            }),
          ]
        : []),
    ]);
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.status_changed",
      entityType: "Conversation",
      entityId: id,
      metadata: { from: conversation.status, to: status },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /**
   * Referência externa da conversa — o ÚNICO caminho de escrita em
   * `externalReference`, para os dois mecanismos que o campo atende:
   *
   * - `manual`: o código do cadastro digitado pela equipe ("EMPRESA 001");
   * - `azevedo-os`: o ponteiro para a empresa no Azevedo-OS, gravado pelo
   *   card de cliente da Inbox.
   *
   * `externalSource` não aceita texto livre (Zod contra a lista conhecida):
   * sem isso o navegador registraria qualquer origem e a próxima integração
   * herdaria vínculos que ninguém sabe de onde vieram. Quem pode o quê é
   * decidido em `planReferenceUpdate` — a regra depende do estado da
   * conversa, não só do papel.
   *
   * Vínculo com o Azevedo-OS é confirmado antes de gravar: a empresa
   * precisa existir lá. Azevedo-OS fora do ar recusa o vínculo (é escrita,
   * e gravar um id não conferido é pior do que adiar), mas não atrapalha
   * nenhuma outra operação da conversa.
   */
  app.patch("/conversations/:id/reference", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        // 64 caracteres cobrem o código digitado e também o identificador do
        // Azevedo-OS (uuid tem 36) sem prender o formato: id externo que um
        // dia deixar de ser uuid continua cabendo.
        externalReference: z.string().trim().max(64).nullable(),
        externalSource: z.enum(EXTERNAL_REFERENCE_SOURCES).default("manual"),
      })
      .parse(request.body);
    const conversation = await findConversationOr404(id, request.user);

    const nextReference =
      body.externalReference && body.externalReference.length > 0 ? body.externalReference : null;
    // Nada mudou: sai antes de auditar, senão reabrir a tela viraria um
    // registro de alteração que nunca aconteceu.
    if (
      nextReference === conversation.externalReference &&
      (nextReference === null || body.externalSource === conversation.externalSource)
    ) {
      return { ok: true };
    }

    const permissions = await loadPermissions(deps.prisma, request.user);
    const plan = planReferenceUpdate({
      currentReference: conversation.externalReference,
      currentSource: conversation.externalSource,
      nextReference,
      nextSource: body.externalSource,
      canLink: permissions.can("azevedo_os.link"),
      canRelink: permissions.can("azevedo_os.relink"),
    });

    if (plan.verifyCompany && plan.reference) {
      // Empresa inexistente responde 404 do próprio client; indisponível
      // responde 502/504. Em nenhum dos casos a conversa é alterada.
      await deps.azevedoOs.getCompany(plan.reference);
    }

    await deps.prisma.conversation.update({
      where: { id },
      data: { externalReference: plan.reference, externalSource: plan.source },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: plan.auditAction,
      entityType: "Conversation",
      entityId: id,
      // Dado de cadastro da empresa não entra na auditoria: o id externo
      // basta para reconstruir o que foi feito, e o resto vive no Azevedo-OS.
      metadata:
        plan.source === AZEVEDO_OS_SOURCE || conversation.externalSource === AZEVEDO_OS_SOURCE
          ? { companyId: plan.reference, previousCompanyId: conversation.externalReference }
          : { externalReference: plan.reference },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /**
   * Nome próprio da conversa.
   *
   * O nome digitado vive em `customTitle`, separado do `title` que vem do
   * WhatsApp — assim a sincronização continua atualizando o nome de origem
   * sem nunca apagar o que a equipe definiu.
   */
  app.patch(
    "/conversations/:id",
    { preHandler: requirePermission(deps, "conversation.rename") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        customTitle: z.string().trim().max(120).nullable().optional(),
      })
      .parse(request.body);
    await findConversationOr404(id, request.user);

    const customTitle =
      body.customTitle === undefined
        ? undefined
        : body.customTitle && body.customTitle.length > 0
          ? body.customTitle
          : null;
    if (customTitle === undefined) return { ok: true };

    await deps.prisma.conversation.update({ where: { id }, data: { customTitle } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.renamed",
      entityType: "Conversation",
      entityId: id,
      metadata: { customTitle },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  /**
   * Cadastro do participante feito pela equipe: nome próprio e papel dentro
   * do cliente. Os dois campos são opcionais e independentes — quem só quer
   * marcar o sócio não precisa reenviar o nome.
   *
   * A edição grava no registro da PESSOA (`PersonProfile`, único na
   * organização), e não mais na linha deste grupo: a mesma pessoa está nos
   * grupos Geral, Contábil, Fiscal e DP do cliente, e a correção vale para
   * todos eles — e para a conversa individual — de uma vez. A rota continua
   * exigindo acesso ao GRUPO de onde a edição parte (`groupScope`), então
   * ninguém edita quem não enxerga.
   *
   * Papel mínimo continua sendo `agent`: quem atende o grupo é quem sabe
   * quem é quem nele.
   */
  app.patch(
    "/group-participants/:id",
    { preHandler: requirePermission(deps, "group_participant.rename") },
    async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        customName: z.string().trim().max(120).nullable().optional(),
        // Coluna única, então a seleção é única por construção: sócio,
        // administrativo ou null (nenhuma marcação). Nunca as duas.
        clientRole: z.enum(PARTICIPANT_CLIENT_ROLES).nullable().optional(),
      })
      .parse(request.body);
    const access = await loadConversationAccess(deps.prisma, request.user);
    const participant = await deps.prisma.groupParticipant.findFirst({
      where: {
        id,
        group: { organizationId: request.user.organizationId, ...groupScope(access) },
      },
      select: {
        id: true,
        externalContactId: true,
        phoneNumber: true,
        customName: true,
        clientRole: true,
      },
    });
    if (!participant) throw new NotFoundError("Participante");

    const valor =
      body.customName !== undefined && body.customName && body.customName.length > 0
        ? body.customName
        : null;

    // Valores EFETIVOS anteriores (registro da pessoa quando existe, senão o
    // legado do grupo) — a auditoria registra de onde a mudança partiu.
    const previousProfile = await deps.prisma.personProfile.findUnique({
      where: {
        organizationId_externalId: {
          organizationId: request.user.organizationId,
          externalId: participant.externalContactId,
        },
      },
      select: { customName: true, clientRole: true },
    });
    const previous = previousProfile ?? participant;

    await upsertPersonProfile(deps.prisma, request.user.organizationId, participant, {
      ...(body.customName !== undefined ? { customName: valor } : {}),
      ...(body.clientRole !== undefined ? { clientRole: body.clientRole } : {}),
    });

    // Todas as participações da pessoa na organização: dão a contagem de
    // grupos afetados (auditoria e resposta) e a audiência de cada conversa.
    const participations = await deps.prisma.groupParticipant.findMany({
      where: {
        externalContactId: participant.externalContactId,
        group: { organizationId: request.user.organizationId },
      },
      select: {
        group: {
          select: {
            conversationId: true,
            whatsappInstanceId: true,
            conversation: {
              select: { departmentId: true, assignedUserId: true, whatsappInstanceId: true },
            },
          },
        },
      },
    });
    const affectedGroups = participations.length;

    if (body.customName !== undefined) {
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "group_participant.renamed",
        entityType: "GroupParticipant",
        entityId: id,
        metadata: { from: previous.customName, customName: valor, affectedGroups },
      });
    }
    // Marcação de papel é alteração de cadastro feita por pessoa: entra na
    // auditoria com o valor anterior, para dar para reconstruir a mudança.
    if (body.clientRole !== undefined) {
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "group_participant.client_role_changed",
        entityType: "GroupParticipant",
        entityId: id,
        metadata: { from: previous.clientRole, to: body.clientRole, affectedGroups },
      });
    }

    // Quem está com QUALQUER grupo da pessoa aberto precisa ver a mudança sem
    // reload — a edição agora vale para todos eles. O payload não muda
    // (`{ conversationId }`); o alcance é que passa a ser um evento por
    // conversa de grupo afetada, cada um para a própria audiência: quem não
    // enxerga um grupo continua sem receber nada dele.
    for (const participation of participations) {
      const conversationId = participation.group.conversationId;
      if (!conversationId) continue;
      deps.io
        .to(
          conversationAudience(
            request.user.organizationId,
            participation.group.conversation ?? {
              whatsappInstanceId: participation.group.whatsappInstanceId,
              departmentId: null,
              assignedUserId: null,
            },
          ),
        )
        .emit(RealtimeEvents.GroupParticipants, { conversationId });
    }

    // A conversa individual exibe o mesmo nome corrigido: publica o DTO novo
    // para a lista de quem a enxerga. O casamento por telefone cobre o caso
    // do grupo por "@lid" com privado por "@s.whatsapp.net".
    if (body.customName !== undefined) {
      const phone = participant.phoneNumber.replace(/\D/g, "");
      const individuals = await deps.prisma.conversation.findMany({
        where: {
          organizationId: request.user.organizationId,
          type: "individual",
          externalChatId: {
            in: [
              participant.externalContactId,
              ...(phone.length > 0 ? [`${phone}@s.whatsapp.net`] : []),
            ],
          },
        },
        select: { id: true },
      });
      for (const conversa of individuals) {
        await emitConversationUpdated(conversa.id, request.user.organizationId);
      }
    }
    return { ok: true, affectedGroups };
  });

  /**
   * Arquivos trocados na conversa — documentos, imagens, áudios e vídeos em
   * um só lugar, sem precisar rolar o histórico atrás de um vencimento.
   */
  app.get("/conversations/:id/files", { preHandler: authenticate }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { limit } = z
      .object({ limit: z.coerce.number().min(1).max(200).default(100) })
      .parse(request.query);
    await findConversationOr404(id, request.user);
    const files = await deps.prisma.message.findMany({
      where: {
        conversationId: id,
        deletedAt: null,
        mediaUrl: { not: null },
      },
      orderBy: { timestamp: "desc" },
      take: limit,
      select: {
        id: true,
        type: true,
        filename: true,
        mimeType: true,
        direction: true,
        senderName: true,
        timestamp: true,
      },
    });
    return {
      files: files.map((file) => ({
        id: file.id,
        type: file.type,
        filename: file.filename,
        mimeType: file.mimeType,
        direction: file.direction,
        senderName: file.senderName,
        timestamp: file.timestamp.toISOString(),
      })),
    };
  });

  // ---------------- Etiquetas da conversa ----------------

  app.post("/conversations/:id/tags/:tagId", { preHandler: authenticate }, async (request) => {
    const { id, tagId } = z
      .object({ id: z.string().uuid(), tagId: z.string().uuid() })
      .parse(request.params);
    const conversation = await findConversationOr404(id, request.user);
    const accessible = await accessibleDepartmentIds(deps.prisma, request.user);
    const tag = await deps.prisma.tag.findFirst({
      where: {
        id: tagId,
        organizationId: request.user.organizationId,
        // Etiqueta que a pessoa não enxerga não existe para ela: 404, e não
        // 403, para não confirmar a existência de etiqueta de outra equipe.
        ...departmentResourceScope(accessible),
      },
      include: { departments: { select: { departmentId: true } } },
    });
    if (!tag) throw new NotFoundError("Etiqueta");
    if (!canApplyToConversation(tag, conversation.departmentId)) {
      throw new ForbiddenError("Esta etiqueta não vale para o departamento desta conversa");
    }
    await deps.prisma.conversationTag.upsert({
      where: { conversationId_tagId: { conversationId: id, tagId } },
      update: {},
      create: { conversationId: id, tagId },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "conversation.tag_added",
      entityType: "Conversation",
      entityId: id,
      metadata: { tagId },
    });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  app.delete("/conversations/:id/tags/:tagId", { preHandler: authenticate }, async (request) => {
    const { id, tagId } = z
      .object({ id: z.string().uuid(), tagId: z.string().uuid() })
      .parse(request.params);
    await findConversationOr404(id, request.user);
    await deps.prisma.conversationTag.deleteMany({ where: { conversationId: id, tagId } });
    await emitConversationUpdated(id, request.user.organizationId);
    return { ok: true };
  });

  // ---------------- Notas internas ----------------

  app.post("/conversations/:id/notes", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(request.body);
    const conversation = await findConversationOr404(id, request.user);
    const note = await deps.prisma.internalNote.create({
      data: {
        organizationId: request.user.organizationId,
        conversationId: id,
        userId: request.user.sub,
        content,
      },
      include: { user: true },
    });
    const payload = {
      id: note.id,
      conversationId: id,
      content: note.content,
      user: note.user ? serializeUserDirectory(note.user) : null,
      createdAt: note.createdAt.toISOString(),
    };
    // Aparece na hora para toda a equipe, dentro da conversa.
    deps.io
      .to(conversationAudience(request.user.organizationId, conversation))
      .emit(RealtimeEvents.InternalNote, payload);
    return reply.status(201).send({ note: payload });
  });

  /** Edita uma nota interna (autor, supervisor ou admin). */
  app.patch("/conversations/:id/notes/:noteId", { preHandler: authenticate }, async (request) => {
    const { id, noteId } = z
      .object({ id: z.string().uuid(), noteId: z.string().uuid() })
      .parse(request.params);
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(request.body);
    const note = await deps.prisma.internalNote.findFirst({
      where: { id: noteId, conversationId: id, organizationId: request.user.organizationId },
    });
    if (!note) throw new NotFoundError("Nota interna");
    // Nota própria cada um sempre edita — isso é código, não chave, e é o
    // que garante que nenhuma configuração tranque a pessoa fora do próprio
    // trabalho. Nota de TERCEIRO depende de `note.delete_other`.
    const permissions = await loadPermissions(deps.prisma, request.user);
    if (
      !canManageInternalNote({
        authorId: note.userId,
        actorId: request.user.sub,
        canManageOthers: permissions.can("note.delete_other"),
      })
    ) {
      permissions.assert("note.delete_other");
    }
    const updated = await deps.prisma.internalNote.update({
      where: { id: noteId },
      data: { content },
      include: { user: true },
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "note.updated",
      entityType: "InternalNote",
      entityId: noteId,
    });
    return {
      note: {
        id: updated.id,
        conversationId: id,
        content: updated.content,
        user: updated.user ? serializeUserDirectory(updated.user) : null,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });

  /** Remove uma nota interna (autor ou supervisor/admin). */
  app.delete("/conversations/:id/notes/:noteId", { preHandler: authenticate }, async (request) => {
    const { id, noteId } = z
      .object({ id: z.string().uuid(), noteId: z.string().uuid() })
      .parse(request.params);
    const note = await deps.prisma.internalNote.findFirst({
      where: { id: noteId, conversationId: id, organizationId: request.user.organizationId },
    });
    if (!note) throw new NotFoundError("Nota interna");
    // Nota própria cada um sempre edita — isso é código, não chave, e é o
    // que garante que nenhuma configuração tranque a pessoa fora do próprio
    // trabalho. Nota de TERCEIRO depende de `note.delete_other`.
    const permissions = await loadPermissions(deps.prisma, request.user);
    if (
      !canManageInternalNote({
        authorId: note.userId,
        actorId: request.user.sub,
        canManageOthers: permissions.can("note.delete_other"),
      })
    ) {
      permissions.assert("note.delete_other");
    }
    await deps.prisma.internalNote.delete({ where: { id: noteId } });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "note.deleted",
      entityType: "InternalNote",
      entityId: noteId,
    });
    return { ok: true };
  });
}
