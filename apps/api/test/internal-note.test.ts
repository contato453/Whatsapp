import { describe, expect, it } from "vitest";
import { canManageInternalNote } from "@azvchat/shared";

/**
 * A regra decide o 403 da API e os botões de editar/excluir em DOIS lugares da
 * tela (cartão do chat e item do painel lateral). O teste existe para o painel
 * nunca oferecer o que a rota recusa.
 */
describe("canManageInternalNote", () => {
  const autor = "user-1";
  const outro = "user-2";

  it("autor mexe na própria nota, mesmo sendo agent", () => {
    expect(
      canManageInternalNote({ authorId: autor, actorId: autor, actorRole: "agent" }),
    ).toBe(true);
  });

  it("agent não mexe em nota de terceiro", () => {
    expect(
      canManageInternalNote({ authorId: outro, actorId: autor, actorRole: "agent" }),
    ).toBe(false);
  });

  it("supervisor e admin mexem em nota de qualquer um", () => {
    expect(
      canManageInternalNote({ authorId: outro, actorId: autor, actorRole: "supervisor" }),
    ).toBe(true);
    expect(
      canManageInternalNote({ authorId: outro, actorId: autor, actorRole: "admin" }),
    ).toBe(true);
  });

  it("sessão ainda carregando nega — esconder botão custa menos que 403", () => {
    expect(
      canManageInternalNote({ authorId: autor, actorId: null, actorRole: null }),
    ).toBe(false);
  });

  it("nota de usuário excluído só é gerenciada por supervisor para cima", () => {
    expect(
      canManageInternalNote({ authorId: null, actorId: autor, actorRole: "agent" }),
    ).toBe(false);
    expect(
      canManageInternalNote({ authorId: null, actorId: autor, actorRole: "supervisor" }),
    ).toBe(true);
  });
});
