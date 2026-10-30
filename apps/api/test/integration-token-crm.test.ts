import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { registerIntegrationTokenAdminRoutes } from "../src/modules/integrations/message-api.js";
import type { AppDeps } from "../src/types.js";

/**
 * Destino no CRM gravado no token (Configurações → Tokens de integração).
 *
 * Os riscos: gravar etapa de OUTRO funil (o card nasceria numa coluna que não
 * existe no quadro), gravar funil de outra organização, e trocar o funil
 * deixando a etapa antiga pendurada. E só admin mexe.
 */

const ORG = "org-1";
const ADMIN: AuthTokenPayload = { sub: "admin-1", organizationId: ORG, role: "admin", name: "Admin", email: "a@x" };
const SUPERVISOR: AuthTokenPayload = { sub: "sup-1", organizationId: ORG, role: "supervisor", name: "Sup", email: "s@x" };
const TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const PIPE_A = "22222222-2222-4222-8222-222222222222";
const STAGE_A1 = "33333333-3333-4333-8333-333333333333";
const STAGE_A2 = "44444444-4444-4444-8444-444444444444";
const PIPE_B = "55555555-5555-4555-8555-555555555555";
const STAGE_B1 = "66666666-6666-4666-8666-666666666666";

interface TokenRow {
  id: string;
  organizationId: string;
  name: string;
  tokenPrefix: string;
  whatsappInstanceId: string;
  active: boolean;
  lastUsedAt: Date | null;
  usageCount: number;
  crmPipelineId: string | null;
  crmStageId: string | null;
  createdAt: Date;
}

let app: FastifyInstance;
let row: TokenRow;
let audits: Array<{ action: string; metadata?: unknown }>;
let sign: (user: AuthTokenPayload) => string;

const pipelines: Record<string, { organizationId: string; name: string; stages: { id: string; name: string }[] }> = {
  [PIPE_A]: {
    organizationId: ORG,
    name: "Comercial",
    stages: [
      { id: STAGE_A1, name: "Novo lead" },
      { id: STAGE_A2, name: "Inscrito no workshop" },
    ],
  },
  [PIPE_B]: { organizationId: ORG, name: "Pós-venda", stages: [{ id: STAGE_B1, name: "Onboarding" }] },
};

beforeEach(async () => {
  audits = [];
  row = {
    id: TOKEN_ID,
    organizationId: ORG,
    name: "Site workshop",
    tokenPrefix: "azv_abc",
    whatsappInstanceId: "inst-1",
    active: true,
    lastUsedAt: null,
    usageCount: 0,
    crmPipelineId: null,
    crmStageId: null,
    createdAt: new Date("2026-10-01T12:00:00Z"),
  };
  const withNames = () => {
    const pipeline = row.crmPipelineId ? pipelines[row.crmPipelineId] : null;
    const stage = pipeline?.stages.find((item) => item.id === row.crmStageId) ?? null;
    return {
      ...row,
      instance: { name: "Comercial EP" },
      crmPipeline: pipeline ? { name: pipeline.name } : null,
      crmStage: stage ? { name: stage.name } : null,
    };
  };
  const prisma = {
    integrationToken: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        where.id === row.id && where.organizationId === row.organizationId ? row : null,
      update: async ({ data }: { data: Partial<TokenRow> }) => {
        row = { ...row, ...data };
        return withNames();
      },
    },
    crmPipeline: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => {
        const pipeline = pipelines[where.id];
        return pipeline && pipeline.organizationId === where.organizationId
          ? { stages: pipeline.stages.map((stage) => ({ id: stage.id })) }
          : null;
      },
    },
  } as unknown as PrismaClient;

  app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste-com-tamanho-suficiente" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  registerIntegrationTokenAdminRoutes(app, {
    prisma,
    audit: { record: (entry: { action: string; metadata?: unknown }) => audits.push(entry) },
  } as unknown as AppDeps);
  await app.ready();
  sign = (user) => app.jwt.sign(user);
});

afterEach(async () => {
  await app.close();
});

function patch(body: Record<string, unknown>, user: AuthTokenPayload = ADMIN) {
  return app.inject({
    method: "PATCH",
    url: `/integration-tokens/${TOKEN_ID}`,
    headers: { authorization: `Bearer ${sign(user)}` },
    payload: body,
  });
}

describe("PATCH /integration-tokens/:id — destino no CRM", () => {
  it("grava funil e etapa, devolve os nomes e audita antes/depois", async () => {
    const res = await patch({ crmPipelineId: PIPE_A, crmStageId: STAGE_A2 });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrationToken).toMatchObject({
      crmPipelineId: PIPE_A,
      crmPipelineName: "Comercial",
      crmStageId: STAGE_A2,
      crmStageName: "Inscrito no workshop",
    });
    expect(audits[0]).toMatchObject({
      action: "integration_token.updated",
      metadata: { before: { crmPipelineId: null }, after: { crmPipelineId: PIPE_A, crmStageId: STAGE_A2 } },
    });
  });

  it("etapa de OUTRO funil é recusada e nada é gravado", async () => {
    const res = await patch({ crmPipelineId: PIPE_A, crmStageId: STAGE_B1 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("etapa_invalida");
    expect(row.crmPipelineId).toBeNull();
  });

  it("funil que não existe na organização é 404", async () => {
    const res = await patch({ crmPipelineId: "77777777-7777-4777-8777-777777777777" });
    expect(res.statusCode).toBe(404);
  });

  it("trocar de funil sem dizer a etapa zera a etapa antiga", async () => {
    await patch({ crmPipelineId: PIPE_A, crmStageId: STAGE_A2 });
    const res = await patch({ crmPipelineId: PIPE_B });
    expect(res.statusCode).toBe(200);
    expect(row).toMatchObject({ crmPipelineId: PIPE_B, crmStageId: null });
  });

  it("limpar o funil desliga o CRM do token (etapa junto)", async () => {
    await patch({ crmPipelineId: PIPE_A, crmStageId: STAGE_A1 });
    const res = await patch({ crmPipelineId: null });
    expect(res.statusCode).toBe(200);
    expect(row).toMatchObject({ crmPipelineId: null, crmStageId: null });
  });

  it("renomear não mexe no destino", async () => {
    await patch({ crmPipelineId: PIPE_A, crmStageId: STAGE_A1 });
    await patch({ name: "Formulário do workshop" });
    expect(row).toMatchObject({ name: "Formulário do workshop", crmPipelineId: PIPE_A, crmStageId: STAGE_A1 });
  });

  it("quem não é admin é recusado", async () => {
    const res = await patch({ crmPipelineId: PIPE_A }, SUPERVISOR);
    expect(res.statusCode).toBe(403);
    expect(row.crmPipelineId).toBeNull();
  });
});
