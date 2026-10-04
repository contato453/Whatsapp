/**
 * Gravação de ligação que o AstraCalls diz NÃO EXISTIR.
 *
 * O AstraCalls não manda o id da gravação nos eventos: o sistema DEDUZ que
 * toda chamada atendida tem um MP3 com o id da própria chamada. Na prática
 * isso falha — ligação atendida no celular (fora do AstraCalls), gravação
 * apagada ou expirada lá —, e a tela mostrava o player com um alerta vermelho
 * que parecia defeito e convidava a clicar de novo para sempre.
 *
 * Quando o AstraCalls responde 404 para uma ligação já ASSENTADA, a API grava
 * a data em `Message.metadata` (esta chave) e a lista passa a dizer
 * "Gravação indisponível", sem player, sem download e sem botão de IA.
 *
 * A CARÊNCIA não é detalhe: o arquivo é escrito pelo AstraCalls DEPOIS de a
 * chamada terminar, e um 404 no primeiro minuto é só "ainda não ficou
 * pronto". Marcar aí apagaria para sempre uma gravação que ia existir.
 */
export const CALL_RECORDING_MISSING_METADATA_KEY = "recordingMissingAt";

/** Depois disto, contado do início da ligação, 404 do AstraCalls é definitivo. */
export const CALL_RECORDING_GRACE_MS = 30 * 60 * 1000;

/**
 * A ligação já passou da carência? Usa o início da chamada somado à duração
 * conhecida, porque uma ligação de 40 minutos ainda estaria em andamento no
 * fim de uma carência contada só do começo.
 */
export function isCallRecordingSettled(
  call: { timestamp: Date | string; durationSeconds?: number | null },
  now: Date = new Date(),
): boolean {
  const start = new Date(call.timestamp).getTime();
  if (!Number.isFinite(start)) return false;
  const duration = (call.durationSeconds ?? 0) * 1000;
  return now.getTime() - (start + duration) >= CALL_RECORDING_GRACE_MS;
}

/** A gravação desta ligação já foi dada como inexistente? */
export function isCallRecordingMissing(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const value = (metadata as Record<string, unknown>)[CALL_RECORDING_MISSING_METADATA_KEY];
  return typeof value === "string" && value.length > 0;
}
