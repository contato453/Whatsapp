import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@azvchat/database";
import {
  accessibleConversationWhere,
  findAccessibleConversation,
} from "../src/lib/conversation-access.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

/**
 * A porta de entrada de qualquer módulo que chega a uma conversa pelo id —
 * inclusive a integração com o Azevedo-OS.
 *
 * O que estes testes protegem: o recorte vem de `access.ts`, e não de um
 * `where` montado à mão. Sem isso, uma rota nova de integração viraria o
 * caminho por onde se lê a conversa de um número que a pessoa não enxerga.
 */

const NUMERO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NUMERO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEPARTAMENTO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function usuario(role: AuthTokenPayload["role"]): AuthTokenPayload {
  return {
    sub: "user-1",
    organizationId: "org-1",
    role,
    name: "Fulano",
    email: "fulano@exemplo.com",
  };
}

/**
 * Prisma de mentira. A consulta de conversa devolve a linha só quando o
 * `where` recebido permite o número dela — é exatamente o filtro que
 * `conversationScope` monta e que a rota não pode deixar de aplicar.
 */
function fakePrisma(conversaNoNumero: string, vinculos: string[]) {
  const findFirst = vi.fn(async ({ where }: { where: Prisma.ConversationWhereInput }) => {
    const filtros = (where.AND ?? []) as Prisma.ConversationWhereInput[];
    const permitido = filtros.every((filtro) => {
      const instancia = filtro.whatsappInstanceId;
      if (instancia && typeof instancia === "object" && "in" in instancia) {
        return (instancia.in as string[]).includes(conversaNoNumero);
      }
      return true;
    });
    return permitido ? { id: CONVERSA, whatsappInstanceId: conversaNoNumero } : null;
  });
  return {
    findFirst,
    prisma: {
      conversation: { findFirst },
      userWhatsAppInstance: {
        findMany: async () => vinculos.map((id) => ({ whatsappInstanceId: id })),
      },
      userDepartment: {
        findMany: async () => [{ departmentId: DEPARTAMENTO }],
      },
    } as unknown as PrismaClient,
  };
}

describe("where da conversa acessível", () => {
  it("supervisor: carrega organização, números e departamentos do login", async () => {
    const { prisma } = fakePrisma(NUMERO_A, [NUMERO_A]);
    const where = await accessibleConversationWhere(prisma, usuario("supervisor"), CONVERSA);

    expect(where.id).toBe(CONVERSA);
    expect(where.organizationId).toBe("org-1");
    expect(where.AND).toEqual([
      { whatsappInstanceId: { in: [NUMERO_A] } },
      { OR: [{ departmentId: null }, { departmentId: { in: [DEPARTAMENTO] } }] },
    ]);
  });

  it("agent também fica preso ao próprio atendimento (ou ao que está sem responsável)", async () => {
    const { prisma } = fakePrisma(NUMERO_A, [NUMERO_A]);
    const where = await accessibleConversationWhere(prisma, usuario("agent"), CONVERSA);

    expect(where.AND).toContainEqual({
      OR: [{ assignedUserId: "user-1" }, { assignedUserId: null }],
    });
  });

  it("admin não recebe filtro de recorte", async () => {
    const { prisma } = fakePrisma(NUMERO_A, []);
    const where = await accessibleConversationWhere(prisma, usuario("admin"), CONVERSA);

    expect(where.AND).toBeUndefined();
  });
});

describe("buscar a conversa pelo id", () => {
  it("supervisor com o número vinculado encontra", async () => {
    const { prisma } = fakePrisma(NUMERO_A, [NUMERO_A]);
    await expect(
      findAccessibleConversation(prisma, usuario("supervisor"), CONVERSA),
    ).resolves.toMatchObject({ id: CONVERSA });
  });

  it("supervisor sem o número não encontra — 404, como se não existisse", async () => {
    const { prisma } = fakePrisma(NUMERO_A, [NUMERO_B]);
    const erro = await findAccessibleConversation(prisma, usuario("supervisor"), CONVERSA).catch(
      (err: unknown) => err,
    );
    expect(erro).toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("usuário sem número nenhum marcado não enxerga conversa alguma", async () => {
    const { prisma } = fakePrisma(NUMERO_A, []);
    await expect(
      findAccessibleConversation(prisma, usuario("agent"), CONVERSA),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
