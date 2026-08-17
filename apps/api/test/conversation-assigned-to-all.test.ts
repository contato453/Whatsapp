import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { NormalizedMessage } from "@azvchat/shared";
import {
  assignedToAllWhere,
  assignToAllData,
  assignToUserData,
  clearAssignmentData,
  unassignedConversationWhere,
} from "../src/lib/conversation-assignment.js";
import { MessageIngestService } from "../src/services/message-ingest.js";
import type { MediaStorage } from "../src/lib/media-storage.js";

/**
 * Atendimento coletivo ("@todos"): a conversa é de todo o departamento, e não
 * de uma pessoa. Três coisas precisam continuar valendo, e são as três que
 * este arquivo prende:
 *
 * 1. marcação e responsável nunca coexistem — nem no código, nem no banco;
 * 2. a conversa marcada não recebe responsável padrão na ingestão;
 * 3. "sem responsável" deixou de ser só `assignedUserId IS NULL`.
 */

describe("exclusão mútua entre a marcação e o responsável", () => {
  it("atribuir a alguém desliga a marcação no mesmo update", () => {
    expect(assignToUserData("user-1")).toEqual({
      assignedUserId: "user-1",
      assignedToAll: false,
    });
  });

  it("marcar como @todos tira o responsável no mesmo update", () => {
    expect(assignToAllData()).toEqual({ assignedUserId: null, assignedToAll: true });
  });

  it("limpar deixa a conversa realmente órfã — sem dono e sem marcação", () => {
    expect(clearAssignmentData()).toEqual({ assignedUserId: null, assignedToAll: false });
  });

  it('"sem responsável" exclui a coletiva; o coletivo tem filtro próprio', () => {
    expect(unassignedConversationWhere()).toEqual({ assignedUserId: null, assignedToAll: false });
    expect(assignedToAllWhere()).toEqual({ assignedToAll: true });
  });
});

/**
 * A garantia do banco. Sem ambiente de integração com Postgres no repositório,
 * o que dá para provar aqui é que a migration declara a constraint — que é
 * justamente o que impede o estado "coletiva com dono" de nascer por um
 * caminho de gravação que esqueça a regra.
 */
describe("constraint no banco", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/database/prisma/migrations/20260817120000_conversation_assigned_to_all/migration.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("cria a coluna desligada por padrão", () => {
    expect(sql).toMatch(/ADD COLUMN "assignedToAll" BOOLEAN NOT NULL DEFAULT false/);
  });

  it("recusa marcação e responsável ao mesmo tempo", () => {
    expect(sql).toContain('CHECK (NOT ("assignedToAll" AND "assignedUserId" IS NOT NULL))');
  });

  it("registra as ações próprias do histórico", () => {
    expect(sql).toContain("ADD VALUE 'assigned_to_all'");
    expect(sql).toContain("ADD VALUE 'unassigned_from_all'");
  });
});

interface Conversation {
  id: string;
  departmentId: string | null;
  assignedUserId: string | null;
  assignedToAll: boolean;
  title: string;
  externalChatId: string;
}

function harness(conversation: Conversation) {
  const conversationUpdate = vi.fn(async () => conversation);
  const historyCreate = vi.fn(async () => ({}));
  const prisma = {
    conversation: {
      findUnique: async () => conversation,
      update: conversationUpdate,
      create: async () => conversation,
    },
    department: { findUnique: async () => ({ defaultAssigneeId: "user-padrao" }) },
    whatsAppInstance: { findUnique: async () => ({ defaultAssigneeId: "user-do-numero" }) },
    user: { findFirst: async () => ({ id: "user-padrao" }) },
    conversationAssignmentHistory: { create: historyCreate },
    // Mensagem já existente: a ingestão para na deduplicação, depois do
    // ponto que interessa aqui (a atribuição automática).
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

function inbound(): NormalizedMessage {
  return {
    instanceId: "inst-1",
    externalChatId: "5511999-123@g.us",
    externalMessageId: "ext-1",
    chatType: "group",
    chatName: "Cliente · Fiscal",
    direction: "inbound",
    senderExternalId: "5511999@s.whatsapp.net",
    senderName: "Cliente",
    senderPhone: "5511999",
    type: "text",
    content: "oi",
    timestamp: new Date("2026-08-17T12:00:00Z"),
  } as NormalizedMessage;
}

const COLETIVA: Conversation = {
  id: "conv-1",
  departmentId: "dep-1",
  assignedUserId: null,
  assignedToAll: true,
  title: "Cliente · Fiscal",
  externalChatId: "5511999-123@g.us",
};

describe("ingestão em conversa marcada como @todos", () => {
  it("não aplica o responsável padrão do departamento", async () => {
    const { service, conversationUpdate, historyCreate } = harness(COLETIVA);
    await service.ingest(inbound(), { organizationId: "org-1" });
    // Sem isso o grupo ganharia dono sozinho na próxima mensagem e a
    // marcação viraria enfeite.
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(historyCreate).not.toHaveBeenCalled();
  });

  it("a conversa órfã de verdade continua recebendo o padrão", async () => {
    const { service, conversationUpdate } = harness({ ...COLETIVA, assignedToAll: false });
    await service.ingest(inbound(), { organizationId: "org-1" });
    expect(conversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assignedUserId: "user-padrao" } }),
    );
  });
});
