import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { callAudioErrorMessage } from "@/lib/call-audio-error";

function domError(name: string): Error {
  const err = new Error("x");
  err.name = name;
  return err;
}

describe("callAudioErrorMessage", () => {
  it("diz que falta microfone quando o navegador não acha nenhum", () => {
    expect(callAudioErrorMessage(domError("NotFoundError"))).toMatch(/Nenhum microfone encontrado/);
  });

  it("diz que o microfone está ocupado", () => {
    expect(callAudioErrorMessage(domError("NotReadableError"))).toMatch(/ocupado/);
  });

  it("mantém a permissão negada", () => {
    expect(callAudioErrorMessage(domError("NotAllowedError"))).toMatch(/Permissão de microfone negada/);
  });

  it("aponta o servidor quando a troca de SDP é recusada pela API", () => {
    expect(callAudioErrorMessage(new ApiError("Erro interno", 500))).toMatch(/servidor de ligações/);
  });

  it("cai na frase genérica para o que não reconhece", () => {
    expect(callAudioErrorMessage(new Error("?"))).toBe("Falha ao conectar o áudio.");
  });
});
