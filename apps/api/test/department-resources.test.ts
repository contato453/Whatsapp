import { describe, expect, it } from "vitest";
import { canWriteInDepartment, departmentResourceScope } from "../src/lib/access.js";

/**
 * Etiquetas e respostas rápidas por departamento.
 *
 * `null` em departmentIds significa admin (sem restrição); `null` em
 * departmentId significa recurso geral, da organização inteira.
 */

describe("departmentResourceScope", () => {
  it("admin não recebe filtro", () => {
    expect(departmentResourceScope(null)).toEqual({});
  });

  it("usuário enxerga os gerais e os dos departamentos dele", () => {
    expect(departmentResourceScope(["dep-1", "dep-2"])).toEqual({
      OR: [{ departmentId: null }, { departmentId: { in: ["dep-1", "dep-2"] } }],
    });
  });

  it("usuário sem departamento ainda enxerga os gerais", () => {
    // Lista vazia não pode virar "vê tudo": o filtro continua existindo.
    expect(departmentResourceScope([])).toEqual({
      OR: [{ departmentId: null }, { departmentId: { in: [] } }],
    });
  });
});

describe("canWriteInDepartment", () => {
  it("admin escreve em qualquer departamento e no geral", () => {
    expect(canWriteInDepartment(null, "dep-1")).toBe(true);
    expect(canWriteInDepartment(null, null)).toBe(true);
  });

  it("usuário escreve nos departamentos dele", () => {
    expect(canWriteInDepartment(["dep-1"], "dep-1")).toBe(true);
  });

  it("usuário não escreve em departamento alheio", () => {
    expect(canWriteInDepartment(["dep-1"], "dep-2")).toBe(false);
  });

  it("usuário não cria recurso geral", () => {
    // Geral vale para a organização inteira — é decisão de administrador.
    expect(canWriteInDepartment(["dep-1"], null)).toBe(false);
  });

  it("usuário sem departamento não escreve em lugar nenhum", () => {
    expect(canWriteInDepartment([], "dep-1")).toBe(false);
    expect(canWriteInDepartment([], null)).toBe(false);
  });
});
