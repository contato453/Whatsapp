import type { CallEndReason } from "@azvchat/shared";

/**
 * Falha ao DISCAR, já traduzida num motivo. Vive aqui, ao lado do provider,
 * para a API recusar a chamada com a frase certa sem conhecer o formato de
 * erro do AstraCalls (nada fora deste pacote sabe que ele existe).
 */
export class CallStartError extends Error {
  constructor(public readonly reason: Extract<CallEndReason, "not_found" | "failed">) {
    super(reason === "not_found" ? "call_not_found" : "call_start_failed");
    this.name = "CallStartError";
  }
}
