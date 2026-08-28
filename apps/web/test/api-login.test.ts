import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";

/**
 * A tela de login precisa mostrar o motivo REAL da recusa. O 401 do
 * `/auth/login` significa "Credenciais inválidas" (senha errada ou cadastro
 * desativado), e mascará-lo com "Sessão expirada" — o tratamento genérico de
 * token vencido — faz a pessoa tentar de novo à toa sem entender o porquê.
 *
 * Este teste trava a regressão: já aconteceu de a atendente ver "Sessão
 * expirada" na primeira tentativa, sem sessão nenhuma para expirar.
 */
function mockJsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api.login", () => {
  it("propaga a mensagem real do 401 em vez de 'Sessão expirada'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockJsonResponse(401, { error: "unauthorized", message: "Credenciais inválidas" }),
      ),
    );

    await expect(api.login({ email: "x@y.z", password: "errada" })).rejects.toMatchObject({
      message: "Credenciais inválidas",
      code: "unauthorized",
      status: 401,
    });
  });

  it("preserva o 403 de horário de login (mensagem e código)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        mockJsonResponse(403, {
          error: "login_outside_schedule",
          message: "Fora do horário permitido",
        }),
      ),
    );

    await expect(api.login({ email: "x@y.z", password: "ok" })).rejects.toMatchObject({
      message: "Fora do horário permitido",
      code: "login_outside_schedule",
    });
  });
});

describe("request (rota interna)", () => {
  it("mantém 'Sessão expirada' no 401 de sessão vencida", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse(401, { error: "unauthorized" })));

    const error = await api.get("/conversations").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("Sessão expirada");
  });
});
