import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { NormalizedMessage } from "@azvchat/shared";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

/**
 * Atribuição automática pelo responsável padrão — o do departamento e, na
 * falta dele, o do número. O que importa aqui é QUANDO a conversa é
 * atribuída, quando não é, e qual dos dois padrões ganha.
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
  /** Responsável padrão do número, usado quando o departamento não resolve. */
  instanceAssigneeId?: string | null;
  /** null simula usuário inexistente, inativo ou sem acesso ao número */
  assignee?: { id: string } | null;
}

function harness(scenario: Scenario) {
  const conversationUpdate = vi.fn(async () => scenario.conversation);
  const historyCreate = vi.fn(async () => ({}));
  // Tipado para o teste poder inspecionar o filtro de elegibilidade.
  const userFindFirst = vi.fn(
    async (_args: { where: Record<string, unknown> }) => scenario.assignee ?? null,
  );

  const prisma = {
    conversation: {
      findUnique: async () => scenario.conversation,
      update: conversationUpdate,
      create: async () => scenario.conversation,
    },
    department: {
      findUnique: async () => ({ defaultAssigneeId: scenario.defaultAssigneeId ?? null }),
    },
    whatsAppInstance: {
      findUnique: async () => ({ defaultAssigneeId: scenario.instanceAssigneeId ?? null }),
    },
    user: { findFirst: userFindFirst },
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
    userFindFirst,
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

  it("conversa sem departamento não usa o padrão de departamento nenhum", async () => {
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

describe("responsável padrão do número", () => {
  it("assume a conversa sem departamento, que antes ficava órfã para sempre", async () => {
    const { service, conversationUpdate, historyCreate } = harness({
      conversation: { ...CONVERSATION, departmentId: null },
      instanceAssigneeId: "user-2",
      assignee: { id: "user-2" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-2" } }),
    );
    expect(historyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ note: "Responsável padrão do número" }),
      }),
    );
  });

  it("perde para o do departamento, que é o mais específico", async () => {
    const { service, conversationUpdate, historyCreate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: "user-1",
      instanceAssigneeId: "user-2",
      assignee: { id: "user-1" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-1" } }),
    );
    expect(historyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ note: "Responsável padrão do departamento" }),
      }),
    );
  });

  it("cobre a conversa cujo departamento não tem responsável padrão", async () => {
    const { service, conversationUpdate } = harness({
      conversation: CONVERSATION,
      defaultAssigneeId: null,
      instanceAssigneeId: "user-2",
      assignee: { id: "user-2" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-2" } }),
    );
  });

  it("não atribui a quem não enxerga a conversa", async () => {
    // Pior que "sem responsável" é a conversa atribuída a quem não
    // consegue abri-la: ela some da fila e não aparece para ninguém.
    const { service, conversationUpdate } = harness({
      conversation: { ...CONVERSATION, departmentId: null },
      instanceAssigneeId: "user-2",
      assignee: null,
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("exige o número vinculado e o departamento da conversa", async () => {
    const { service, userFindFirst } = harness({
      conversation: CONVERSATION,
      instanceAssigneeId: "user-2",
      assignee: { id: "user-2" },
    });
    await service.ingest(inbound(), { organizationId: "org-1" });
    const where = userFindFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      id: "user-2",
      status: "active",
      OR: [
        { role: "admin" },
        {
          whatsappAccess: { some: { whatsappInstanceId: "inst-1" } },
          departmentAccess: { some: { departmentId: "dep-1" } },
        },
      ],
    });
  });
});
