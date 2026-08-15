import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { RealtimeEvents } from "@azvchat/shared";
import { countPendingScheduled, emitScheduledPending } from "../src/lib/scheduled-pending.js";

const ORG = "org-1";
const CONVERSA = "conv-1";
const OUTRA_CONVERSA = "conv-2";

interface Agendamento {
  conversationId: string;
  status: string;
}

interface ConversaFake {
  id: string;
  organizationId: string;
  whatsappInstanceId: string;
  departmentId: string | null;
  assignedUserId: string | null;
}

/** Cenário com agendamentos de duas conversas e de todos os status. */
const CENARIO: Agendamento[] = [
  { conversationId: CONVERSA, status: "pending" },
  { conversationId: CONVERSA, status: "pending" },
  { conversationId: CONVERSA, status: "sent" },
  { conversationId: CONVERSA, status: "failed" },
  { conversationId: CONVERSA, status: "canceled" },
  // Outra conversa: nunca pode entrar na conta da primeira.
  { conversationId: OUTRA_CONVERSA, status: "pending" },
  { conversationId: OUTRA_CONVERSA, status: "pending" },
  { conversationId: OUTRA_CONVERSA, status: "pending" },
];

const wheres: Array<Record<string, unknown>> = [];

function fakePrisma(rows: Agendamento[], conversations: ConversaFake[] = []): PrismaClient {
  return {
    scheduledMessage: {
      count: async ({ where }: { where: { conversationId?: string; status?: string } }) => {
        wheres.push({ ...where });
        return rows.filter(
          (row) => row.conversationId === where.conversationId && row.status === where.status,
        ).length;
      },
    },
    conversation: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        conversations.find(
          (conversation) =>
            conversation.id === where.id && conversation.organizationId === where.organizationId,
        ) ?? null,
    },
  } as unknown as PrismaClient;
}

function fakeLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
}

function fakeIo(captured: Array<{ rooms: string[]; event: string; payload: unknown }>): Server {
  return {
    to: (rooms: string[]) => ({
      emit: (event: string, payload: unknown) => captured.push({ rooms, event, payload }),
    }),
  } as unknown as Server;
}

describe("countPendingScheduled (contagem de agendamentos por sair)", () => {
  it("conta só o que está pendente, ignorando enviado, falho e cancelado", async () => {
    expect(await countPendingScheduled(fakePrisma(CENARIO), CONVERSA)).toBe(2);
  });

  it("é escopada pela conversa: agendamento de outra conversa não entra", async () => {
    expect(await countPendingScheduled(fakePrisma(CENARIO), OUTRA_CONVERSA)).toBe(3);
  });

  it("conversa sem agendamento pendente devolve zero", async () => {
    const somenteProcessados: Agendamento[] = [
      { conversationId: CONVERSA, status: "sent" },
      { conversationId: CONVERSA, status: "failed" },
      { conversationId: CONVERSA, status: "canceled" },
    ];
    expect(await countPendingScheduled(fakePrisma(somenteProcessados), CONVERSA)).toBe(0);
  });

  it("filtra sempre por conversa e status, nunca por where montado à mão", async () => {
    wheres.length = 0;
    await countPendingScheduled(fakePrisma(CENARIO), CONVERSA);
    expect(wheres).toEqual([{ conversationId: CONVERSA, status: "pending" }]);
  });
});

describe("emitScheduledPending (aviso em tempo real)", () => {
  const conversas: ConversaFake[] = [
    {
      id: CONVERSA,
      organizationId: ORG,
      whatsappInstanceId: "chip-a",
      departmentId: "dep-1",
      assignedUserId: "user-9",
    },
  ];

  it("emite o contador para a mesma audiência dos demais eventos da conversa", async () => {
    const captured: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
    await emitScheduledPending(
      { prisma: fakePrisma(CENARIO, conversas), io: fakeIo(captured), logger: fakeLogger() },
      ORG,
      CONVERSA,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe(RealtimeEvents.ScheduledPending);
    expect(captured[0]?.payload).toEqual({ conversationId: CONVERSA, pending: 2 });
    // Conversa atribuída: só o responsável e os supervisores do departamento.
    expect(captured[0]?.rooms).toEqual(["org:org-1", "sup:chip-a:dep-1", "mine:chip-a:dep-1:user-9"]);
  });

  it("conversa de outra organização não gera evento algum", async () => {
    const captured: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
    await emitScheduledPending(
      { prisma: fakePrisma(CENARIO, conversas), io: fakeIo(captured), logger: fakeLogger() },
      "org-2",
      CONVERSA,
    );
    expect(captured).toHaveLength(0);
  });

  it("conversa sem departamento usa a sala do 'sem departamento', sem tratamento especial", async () => {
    const semDepartamento: ConversaFake[] = [
      {
        id: CONVERSA,
        organizationId: ORG,
        whatsappInstanceId: "chip-a",
        departmentId: null,
        assignedUserId: null,
      },
    ];
    const captured: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
    await emitScheduledPending(
      { prisma: fakePrisma(CENARIO, semDepartamento), io: fakeIo(captured), logger: fakeLogger() },
      ORG,
      CONVERSA,
    );
    expect(captured[0]?.rooms).toEqual(["org:org-1", "sup:chip-a:none", "free:chip-a:none"]);
  });
});
