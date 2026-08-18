import { describe, expect, it } from "vitest";
import { canManageInternalNote, defaultPermission } from "@azvchat/shared";

/**
 * A regra decide o 403 da API e os botões de editar/excluir em DOIS lugares da
 * tela (cartão do chat e item do painel lateral). O teste existe para o painel
 * nunca oferecer o que a rota recusa.
 *
 * Desde o menu de Permissões, o que entra aqui é a CHAVE `note.delete_other`
 * já resolvida, e não o papel: com o papel, ligar a chave na tela mudaria a
 * API e não mudaria o botão.
 */
describe("canManageInternalNote", () => {
  const autor = "user-1";
  const outro = "user-2";

  it("autor mexe na própria nota, mesmo sem a chave", () => {
    // Isto é código, não configuração: nenhuma combinação de chaves tranca
    // a pessoa fora da própria nota.
    expect(
      canManageInternalNote({ authorId: autor, actorId: autor, canManageOthers: false }),
    ).toBe(true);
  });

  it("sem a chave, não mexe em nota de terceiro", () => {
    expect(
      canManageInternalNote({ authorId: outro, actorId: autor, canManageOthers: false }),
    ).toBe(false);
  });

  it("com a chave, mexe em nota de qualquer um", () => {
    expect(
      canManageInternalNote({ authorId: outro, actorId: autor, canManageOthers: true }),
    ).toBe(true);
  });

  it("sessão ainda carregando nega — esconder botão custa menos que 403", () => {
    expect(
      canManageInternalNote({ authorId: autor, actorId: null, canManageOthers: false }),
    ).toBe(false);
  });

  it("nota de usuário excluído só é gerenciada por quem tem a chave", () => {
    expect(
      canManageInternalNote({ authorId: null, actorId: autor, canManageOthers: false }),
    ).toBe(false);
    expect(
      canManageInternalNote({ authorId: null, actorId: autor, canManageOthers: true }),
    ).toBe(true);
  });

  it("o padrão da chave reproduz a regra antiga: não/sim", () => {
    expect(defaultPermission("note.delete_other", "agent")).toBe(false);
    expect(defaultPermission("note.delete_other", "supervisor")).toBe(true);
  });
});
