import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import pino from "pino";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import { broadcastRoutes } from "../src/modules/broadcast/routes.js";
import type { AppDeps } from "../src/types.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * DUPLICAR é o "editar" de campanha que já saiu do rascunho. O que estes
 * casos trancam:
 *
 *   1. a cópia nasce RASCUNHO, sem entrega, sem horário marcado e sem motivo
 *      de pausa — e com mensagem, variações, audiência, número e ritmo iguais;
 *   2. a ORIGINAL não muda: o histórico dela (o texto exato que saiu) é o
 *      motivo de ela não se editar, e continua `campaign_locked` no PATCH;
 *   3. campanha de outra organização responde 404, nunca vira cópia aqui.
 */

const ORG = "org-1";
const OUTRA = "org-2";

async function montar(db: MemoryPrisma): Promise<{ app: FastifyInstance; token: (u: AuthTokenPayload) => string }> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste-com-tamanho-suficiente" });
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  const deps = {
    prisma: db.client(),
    logger: pino({ level: "silent" }),
    audit: { record: () => undefined },
    io: { to: () => ({ emit: () => undefined }) },
    provider: {},
    ingest: {},
  } as unknown as AppDeps;
  await broadcastRoutes(app, deps);
  await app.ready();
  return { app, token: (u) => app.jwt.sign(u) };
}

function semear(db: MemoryPrisma, org: string) {
  const audienceId = db.seed("broadcastAudience", { organizationId: org, name: "Teste de Lincoln" }).id as string;
  const instanceId = db.seed("whatsAppInstance", { organizationId: org, name: "CHIP COMERCIAL", status: "connected" }).id as string;
  const adminId = db.seed("user", { organizationId: org, name: "Admin", role: "admin", status: "active" }).id as string;
  const campaignId = db.seed("broadcastCampaign", {
    organizationId: org,
    name: "Campanha teste",
    status: "canceled",
    pausedReason: "manual",
    audienceId,
    whatsappInstanceId: instanceId,
    message: "Olá {{primeiro_nome}}",
    messageVariants: ["Oi {{primeiro_nome}}"],
    scheduledFor: new Date("2026-01-01T12:00:00Z"),
    minIntervalSeconds: 10,
    maxIntervalSeconds: 40,
    dailyLimit: 150,
    respectBusinessHours: false,
    consecutiveFailures: 3,
    crmMode: "never",
    crmPipelineId: null,
    crmStageId: null,
    tagId: null,
    createdById: adminId,
  }).id as string;
  db.seed("broadcastDelivery", { campaignId, status: "skipped", phone: "5511999998888" });
  return { audienceId, instanceId, adminId, campaignId };
}

describe("duplicar campanha", () => {
  let db: MemoryPrisma;
  let app: FastifyInstance;
  let token: (u: AuthTokenPayload) => string;
  let A: ReturnType<typeof semear>;
  let B: ReturnType<typeof semear>;

  beforeEach(async () => {
    db = new MemoryPrisma();
    A = semear(db, ORG);
    B = semear(db, OUTRA);
    ({ app, token } = await montar(db));
  });

  const headers = () => ({
    authorization: `Bearer ${token({ sub: A.adminId, organizationId: ORG, role: "admin", name: "Admin", email: "a@x" })}`,
  });

  it("cria um rascunho novo com a mesma configuração e deixa a original intacta", async () => {
    const resposta = await app.inject({
      method: "POST",
      url: `/broadcast/campaigns/${A.campaignId}/duplicate`,
      headers: headers(),
    });
    expect(resposta.statusCode).toBe(201);
    const copia = resposta.json().campaign;
    expect(copia.id).not.toBe(A.campaignId);
    expect(copia.status).toBe("draft");
    expect(copia.name).toBe("Campanha teste (cópia)");
    expect(copia.counts.total).toBe(0);

    const gravada = await db.client().broadcastCampaign.findFirst({ where: { id: copia.id } });
    expect(gravada).toMatchObject({
      organizationId: ORG,
      audienceId: A.audienceId,
      whatsappInstanceId: A.instanceId,
      message: "Olá {{primeiro_nome}}",
      messageVariants: ["Oi {{primeiro_nome}}"],
      minIntervalSeconds: 10,
      maxIntervalSeconds: 40,
      dailyLimit: 150,
      respectBusinessHours: false,
      crmMode: "never",
      scheduledFor: null,
    });
    expect(gravada?.pausedReason ?? null).toBeNull();
    expect(gravada?.consecutiveFailures ?? 0).toBe(0);

    const original = await db.client().broadcastCampaign.findFirst({ where: { id: A.campaignId } });
    expect(original?.status).toBe("canceled");
    const entregasDaCopia = await db.client().broadcastDelivery.count({ where: { campaignId: copia.id } });
    expect(entregasDaCopia).toBe(0);
  });

  it("a original continua travada para edição", async () => {
    const resposta = await app.inject({
      method: "PATCH",
      url: `/broadcast/campaigns/${A.campaignId}`,
      headers: headers(),
      payload: { message: "outro texto" },
    });
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json().code ?? resposta.json().error).toBe("campaign_locked");
  });

  it("campanha de outra organização não vira cópia", async () => {
    const resposta = await app.inject({
      method: "POST",
      url: `/broadcast/campaigns/${B.campaignId}/duplicate`,
      headers: headers(),
    });
    expect(resposta.statusCode).toBe(404);
  });
});
