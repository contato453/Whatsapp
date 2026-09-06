import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import { defaultAiAgentConfig, RealtimeEvents } from "@azvchat/shared";
import { createSecretCipher } from "../src/lib/ai-secrets.js";
import { AiRuntime } from "../src/services/ai/runtime.js";
import { interruptAiSessionForHuman } from "../src/services/ai/session.js";
import type { AzevedoOsClient } from "../src/services/azevedo-os-client.js";
import type { AuditService } from "../src/modules/audit/service.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * O motor de ponta a ponta, sem banco e sem OpenAI de verdade: Prisma em
 * memória e `fetch` simulado devolvendo o JSON que a OpenAI devolveria.
 *
 * O que estes casos fixam:
 *   1. mensagem recebida numa conversa que casa com a automação abre a
 *      sessão, manda a apresentação, chama o provedor e responde pelo MESMO
 *      `provider.sendText` — com a origem marcada na mensagem gravada;
 *   2. duas mensagens rápidas viram UM turno (debounce), e a segunda entra
 *      no contexto enviado ao modelo;
 *   3. `transfer_to_human` pedido pelo modelo vira nota interna com resumo,
 *      conversa roteada e sessão encerrada — e o modelo não é chamado de novo;
 *   4. humano assumindo NO MEIO do turno faz a resposta gerada ser
 *      descartada: nada sai pelo WhatsApp;
 *   5. ferramenta não liberada pedida pelo modelo é recusada e registrada;
 *   6. provedor fora do ar → fallback: mensagem de contingência e humano;
 *   7. orçamento estourado com bloqueio: a IA nem começa;
 *   8. consumo registrado com tokens e custo estimado.
 */

const ORG = "org-1";
const INSTANCE = "inst-1";
const CIPHER = createSecretCipher({ aiSecretsKey: "c".repeat(64), jwtSecret: "x".repeat(32) });

interface Scenario {
  db: MemoryPrisma;
  runtime: AiRuntime;
  sent: Array<{ chatId: string; text: string }>;
  emitted: Array<{ room: string[]; event: string; payload: unknown }>;
  agentId: string;
  conversationId: string;
}

function openAiResponse(content: string | null, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) {
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: toolCalls.map((call, index) => ({
            id: `call-${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

/** `fetch` simulado: cada chamada a /chat/completions consome a próxima resposta da fila. */
function mockFetch(queue: Array<() => unknown>, calls: Array<{ url: string; body: Record<string, unknown> }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }] }), { status: 200 });
    }
    const next = queue.shift();
    if (!next) throw new Error("fetch simulado sem resposta na fila");
    const result = next();
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function scenario(options: { config?: (config: ReturnType<typeof defaultAiAgentConfig>) => void; budgetCents?: number; spentMicros?: number } = {}): Scenario {
  const db = new MemoryPrisma();
  db.seed("organization", { id: ORG, name: "Azevedo" });
  db.seed("user", { id: "user-1", organizationId: ORG, name: "Ana", role: "agent", status: "active" });
  db.seed("whatsAppInstance", { id: INSTANCE, organizationId: ORG, name: "Principal", status: "connected", departmentId: null, defaultAssigneeId: null });
  db.seed("aiProviderConfig", {
    organizationId: ORG,
    provider: "openai",
    apiKeyEncrypted: CIPHER.encrypt("sk-test-1234567890"),
    apiKeyHint: "sk-••••7890",
    defaultModel: "gpt-4.1-mini",
    status: "connected",
  });
  if (options.budgetCents != null) {
    db.seed("aiSettings", {
      organizationId: ORG,
      monthlyBudgetCents: options.budgetCents,
      alertThresholds: [50, 80, 90, 100],
      budgetPolicy: "block_new",
      timeoutMs: 30_000,
      contextMessageLimit: 20,
      pricingOverrides: null,
      alertedMonth: null,
      alertedThresholds: [],
    });
  }
  if (options.spentMicros) {
    db.seed("aiUsageLog", { organizationId: ORG, provider: "openai", model: "gpt-4.1-mini", kind: "chat", outcome: "ok", costMicros: options.spentMicros });
  }
  const config = defaultAiAgentConfig();
  config.objective = "Qualificar leads.";
  config.dataCollection.fields = [{ key: "cidade", label: "Cidade", required: false, hint: "" }];
  options.config?.(config);
  const agent = db.seed("aiAgent", {
    organizationId: ORG,
    name: "IA Comercial",
    description: "",
    status: "active",
    isGeneral: true,
    model: null,
    config,
    currentVersion: 1,
    handoffDepartmentId: null,
    handoffAssigneeId: null,
  });
  db.seed("aiAgentVersion", { agentId: agent.id, version: 1, model: null, config });
  db.seed("aiAutomation", {
    organizationId: ORG,
    name: "Comercial no principal",
    active: true,
    agentId: agent.id,
    whatsappInstanceId: INSTANCE,
    departmentId: null,
    onlyWithoutDepartment: false,
    conversationType: "any",
    onlyUnassigned: true,
    onlyNewConversations: false,
    resolvedTagId: null,
    priority: 100,
  });
  db.seed("tag", { id: "tag-lead", organizationId: ORG, name: "Lead", color: "#000", isGeneral: true });
  const conversation = db.seed("conversation", {
    organizationId: ORG,
    whatsappInstanceId: INSTANCE,
    externalChatId: "5511999998888@s.whatsapp.net",
    type: "individual",
    title: "5511999998888",
    customTitle: null,
    status: "open",
    assignedUserId: null,
    assignedToAll: false,
    departmentId: null,
    archivedAt: null,
    archivedByUserId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    externalReference: null,
    externalSource: null,
    profilePicture: null,
  });

  const sent: Scenario["sent"] = [];
  const emitted: Scenario["emitted"] = [];
  const provider = {
    sendText: async (_instanceId: string, chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { externalMessageId: `wamid-${sent.length}`, timestamp: new Date() };
    },
  } as unknown as WhatsAppProvider;
  const io = {
    to: (room: string[]) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
  };
  const audit = { record: () => undefined } as unknown as AuditService;
  const runtime = new AiRuntime({
    prisma: db.client(),
    io: io as never,
    logger: pino({ level: "silent" }),
    provider,
    audit,
    azevedoOs: { enabled: false } as AzevedoOsClient,
    cipher: CIPHER,
  });
  return { db, runtime, sent, emitted, agentId: agent.id as string, conversationId: conversation.id as string };
}

function inbound(db: MemoryPrisma, conversationId: string, content: string, at = new Date()) {
  return db.seed("message", {
    organizationId: ORG,
    conversationId,
    externalMessageId: `in-${Math.random()}`,
    direction: "inbound",
    type: "text",
    content,
    timestamp: at,
    status: "delivered",
    deletedAt: null,
    metadata: null,
    senderName: null,
    senderPhone: null,
    senderExternalId: null,
  });
}

/** Dispara o debounce e espera a fila da conversa esvaziar. */
async function settle(runtime: AiRuntime, scenarioData: Scenario, messageId: string) {
  runtime.onInboundMessage({ organizationId: ORG, conversationId: scenarioData.conversationId, messageId });
  await vi.advanceTimersByTimeAsync(2_600);
  await vi.runAllTimersAsync();
}

describe("AiRuntime — turno de ponta a ponta", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("abre a sessão pela automação, apresenta, responde e marca a origem da mensagem", async () => {
    const s = scenario();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", mockFetch([() => openAiResponse("Claro! Me conta qual serviço você procura.")], calls));

    const message = inbound(s.db, s.conversationId, "Oi, quero abrir uma empresa");
    await settle(s.runtime, s, message.id as string);

    // Apresentação (determinística) + resposta do modelo, na ordem.
    expect(s.sent.map((entry) => entry.text)).toEqual([
      "Olá! Sou a assistente virtual do escritório.",
      "Claro! Me conta qual serviço você procura.",
    ]);
    const outbound = s.db.rows("message").filter((row) => row.direction === "outbound");
    expect(outbound).toHaveLength(2);
    expect((outbound[1]?.metadata as { origem: string; aiAgentName: string }).origem).toBe("ai");
    expect((outbound[1]?.metadata as { aiAgentName: string }).aiAgentName).toBe("IA Comercial");
    expect(outbound[1]?.senderName).toBe("IA Comercial");

    const session = s.db.rows("aiSession")[0];
    expect(session?.status).toBe("active");
    expect(session?.aiMessageCount).toBe(2);
    expect(session?.customerMessageCount).toBe(1);
    expect(session?.lastProcessedMessageId).toBe(message.id);
    expect(session?.inputTokens).toBe(120);

    // O modelo recebeu o prompt de sistema montado dos campos + a mensagem do cliente.
    const chatCall = calls.find((call) => call.url.endsWith("/chat/completions"));
    const messages = chatCall?.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("Qualificar leads.");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "Oi, quero abrir uma empresa" });
    // A chave nunca aparece no corpo — só no header.
    expect(JSON.stringify(chatCall?.body)).not.toContain("sk-test");
    // Ferramentas oferecidas seguem a capacidade: transferir sim, remover etiqueta não.
    const tools = (chatCall?.body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(tools).toContain("transfer_to_human");
    expect(tools).not.toContain("remove_tag");

    // Consumo registrado com custo estimado (gpt-4.1-mini: 120 in + 30 out).
    const usage = s.db.rows("aiUsageLog").find((row) => row.kind === "chat");
    expect(usage?.inputTokens).toBe(120);
    expect(usage?.outcome).toBe("ok");
    expect(usage?.costMicros).toBe(Math.round((120 / 1e6) * 0.4 * 1e6 + (30 / 1e6) * 1.6 * 1e6));

    // Tempo real: sessão publicada para a audiência e mensagem nova.
    expect(s.emitted.some((entry) => entry.event === RealtimeEvents.AiSession)).toBe(true);
    expect(s.emitted.some((entry) => entry.event === RealtimeEvents.MessageNew)).toBe(true);
  });

  it("duas mensagens rápidas viram um turno só, com as duas no contexto", async () => {
    const s = scenario({ config: (config) => (config.identity.sendGreeting = false) });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", mockFetch([() => openAiResponse("Entendi as duas coisas.")], calls));

    const first = inbound(s.db, s.conversationId, "Oi", new Date(Date.now() - 1000));
    s.runtime.onInboundMessage({ organizationId: ORG, conversationId: s.conversationId, messageId: first.id as string });
    await vi.advanceTimersByTimeAsync(500);
    const second = inbound(s.db, s.conversationId, "Quero abrir empresa");
    await settle(s.runtime, s, second.id as string);

    expect(calls.filter((call) => call.url.endsWith("/chat/completions"))).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    const messages = calls[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages.filter((entry) => entry.role === "user").map((entry) => entry.content)).toEqual(["Oi", "Quero abrir empresa"]);
    expect(s.db.rows("aiSession")[0]?.customerMessageCount).toBe(2);
  });

  it("transfer_to_human: nota com resumo, conversa entregue e sessão transferida", async () => {
    const s = scenario({ config: (config) => (config.identity.sendGreeting = false) });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      mockFetch(
        [
          () =>
            openAiResponse(null, [
              { name: "save_collected_data", arguments: { field: "cidade", value: "Niterói" } },
              { name: "add_tag", arguments: { name: "Lead" } },
              {
                name: "transfer_to_human",
                arguments: { reason: "Solicitou proposta comercial", subject: "Abertura de empresa", need: "Abrir empresa de serviços", summary: "Cliente de Niterói quer abrir este mês." },
              },
            ]),
        ],
        calls,
      ),
    );

    const message = inbound(s.db, s.conversationId, "Quero uma proposta");
    await settle(s.runtime, s, message.id as string);

    // Só uma chamada: depois da ferramenta terminal o modelo não é consultado de novo.
    expect(calls.filter((call) => call.url.endsWith("/chat/completions"))).toHaveLength(1);
    // O cliente recebe a mensagem de transferência configurada.
    expect(s.sent.at(-1)?.text).toContain("encaminhar você para um de nossos atendentes");
    const session = s.db.rows("aiSession")[0];
    expect(session?.status).toBe("transferred");
    expect(session?.endReason).toBe("ai_transfer");
    expect((session?.state as { collected: Record<string, string> }).collected.cidade).toBe("Niterói");
    // Resumo para o atendente, como nota interna.
    const note = s.db.rows("internalNote")[0];
    expect(note?.content).toContain("RESUMO DO ATENDIMENTO POR IA");
    expect(note?.content).toContain("Cidade: Niterói");
    expect(note?.content).toContain("Motivo da transferência: Solicitou proposta comercial");
    // Etiqueta aplicada de verdade e conversa aberta na fila humana.
    expect(s.db.rows("conversationTag")).toHaveLength(1);
    expect(s.db.rows("conversation")[0]?.status).toBe("open");
    const usage = s.db.rows("aiUsageLog").find((row) => row.kind === "chat");
    expect(usage?.toolsExecuted).toEqual(["save_collected_data", "add_tag", "transfer_to_human"]);
    expect(usage?.handoffReason).toBe("Solicitou proposta comercial");
  });

  it("humano assumiu no meio do turno: a resposta gerada é descartada", async () => {
    const s = scenario({ config: (config) => (config.identity.sendGreeting = false) });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const deps = { prisma: s.db.client(), io: { to: () => ({ emit: () => undefined }) } as never, logger: pino({ level: "silent" }) };
    vi.stubGlobal(
      "fetch",
      mockFetch(
        [
          () => {
            // Enquanto o modelo "pensa", a Ana assume a conversa.
            void interruptAiSessionForHuman(deps, { organizationId: ORG, conversationId: s.conversationId, userId: "user-1", userName: "Ana" });
            return openAiResponse("Resposta que não pode sair.");
          },
        ],
        calls,
      ),
    );
    const message = inbound(s.db, s.conversationId, "Oi");
    await settle(s.runtime, s, message.id as string);

    expect(s.sent).toHaveLength(0);
    const session = s.db.rows("aiSession")[0];
    expect(session?.status).toBe("stopped");
    expect(session?.endReason).toBe("human_takeover");
    expect(s.db.rows("conversationAssignmentHistory").some((row) => String(row.note).includes("assumido por Ana"))).toBe(true);
  });

  it("ferramenta não liberada é recusada e registrada, e o modelo é avisado", async () => {
    const s = scenario({
      config: (config) => {
        config.identity.sendGreeting = false;
        config.canDo.capabilities.remove_tags = false;
      },
    });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      mockFetch(
        [
          () => openAiResponse(null, [{ name: "remove_tag", arguments: { name: "Lead" } }]),
          () => openAiResponse("Certo, sem remover a etiqueta."),
        ],
        calls,
      ),
    );
    const message = inbound(s.db, s.conversationId, "Tira a etiqueta");
    await settle(s.runtime, s, message.id as string);

    const second = calls.filter((call) => call.url.endsWith("/chat/completions"))[1];
    const toolMessage = (second?.body.messages as Array<{ role: string; content: string }>).find((entry) => entry.role === "tool");
    expect(toolMessage?.content).toContain("Ação recusada");
    const usage = s.db.rows("aiUsageLog").find((row) => row.kind === "chat");
    expect(usage?.toolsBlocked).toEqual(["remove_tag"]);
    expect(usage?.toolsExecuted).toEqual([]);
    expect(s.sent.at(-1)?.text).toBe("Certo, sem remover a etiqueta.");
  });

  it("provedor com erro permanente: mensagem de fallback e humano assume", async () => {
    const s = scenario({ config: (config) => (config.identity.sendGreeting = false) });
    vi.stubGlobal("fetch", mockFetch([() => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 })], []));
    const message = inbound(s.db, s.conversationId, "Oi");
    await settle(s.runtime, s, message.id as string);

    expect(s.sent.at(-1)?.text).toContain("vou encaminhar você para um de nossos atendentes");
    const session = s.db.rows("aiSession")[0];
    expect(session?.status).toBe("error");
    expect(session?.endReason).toBe("provider_error");
    const usage = s.db.rows("aiUsageLog").find((row) => row.kind === "chat");
    expect(usage?.outcome).toBe("error");
    expect(usage?.errorCode).toBe("invalid_api_key");
  });

  it("orçamento estourado com bloqueio: a IA nem começa, e o bloqueio fica no log", async () => {
    const s = scenario({ budgetCents: 100, spentMicros: 2_000_000 });
    const fetchMock = mockFetch([], []);
    vi.stubGlobal("fetch", fetchMock);
    const message = inbound(s.db, s.conversationId, "Oi");
    await settle(s.runtime, s, message.id as string);

    expect(s.sent).toHaveLength(0);
    expect(s.db.rows("aiSession")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.db.rows("aiUsageLog").some((row) => row.outcome === "blocked" && row.errorCode === "budget_exceeded")).toBe(true);
  });

  it("conversa que já está com um atendente não entra na IA", async () => {
    const s = scenario();
    const fetchMock = mockFetch([], []);
    vi.stubGlobal("fetch", fetchMock);
    const conversation = s.db.rows("conversation")[0] as Record<string, unknown>;
    conversation.assignedUserId = "user-1";
    const message = inbound(s.db, s.conversationId, "Oi");
    await settle(s.runtime, s, message.id as string);
    expect(s.db.rows("aiSession")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
