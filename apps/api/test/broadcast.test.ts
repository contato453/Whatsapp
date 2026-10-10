import { describe, expect, it } from "vitest";
import {
  BROADCAST_LIMITS,
  PERMISSION_ACTIONS,
  estimateCampaignMinutes,
  extractBroadcastVariables,
  guessImportRole,
  isOptOutMessage,
  normalizeColumnKey,
  pickIntervalMs,
  resolveBroadcastTemplate,
  tidyResolvedText,
} from "@azvchat/shared";
import { generateDeliveries, handleBroadcastInbound, registerOptOut } from "../src/lib/broadcast.js";
import {
  IMPORT_TEMPLATE_COLUMNS,
  buildImportTemplate,
  prepareContacts,
  readSpreadsheet,
} from "../src/lib/broadcast-import.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * O que estes casos trancam nos disparos em massa — e cada um deles existe
 * porque errar ali custa o NÚMERO do escritório, não uma tela torta:
 *
 *   1. descadastro casa a mensagem INTEIRA, nunca "contém": "não quero parar
 *      de receber" contém "parar" e significa o contrário;
 *   2. variável sem valor vira vazio E o texto é costurado — a vírgula solta
 *      de "Olá , tudo bem?" denuncia disparo automático na primeira linha;
 *   3. o intervalo é SORTEADO dentro da faixa, e nunca abaixo do mínimo
 *      absoluto: intervalo fixo é a assinatura de robô mais fácil de ver;
 *   4. a fila é materializada de uma vez, e quem está descadastrado entra
 *      como `skipped` em vez de sumir — senão o total não fecha com a
 *      audiência e ninguém entende a diferença;
 *   5. responder marca a resposta UMA vez (a segunda mensagem do cliente não
 *      sobrescreve a hora da primeira) e "SAIR" descadastra na organização
 *      inteira, não só naquela campanha;
 *   6. `broadcast.send` nasce FECHADO até para supervisor: montar a campanha
 *      é trabalho, apertar o botão que fala com 3.000 clientes é decisão.
 */

const ORG = "org-1";

describe("descadastro por palavra-chave", () => {
  it("reconhece o pedido escrito de qualquer jeito", () => {
    expect(isOptOutMessage("SAIR")).toBe(true);
    expect(isOptOutMessage("  parar  ")).toBe(true);
    expect(isOptOutMessage("Descadastrar!")).toBe(true);
    expect(isOptOutMessage("não quero mais receber")).toBe(true);
  });

  it("NÃO descadastra quando a palavra está dentro de uma frase", () => {
    // O caso que uma comparação por "contém" erraria — e errar aqui é parar
    // de mandar para quem queria continuar recebendo.
    expect(isOptOutMessage("não quero parar de receber, pode continuar")).toBe(false);
    expect(isOptOutMessage("preciso cancelar a nota fiscal 123")).toBe(false);
    expect(isOptOutMessage("")).toBe(false);
    expect(isOptOutMessage(null)).toBe(false);
  });
});

describe("texto da mensagem", () => {
  const contato = {
    name: "Maria Souza",
    company: "Souza Comércio",
    phone: "(11) 99999-8888",
    fields: { cidade: "Campinas" },
  };

  it("resolve as variáveis do catálogo e as colunas da planilha", () => {
    const texto = resolveBroadcastTemplate(
      "Olá {{primeiro_nome}}, aqui é sobre a {{empresa}} em {{campo.cidade}}.",
      contato,
    );
    expect(texto).toBe("Olá Maria, aqui é sobre a Souza Comércio em Campinas.");
  });

  it("costura a frase quando a variável vem vazia", () => {
    const texto = resolveBroadcastTemplate("Olá {{nome}}, tudo bem?", {
      ...contato,
      name: null,
    });
    // Sem a costura sairia "Olá , tudo bem?" — a cicatriz que denuncia robô.
    expect(texto).toBe("Olá, tudo bem?");
  });

  it("saúda conforme a hora do ENVIO, não a de montar a campanha", () => {
    const manha = resolveBroadcastTemplate("{{saudacao}}", contato, new Date(2026, 8, 12, 9, 0));
    const noite = resolveBroadcastTemplate("{{saudacao}}", contato, new Date(2026, 8, 12, 20, 0));
    expect(manha).toBe("Bom dia");
    expect(noite).toBe("Boa noite");
  });

  it("lista as variáveis usadas, sem repetir", () => {
    expect(extractBroadcastVariables("{{nome}} {{nome}} {{campo.cidade}}")).toEqual([
      "nome",
      "campo.cidade",
    ]);
  });

  it("tira espaço duplo e espaço antes de pontuação", () => {
    expect(tidyResolvedText("Olá  Maria , tudo bem ?")).toBe("Olá Maria, tudo bem?");
  });
});

describe("ritmo do envio", () => {
  it("sorteia dentro da faixa e nunca abaixo do mínimo absoluto", () => {
    expect(pickIntervalMs(30, 90, () => 0)).toBe(30_000);
    expect(pickIntervalMs(30, 90, () => 0.999999)).toBe(90_000);
    // Pedir 1 segundo não vale: o piso do sistema é o que segura o chip.
    expect(pickIntervalMs(1, 1, () => 0)).toBe(BROADCAST_LIMITS.MIN_INTERVAL_SECONDS * 1000);
  });

  it("estima a duração pela média da faixa", () => {
    expect(estimateCampaignMinutes(100, 30, 90)).toBe(100); // média 60s → 100 min
    expect(estimateCampaignMinutes(0, 30, 90)).toBe(0);
  });
});

describe("importação de planilha", () => {
  it("adivinha o papel da coluna pelo nome, em português e inglês", () => {
    expect(guessImportRole("Telefone")).toBe("phone");
    expect(guessImportRole("WhatsApp")).toBe("phone");
    expect(guessImportRole("Razão Social")).toBe("company");
    expect(guessImportRole("Vencimento")).toBeNull(); // vira campo.vencimento
    expect(normalizeColumnKey("Data de Vencimento")).toBe("data_de_vencimento");
  });

  it("normaliza, recusa com o número da linha e descarta repetido do arquivo", () => {
    const resultado = prepareContacts(
      {
        columns: ["Nome", "Telefone", "Cidade"],
        rows: [
          { Nome: "Maria", Telefone: "(11) 99999-8888", Cidade: "Campinas" },
          { Nome: "Maria de novo", Telefone: "5511999998888", Cidade: "Campinas" },
          { Nome: "Sem número", Telefone: "", Cidade: "Santos" },
          { Nome: "Torto", Telefone: "123", Cidade: "Santos" },
        ],
      },
      { phone: "Telefone", name: "Nome", extras: ["Cidade"] },
    );

    expect(resultado.contacts).toHaveLength(1);
    expect(resultado.contacts[0]?.fields).toEqual({ cidade: "Campinas" });
    // A segunda linha é o MESMO número escrito de outro jeito — e é a
    // normalização que faz a deduplicação enxergar isso.
    expect(resultado.duplicatedInFile).toBe(1);
    expect(resultado.rejected.map((item) => item.row)).toEqual([4, 5]);
    expect(resultado.rejected[0]?.reason).toBe("Sem telefone");
  });
});

describe("modelo de planilha", () => {
  it("volta pela própria importação com o mapeamento já certo e SEM linha de dado", async () => {
    const arquivo = await buildImportTemplate();
    const lido = await readSpreadsheet(arquivo, "modelo-audiencia-azvchat.xlsx");

    // A importação lê a PRIMEIRA aba: ela tem de ser a de contatos, só com
    // o cabeçalho. Exemplo esquecido ali receberia a campanha.
    expect(lido.columns).toEqual(IMPORT_TEMPLATE_COLUMNS.map((coluna) => coluna.header));
    expect(lido.rows).toHaveLength(0);

    expect(guessImportRole("Telefone")).toBe("phone");
    expect(guessImportRole("Nome")).toBe("name");
    expect(guessImportRole("Empresa")).toBe("company");
    // As demais são as variáveis de exemplo.
    expect(lido.columns.slice(3).map((coluna) => guessImportRole(coluna))).toEqual([null, null, null]);
    expect(lido.columns.slice(3).map(normalizeColumnKey)).toEqual(["cidade", "vencimento", "servico"]);
  });
});

describe("fila da campanha", () => {
  async function base() {
    const db = new MemoryPrisma();
    const prisma = db.client();
    db.seed("broadcastAudience", { id: "aud-1", organizationId: ORG, name: "Clientes" });
    db.seed("broadcastContact", { id: "c-1", audienceId: "aud-1", phone: "5511999990001", name: "Ana", company: null, createdAt: new Date(1) });
    db.seed("broadcastContact", { id: "c-2", audienceId: "aud-1", phone: "5511999990002", name: "Bia", company: null, createdAt: new Date(2) });
    db.seed("broadcastContact", { id: "c-3", audienceId: "aud-1", phone: "123", name: "Torto", company: null, createdAt: new Date(3) });
    db.seed("broadcastOptOut", { id: "o-1", organizationId: ORG, phone: "5511999990002", reason: "keyword" });
    return { db, prisma };
  }

  it("gera uma entrega por contato, marcando descadastrado e inválido como pulados", async () => {
    const { db, prisma } = await base();
    const resultado = await generateDeliveries(prisma, {
      id: "camp-1",
      organizationId: ORG,
      audienceId: "aud-1",
    });

    expect(resultado).toEqual({ queued: 1, skippedOptOut: 1, skippedInvalid: 1 });
    // O total da fila fecha com a audiência INTEIRA: quem não recebeu está
    // lá, dizendo por quê.
    expect(db.rows("broadcastDelivery")).toHaveLength(3);
    const pulados = db
      .rows("broadcastDelivery")
      .filter((linha) => linha.status === "skipped")
      .map((linha) => linha.skipReason)
      .sort();
    expect(pulados).toEqual(["invalid_phone", "opted_out"]);
  });
});

describe("resposta do contato", () => {
  function comEntrega() {
    const db = new MemoryPrisma();
    db.seed("conversation", { id: "conv-1", organizationId: ORG, externalChatId: "5511999990001@s.whatsapp.net" });
    db.seed("broadcastDelivery", {
      id: "d-1",
      organizationId: ORG,
      campaignId: "camp-1",
      conversationId: "conv-1",
      phone: "5511999990001",
      contactName: "Ana",
      status: "sent",
      sentAt: new Date(),
      repliedAt: null,
    });
    return db;
  }

  it("marca a resposta uma vez e não sobrescreve na segunda mensagem", async () => {
    const db = comEntrega();
    const prisma = db.client();

    const primeira = await handleBroadcastInbound(prisma, {
      organizationId: ORG,
      conversationId: "conv-1",
      content: "oi, quero saber mais",
    });
    expect(primeira.replied).toBe(true);
    const marcadaEm = db.rows("broadcastDelivery")[0]?.repliedAt as Date;

    const segunda = await handleBroadcastInbound(prisma, {
      organizationId: ORG,
      conversationId: "conv-1",
      content: "e o prazo?",
    });
    // A entrega já respondida sai do alcance: a métrica mede a PRIMEIRA
    // resposta, não a última mensagem do cliente.
    expect(segunda.replied).toBe(false);
    expect(db.rows("broadcastDelivery")[0]?.repliedAt).toBe(marcadaEm);
  });

  it('"SAIR" descadastra o telefone na organização inteira', async () => {
    const db = comEntrega();
    const prisma = db.client();

    const resultado = await handleBroadcastInbound(prisma, {
      organizationId: ORG,
      conversationId: "conv-1",
      content: "SAIR",
    });

    expect(resultado.optedOut).toBe(true);
    const descadastros = db.rows("broadcastOptOut");
    expect(descadastros).toHaveLength(1);
    expect(descadastros[0]?.phone).toBe("5511999990001");
    // A lista é da ORGANIZAÇÃO, não da campanha: quem pediu para sair não
    // recebe da próxima campanha também.
    expect(descadastros[0]?.organizationId).toBe(ORG);
  });

  it("descadastra pelo telefone da conversa quando não há entrega casada", async () => {
    const db = new MemoryPrisma();
    db.seed("conversation", { id: "conv-2", organizationId: ORG, externalChatId: "5511999990009@s.whatsapp.net" });
    const resultado = await handleBroadcastInbound(db.client(), {
      organizationId: ORG,
      conversationId: "conv-2",
      content: "parar",
    });
    expect(resultado.optedOut).toBe(true);
    expect(db.rows("broadcastOptOut")[0]?.phone).toBe("5511999990009");
  });

  it("registrar o mesmo descadastro duas vezes não duplica", async () => {
    const db = new MemoryPrisma();
    const prisma = db.client();
    for (let i = 0; i < 2; i += 1) {
      await registerOptOut(prisma, {
        organizationId: ORG,
        phone: "5511999990001",
        reason: "manual",
      });
    }
    expect(db.rows("broadcastOptOut")).toHaveLength(1);
  });
});

describe("permissões dos disparos", () => {
  it("apertar o botão de disparar nasce FECHADO até para supervisor", () => {
    const enviar = PERMISSION_ACTIONS.find((acao) => acao.key === "broadcast.send");
    expect(enviar).toBeDefined();
    // Montar a campanha é trabalho de supervisão; mandar a mensagem para
    // milhares de clientes de uma vez é decisão de quem responde pelo número.
    expect(enviar?.defaults.agent).toBe(false);
    expect(enviar?.defaults.supervisor).toBe(false);
  });

  it("ver e montar seguem o padrão de supervisão", () => {
    for (const chave of ["broadcast.view", "broadcast.audience.manage", "broadcast.campaign.manage"]) {
      const acao = PERMISSION_ACTIONS.find((item) => item.key === chave);
      expect(acao?.defaults.agent).toBe(false);
      expect(acao?.defaults.supervisor).toBe(true);
    }
  });
});
