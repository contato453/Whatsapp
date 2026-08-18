import { describe, expect, it } from "vitest";
import {
  UNREAD_BADGE_CAP,
  bumpUnreadCount,
  formatUnreadBadge,
  setUnreadCount,
} from "@/lib/unread";

/**
 * O contador é por usuário e vive fora do DTO da conversa — estas são as
 * regras puras que a tela usa para mantê-lo vivo entre uma carga e outra.
 */
describe("badge de não lidas", () => {
  it("acima do teto vira 99+, e o teto casa com o da API", () => {
    expect(formatUnreadBadge(1)).toBe("1");
    expect(formatUnreadBadge(99)).toBe("99");
    expect(formatUnreadBadge(100)).toBe("99+");
    expect(UNREAD_BADGE_CAP).toBe(99);
  });
});

describe("mapa de não lidas", () => {
  it("mensagem recebida soma na conversa certa, sem tocar nas outras", () => {
    const depois = bumpUnreadCount({ a: 2, b: 5 }, "a");
    expect(depois).toEqual({ a: 3, b: 5 });
  });

  it("conversa que ainda não estava no mapa começa em 1", () => {
    expect(bumpUnreadCount({}, "nova")).toEqual({ nova: 1 });
  });

  it("passar do teto não muda nada: o badge já diz 99+", () => {
    const cheio = { a: UNREAD_BADGE_CAP + 1 };
    expect(bumpUnreadCount(cheio, "a")).toBe(cheio);
  });

  it("ler zera só a conversa lida", () => {
    expect(setUnreadCount({ a: 4, b: 1 }, "a", 0)).toEqual({ a: 0, b: 1 });
  });

  it("valor igual devolve o mesmo objeto — não força render à toa", () => {
    const atual = { a: 0 };
    expect(setUnreadCount(atual, "a", 0)).toBe(atual);
  });
});
