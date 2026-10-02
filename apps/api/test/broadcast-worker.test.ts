import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Server } from "socket.io";
import type { PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import { BROADCAST_LIMITS } from "@azvchat/shared";
import { BroadcastWorker } from "../src/services/broadcast-worker.js";
import type { MessageIngestService } from "../src/services/message-ingest.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * AS TRAVAS DO MOTOR DE DISPARO, e por que cada uma vale um teste:
 *
 *   1. número fora do ar PAUSA — marcar 200 entregas como falha por causa de
 *      um QR vencido destruiria a lista sem ninguém pedir;
 *   2. teto diário REPROGRAMA para o dia seguinte, e não falha nem pausa de
 *      vez: a campanha continua de onde parou;
 *   3. descadastro é reconferido NO INSTANTE DO ENVIO — quem pede para sair
 *      no meio do disparo é justamente quem denuncia se receber a próxima;
 *   4. falhas seguidas PARAM a campanha: falha em série é sintoma de bloqueio
 *      em curso, e insistir até o fim da lista é o que derruba o chip;
 *   5. o caminho feliz grava a entrega com o texto EXATO que saiu e reprograma
 *      a próxima dentro da faixa de intervalo — nunca sem espera.
 */

const ORG = "org-1";
const INSTANCIA = "inst-1";

function montar(overrides: { sendText?: () => Promise<unknown> } = {}) {
  const db = new MemoryPrisma();
  db.seed("whatsAppInstance", { id: INSTANCIA, organizationId: ORG, name: "Comercial", status: "connected" });
  db.seed("conversation", {
    id: "conv-1",
    organizationId: ORG,
    whatsappInstanceId: INSTANCIA,
    externalChatId: "5511999990001@s.whatsapp.net",
    departmentId: null,
    assignedUserId: null,
  });

  const sendText =
    overrides.sendText ??
    (async () => ({ externalMessageId: `ext-${Math.random()}`, timestamp: new Date() }));

  const provider = { sendText: vi.fn(sendText) } as unknown as WhatsAppProvider;
  const ingest = {
    ensureConversation: async () => ({ id: "conv-1", organizationId: ORG }),
  } as unknown as MessageIngestService;
  const io = { to: () => ({ emit: () => undefined }), emit: () => undefined } as unknown as Server;

  const worker = new BroadcastWorker(
    db.client() as PrismaClient,
    provider,
    ingest,
    io,
    pino({ level: "silent" }),
  );
  return { db, worker, provider };
}

function campanha(db: MemoryPrisma, extra: Record<string, unknown> = {}) {
  return db.seed("broadcastCampaign", {
    id: "camp-1",
    organizationId: ORG,
    name: "Aviso fiscal",
    audienceId: "aud-1",
    whatsappInstanceId: INSTANCIA,
    message: "Olá {{primeiro_nome}}, aqui é do escritório.",
    messageVariants: null,
    status: "running",
    pausedReason: null,
    minIntervalSeconds: 30,
    maxIntervalSeconds: 90,
    dailyLimit: null,
    respectBusinessHours: false,
    consecutiveFailures: 0,
    crmMode: "never",
    crmPipelineId: null,
    crmStageId: null,
    tagId: null,
    sentToday: 0,
    sentTodayDate: null,
    nextSendAt: null,
    ...extra,
  });
}

function entrega(db: MemoryPrisma, extra: Record<string, unknown> = {}) {
  return db.seed("broadcastDelivery", {
    organizationId: ORG,
    campaignId: "camp-1",
    contactId: null,
    phone: "5511999990001",
    contactName: "Ana Paula",
    contactCompany: null,
    status: "pending",
    skipReason: null,
    failureReason: null,
    attempts: 0,
    sentAt: null,
    repliedAt: null,
    conversationId: null,
    messageId: null,
    content: null,
    ...extra,
  });
}

describe("motor de disparo", () => {
  it("manda a mensagem, congela o texto na entrega e espera o intervalo", async () => {
    const { db, worker, provider } = montar();
    campanha(db);
    entrega(db);

    await worker.tick();

    expect(provider.sendText).toHaveBeenCalledTimes(1);
    const linha = db.rows("broadcastDelivery")[0];
    expect(linha?.status).toBe("sent");
    // O texto fica GRAVADO na entrega: o histórico precisa responder o que
    // esta pessoa recebeu, mesmo depois de alguém editar a campanha.
    expect(linha?.content).toBe("Olá Ana, aqui é do escritório.");

    const camp = db.rows("broadcastCampaign")[0];
    const espera = (camp?.nextSendAt as Date).getTime() - Date.now();
    // Nunca sem espera, e nunca além do máximo configurado.
    expect(espera).toBeGreaterThanOrEqual(29_000);
    expect(espera).toBeLessThanOrEqual(91_000);
    expect(camp?.status).toBe("running");
  });

  it("pausa quando o número está fora do ar, sem queimar a fila", async () => {
    const { db, worker, provider } = montar();
    db.rows("whatsAppInstance")[0]!.status = "qr_required";
    campanha(db);
    entrega(db);

    await worker.tick();

    expect(provider.sendText).not.toHaveBeenCalled();
    expect(db.rows("broadcastCampaign")[0]?.status).toBe("paused");
    expect(db.rows("broadcastCampaign")[0]?.pausedReason).toBe("instance_offline");
    // A entrega continua na fila: reconectar retoma de onde parou.
    expect(db.rows("broadcastDelivery")[0]?.status).toBe("pending");
  });

  it("pula quem pediu descadastro DEPOIS da fila gerada, sem gastar o intervalo", async () => {
    const { db, worker, provider } = montar();
    campanha(db);
    entrega(db);
    db.seed("broadcastOptOut", { organizationId: ORG, phone: "5511999990001", reason: "keyword" });

    await worker.tick();

    expect(provider.sendText).not.toHaveBeenCalled();
    expect(db.rows("broadcastDelivery")[0]?.status).toBe("skipped");
    expect(db.rows("broadcastDelivery")[0]?.skipReason).toBe("opted_out");
    // Pular não é enviar: a próxima sai na volta seguinte, sem esperar.
    expect((db.rows("broadcastCampaign")[0]?.nextSendAt as Date).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("reprograma para o DIA SEGUINTE ao bater o teto diário", async () => {
    const { db, worker, provider } = montar();
    const hoje = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    campanha(db, { dailyLimit: 10, sentToday: 10, sentTodayDate: hoje });
    entrega(db);

    await worker.tick();

    expect(provider.sendText).not.toHaveBeenCalled();
    const camp = db.rows("broadcastCampaign")[0];
    // Continua rodando — só adiada. Uma retomada no MESMO dia faria a
    // campanha voltar a esta guarda a cada volta do worker até a virada.
    expect(camp?.status).toBe("running");
    expect(camp?.pausedReason).toBe("daily_limit");
    // Confere o DIA CIVIL no fuso do escritório, e não "mais de uma hora à
    // frente": às 23h50 de Brasília o dia seguinte começa em dez minutos, e a
    // conta de horas fazia o teste falhar só naquele horário.
    const diaDaRetomada = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(camp?.nextSendAt as Date);
    expect(diaDaRetomada > hoje).toBe(true);
  });

  it("para a campanha depois de falhas seguidas demais", async () => {
    const { db, worker } = montar({
      sendText: async () => {
        throw new Error("connection closed");
      },
    });
    campanha(db, { consecutiveFailures: BROADCAST_LIMITS.MAX_CONSECUTIVE_FAILURES - 1 });
    entrega(db);

    await worker.tick();

    expect(db.rows("broadcastCampaign")[0]?.status).toBe("paused");
    expect(db.rows("broadcastCampaign")[0]?.pausedReason).toBe("too_many_failures");
  });

  it("conclui a campanha quando não sobra entrega pendente", async () => {
    const { db, worker } = montar();
    campanha(db);
    entrega(db, { status: "sent", sentAt: new Date() });

    await worker.tick();

    const camp = db.rows("broadcastCampaign")[0];
    expect(camp?.status).toBe("completed");
    expect(camp?.finishedAt).toBeInstanceOf(Date);
  });
});
