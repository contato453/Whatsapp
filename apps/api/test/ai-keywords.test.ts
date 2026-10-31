import { describe, expect, it } from "vitest";
import { defaultAiAgentConfig, findAiKeyword } from "@azvchat/shared";
import { aiAgentConfigSchema, parseStoredAgentConfig } from "../src/services/ai/config-schema.js";

/**
 * Palavra-chave de ligar/desligar o agente: a regra de comparação e a
 * validação do cadastro. O efeito na conversa está em `ai-runtime.test.ts`.
 */
describe("findAiKeyword", () => {
  it("ignora maiúsculas, acentos e espaços repetidos", () => {
    expect(findAiKeyword("Quero   FALAR com a Atendênte", ["falar com a atendente"])).toBe("falar com a atendente");
  });

  it("casa a frase inteira como palavra, nunca dentro de outra", () => {
    expect(findAiKeyword("bom dia", ["ia"])).toBeNull();
    expect(findAiKeyword("atendente humanos", ["atendente humano"])).toBeNull();
    expect(findAiKeyword("ok, ia!", ["ia"])).toBe("ia");
  });

  it("pontuação faz parte do código: '#ia' não casa com 'ia' solto", () => {
    expect(findAiKeyword("eu ia te ligar", ["#ia"])).toBeNull();
    expect(findAiKeyword("passo para a #IA agora", ["#ia"])).toBe("#ia");
  });

  it("texto vazio e lista vazia não casam nada", () => {
    expect(findAiKeyword(null, ["#ia"])).toBeNull();
    expect(findAiKeyword("#ia", [])).toBeNull();
    expect(findAiKeyword("#ia", ["   "])).toBeNull();
  });
});

describe("configuração das palavras-chave", () => {
  it("agente gravado antes do campo existir ganha as listas vazias", () => {
    const stored = defaultAiAgentConfig() as unknown as Record<string, unknown>;
    delete stored.keywords;
    expect(parseStoredAgentConfig(stored).keywords).toEqual({ activate: [], deactivate: [] });
  });

  it("recusa a mesma frase nas duas listas e frase repetida", () => {
    const both = defaultAiAgentConfig();
    both.keywords = { activate: ["#IA"], deactivate: ["#ia"] };
    expect(aiAgentConfigSchema.safeParse(both).success).toBe(false);

    const repeated = defaultAiAgentConfig();
    repeated.keywords = { activate: ["#ia", "#Ia"], deactivate: [] };
    expect(aiAgentConfigSchema.safeParse(repeated).success).toBe(false);

    const ok = defaultAiAgentConfig();
    ok.keywords = { activate: ["#ia"], deactivate: ["#humano"] };
    expect(aiAgentConfigSchema.safeParse(ok).success).toBe(true);
  });
});
