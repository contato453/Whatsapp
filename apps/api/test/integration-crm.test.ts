import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import { openIntegrationOpportunity } from "../src/lib/integration-crm.js";
import { clearOrganizationFeaturesCache } from "../src/lib/organization-features.js";
import type { createCrmOpportunity } from "../src/lib/crm-opportunity.js";

/**
 * Card no CRM para quem chega pela API de integração (o formulário do site).
 *
 * O risco que estes testes trancam é o envio quebrar por causa do CRM: a
 * mensagem já saiu quando esta função roda, então ela NUNCA lança — todo
 * motivo de não abrir o card vira um status. E as regras do bloco "Enviar
 * para funil" dos fluxos valem igual: CRM desligado não abre, funil inativo
 * não abre, etapa removida cai na primeira e card aberto não duplica.
 */

const PIPELINE_ID = "p-1";
const STAGE_ID = "s-2";

interface Setup {
  crmEnabled?: boolean;
  pipeline?: { isActive: boolean; stages: { id: string }[] } | null;
}

function setup(opts: Setup = {}) {
  const prisma = {
    organization: { findUnique: async () => ({ crmEnabled: opts.crmEnabled ?? true }) },
    crmPipeline: {
      findFirst: async () =>
        opts.pipeline === undefined
          ? { isActive: true, stages: [{ id: "s-1" }, { id: STAGE_ID }] }
          : opts.pipeline,
    },
  } as unknown as PrismaClient;
  const logger = { warn() {}, error() {}, info() {} };
  return { prisma, io: {}, logger } as unknown as Parameters<typeof openIntegrationOpportunity>[0];
}

const input = {
  organizationId: "org-1",
  conversationId: "conv-1",
  pipelineId: PIPELINE_ID,
  stageId: STAGE_ID,
  title: "Maria Souza",
  integrationTokenId: "tok-1",
};

type CreateFn = typeof createCrmOpportunity;
function fakeCreate(result: { duplicated: boolean } | Error) {
  const calls: Array<Parameters<CreateFn>[1]> = [];
  const fn = (async (_deps, args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return { opportunity: { id: "opp-1" }, duplicated: result.duplicated };
  }) as CreateFn;
  return { fn, calls };
}

beforeEach(() => clearOrganizationFeaturesCache());

describe("openIntegrationOpportunity", () => {
  it("abre o card na etapa do token, com o nome do formulário e autor nulo", async () => {
    const create = fakeCreate({ duplicated: false });
    const result = await openIntegrationOpportunity(setup(), input, create.fn);
    expect(result).toEqual({ status: "created", opportunityId: "opp-1" });
    expect(create.calls[0]).toMatchObject({
      organizationId: "org-1",
      pipelineId: PIPELINE_ID,
      stageId: STAGE_ID,
      conversationId: "conv-1",
      title: "Maria Souza",
      origin: "whatsapp",
      performedByUserId: null,
    });
  });

  it("card já aberto desta conversa no funil: fica onde está (existing)", async () => {
    const create = fakeCreate({ duplicated: true });
    const result = await openIntegrationOpportunity(setup(), input, create.fn);
    expect(result).toEqual({ status: "existing", opportunityId: "opp-1" });
  });

  it("CRM desligado não abre card nenhum", async () => {
    const create = fakeCreate({ duplicated: false });
    const result = await openIntegrationOpportunity(setup({ crmEnabled: false }), input, create.fn);
    expect(result).toEqual({ status: "crm_disabled", opportunityId: null });
    expect(create.calls).toHaveLength(0);
  });

  it("funil desativado ou apagado não abre card", async () => {
    const inactive = fakeCreate({ duplicated: false });
    expect(
      await openIntegrationOpportunity(
        setup({ pipeline: { isActive: false, stages: [{ id: STAGE_ID }] } }),
        input,
        inactive.fn,
      ),
    ).toEqual({ status: "pipeline_unavailable", opportunityId: null });
    clearOrganizationFeaturesCache();
    const gone = fakeCreate({ duplicated: false });
    expect(await openIntegrationOpportunity(setup({ pipeline: null }), input, gone.fn)).toEqual({
      status: "pipeline_unavailable",
      opportunityId: null,
    });
    expect(inactive.calls).toHaveLength(0);
    expect(gone.calls).toHaveLength(0);
  });

  it("etapa que saiu do funil cai na PRIMEIRA, em vez de perder o lead", async () => {
    const create = fakeCreate({ duplicated: false });
    const result = await openIntegrationOpportunity(
      setup({ pipeline: { isActive: true, stages: [{ id: "s-1" }] } }),
      input,
      create.fn,
    );
    expect(result.status).toBe("created");
    expect(create.calls[0]?.stageId).toBeNull();
  });

  it("falha na criação NÃO lança: vira status failed", async () => {
    const create = fakeCreate(new Error("banco fora"));
    const result = await openIntegrationOpportunity(setup(), input, create.fn);
    expect(result).toEqual({ status: "failed", opportunityId: null });
  });
});
