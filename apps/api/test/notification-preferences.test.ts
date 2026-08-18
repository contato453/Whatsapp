import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient, User } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { serializeUser, serializeUserDirectory } from "../src/lib/serialize.js";
import { authRoutes } from "../src/modules/auth/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * O que estes testes fixam: som e volume de notificação são preferência
 * pessoal, gravada pelo mesmo caminho de `signMessages`, com enum fechado —
 * e que elas não escapam no usuário visto por terceiros.
 *
 * Texto livre aqui viraria valor inválido no banco e som que não toca sem
 * ninguém entender por quê.
 */

const ORG = "org-1";

let stored: User;

function fakeUser(): User {
  return {
    id: "user-1",
    organizationId: ORG,
    name: "Fulano de Tal",
    email: "fulano@example.com",
    passwordHash: "$2a$10$hash",
    role: "agent",
    status: "active",
    avatarUrl: null,
    signMessages: false,
    notificationSound: "sound_1",
    notificationVolume: "medium",
    lastLoginAt: new Date("2026-01-01T10:00:00Z"),
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
  } as unknown as User;
}

function fakePrisma(): PrismaClient {
  return {
    rolePermission: rolePermissionStub,
    user: {
      findUnique: async () => stored,
      update: async ({ data }: { data: Partial<User> }) => {
        stored = { ...stored, ...data };
        return stored;
      },
    },
  } as unknown as PrismaClient;
}

function fakeDeps(): AppDeps {
  return {
    prisma: fakePrisma(),
    config: { JWT_EXPIRES_IN: "7d" },
    audit: { record: () => undefined },
  } as unknown as AppDeps;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  // O verificador real vai ao banco; aqui o token já é o estado atual,
  // porque o que está em teste é a validação do corpo.
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await authRoutes(app, fakeDeps());
  await app.ready();
  return app;
}

function token(app: FastifyInstance): string {
  return app.jwt.sign({
    sub: "user-1",
    organizationId: ORG,
    role: "agent",
    name: "Fulano de Tal",
    email: "fulano@example.com",
  });
}

async function patchProfile(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PATCH",
    url: "/auth/me",
    headers: { authorization: `Bearer ${token(app)}` },
    payload,
  });
}

describe("PATCH /auth/me — preferências de som", () => {
  beforeEach(() => {
    stored = fakeUser();
  });

  it("grava som e volume válidos e devolve o usuário atualizado", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, {
      notificationSound: "sound_2",
      notificationVolume: "high",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.notificationSound).toBe("sound_2");
    expect(response.json().user.notificationVolume).toBe("high");
    expect(stored.notificationSound).toBe("sound_2");
    expect(stored.notificationVolume).toBe("high");
    await app.close();
  });

  it("aceita o silêncio escolhido de propósito", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, { notificationSound: "none" });
    expect(response.statusCode).toBe(200);
    expect(stored.notificationSound).toBe("none");
    // Volume não informado continua como estava — nada de zerar por tabela.
    expect(stored.notificationVolume).toBe("medium");
    await app.close();
  });

  it("recusa som fora do enum, sem gravar nada", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, { notificationSound: "sirene" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(stored.notificationSound).toBe("sound_1");
    await app.close();
  });

  it("recusa volume fora do enum, sem gravar nada", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, { notificationVolume: "altissimo" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(stored.notificationVolume).toBe("medium");
    await app.close();
  });

  it("recusa número no lugar do enum — nada de aceitar índice", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, { notificationSound: 2 });
    expect(response.statusCode).toBe(400);
    expect(stored.notificationSound).toBe("sound_1");
    await app.close();
  });

  it("não mexe nas preferências quando o corpo só traz o nome", async () => {
    const app = await buildTestApp();
    const response = await patchProfile(app, { name: "Outro Nome" });
    expect(response.statusCode).toBe(200);
    expect(stored.name).toBe("Outro Nome");
    expect(stored.notificationSound).toBe("sound_1");
    expect(stored.notificationVolume).toBe("medium");
    await app.close();
  });
});

describe("preferências de som na serialização", () => {
  it("saem para o próprio dono, em /auth/me", () => {
    const serialized = serializeUser(fakeUser());
    expect(serialized.notificationSound).toBe("sound_1");
    expect(serialized.notificationVolume).toBe("medium");
  });

  it("nunca aparecem no usuário visto por terceiros", () => {
    const serialized = serializeUserDirectory(fakeUser()) as Record<string, unknown>;
    expect(serialized).not.toHaveProperty("notificationSound");
    expect(serialized).not.toHaveProperty("notificationVolume");
  });
});
