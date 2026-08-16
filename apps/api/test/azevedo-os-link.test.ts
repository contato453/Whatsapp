import { describe, expect, it } from "vitest";
import { AZEVEDO_OS_SOURCE, canManageAzevedoOsLink } from "@azvchat/shared";
import { planReferenceUpdate, REFERENCE_AUDIT_ACTIONS } from "../src/lib/azevedo-os-link.js";
import { AppError } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

/**
 * Quem pode mexer no vínculo com a empresa do Azevedo-OS.
 *
 * O ponto delicado que estes testes protegem: `externalReference` é o mesmo
 * campo do código de cadastro manual, que é de `agent`. Sem a regra, bastaria
 * digitar no campo "Cadastro" para desvincular a empresa — uma alteração de
 * vínculo feita por quem não pode alterar vínculo, e sem auditoria de
 * desvinculação.
 */

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";

function semVinculo(role: AuthTokenPayload["role"], nextReference: string | null, nextSource: "manual" | typeof AZEVEDO_OS_SOURCE = "manual") {
  return planReferenceUpdate({
    currentReference: null,
    currentSource: null,
    nextReference,
    nextSource,
    role,
  });
}

function vinculada(role: AuthTokenPayload["role"], nextReference: string | null, nextSource: "manual" | typeof AZEVEDO_OS_SOURCE = AZEVEDO_OS_SOURCE) {
  return planReferenceUpdate({
    currentReference: EMPRESA,
    currentSource: AZEVEDO_OS_SOURCE,
    nextReference,
    nextSource,
    role,
  });
}

describe("vincular empresa", () => {
  it("admin vincula, e a gravação confirma a empresa no Azevedo-OS antes", () => {
    const plan = semVinculo("admin", EMPRESA, AZEVEDO_OS_SOURCE);
    expect(plan).toEqual({
      reference: EMPRESA,
      source: AZEVEDO_OS_SOURCE,
      auditAction: REFERENCE_AUDIT_ACTIONS.linked,
      verifyCompany: true,
    });
  });

  it("supervisor vincula", () => {
    expect(semVinculo("supervisor", EMPRESA, AZEVEDO_OS_SOURCE).auditAction).toBe(
      REFERENCE_AUDIT_ACTIONS.linked,
    );
  });

  it("agent não vincula — 403", () => {
    const erro = (() => {
      try {
        semVinculo("agent", EMPRESA, AZEVEDO_OS_SOURCE);
      } catch (err) {
        return err;
      }
    })();
    expect(erro).toBeInstanceOf(AppError);
    expect(erro).toMatchObject({ statusCode: 403, code: "forbidden" });
  });
});

describe("trocar empresa", () => {
  it("supervisor troca, e a ação registrada é a de troca (não a de vínculo)", () => {
    const plan = vinculada("supervisor", OUTRA);
    expect(plan.reference).toBe(OUTRA);
    expect(plan.auditAction).toBe(REFERENCE_AUDIT_ACTIONS.changed);
    expect(plan.verifyCompany).toBe(true);
  });

  it("agent não troca", () => {
    expect(() => vinculada("agent", OUTRA)).toThrow(AppError);
  });
});

describe("desvincular empresa", () => {
  it("supervisor desvincula: some a referência e a fonte", () => {
    expect(vinculada("supervisor", null)).toEqual({
      reference: null,
      source: null,
      auditAction: REFERENCE_AUDIT_ACTIONS.unlinked,
      verifyCompany: false,
    });
  });

  it("agent não desvincula, nem limpando o campo de cadastro", () => {
    expect(() => vinculada("agent", null, "manual")).toThrow(AppError);
  });
});

describe("código de cadastro manual continua como era", () => {
  it("agent grava e apaga o código em conversa sem vínculo", () => {
    expect(semVinculo("agent", "EMPRESA 001")).toEqual({
      reference: "EMPRESA 001",
      source: "manual",
      auditAction: REFERENCE_AUDIT_ACTIONS.manual,
      verifyCompany: false,
    });
    expect(semVinculo("agent", null).auditAction).toBe(REFERENCE_AUDIT_ACTIONS.manual);
  });

  it("conversa vinculada recusa código manual até para o admin", () => {
    // Desvincular é decisão explícita, não efeito colateral de digitar.
    expect(() => vinculada("admin", "EMPRESA 001", "manual")).toThrow(AppError);
  });
});

describe("hierarquia de papéis do vínculo", () => {
  it("é a mesma que a tela usa para desenhar os botões", () => {
    expect(canManageAzevedoOsLink("admin")).toBe(true);
    expect(canManageAzevedoOsLink("supervisor")).toBe(true);
    expect(canManageAzevedoOsLink("agent")).toBe(false);
  });
});
