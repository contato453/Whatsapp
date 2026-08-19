import { describe, expect, it } from "vitest";
import { CONVERSATION_STATUS_COLORS } from "@azvchat/shared";
import {
  queueCellStyle,
  queueSlice,
  resolvedCellStyle,
  resolvedSlice,
  rowAssignmentToken,
  rowLabel,
} from "@/lib/report-cells";

/**
 * O que estes testes trancam na tela:
 *
 * 1. **zero não recebe cor** — colorir a célula vazia pinta a tabela inteira
 *    e some com o sinal;
 * 2. a cor sai de `CONVERSATION_STATUS_COLORS`, nunca escrita aqui;
 * 3. o recorte que a célula manda para a lista é o esperado, inclusive o de
 *    concluídas, que é do PERÍODO e não filtra responsável de agora.
 */

const ANA = "77777777-7777-4777-8777-777777777777";

describe("cor das células de fila", () => {
  it("zero não tem preenchimento", () => {
    expect(queueCellStyle(0, 10, "open")).toBeUndefined();
  });

  it("a cor vem do enum compartilhado, e o tom acompanha o volume", () => {
    const fraco = queueCellStyle(1, 100, "open");
    const forte = queueCellStyle(100, 100, "open");
    const [r, g, b] = [22, 163, 74]; // #16a34a, o verde de "Aberto"
    expect(CONVERSATION_STATUS_COLORS.open).toBe("#16a34a");
    expect(fraco?.backgroundColor).toContain(`rgba(${r}, ${g}, ${b}`);
    expect(forte?.backgroundColor).toContain(`rgba(${r}, ${g}, ${b}`);
    const alpha = (estilo: string | undefined): number =>
      Number(String(estilo).replace(/.*,\s*([\d.]+)\)$/, "$1"));
    expect(alpha(fraco?.backgroundColor)).toBeLessThan(alpha(forte?.backgroundColor));
    // Teto baixo o bastante para o texto escuro da tabela continuar legível.
    expect(alpha(forte?.backgroundColor)).toBeLessThanOrEqual(0.44);
  });

  it("cada status usa a própria cor", () => {
    expect(queueCellStyle(5, 5, "waiting_client")?.backgroundColor).toContain("234, 179, 8");
    expect(queueCellStyle(5, 5, "waiting_internal")?.backgroundColor).toContain("220, 38, 38");
  });

  it("concluídas tem tratamento próprio: contorno, não preenchimento", () => {
    const estilo = resolvedCellStyle(3);
    expect(estilo?.backgroundColor).toBeUndefined();
    expect(estilo?.color).toBe(CONVERSATION_STATUS_COLORS.resolved);
    expect(resolvedCellStyle(0)).toBeUndefined();
  });
});

describe("recorte que a célula manda para a lista", () => {
  it("célula de fila leva status e token da pessoa", () => {
    const slice = queueSlice({ kind: "user", userId: ANA, name: "Ana" }, "open", 4);
    expect(slice.query).toEqual({ assignment: `user:${ANA}`, status: "open" });
    expect(slice.cellValue).toBe(4);
    expect(slice.scopeNote).toBe("situação de agora");
  });

  it("célula de concluídas leva o intervalo e NÃO o responsável de agora", () => {
    const slice = resolvedSlice(
      { kind: "user", userId: ANA, name: "Ana" },
      2,
      "2026-08-01T00:00:00.000Z",
      "2026-08-19T00:00:00.000Z",
    );
    expect(slice.query).toEqual({
      resolvedBy: ANA,
      resolvedFrom: "2026-08-01T00:00:00.000Z",
      resolvedTo: "2026-08-19T00:00:00.000Z",
    });
    // O cabeçalho do painel precisa dizer que o recorte é do período.
    expect(slice.scopeNote).toContain("concluídas entre");
  });

  it("órfã e coletivo são tokens diferentes — não se somam", () => {
    expect(rowAssignmentToken({ kind: "unassigned" })).toBe("none");
    expect(rowAssignmentToken({ kind: "all_users" })).toBe("all_users");
    expect(rowLabel({ kind: "unassigned" })).toBe("Sem responsável");
    expect(rowLabel({ kind: "all_users" })).toBe("@todos");
  });

  it("células diferentes têm chaves diferentes, para o destaque não vazar", () => {
    const ref = { kind: "user", userId: ANA, name: "Ana" } as const;
    expect(queueSlice(ref, "open", 1).key).not.toBe(queueSlice(ref, "waiting_client", 1).key);
    expect(queueSlice(ref, "open", 1).key).not.toBe(
      queueSlice({ kind: "unassigned" }, "open", 1).key,
    );
  });
});
