import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { NormalizedMessage } from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

/**
 * Atribuição automática pelo responsável padrão do departamento.
 * O que importa aqui é QUANDO a conversa é atribuída — e quando não é.
 */

interface Scenario {
  conversation: {
    id: string;
    departmentId: string | null;
    assignedUserId: string | null;
    // Título já resolvido: sem isso a ingestão entra no caminho que
    // melhora o título e o update deixa de indicar atribuição.
    title: string;
    externalChatId: string;
  };
  defaultAssigneeId?: string | null;
  /** null simula usuário inexistente ou inativo */
  assignee?: { id: string } | null;
}

function harness(scenario: Scenario) {
  const conversationUpdate = vi.fn(async () => scenario.conversation);
  const historyCreate = vi.fn(async () => ({}));

  const prisma = {
    conversation: {
      findUnique: async () => scenario.conversation,
      update: conversationUpdate,
      create: async () => scenario.conversation,
    },
    department: {
      findUnique: async () => ({ defaultAssigneeId: scenario.defaultAssigneeId ?? null }),
    },
    user: { findFirst: async () => scenario.assignee ?? null },
    conversationAssignmentHistory: { create: historyCreate },
    // A ingestão para logo depois: a mensagem já existe (deduplicação).
    message: { findUnique: async () => ({ id: "msg-1" }) },
    groupParticipant: { findFirst: async () => null },
  } as unknown as PrismaClient;

  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const storage = { save: async () => "key" } as unknown as MediaStorage;

  return {
    service: new MessageIngestService(prisma, storage, logger),
    conversationUpdate,
    historyCreate,
  };
}

function inbound(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    instanceId: "inst-1",
    externalChatId: "5511999@s.whatsapp.net",
    externalMessageId: "ext-1",
    chatType: "individual",
    chatName: null,
    direction: "inbound",
    senderExternalId: "5511999@s.whatsapp.net",
    senderName: "Cliente",
    senderPhone: "5511999",
    type: "text",
    content: "oi",
    timestamp: new Date("2026-08-14T12:00:00Z"),
    ...overrides,
  } as NormalizedMessage;
}

const CONVERSATION = {
  id: "conv-1",
  departmentId: "dep-1",
  assignedUserId: null,
  title: "Cliente",
  externalChatId: "5511999@s.whatsapp.net",
};

describe("responsável padrão do departamento", () => {
  it("atribui a conversa sem responsável a quem está configurado", async () => {
    const { service, conversationUpdate, historyCreate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: "user-1",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-1" } }),
    );
    // Sem performedBy: é o que distingue a atribuição automática da manual.
    expect(historyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "assigned", toUserId: "user-1" }),
      }),
    );
  });

  it("não tira a conversa de quem já assumiu", async () => {
    const { service, conversationUpdate } = harness({
      conversation: { ...CONVERSATION, assignedUserId: "outro-usuario" },
      defaultAssigneeId: "user-1",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("não atribui quando o departamento não tem responsável padrão", async () => {
    const { service, conversationUpdate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: null,
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("não atribui a usuário inativo ou removido", async () => {
    const { service, conversationUpdate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: "user-1",
      assignee: null,
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("não atribui quando a conversa não tem departamento", async () => {
    const { service, conversationUpdate } = harness({
      conversation: { ...CONVERSATION, departmentId: null },
      defaultAssigneeId: "user-1",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("conversa iniciada pela equipe também recebe responsável", async () => {
    // Sem isso, a conversa que nós começamos nasceria órfã na lista.
    const { service, conversationUpdate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: "user-1",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound({ direction: "outbound" }), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-1" } }),
    );
  });

  it("mensagem da equipe em conversa já atribuída não muda o responsável", async () => {
    const { service, conversationUpdate } = harness({
      conversation: { ...CONVERSATION, assignedUserId: "outro-usuario" },
      defaultAssigneeId: "user-1",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound({ direction: "outbound" }), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });
});
