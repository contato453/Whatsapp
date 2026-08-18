import { describe, expect, it } from "vitest";
import { AZEVEDO_OS_SOURCE, defaultPermission } from "@azvchat/shared";
import { planReferenceUpdate, REFERENCE_AUDIT_ACTIONS } from "../src/lib/azevedo-os-link.js";
import { AppError } from "../src/lib/errors.js";

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

/**
 * As duas chaves do catálogo, traduzidas do papel para facilitar a leitura
 * dos casos: hoje `azevedo_os.link` é de supervisor para cima e
 * `azevedo_os.relink` também, mas o motor decide por CHAVE, não por papel —
 * os casos abaixo passam a chave, não o cargo.
 */
type Papel = "admin" | "supervisor" | "agent";

function chaves(role: Papel) {
  if (role === "admin") return { canLink: true, canRelink: true };
  return {
    canLink: defaultPermission("azevedo_os.link", role),
    canRelink: defaultPermission("azevedo_os.relink", role),
  };
}

function semVinculo(role: Papel, nextReference: string | null, nextSource: "manual" | typeof AZEVEDO_OS_SOURCE = "manual") {
  return planReferenceUpdate({
    currentReference: null,
    currentSource: null,
    nextReference,
    nextSource,
    ...chaves(role),
  });
}

function vinculada(role: Papel, nextReference: string | null, nextSource: "manual" | typeof AZEVEDO_OS_SOURCE = AZEVEDO_OS_SOURCE) {
  return planReferenceUpdate({
    currentReference: EMPRESA,
    currentSource: AZEVEDO_OS_SOURCE,
    nextReference,
    nextSource,
    ...chaves(role),
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

  it("atendente VINCULA conversa vazia — é rotina de classificação", () => {
    // Padrão do catálogo: `azevedo_os.link` é sim/sim. Preencher empresa em
    // conversa que está sem empresa é o trabalho de quem atende.
    expect(semVinculo("agent", EMPRESA, AZEVEDO_OS_SOURCE).auditAction).toBe(
      REFERENCE_AUDIT_ACTIONS.linked,
    );
  });

  it("mas o atendente NÃO troca vínculo já existente — 403", () => {
    // `azevedo_os.relink` é não/sim: mexer na classificação de outra pessoa
    // anexa a conversa ao cliente errado quando dá errado.
    const erro = (() => {
      try {
        vinculada("agent", OUTRA);
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

/**
 * VINCULAR e TROCAR são duas chaves separadas de propósito: preencher
 * conversa vazia é rotina; mexer em vínculo já feito por outra pessoa anexa
 * a conversa ao cliente errado quando dá errado.
 */
describe("vincular e trocar são chaves independentes", () => {
  it("quem só pode vincular preenche conversa vazia", () => {
    const plan = planReferenceUpdate({
      currentReference: null,
      currentSource: null,
      nextReference: EMPRESA,
      nextSource: AZEVEDO_OS_SOURCE,
      canLink: true,
      canRelink: false,
    });
    expect(plan.auditAction).toBe(REFERENCE_AUDIT_ACTIONS.linked);
  });

  it("quem só pode vincular NÃO troca vínculo existente", () => {
    expect(() =>
      planReferenceUpdate({
        currentReference: EMPRESA,
        currentSource: AZEVEDO_OS_SOURCE,
        nextReference: OUTRA,
        nextSource: AZEVEDO_OS_SOURCE,
        canLink: true,
        canRelink: false,
      }),
    ).toThrow(AppError);
  });

  it("quem só pode vincular NÃO desfaz vínculo existente", () => {
    expect(() =>
      planReferenceUpdate({
        currentReference: EMPRESA,
        currentSource: AZEVEDO_OS_SOURCE,
        nextReference: null,
        nextSource: "manual",
        canLink: true,
        canRelink: false,
      }),
    ).toThrow(AppError);
  });

  it("quem só pode trocar não preenche conversa vazia", () => {
    expect(() =>
      planReferenceUpdate({
        currentReference: null,
        currentSource: null,
        nextReference: EMPRESA,
        nextSource: AZEVEDO_OS_SOURCE,
        canLink: false,
        canRelink: true,
      }),
    ).toThrow(AppError);
  });
});
