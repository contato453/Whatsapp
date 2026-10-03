import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { Server } from "socket.io";
import type { PrismaClient } from "@azvchat/database";
import type { WhatsAppProvider } from "@azvchat/whatsapp";
import {
  MayaWhatsappService,
  agoraEmBrasilia,
  mayaConfigFromEnv,
  paraWhatsapp,
  parseDias,
  telefoneCanonico,
  type MayaWhatsappConfig,
} from "../src/services/maya-whatsapp.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * MAYA NO WHATSAPP, e o que cada teste protege:
 *
 *   1. só o número configurado, só no grupo configurado, aciona a Maya —
 *      mensagem de outro número no mesmo grupo nunca vira chamada;
 *   2. telefone sem vínculo no Azevedo OS deixa o grupo CALADO;
 *   3. falha da Maya vira uma frase no grupo, não silêncio (quem perguntou
 *      precisa saber que não veio resposta);
 *   4. o resumo sai uma vez por dia, depois do horário, e nem um restart do
 *      processo o faz sair de novo (o banco é quem diz que já saiu).
 */

const ORG = "org-1";
const GRUPO_JID = "120363000000000000@g.us";
const LINCOLN = "34999990000";

function config(over: Partial<MayaWhatsappConfig> = {}): MayaWhatsappConfig {
  return {
    url: "https://x.supabase.co/functions/v1/maya-whatsapp",
    token: "token-de-teste",
    grupo: "Maya",
    telefone: LINCOLN,
    resumoHorario: "08:00",
    resumoDias: [1, 2, 3, 4, 5],
    resumoPergunta: "resumo",
    timeoutMs: 60_000,
    ...over,
  };
}

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

function montar(
  opts: {
    config?: MayaWhatsappConfig | null;
    fetch?: () => Promise<Response>;
    agora?: Date;
  } = {},
) {
  const db = new MemoryPrisma();
  const conversa = db.seed("conversation", {
    id: "conv-maya",
    organizationId: ORG,
    whatsappInstanceId: "inst-1",
    externalChatId: GRUPO_JID,
    type: "group",
    title: "Maya",
    customTitle: null,
    archivedAt: null,
  }) as never;
  const outro = db.seed("conversation", {
    id: "conv-outro",
    organizationId: ORG,
    whatsappInstanceId: "inst-1",
    externalChatId: "120363999999999999@g.us",
    type: "group",
    title: "Equipe",
    customTitle: null,
    archivedAt: null,
  }) as never;

  const fetchImpl = vi.fn(opts.fetch ?? (async () => resposta(200, { resposta: "Temos **248** empresas." })));
  const sendText = vi.fn(async () => ({ externalMessageId: `ext-${Math.random()}`, timestamp: new Date() }));
  const provider = { sendText } as unknown as WhatsAppProvider;
  const io = { to: () => ({ emit: () => undefined }), emit: () => undefined } as unknown as Server;
  let agora = opts.agora ?? new Date("2026-10-05T11:30:00Z");

  const maya = new MayaWhatsappService(
    db.client() as PrismaClient,
    provider,
    io,
    pino({ level: "silent" }),
    opts.config === undefined ? config() : opts.config,
    fetchImpl as unknown as typeof fetch,
    () => agora,
  );
  return {
    db,
    maya,
    fetchImpl,
    sendText,
    conversa,
    outro,
    setAgora: (d: Date) => {
      agora = d;
    },
  };
}

describe("funções de apoio", () => {
  it("parseDias entende faixa, lista e ignora lixo", () => {
    expect(parseDias("1-5")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDias("1,3,5")).toEqual([1, 3, 5]);
    expect(parseDias("0-6")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDias("8,x,2")).toEqual([2]);
  });

  it("telefoneCanonico casa o número com e sem 55 e com e sem o nono dígito", () => {
    const alvo = telefoneCanonico("34 99999-0000");
    expect(alvo).toBe("553499990000");
    expect(telefoneCanonico("5534999990000")).toBe(alvo);
    expect(telefoneCanonico("553499990000")).toBe(alvo);
    expect(telefoneCanonico("+55 (34) 9 9999-0000")).toBe(alvo);
    expect(telefoneCanonico(null)).toBeNull();
    expect(telefoneCanonico(GRUPO_JID)).toBeNull();
  });

  it("paraWhatsapp troca a formatação de Markdown pela do WhatsApp", () => {
    expect(paraWhatsapp("Temos **248** empresas")).toBe("Temos *248* empresas");
    expect(paraWhatsapp("## Resumo\n- item")).toBe("*Resumo*\n- item");
    expect(paraWhatsapp("veja [o portal](https://a.b/c)")).toBe("veja o portal (https://a.b/c)");
  });

  it("agoraEmBrasilia usa o fuso de Brasília, não o do servidor", () => {
    // 02:30 UTC de segunda é 23:30 de domingo em Brasília.
    expect(agoraEmBrasilia(new Date("2026-10-05T02:30:00Z"))).toEqual({
      data: "2026-10-04",
      hora: "23:30",
      diaSemana: 0,
    });
  });

  it("mayaConfigFromEnv nasce desligada sem grupo, telefone ou token, e deriva o endereço", () => {
    const base = {
      AZEVEDO_OS_API_URL: "https://p.supabase.co/functions/v1/azvchat",
      AZEVEDO_OS_API_TOKEN: "t",
      AZEVEDO_OS_TIMEOUT_MS: 5000,
      MAYA_GRUPO: "Maya",
      MAYA_TELEFONE: LINCOLN,
      MAYA_RESUMO_DIAS: "1-5",
    };
    expect(mayaConfigFromEnv({ ...base, MAYA_GRUPO: undefined })).toBeNull();
    expect(mayaConfigFromEnv({ ...base, MAYA_TELEFONE: undefined })).toBeNull();
    expect(mayaConfigFromEnv({ ...base, AZEVEDO_OS_API_TOKEN: undefined })).toBeNull();
    const c = mayaConfigFromEnv(base);
    expect(c?.url).toBe("https://p.supabase.co/functions/v1/maya-whatsapp");
    expect(c?.resumoHorario).toBeNull();
    expect(c?.timeoutMs).toBe(60_000);
  });
});

async function esperarFila() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("pergunta e resposta no grupo", () => {
  it("responde ao número configurado, no grupo configurado, com a sessão dele", async () => {
    const { maya, fetchImpl, sendText, conversa, db } = montar();
    maya.onInboundMessage({ conversation: conversa, senderPhone: "5534999990000", content: "Quantas empresas?" });
    await esperarFila();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ telefone: LINCOLN, pergunta: "Quantas empresas?" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-de-teste");
    expect(sendText).toHaveBeenCalledWith("inst-1", GRUPO_JID, "Temos *248* empresas.");
    const gravada = db.rows("message")[0];
    expect(gravada).toMatchObject({ direction: "outbound", senderName: "Maya", content: "Temos *248* empresas." });
  });

  it("ignora outro número no mesmo grupo e o mesmo número em outro grupo", async () => {
    const { maya, fetchImpl, conversa, outro } = montar();
    maya.onInboundMessage({ conversation: conversa, senderPhone: "5511988887777", content: "oi" });
    maya.onInboundMessage({ conversation: outro, senderPhone: LINCOLN, content: "oi" });
    maya.onInboundMessage({ conversation: conversa, senderPhone: null, content: "oi" });
    await esperarFila();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aceita o grupo pelo JID também", async () => {
    const { maya, fetchImpl, conversa } = montar({ config: config({ grupo: GRUPO_JID }) });
    maya.onInboundMessage({ conversation: conversa, senderPhone: LINCOLN, content: "oi" });
    await esperarFila();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("telefone sem vínculo no Azevedo OS deixa o grupo calado", async () => {
    const { maya, sendText, conversa } = montar({
      fetch: async () => resposta(404, { error: { code: "unknown_phone", message: "x" } }),
    });
    maya.onInboundMessage({ conversation: conversa, senderPhone: LINCOLN, content: "oi" });
    await esperarFila();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("recusa da Maya chega ao grupo com a frase dela; falha vira aviso", async () => {
    const recusa = montar({
      fetch: async () => resposta(403, { error: { code: "maya_desativada", message: "A Maya está desativada para você." } }),
    });
    recusa.maya.onInboundMessage({ conversation: recusa.conversa, senderPhone: LINCOLN, content: "oi" });
    await esperarFila();
    expect(recusa.sendText).toHaveBeenCalledWith("inst-1", GRUPO_JID, "A Maya está desativada para você.");

    const falha = montar({ fetch: async () => resposta(500, {}) });
    falha.maya.onInboundMessage({ conversation: falha.conversa, senderPhone: LINCOLN, content: "oi" });
    await esperarFila();
    expect(falha.sendText).toHaveBeenCalledWith(
      "inst-1",
      GRUPO_JID,
      "Não consegui consultar a Maya agora. Tente de novo em instantes.",
    );
  });

  it("desligada, não faz nada", async () => {
    const { maya, fetchImpl, conversa } = montar({ config: null });
    maya.onInboundMessage({ conversation: conversa, senderPhone: LINCOLN, content: "oi" });
    await esperarFila();
    expect(maya.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("resumo programado", () => {
  it("não sai antes do horário nem fora dos dias, sai uma vez depois do horário", async () => {
    // Segunda, 07:59 em Brasília.
    const t = montar({ agora: new Date("2026-10-05T10:59:00Z") });
    await t.maya.tickResumo();
    expect(t.sendText).not.toHaveBeenCalled();

    t.setAgora(new Date("2026-10-05T11:00:30Z")); // 08:00:30
    await t.maya.tickResumo();
    expect(t.sendText).toHaveBeenCalledTimes(1);
    const [, init] = t.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ telefone: LINCOLN, pergunta: "resumo" });
    expect(t.db.rows("message")[0]).toMatchObject({ senderName: "Maya (resumo)" });

    t.setAgora(new Date("2026-10-05T14:00:00Z"));
    await t.maya.tickResumo();
    expect(t.sendText).toHaveBeenCalledTimes(1);

    // Domingo: fora dos dias úteis.
    const domingo = montar({ agora: new Date("2026-10-04T12:00:00Z") });
    await domingo.maya.tickResumo();
    expect(domingo.sendText).not.toHaveBeenCalled();
  });

  it("um restart no mesmo dia não manda o resumo de novo", async () => {
    const t = montar({ agora: new Date("2026-10-05T12:00:00Z") });
    t.db.seed("message", {
      organizationId: ORG,
      conversationId: "conv-maya",
      direction: "outbound",
      senderName: "Maya (resumo)",
      timestamp: new Date("2026-10-05T11:00:40Z"),
    });
    await t.maya.tickResumo();
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("falha da Maya no resumo tenta de novo no próximo minuto", async () => {
    let primeira = true;
    const t = montar({
      agora: new Date("2026-10-05T11:05:00Z"),
      fetch: async () => {
        if (primeira) {
          primeira = false;
          return resposta(502, {});
        }
        return resposta(200, { resposta: "ok" });
      },
    });
    await t.maya.tickResumo();
    expect(t.sendText).not.toHaveBeenCalled();
    await t.maya.tickResumo();
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it("sem horário configurado, não há resumo", async () => {
    const t = montar({ config: config({ resumoHorario: null }), agora: new Date("2026-10-05T12:00:00Z") });
    await t.maya.tickResumo();
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });
});
