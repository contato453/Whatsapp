import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { GroupParticipant, PrismaClient } from "@azvchat/database";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { registerErrorHandler } from "../src/lib/errors.js";
import { conversationRoutes } from "../src/modules/conversations/routes.js";
import { serializeConversation, serializeGroupParticipant } from "../src/lib/serialize.js";
import {
  phoneFromJid,
  resolveConversationPersonNames,
  upsertPersonProfile,
} from "../src/lib/person-profile.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * O que estes testes fixam sobre a identidade unificada da pessoa:
 *
 * 1. o registro da PESSOA (`PersonProfile`) vence o legado por grupo em TODOS
 *    os grupos de uma vez — inclusive valendo nulo (limpar é decisão);
 * 2. o sync do WhatsApp continua sem sobrescrever o valor da equipe, agora no
 *    nível da pessoa: ele só escreve `name`, e o perfil vence o `name`;
 * 3. a edição pelo lápis grava no registro da pessoa, conta os grupos
 *    afetados, audita com a contagem e avisa cada conversa de grupo na SUA
 *    audiência — nunca a organização inteira;
 * 4. a rota continua recusando participante fora do recorte de acesso;
 * 5. a conversa individual exibe o mesmo nome corrigido (ponte por
 *    identificador e por telefone — e LID nunca vira telefone).
 */

function participante(overrides: Partial<GroupParticipant> = {}): GroupParticipant {
  return {
    id: "p-1",
    groupId: "g-1",
    externalContactId: "123456789012345@lid",
    phoneNumber: "5511999999999",
    name: "Mari",
    customName: null,
    clientRole: null,
    isAdmin: false,
    isSuperAdmin: false,
    avatarUrl: null,
    avatarCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("registro da pessoa x legado por grupo (exibição)", () => {
  it("uma edição, todos os grupos: o perfil vence os legados divergentes", () => {
    // A mesma pessoa em três grupos, com três valores antigos diferentes —
    // o caso que a unificação veio resolver.
    const perfil = { customName: "Dra. Marina", clientRole: "partner" as const };
    const nosGrupos = [
      participante({ id: "p-1", groupId: "g-1", customName: "Marina" }),
      participante({ id: "p-2", groupId: "g-2", customName: "Marina Fiscal" }),
      participante({ id: "p-3", groupId: "g-3", customName: null }),
    ];
    for (const linha of nosGrupos) {
      const dto = serializeGroupParticipant(linha, { profile: perfil });
      expect(dto.name).toBe("Dra. Marina");
      expect(dto.clientRole).toBe("partner");
    }
  });

  it("perfil presente vale MESMO NULO: limpar o nome limpa em todos os grupos", () => {
    const dto = serializeGroupParticipant(participante({ customName: "Nome antigo" }), {
      profile: { customName: null, clientRole: null },
    });
    // Sem nome da equipe, a cadeia segue para o pushName — nunca de volta ao
    // legado do grupo, senão limpar não limparia nada.
    expect(dto.name).toBe("Mari");
    expect(dto.customName).toBeNull();
  });

  it("sem perfil (pessoa em conflito ainda não resolvida), vale o legado do grupo", () => {
    const dto = serializeGroupParticipant(participante({ customName: "Marina Fiscal" }), {
      profile: null,
    });
    expect(dto.name).toBe("Marina Fiscal");
  });

  it("o sync não sobrescreve a equipe: name novo do WhatsApp perde para o perfil", () => {
    // O sync e a ingestão só escrevem `name`/`phoneNumber` — nunca tocam o
    // perfil. Mesmo depois de o WhatsApp trocar o pushName, o nome da equipe
    // continua na tela.
    const depoisDoSync = participante({ name: "Mari Nova do Sync" });
    const dto = serializeGroupParticipant(depoisDoSync, {
      profile: { customName: "Dra. Marina", clientRole: null },
    });
    expect(dto.name).toBe("Dra. Marina");
    expect(dto.whatsappName).toBe("Mari Nova do Sync");
  });

  it("groupCount viaja no DTO para o aviso da tela, com piso 1", () => {
    expect(serializeGroupParticipant(participante(), { groupCount: 5 }).groupCount).toBe(5);
    expect(serializeGroupParticipant(participante()).groupCount).toBe(1);
  });
});

describe("upsertPersonProfile (a escrita da edição)", () => {
  interface Gravado {
    upserts: Array<Record<string, unknown>>;
  }
  let gravado: Gravado;
  beforeEach(() => {
    gravado = { upserts: [] };
  });
  function prismaGravador(): PrismaClient {
    return {
      personProfile: {
        upsert: async (args: Record<string, unknown>) => {
          gravado.upserts.push(args);
          return {};
        },
      },
    } as unknown as PrismaClient;
  }

  it("na criação, o campo NÃO editado é semeado da linha visível na tela", async () => {
    // Renomear alguém que tinha papel marcado não pode apagar o chip de
    // sócio de todos os grupos em silêncio.
    await upsertPersonProfile(
      prismaGravador(),
      "org-1",
      {
        externalContactId: "123@lid",
        phoneNumber: "5511999999999",
        customName: null,
        clientRole: "partner",
      },
      { customName: "Dra. Marina" },
    );
    const create = gravado.upserts[0]?.create as Record<string, unknown>;
    expect(create.customName).toBe("Dra. Marina");
    expect(create.clientRole).toBe("partner");
    expect(create.phoneNumber).toBe("5511999999999");
    // Na atualização, só o campo editado muda — o outro fica como está.
    const update = gravado.upserts[0]?.update as Record<string, unknown>;
    expect(update).toHaveProperty("customName", "Dra. Marina");
    expect(update).not.toHaveProperty("clientRole");
  });

  it("telefone vazio nunca vira ponte nem apaga telefone conhecido", async () => {
    await upsertPersonProfile(
      prismaGravador(),
      "org-1",
      { externalContactId: "123@lid", phoneNumber: "", customName: null, clientRole: null },
      { clientRole: "administrative" },
    );
    const create = gravado.upserts[0]?.create as Record<string, unknown>;
    expect(create.phoneNumber).toBeNull();
    const update = gravado.upserts[0]?.update as Record<string, unknown>;
    expect(update).not.toHaveProperty("phoneNumber");
  });
});

describe("conversa individual com a mesma pessoa", () => {
  const perfis = [
    {
      externalId: "123456789012345@lid",
      phoneNumber: "5511999999999",
      customName: "Dra. Marina",
      updatedAt: new Date("2026-08-18T10:00:00Z"),
    },
  ];
  function prismaComPerfis(): PrismaClient {
    return {
      personProfile: { findMany: async () => perfis },
    } as unknown as PrismaClient;
  }

  it("casa pelo identificador exato e pela ponte de telefone", async () => {
    const nomes = await resolveConversationPersonNames(prismaComPerfis(), "org-1", [
      // Privado pelo MESMO LID do grupo.
      { id: "c-1", type: "individual", externalChatId: "123456789012345@lid" },
      // Privado por telefone, pessoa no grupo por LID: a ponte cobre.
      { id: "c-2", type: "individual", externalChatId: "5511999999999@s.whatsapp.net" },
      // Grupo nunca entra — título de grupo não é nome de pessoa.
      { id: "c-3", type: "group", externalChatId: "120363000@g.us" },
    ]);
    expect(nomes.get("c-1")).toBe("Dra. Marina");
    expect(nomes.get("c-2")).toBe("Dra. Marina");
    expect(nomes.has("c-3")).toBe(false);
  });

  it("o apelido próprio da conversa continua mais forte que o nome da pessoa", () => {
    const conversa = {
      id: "c-1",
      whatsappInstanceId: "i-1",
      externalChatId: "5511999999999@s.whatsapp.net",
      type: "individual",
      title: "Mari",
      customTitle: "Cliente VIP",
      profilePicture: null,
      status: "open",
      assignedUserId: null,
      assignedToAll: false,
      departmentId: null,
      unreadCount: 0,
      archivedAt: null,
      archivedByUserId: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      externalReference: null,
      externalSource: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    type Conversa = Parameters<typeof serializeConversation>[0];
    expect(serializeConversation(conversa as unknown as Conversa, "Dra. Marina").title).toBe(
      "Cliente VIP",
    );
    expect(
      serializeConversation(
        { ...conversa, customTitle: null } as unknown as Conversa,
        "Dra. Marina",
      ).title,
    ).toBe("Dra. Marina");
  });

  it("os dígitos de um LID nunca viram telefone de ponte", () => {
    expect(phoneFromJid("123456789012345@lid")).toBeNull();
    expect(phoneFromJid("5511999999999@s.whatsapp.net")).toBe("5511999999999");
  });
});

// ============================================================
// A rota do lápis: PATCH /group-participants/:id
// ============================================================

const PARTICIPANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Recorded {
  upserts: Array<Record<string, unknown>>;
  participantWhere: Array<Record<string, unknown>>;
  groupParticipantUpdates: Array<Record<string, unknown>>;
  emitted: Array<{ rooms: unknown; event: string; payload: unknown }>;
  auditoria: Array<{ action: string; metadata?: Record<string, unknown> }>;
}
let recorded: Recorded;

beforeEach(() => {
  recorded = {
    upserts: [],
    participantWhere: [],
    groupParticipantUpdates: [],
    emitted: [],
    auditoria: [],
  };
});

/** A pessoa está em TRÊS grupos, cada um com a própria conversa/audiência. */
const participacoes = [
  {
    group: {
      conversationId: "c-g1",
      whatsappInstanceId: "inst-1",
      conversation: { departmentId: "dep-1", assignedUserId: null, whatsappInstanceId: "inst-1" },
    },
  },
  {
    group: {
      conversationId: "c-g2",
      whatsappInstanceId: "inst-1",
      conversation: { departmentId: "dep-2", assignedUserId: "u-9", whatsappInstanceId: "inst-1" },
    },
  },
  {
    group: {
      conversationId: null, // grupo ainda sem conversa vinculada: não emite
      whatsappInstanceId: "inst-1",
      conversation: null,
    },
  },
];

function fakePrisma(opts: { found: boolean }): PrismaClient {
  // O dublê guarda o perfil gravado: depois do upsert, a resolução do nome
  // da conversa individual precisa enxergá-lo — como no banco de verdade.
  let profile: Record<string, unknown> | null = null;
  return {
    rolePermission: rolePermissionStub,
    userWhatsAppInstance: { findMany: async () => [] },
    userDepartment: { findMany: async () => [] },
    groupParticipant: {
      findFirst: async (args: Record<string, unknown>) => {
        recorded.participantWhere.push(args.where as Record<string, unknown>);
        if (!opts.found) return null;
        return {
          id: PARTICIPANT_ID,
          externalContactId: "123456789012345@lid",
          phoneNumber: "5511999999999",
          customName: "Nome antigo",
          clientRole: null,
        };
      },
      findMany: async () => participacoes,
      update: async (args: Record<string, unknown>) => {
        recorded.groupParticipantUpdates.push(args);
        return {};
      },
    },
    personProfile: {
      findUnique: async () => null,
      findMany: async () => (profile ? [profile] : []),
      upsert: async (args: Record<string, unknown>) => {
        recorded.upserts.push(args);
        profile = {
          externalId: "123456789012345@lid",
          phoneNumber: "5511999999999",
          customName: (args.create as Record<string, unknown>).customName,
          clientRole: (args.create as Record<string, unknown>).clientRole,
          updatedAt: new Date(),
        };
        return profile;
      },
    },
    conversation: {
      // A conversa individual da pessoa, achada pela ponte de telefone.
      findMany: async () => [{ id: "c-ind" }],
      findUnique: async () => ({
        id: "c-ind",
        organizationId: "org-1",
        whatsappInstanceId: "inst-1",
        externalChatId: "5511999999999@s.whatsapp.net",
        type: "individual",
        title: "Mari",
        customTitle: null,
        profilePicture: null,
        status: "open",
        assignedUserId: null,
        assignedToAll: false,
        departmentId: null,
        unreadCount: 0,
        archivedAt: null,
        archivedByUserId: null,
        archivedBy: null,
        lastMessageAt: null,
        lastMessagePreview: null,
        externalReference: null,
        externalSource: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        assignedUser: null,
        department: null,
        instance: null,
        tags: [],
      }),
    },
  } as unknown as PrismaClient;
}

function deps(prisma: PrismaClient): AppDeps {
  return {
    prisma,
    io: {
      to: (rooms: unknown) => ({
        emit: (event: string, payload: unknown) => {
          recorded.emitted.push({ rooms, event, payload });
        },
      }),
    },
    audit: {
      record: (entry: { action: string; metadata?: Record<string, unknown> }) => {
        recorded.auditoria.push(entry);
      },
    },
  } as unknown as AppDeps;
}

async function buildApp(prisma: PrismaClient): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await conversationRoutes(app, deps(prisma));
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance): string {
  return app.jwt.sign({
    sub: "user-agent",
    organizationId: "org-1",
    role: "admin",
    name: "Fulana",
    email: "fulana@example.com",
  } as AuthTokenPayload);
}

describe("PATCH /group-participants/:id (edição global)", () => {
  it("grava no registro da PESSOA, nunca mais na linha do grupo, e conta os grupos", async () => {
    const app = await buildApp(fakePrisma({ found: true }));
    const response = await app.inject({
      method: "PATCH",
      url: `/group-participants/${PARTICIPANT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app)}` },
      payload: { customName: "Dra. Marina" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, affectedGroups: 3 });

    // A escrita foi no perfil da pessoa, chaveado por organização +
    // identificador — e NENHUM update na linha do grupo.
    expect(recorded.upserts).toHaveLength(1);
    const where = recorded.upserts[0]?.where as Record<string, Record<string, string>>;
    expect(where.organizationId_externalId).toEqual({
      organizationId: "org-1",
      externalId: "123456789012345@lid",
    });
    expect(recorded.groupParticipantUpdates).toHaveLength(0);

    // Auditoria com a contagem de grupos afetados.
    const auditoria = recorded.auditoria.find((e) => e.action === "group_participant.renamed");
    expect(auditoria?.metadata?.affectedGroups).toBe(3);
    await app.close();
  });

  it("avisa CADA conversa de grupo na própria audiência, e a individual também", async () => {
    const app = await buildApp(fakePrisma({ found: true }));
    await app.inject({
      method: "PATCH",
      url: `/group-participants/${PARTICIPANT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app)}` },
      payload: { customName: "Dra. Marina" },
    });
    const groupEvents = recorded.emitted.filter((e) => e.event === "group:participants");
    // Dois grupos com conversa (o terceiro ainda não tem) — um evento cada,
    // cada um com o conversationId da própria conversa.
    expect(groupEvents.map((e) => (e.payload as { conversationId: string }).conversationId)).toEqual(
      ["c-g1", "c-g2"],
    );
    // Cada evento saiu para a audiência DA PRÓPRIA conversa (departamento e
    // responsável dela) — a unificação não vira um canal que fura o recorte.
    expect(groupEvents[0]?.rooms).toContain("sup:inst-1:dep-1");
    expect(groupEvents[0]?.rooms).toContain("free:inst-1:dep-1");
    expect(groupEvents[1]?.rooms).toContain("sup:inst-1:dep-2");
    expect(groupEvents[1]?.rooms).toContain("mine:inst-1:dep-2:u-9");
    // A conversa individual da pessoa recebeu o DTO novo, já com o nome.
    const updated = recorded.emitted.find((e) => e.event === "conversation:updated");
    expect((updated?.payload as { title: string }).title).toBe("Dra. Marina");
    await app.close();
  });

  it("participante fora do recorte de acesso é 404 e nada é gravado", async () => {
    const app = await buildApp(fakePrisma({ found: false }));
    const response = await app.inject({
      method: "PATCH",
      url: `/group-participants/${PARTICIPANT_ID}`,
      headers: { authorization: `Bearer ${tokenFor(app)}` },
      payload: { customName: "Dra. Marina" },
    });
    expect(response.statusCode).toBe(404);
    expect(recorded.upserts).toHaveLength(0);
    // A consulta levou o recorte junto: organização E escopo de grupo.
    const where = recorded.participantWhere[0] as { group: Record<string, unknown> };
    expect(where.group.organizationId).toBe("org-1");
    await app.close();
  });
});
