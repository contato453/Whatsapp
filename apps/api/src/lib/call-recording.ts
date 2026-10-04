import type { Prisma, PrismaClient } from "@azvchat/database";
import {
  CALL_RECORDING_MISSING_METADATA_KEY,
  isCallRecordingSettled,
} from "@azvchat/shared";
import { AppError } from "./errors.js";

/**
 * O AstraCalls respondeu que a gravação desta ligação não existe.
 *
 * Passada a carência (`isCallRecordingSettled`), o 404 é definitivo: grava a
 * data em `Message.metadata` para a lista parar de oferecer player, download
 * e IA para um arquivo que não vai aparecer. Antes dela, é só "ainda não
 * ficou pronto" e nada é gravado — marcar cedo apagaria de vez uma gravação
 * que o AstraCalls ainda ia escrever.
 *
 * Relê o `metadata` em vez de usar a cópia de quem chamou, para não pisar no
 * que outra escrita mudou no meio (a análise, a exclusão por período). O
 * `recordingId` FICA: é o registro do que o sistema esperava encontrar, e
 * apagá-lo esconderia a diferença entre "nunca houve" e "sumiu".
 *
 * Devolve o erro já pronto para a rota lançar, com a frase de cada caso.
 */
export async function noteMissingCallRecording(
  prisma: PrismaClient,
  call: { id: string; organizationId: string },
  now: Date = new Date(),
): Promise<AppError> {
  // A organização vai no filtro mesmo depois de a rota já ter achado a
  // ligação no recorte de quem pediu: escrita por id solto é o tipo de
  // atalho que um dia vira gravação na linha de outro escritório.
  const row = await prisma.message.findFirst({
    where: { id: call.id, organizationId: call.organizationId, type: "call" },
    select: { timestamp: true, metadata: true },
  });
  const metadata = (row?.metadata as Record<string, unknown> | null) ?? {};
  const durationSeconds = typeof metadata.durationSeconds === "number" ? metadata.durationSeconds : null;
  if (!row || !isCallRecordingSettled({ timestamp: row.timestamp, durationSeconds }, now)) {
    return new AppError(
      "A gravação desta ligação ainda não ficou pronta. Tente de novo em alguns minutos.",
      404,
      "recording_not_ready",
    );
  }
  if (!metadata[CALL_RECORDING_MISSING_METADATA_KEY]) {
    await prisma.message.update({
      where: { id: call.id },
      data: {
        metadata: { ...metadata, [CALL_RECORDING_MISSING_METADATA_KEY]: now.toISOString() } as Prisma.InputJsonValue,
      },
    });
  }
  return recordingMissingError();
}

export function recordingMissingError(): AppError {
  return new AppError(
    "A gravação desta ligação não existe no AstraCalls. Ela pode ter sido atendida fora do sistema ou apagada por lá.",
    404,
    "recording_missing",
  );
}
