import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import {
  UNREAD_COUNT_CAP,
  loadUnreadCounts,
  markConversationRead,
  markConversationUnread,
  unreadConversationWhere,
} from "../src/lib/conversation-reads.js";
import type { AppDeps } from "../src/types.js";

/**
 * O que estes testes fixam sobre a leitura POR USUÁRIO:
 *
 * 1. duas pessoas na mesma conversa têm contadores independentes — a
 *    consulta leva a marca de cada uma;
 * 2. marcar como lida escreve SÓ na linha de quem leu, e o aviso de leitura
 *    vai só para as abas dela (nunca para a audiência da conversa — esse era
 *    o bug: o supervisor abrindo apagava o aviso do atendente);
 * 3. só mensagem RECEBIDA conta: enviada, apagada e nota interna ficam de
 *    fora (nota interna nem mora na tabela de mensagens);
 * 4. a marca nunca retrocede sozinha — reler mensagem antiga não faz a
 *    conversa voltar a ter não lidas; recuar é ação explícita.
 */

const CONV_ID = "33333333-3333-4333-8333-333333333333";
const OUTRA_CONV = "55555555-5555-4555-8555-555555555555";
const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Recorded {
  rawQueries: Array<{ sql: string; values: unknown[] }>;
  readFindMany: Array<Record<string, unknown>>;
  readUpdateMany: Array<Record<string, unknown>>;
  readCreates: Array<Record<string, unknown>>;
  readUpserts: Array<Record<string, unknown>>;
  emits: Array<{ room: string; event: string; payload: unknown }>;
}

let recorded: Recorded;

/** A carga JSON da página, entre os parâmetros da consulta crua. */
function pageOf(index: number): Array<{ conversation_id: string; since: string | null }> {
  const raw = recorded.rawQueries[index]?.values.find(
    (value) => typeof value === "string" && value.startsWith("["),
  );
  return JSON.parse(String(raw));
}

beforeEach(() => {
  recorded = {
    rawQueries: [],
    readFindMany: [],
    readUpdateMany: [],
    readCreates: [],
    readUpserts: [],
    emits: [],
  };
});

/** Última mensagem da conversa; `null` = conversa sem mensagem nenhuma. */
interface FakeOptions {
  marks?: Array<{ conversationId: string; lastReadAt: Date }>;
  lastMessage?: { id: string; timestamp: Date } | null;
  lastInbound?: { timestamp: Date } | null;
  updatedRows?: number;
  createThrows?: boolean;
  unreadRows?: Array<{ conversationId: string; unread: number }>;
}

function fakePrisma(options: FakeOptions = {}): PrismaClient {
  return {
    userWhatsAppInstance: { findMany: async () => [] },
    userDepartment: { findMany: async () => [] },
    conversation: {
      findFirst: async () => ({
        id: CONV_ID,
        organizationId: "org-1",
        whatsappInstanceId: "44444444-4444-4444-8444-444444444444",
        departmentId: null,
        assignedUserId: null,
        archivedAt: null,
        type: "individual",
        title: "Cliente",
        customTitle: null,
        profilePicture: null,
        status: "open",
        assignedToAll: false,
        externalChatId: "5511999@s.whatsapp.net",
        externalReference: null,
        externalSource: null,
        lastMessageAt: new Date(),
        lastMessagePreview: null,
        archivedByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        assignedUser: null,
        department: null,
        instance: null,
        archivedBy: null,
        tags: [],
      }),
    },
    conversationRead: {
      findMany: async (args: Record<string, unknown>) => {
        recorded.readFindMany.push(args);
        return options.marks ?? [];
      },
      updateMany: async (args: Record<string, unknown>) => {
        recorded.readUpdateMany.push(args);
        return { count: options.updatedRows ?? 0 };
      },
      create: async (args: Record<string, unknown>) => {
        recorded.readCreates.push(args);
        if (options.createThrows) throw Object.assign(new Error("unique"), { code: "P2002" });
        return args.data;
      },
      upsert: async (args: Record<string, unknown>) => {
        recorded.readUpserts.push(args);
        return args.create;
      },
    },
    message: {
      findFirst: async (args: Record<string, unknown>) => {
        const where = args.where as Record<string, unknown>;
        // A consulta da marca de leitura pega a última mensagem de qualquer
        // direção; a de "marcar como não lida" filtra `inbound`.
        if (where.direction === "inbound") return options.lastInbound ?? null;
        return options.lastMessage ?? null;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.rawQueries.push({ sql: strings.join("?"), values });
      return options.unreadRows ?? [];
    },
  } as unknown as PrismaClient;
}

describe("contagem de não lidas por usuário", () => {
  it("leva a marca de CADA pessoa: a mesma conversa conta diferente para cada uma", async () => {
    const anaLeuAgora = new Date("2026-08-18T12:00:00.000Z");
    const prismaAna = fakePrisma({
      marks: [{ conversationId: CONV_ID, lastReadAt: anaLeuAgora }],
      unreadRows: [{ conversationId: CONV_ID, unread: 0 }],
    });
    const daAna = await loadUnreadCounts(prismaAna, ANA, [CONV_ID]);
    expect(daAna.get(CONV_ID)).toBe(0);
    expect((recorded.readFindMany[0]?.where as Record<string, unknown>).userId).toBe(ANA);
    expect(pageOf(0)[0]?.since).toBe(anaLeuAgora.toISOString());

    // Bruno nunca abriu a conversa: sem linha, a marca vai nula e tudo o que
    // o cliente mandou continua por ler para ele.
    const prismaBruno = fakePrisma({
      marks: [],
      unreadRows: [{ conversationId: CONV_ID, unread: 4 }],
    });
    const doBruno = await loadUnreadCounts(prismaBruno, BRUNO, [CONV_ID]);
    expect(doBruno.get(CONV_ID)).toBe(4);
    expect(pageOf(1)[0]?.since).toBeNull();
  });

  it("é UMA consulta para a página inteira, nunca uma por conversa", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `conversa-${index}`);
    await loadUnreadCounts(fakePrisma(), ANA, ids);
    expect(recorded.readFindMany).toHaveLength(1);
    expect(recorded.rawQueries).toHaveLength(1);
    expect(pageOf(0)).toHaveLength(50);
  });

  it("sem conversa nenhuma não consulta o banco", async () => {
    const counts = await loadUnreadCounts(fakePrisma(), ANA, []);
    expect(counts.size).toBe(0);
    expect(recorded.rawQueries).toHaveLength(0);
    expect(recorded.readFindMany).toHaveLength(0);
  });

  it("só conta mensagem recebida, viva, de conversa não arquivada — e para no teto", async () => {
    await loadUnreadCounts(fakePrisma(), ANA, [CONV_ID]);
    const sql = recorded.rawQueries[0]?.sql ?? "";
    // Enviada pela equipe não conta...
    expect(sql).toContain(`m."direction" = 'inbound'`);
    // ...apagada também não...
    expect(sql).toContain(`m."deletedAt" IS NULL`);
    // ...e conversa arquivada não conta para ninguém.
    expect(sql).toContain(`c."archivedAt" IS NULL`);
    // Nota interna não é mensagem: a consulta só olha a tabela de mensagens.
    expect(sql).not.toContain("internal_notes");
    // O badge mostra "99+": contar além do centésimo não muda um pixel.
    expect(recorded.rawQueries[0]?.values).toContain(UNREAD_COUNT_CAP);
    expect(UNREAD_COUNT_CAP).toBe(100);
  });

  it("o filtro Não lidas exige mensagem recebida e exclui o que a pessoa já leu", () => {
    expect(unreadConversationWhere([CONV_ID])).toEqual({
      messages: { some: { direction: "inbound", deletedAt: null } },
      id: { notIn: [CONV_ID] },
    });
    // Quem nunca leu nada não gera exclusão nenhuma.
    expect(unreadConversationWhere([])).toEqual({
      messages: { some: { direction: "inbound", deletedAt: null } },
    });
  });
});

describe("marcar como lida", () => {
  const ultima = { id: "msg-9", timestamp: new Date("2026-08-18T12:00:00.000Z") };

  it("escreve só na linha de quem leu, e avança até a última mensagem", async () => {
    const prisma = fakePrisma({ lastMessage: ultima, updatedRows: 1 });
    await markConversationRead(prisma, {
      organizationId: "org-1",
      conversationId: CONV_ID,
      userId: ANA,
    });
    const where = recorded.readUpdateMany[0]?.where as Record<string, unknown>;
    expect(where.userId).toBe(ANA);
    expect(where.conversationId).toBe(CONV_ID);
    const data = recorded.readUpdateMany[0]?.data as Record<string, unknown>;
    expect(data.lastReadAt).toEqual(ultima.timestamp);
    expect(data.lastReadMessageId).toBe("msg-9");
    // Uma linha atualizada: nada de criar em duplicidade.
    expect(recorded.readCreates).toHaveLength(0);
  });

  it("A MARCA NUNCA RETROCEDE SOZINHA: só avança quando a atual é mais velha", async () => {
    const prisma = fakePrisma({ lastMessage: ultima, updatedRows: 0, createThrows: true });
    await markConversationRead(prisma, {
      organizationId: "org-1",
      conversationId: CONV_ID,
      userId: ANA,
    });
    // A condição do update é o que garante a regra: marca igual ou à frente
    // não casa, e a linha fica como está. É o caso de quem rola para cima e
    // relê mensagens antigas — a conversa não volta a ter não lidas.
    const where = recorded.readUpdateMany[0]?.where as Record<string, unknown>;
    expect(where.lastReadAt).toEqual({ lt: ultima.timestamp });
    // Nenhuma linha casou: tenta criar, e a duplicidade (corrida entre duas
    // abas) é engolida em vez de derrubar a requisição.
    expect(recorded.readCreates).toHaveLength(1);
  });

  it("primeira leitura cria a linha — ninguém é semeado antes de ler", async () => {
    const prisma = fakePrisma({ lastMessage: ultima, updatedRows: 0 });
    await markConversationRead(prisma, {
      organizationId: "org-1",
      conversationId: CONV_ID,
      userId: BRUNO,
    });
    const data = recorded.readCreates[0]?.data as Record<string, unknown>;
    expect(data.userId).toBe(BRUNO);
    expect(data.conversationId).toBe(CONV_ID);
    expect(data.lastReadAt).toEqual(ultima.timestamp);
  });

  it("conversa sem mensagem nenhuma não gasta escrita", async () => {
    const prisma = fakePrisma({ lastMessage: null });
    await markConversationRead(prisma, {
      organizationId: "org-1",
      conversationId: CONV_ID,
      userId: ANA,
    });
    expect(recorded.readUpdateMany).toHaveLength(0);
    expect(recorded.readCreates).toHaveLength(0);
  });
});

describe("marcar como NÃO lida (recuo explícito)", () => {
  it("recua para logo antes da última recebida, e só para quem pediu", async () => {
    const recebida = new Date("2026-08-18T12:00:00.000Z");
    const prisma = fakePrisma({ lastInbound: { timestamp: recebida } });
    await markConversationUnread(prisma, {
      organizationId: "org-1",
      conversationId: CONV_ID,
      userId: ANA,
    });
    const upsert = recorded.readUpserts[0] as Record<string, unknown>;
    expect((upsert.where as { userId_conversationId: { userId: string } }).userId_conversationId.userId).toBe(ANA);
    const update = upsert.update as { lastReadAt: Date };
    // Um milissegundo antes: a conversa volta com UMA não lida, e não com o
    // histórico inteiro por ler.
    expect(update.lastReadAt.getTime()).toBe(recebida.getTime() - 1);
  });

  it("sem mensagem recebida não há o que marcar", async () => {
    const prisma = fakePrisma({ lastInbound: null });
    await markConversationUnread(prisma, {
      organizationId: "org-1",
      conversationId: OUTRA_CONV,
      userId: ANA,
    });
    expect(recorded.readUpserts).toHaveLength(0);
  });
});

describe("POST /conversations/:id/read e /unread", () => {
  function depsWith(prisma: PrismaClient): AppDeps {
    return {
      prisma,
      io: {
        to: (room: string) => ({
          emit: (event: string, payload: unknown) => {
            recorded.emits.push({ room, event, payload });
          },
        }),
      },
      audit: { record: () => undefined },
    } as unknown as AppDeps;
  }

  async function buildApp(prisma: PrismaClient): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(jwt, { secret: "segredo-de-teste" });
    app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
    registerErrorHandler(app);
    await conversationRoutes(app, depsWith(prisma));
    await app.ready();
    return app;
  }

  function tokenFor(app: FastifyInstance, sub: string, role: AuthTokenPayload["role"]): string {
    return app.jwt.sign({
      sub,
      organizationId: "org-1",
      role,
      name: "Fulano de Tal",
      email: "fulano@example.com",
    });
  }

  it("o supervisor abrindo NÃO apaga o aviso do atendente", async () => {
    const prisma = fakePrisma({
      lastMessage: { id: "msg-9", timestamp: new Date("2026-08-18T12:00:00.000Z") },
      updatedRows: 1,
      unreadRows: [{ conversationId: CONV_ID, unread: 0 }],
    });
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/read`,
      headers: { authorization: `Bearer ${tokenFor(app, ANA, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);

    // A escrita carrega o usuário: a marca do Bruno não é tocada.
    expect((recorded.readUpdateMany[0]?.where as Record<string, unknown>).userId).toBe(ANA);
    // E o aviso vai SÓ para as abas de quem leu. Nenhum `conversation:updated`
    // sai daqui: era ele que zerava o badge de todo mundo.
    expect(recorded.emits).toHaveLength(1);
    expect(recorded.emits[0]?.room).toBe(`user:${ANA}`);
    expect(recorded.emits[0]?.event).toBe("conversation:read");
    expect(recorded.emits[0]?.payload).toEqual({ conversationId: CONV_ID, unreadCount: 0 });
    await app.close();
  });

  it("marcar como não lida devolve o contador e avisa só as abas da pessoa", async () => {
    const prisma = fakePrisma({
      lastInbound: { timestamp: new Date("2026-08-18T12:00:00.000Z") },
      unreadRows: [{ conversationId: CONV_ID, unread: 1 }],
    });
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${CONV_ID}/unread`,
      headers: { authorization: `Bearer ${tokenFor(app, BRUNO, "agent")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, unreadCount: 1 });
    expect(recorded.emits[0]?.room).toBe(`user:${BRUNO}`);
    await app.close();
  });

  it("id que não é uuid é recusado pelo Zod antes de qualquer escrita", async () => {
    const app = await buildApp(fakePrisma());
    const response = await app.inject({
      method: "POST",
      url: "/conversations/nao-e-uuid/read",
      headers: { authorization: `Bearer ${tokenFor(app, ANA, "agent")}` },
    });
    expect(response.statusCode).toBe(400);
    expect(recorded.readUpdateMany).toHaveLength(0);
    await app.close();
  });
});
