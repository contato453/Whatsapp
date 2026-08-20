import type { Message, PrismaClient, Prisma } from "@azvchat/database";
import type { NormalizedMessage, QuotedSnapshot } from "@azvchat/shared";
import {
  EDIT_CONTENT_UNAVAILABLE_METADATA_KEY,
  MESSAGE_SECRET_METADATA_KEY,
  isEditContentUnavailable,
  appendMessageVersion,
  quotedSenderLabel,
  stripWhatsAppFormatting,
  withQuotedSnapshot,
} from "@azvchat/shared";
import type { Logger } from "pino";
import type { MediaStorage } from "../lib/media-storage.js";
import { extensionFromMime } from "../lib/media-storage.js";
import { eligibleAssigneeWhere } from "../lib/default-assignee.js";

/** Mensagem atualizada mais a conversa, que quem emite usa para a audiência. */
export interface EditResult {
  message: Message;
  conversation: {
    id: string;
    whatsappInstanceId: string;
    departmentId: string | null;
    assignedUserId: string | null;
  };
}

export interface IngestResult {
  conversationId: string;
  messageId: string;
  isNewMessage: boolean;
}

/**
 * Gera o texto de preview exibido na lista de conversas.
 * Sem os marcadores de formatação: "*Fernanda:*" viraria ruído na prévia.
 */
export function buildPreview(message: Pick<NormalizedMessage, "type" | "content">): string {
  const content = message.content ? stripWhatsAppFormatting(message.content) : null;
  if (message.type === "text") return (content ?? "").slice(0, 120);
  const labels: Record<string, string> = {
    image: "📷 Imagem",
    audio: "🎤 Áudio",
    video: "🎬 Vídeo",
    document: "📄 Documento",
    sticker: "🩵 Figurinha",
    location: "📍 Localização",
    contact: "👤 Contato",
    other: "Mensagem",
  };
  const label = labels[message.type] ?? "Mensagem";
  return content ? `${label} — ${content}`.slice(0, 120) : label;
}

/**
 * Pipeline de ingestão: mensagem normalizada do provider →
 * persistência (conversa + mensagem + mídia) → resultado para publicação
 * em tempo real. Idempotente por (conversationId, externalMessageId).
 */
export class MessageIngestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: MediaStorage,
    private readonly logger: Logger,
  ) {}

  async ingest(
    message: NormalizedMessage,
    context: { organizationId: string },
  ): Promise<IngestResult | null> {
    const conversation = await this.upsertConversation(message, context.organizationId);

    // Conversa sem responsável cai para o responsável padrão — do
    // departamento, ou do número quando não há departamento. Vale tanto na
    // mensagem que o cliente manda quanto na que a equipe manda primeiro:
    // conversa iniciada por nós também precisa de dono, senão nasce órfã
    // na lista.
    //
    // Arquivada fica de fora: ela não está em fila nenhuma, e o número de
    // backup (onde toda conversa nasce arquivada) geraria histórico de
    // atribuição em massa para alguém que nunca vai atender ali.
    //
    // A marcada como @todos também fica: ela está sem responsável POR
    // DECISÃO, e não por falta de dono. Sem esta condição o grupo coletivo
    // ganharia responsável sozinho na próxima mensagem do cliente — a
    // marcação viraria enfeite e o grupo sumiria da tela dos demais
    // justamente no caso que ela veio resolver.
    if (!conversation.assignedUserId && !conversation.assignedToAll && !conversation.archivedAt) {
      await this.applyDefaultAssignee(conversation, message.instanceId, context.organizationId);
    }

    // Deduplicação: eventos do WhatsApp podem chegar repetidos.
    const existing = await this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { conversationId: conversation.id, messageId: existing.id, isNewMessage: false };
    }

    let mediaUrl: string | null = null;
    if (message.media) {
      try {
        const buffer = await message.media.download();
        mediaUrl = await this.storage.save(buffer, {
          instanceId: message.instanceId,
          extension: message.media.filename?.split(".").pop() ?? extensionFromMime(message.media.mimeType),
        });
      } catch (err) {
        this.logger.warn({
          instanceId: message.instanceId,
          messageId: message.externalMessageId,
          event: "media_download_failed",
          error: String(err),
        });
      }
    }

    const isInbound = message.direction === "inbound";
    const preview = buildPreview(message);

    // Em grupos que usam identificadores internos (@lid), o telefone pode
    // não vir na mensagem — buscamos o que já conhecemos do participante.
    // Quando vem, aproveitamos para gravá-lo: é assim que o cadastro de um
    // grupo anônimo aprende os números, conforme as pessoas escrevem.
    let senderPhone = message.senderPhone;
    if (message.chatType === "group" && message.senderExternalId) {
      const participant = await this.prisma.groupParticipant.findFirst({
        where: {
          externalContactId: message.senderExternalId,
          group: { whatsappInstanceId: message.instanceId, externalId: message.externalChatId },
        },
        select: { id: true, phoneNumber: true, name: true },
      });

      const updates: { phoneNumber?: string; name?: string } = {};
      if (!senderPhone) {
        senderPhone = participant?.phoneNumber || null;
      } else if (participant && participant.phoneNumber !== senderPhone) {
        updates.phoneNumber = senderPhone;
      }

      // O metadado do grupo quase nunca traz o nome de quem participa — o
      // pushName da mensagem costuma ser a única fonte. Gravando aqui, o
      // painel passa a mostrar o nome de quem já escreveu mesmo depois,
      // sem depender de a pessoa escrever de novo enquanto a tela está
      // aberta. Só entra na mensagem recebida: no que sai, o remetente é a
      // própria conexão, não o participante.
      //
      // Nunca toca em `customName` — o nome da equipe continua soberano.
      if (isInbound && participant && message.senderName && participant.name !== message.senderName) {
        updates.name = message.senderName;
      }

      if (participant && Object.keys(updates).length > 0) {
        await this.prisma.groupParticipant.update({
          where: { id: participant.id },
          data: updates,
        });
      }
    }

    // Quem a mensagem marcou. Guardado porque o texto sozinho não diz:
    // ele traz "@5511999998888", e é esta lista que permite à Inbox
    // exibir o NOME do participante no lugar do número.
    let metadata: Record<string, unknown> | null = message.mentionedExternalIds?.length
      ? { mentions: message.mentionedExternalIds }
      : null;
    // Resumo da citação, congelado agora: é o que mantém o bloco de pé
    // quando a original não está (ou deixar de estar) no banco.
    const quotedSnapshot = await this.buildQuotedSnapshot(conversation, message);
    if (quotedSnapshot) {
      metadata = withQuotedSnapshot(metadata, quotedSnapshot);
    }
    // Segredo da mensagem: é dele que sai a chave da EDIÇÃO que o cliente
    // fizer nela depois. Sem guardar aqui, a edição chega e não há como
    // lê-la — o WhatsApp não manda o texto novo em claro.
    if (message.messageSecret) {
      metadata = { ...(metadata ?? {}), [MESSAGE_SECRET_METADATA_KEY]: message.messageSecret };
    }

    const created = await this.prisma.message.create({
      data: {
        organizationId: context.organizationId,
        conversationId: conversation.id,
        externalMessageId: message.externalMessageId,
        senderExternalId: message.senderExternalId,
        senderName: message.senderName,
        senderPhone,
        direction: message.direction,
        type: message.type,
        content: message.content,
        mediaUrl,
        mimeType: message.media?.mimeType ?? null,
        filename: message.media?.filename ?? null,
        quotedMessageId: message.quotedExternalMessageId,
        timestamp: message.timestamp,
        status: isInbound ? "delivered" : "sent",
        ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
      },
    });

    /**
     * Conversa arquivada CONTINUA ARQUIVADA quando chega mensagem — de
     * propósito, e diferente do WhatsApp do celular: o chip de backup recebe
     * as mesmas conversas o tempo todo, e desarquivar sozinho encheria a
     * Inbox de novo todo dia. A mensagem é gravada normalmente (o histórico
     * fica completo, legível pela busca), mas a conversa não conta como não
     * lida para ninguém (a contagem por usuário descarta arquivada) nem muda
     * de status — o status congela junto com o arquivamento e volta a reagir
     * quando alguém desarquivar.
     */
    const isArchived = conversation.archivedAt != null;
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: message.timestamp,
        lastMessagePreview: preview,
        ...(isInbound && !isArchived
          ? {
              // Não há contador para incrementar: o não lido é POR USUÁRIO e
              // sai derivado da marca de leitura de cada um
              // (`lib/conversation-reads.ts`). Incrementar uma coluna da
              // conversa era o que fazia a leitura de um apagar o aviso de
              // todos os outros.
              // Mensagem do cliente devolve a conversa para a fila: concluída
              // reabre, e "AG. Cliente" deixa de fazer sentido — a espera
              // acabou no momento em que ele respondeu.
              ...(conversation.status === "resolved" || conversation.status === "waiting_client"
                ? { status: "open" as const }
                : {}),
            }
          : {}),
      },
    });

    this.logger.info({
      instanceId: message.instanceId,
      conversationId: conversation.id,
      messageId: created.id,
      event: "message_persisted",
      timestamp: message.timestamp.toISOString(),
    });

    return { conversationId: conversation.id, messageId: created.id, isNewMessage: true };
  }

  /**
   * Resumo da mensagem citada, gravado junto com a resposta que chega.
   *
   * Com a original no banco, o resumo sai dela (e leva o id local, que é o
   * que faz o clique no bloco navegar). Sem ela — resposta a mensagem
   * anterior à conexão do número —, o resumo sai do PRÓPRIO payload do
   * WhatsApp (`quotedInfo`): antes disso a citação era descartada em
   * silêncio, e o atendente lia a resposta sem saber resposta a quê.
   */
  private async buildQuotedSnapshot(
    conversation: {
      id: string;
      type: string;
      title: string;
      externalChatId: string;
      whatsappInstanceId: string;
    },
    message: NormalizedMessage,
  ): Promise<QuotedSnapshot | null> {
    if (!message.quotedExternalMessageId) return null;

    const original = await this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId: message.quotedExternalMessageId,
        },
      },
      select: { id: true, senderName: true, senderPhone: true, content: true, type: true, direction: true },
    });
    if (original) {
      return {
        id: original.id,
        senderName: quotedSenderLabel(original),
        content: original.content,
        type: original.type,
      };
    }

    const info = message.quotedInfo;
    if (!info) return null;

    // Original desconhecida: o autor sai do cadastro que já temos — o
    // participante do grupo, ou o título da conversa individual quando quem
    // foi citado é o próprio cliente. Sem fonte, o bloco mostra o conteúdo
    // com o rótulo genérico, que ainda é melhor que citação nenhuma.
    let senderName: string | null = null;
    if (info.participantExternalId) {
      if (conversation.type === "group") {
        const participant = await this.prisma.groupParticipant.findFirst({
          where: {
            externalContactId: info.participantExternalId,
            group: {
              whatsappInstanceId: conversation.whatsappInstanceId,
              externalId: conversation.externalChatId,
            },
          },
          select: { customName: true, name: true },
        });
        senderName = participant?.customName ?? participant?.name ?? null;
      } else if (info.participantExternalId === conversation.externalChatId) {
        senderName = conversation.title;
      }
    }

    return { id: null, senderName, content: info.content, type: info.type };
  }

  /**
   * Aplica a edição que o cliente fez no celular.
   *
   * EDIÇÃO É ATUALIZAÇÃO, NUNCA MENSAGEM NOVA. O WhatsApp manda a edição
   * como pacote de protocolo apontando para a mensagem original; tratá-la
   * como mensagem de entrada criava uma bolha lixo no histórico e, pior,
   * deixava a original com o texto ANTIGO na tela — a atendente seguia
   * lendo o CNPJ, o valor ou a competência que o cliente já tinha corrigido.
   *
   * O conteúdo anterior vai para o histórico de versões em `metadata`
   * (`appendMessageVersion`): num escritório contábil, saber o que estava
   * escrito antes da correção é o que permite desfazer o que já foi feito
   * com o dado errado.
   *
   * Devolve null quando não há o que atualizar — e isso inclui o caso da
   * mensagem original desconhecida (anterior à conexão do número, ou nunca
   * sincronizada): fica só o log, sem registro novo e sem bolha de erro.
   */
  async applyEdit(input: {
    instanceId: string;
    externalChatId: string;
    targetExternalMessageId: string;
    newContent: string;
    editedAt: Date | null;
  }): Promise<EditResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        whatsappInstanceId_externalChatId: {
          whatsappInstanceId: input.instanceId,
          externalChatId: input.externalChatId,
        },
      },
      select: {
        id: true,
        whatsappInstanceId: true,
        departmentId: true,
        assignedUserId: true,
      },
    });
    const message = conversation
      ? await this.prisma.message.findUnique({
          where: {
            conversationId_externalMessageId: {
              conversationId: conversation.id,
              externalMessageId: input.targetExternalMessageId,
            },
          },
        })
      : null;

    if (!conversation || !message) {
      // Sem conteúdo de mensagem no log, só o identificador e o fato.
      this.logger.info({
        instanceId: input.instanceId,
        externalMessageId: input.targetExternalMessageId,
        event: "message_edit_target_missing",
        // Distingue "a conversa não existe" de "a conversa existe e a
        // mensagem não" — são causas diferentes e o log precisa dizer qual.
        conversationFound: conversation != null,
      });
      return null;
    }

    // Apagada não volta atrás: a edição chegou depois do revoke, e
    // ressuscitar o texto contrariaria o que o cliente pediu.
    if (message.deletedAt) return null;

    // Idempotência: o mesmo evento chega pelos dois canais do Baileys
    // (upsert e update). Conteúdo igual ao que já está gravado não gera
    // versão nova nem reescreve nada.
    if (message.content === input.newContent) {
      this.logger.info({
        instanceId: input.instanceId,
        messageId: message.id,
        event: "message_edit_noop",
      });
      return null;
    }

    const editedAt = input.editedAt ?? new Date();
    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        content: input.newContent,
        editedAt,
        metadata: appendMessageVersion(
          message.metadata,
          message.content,
          editedAt,
        ) as Prisma.InputJsonValue,
      },
    });

    // A prévia da lista mostra a última mensagem da conversa. Se foi ela
    // que mudou, a lista precisa acompanhar — senão a Inbox continuaria
    // anunciando o texto que o cliente já corrigiu.
    const last = await this.prisma.message.findFirst({
      where: { conversationId: conversation.id, deletedAt: null },
      orderBy: { timestamp: "desc" },
      select: { id: true },
    });
    if (last?.id === updated.id) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessagePreview: buildPreview(updated) },
      });
    }

    this.logger.info({
      instanceId: input.instanceId,
      conversationId: conversation.id,
      messageId: updated.id,
      event: "message_edit_applied",
    });

    return { message: updated, conversation };
  }

  /**
   * Marca que o cliente editou a mensagem, quando não foi possível ler o
   * texto novo.
   *
   * O WhatsApp cifra a edição, e há casos em que a abertura falha. Deixar a
   * bolha intacta seria o defeito original de volta, e o pior dele: a
   * atendente lendo um valor que o cliente já corrigiu, sem nada na tela
   * avisando. A mensagem mantém o conteúdo anterior, que é o que temos, mas
   * passa a exibir o aviso.
   *
   * Idempotente: a mesma edição chega mais de uma vez e a marca não se
   * repete.
   */
  async markEditUnavailable(input: {
    instanceId: string;
    externalChatId: string;
    targetExternalMessageId: string;
    editedAt: Date | null;
  }): Promise<EditResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        whatsappInstanceId_externalChatId: {
          whatsappInstanceId: input.instanceId,
          externalChatId: input.externalChatId,
        },
      },
      select: { id: true, whatsappInstanceId: true, departmentId: true, assignedUserId: true },
    });
    if (!conversation) return null;
    const message = await this.prisma.message.findUnique({
      where: {
        conversationId_externalMessageId: {
          conversationId: conversation.id,
          externalMessageId: input.targetExternalMessageId,
        },
      },
    });
    if (!message || message.deletedAt) return null;
    if (isEditContentUnavailable(message.metadata)) return null;

    const metadata = {
      ...((message.metadata as Record<string, unknown> | null) ?? {}),
      [EDIT_CONTENT_UNAVAILABLE_METADATA_KEY]: true,
    };
    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: {
        editedAt: input.editedAt ?? new Date(),
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    this.logger.info({
      instanceId: input.instanceId,
      messageId: updated.id,
      event: "message_edit_marked_unavailable",
    });
    return { message: updated, conversation };
  }

  /**
   * Garante a conversa de um contato que ainda não mandou mensagem —
   * usado quando a primeira interação é uma ligação.
   */
  async ensureConversation(
    input: {
      instanceId: string;
      externalChatId: string;
      isGroup: boolean;
      callerName: string | null;
      callerPhone: string | null;
    },
    organizationId: string,
  ) {
    return this.upsertConversation(
      {
        instanceId: input.instanceId,
        externalChatId: input.externalChatId,
        chatType: input.isGroup ? "group" : "individual",
        chatName: null,
        direction: "inbound",
        senderName: input.callerName,
        senderPhone: input.callerPhone,
      },
      organizationId,
    );
  }

  /**
   * Atribui a conversa ao responsável padrão configurado.
   *
   * O do departamento vem primeiro, porque é o mais específico; o do número
   * cobre o resto — inclusive a conversa sem departamento, que antes nunca
   * encontrava dono e ficava "Sem responsável" para sempre.
   *
   * Só age quando ninguém está responsável — nunca tira uma conversa de
   * quem já assumiu. O registro no histórico fica sem "performedBy", que é
   * o que distingue a atribuição automática da feita por uma pessoa.
   */
  private async applyDefaultAssignee(
    conversation: { id: string; departmentId: string | null },
    whatsappInstanceId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      const [department, instance] = await Promise.all([
        conversation.departmentId
          ? this.prisma.department.findUnique({
              where: { id: conversation.departmentId },
              select: { defaultAssigneeId: true },
            })
          : Promise.resolve(null),
        this.prisma.whatsAppInstance.findUnique({
          where: { id: whatsappInstanceId },
          select: { defaultAssigneeId: true },
        }),
      ]);
      const fromDepartment = department?.defaultAssigneeId ?? null;
      const assigneeId = fromDepartment ?? instance?.defaultAssigneeId ?? null;
      if (!assigneeId) return;

      /**
       * Quem foi desativado, perdeu o número ou saiu do departamento depois
       * de configurado não recebe a conversa: ela ficaria parada numa caixa
       * que ninguém abre, e pior que "sem responsável" é a conversa
       * atribuída a quem não consegue enxergá-la.
       */
      const assignee = await this.prisma.user.findFirst({
        where: eligibleAssigneeWhere({
          userId: assigneeId,
          organizationId,
          whatsappInstanceId,
          departmentId: conversation.departmentId,
        }),
        select: { id: true },
      });
      if (!assignee) return;

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { assignedUserId: assignee.id },
      });
      await this.prisma.conversationAssignmentHistory.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          action: "assigned",
          toUserId: assignee.id,
          toDepartmentId: conversation.departmentId,
          note: fromDepartment
            ? "Responsável padrão do departamento"
            : "Responsável padrão do número",
        },
      });
    } catch (err) {
      // Falhar aqui não pode impedir a mensagem de ser gravada.
      this.logger.warn({
        conversationId: conversation.id,
        event: "default_assignee_failed",
        error: String(err),
      });
    }
  }

  private async upsertConversation(
    message: Pick<
      NormalizedMessage,
      | "instanceId"
      | "externalChatId"
      | "chatType"
      | "chatName"
      | "direction"
      | "senderName"
      | "senderPhone"
    >,
    organizationId: string,
  ) {
    const fallbackTitle =
      message.chatName ??
      (message.chatType === "group"
        ? "Grupo"
        : message.direction === "inbound"
          ? (message.senderName ?? message.senderPhone ?? message.externalChatId)
          : (message.senderPhone ?? message.externalChatId));

    const existing = await this.prisma.conversation.findUnique({
      where: {
        whatsappInstanceId_externalChatId: {
          whatsappInstanceId: message.instanceId,
          externalChatId: message.externalChatId,
        },
      },
    });
    if (existing) {
      // Melhora o título se antes só tínhamos o telefone/JID e agora temos nome.
      if (
        message.chatType === "individual" &&
        message.direction === "inbound" &&
        message.senderName &&
        (existing.title === existing.externalChatId || /^\d+$/.test(existing.title))
      ) {
        return this.prisma.conversation.update({
          where: { id: existing.id },
          data: { title: message.senderName },
        });
      }
      return existing;
    }

    // A conversa nasce no departamento padrão do número, para já entrar
    // classificada e respeitar o recorte por departamento desde a primeira
    // mensagem.
    const instance = await this.prisma.whatsAppInstance.findUnique({
      where: { id: message.instanceId },
      select: { departmentId: true, isBackup: true },
    });
    const data: Prisma.ConversationUncheckedCreateInput = {
      organizationId,
      whatsappInstanceId: message.instanceId,
      externalChatId: message.externalChatId,
      type: message.chatType,
      title: fallbackTitle,
      departmentId: instance?.departmentId ?? null,
      status: "open",
      // Número marcado como backup: a conversa já NASCE arquivada, no mesmo
      // caminho de criação de sempre — é assim que o chip reserva não enche
      // a Inbox nem os números do dashboard. Sem autor: foi o sistema.
      ...(instance?.isBackup ? { archivedAt: new Date() } : {}),
    };
    return this.prisma.conversation.create({ data });
  }
}
