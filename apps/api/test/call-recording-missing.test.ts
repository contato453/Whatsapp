import { describe, expect, it } from "vitest";
import {
  CALL_RECORDING_GRACE_MS,
  CALL_RECORDING_MISSING_METADATA_KEY,
  isCallRecordingMissing,
  isCallRecordingSettled,
} from "@azvchat/shared";
import { noteMissingCallRecording } from "../src/lib/call-recording.js";
import { MemoryPrisma } from "./helpers/memory-prisma.js";

/**
 * GRAVAÇÃO QUE O ASTRACALLS DIZ NÃO EXISTIR.
 *
 * O que estes casos trancam:
 *   1. 404 logo depois da ligação é "ainda não ficou pronta" e NÃO marca nada
 *      — marcar cedo apagaria de vez uma gravação que ia aparecer;
 *   2. passada a carência, o 404 marca a ligação e preserva o resto do
 *      metadata (o `recordingId` inclusive);
 *   3. a carência conta do FIM da ligação, não do começo.
 */

const NOW = new Date("2026-10-04T12:00:00Z");
const CALL = { id: "call-1", organizationId: "org-1" };

function seedCall(db: MemoryPrisma, minutesAgo: number, durationSeconds = 60) {
  db.seed("message", {
    id: "call-1",
    organizationId: "org-1",
    type: "call",
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000),
    metadata: { recordingId: "rec-1", durationSeconds, callStatus: "accepted" },
  });
}

describe("isCallRecordingSettled", () => {
  it("conta a carência a partir do fim da ligação", () => {
    const start = new Date(NOW.getTime() - CALL_RECORDING_GRACE_MS - 60_000);
    expect(isCallRecordingSettled({ timestamp: start, durationSeconds: 0 }, NOW)).toBe(true);
    // A mesma ligação, mas de 40 minutos: ainda dentro da carência.
    expect(isCallRecordingSettled({ timestamp: start, durationSeconds: 40 * 60 }, NOW)).toBe(false);
  });

  it("data inválida nunca é dada como assentada", () => {
    expect(isCallRecordingSettled({ timestamp: "não é data" }, NOW)).toBe(false);
  });
});

describe("noteMissingCallRecording", () => {
  it("ligação recente: diz que ainda não ficou pronta e não marca nada", async () => {
    const db = new MemoryPrisma();
    seedCall(db, 2);
    const error = await noteMissingCallRecording(db.client(), CALL, NOW);
    expect(error.code).toBe("recording_not_ready");
    expect(isCallRecordingMissing(db.rows("message")[0]?.metadata)).toBe(false);
  });

  it("ligação assentada: marca como inexistente e preserva o resto", async () => {
    const db = new MemoryPrisma();
    seedCall(db, 120);
    const error = await noteMissingCallRecording(db.client(), CALL, NOW);
    expect(error.code).toBe("recording_missing");
    expect(error.statusCode).toBe(404);
    const metadata = db.rows("message")[0]?.metadata as Record<string, unknown>;
    expect(metadata[CALL_RECORDING_MISSING_METADATA_KEY]).toBe(NOW.toISOString());
    expect(metadata.recordingId).toBe("rec-1");
    expect(metadata.callStatus).toBe("accepted");
    expect(isCallRecordingMissing(metadata)).toBe(true);
  });

  it("ligação de outra organização não é tocada", async () => {
    const db = new MemoryPrisma();
    seedCall(db, 120);
    const error = await noteMissingCallRecording(db.client(), { id: "call-1", organizationId: "org-2" }, NOW);
    expect(error.code).toBe("recording_not_ready");
    expect(isCallRecordingMissing(db.rows("message")[0]?.metadata)).toBe(false);
  });

  it("marcar de novo não troca a data da primeira vez", async () => {
    const db = new MemoryPrisma();
    seedCall(db, 120);
    await noteMissingCallRecording(db.client(), CALL, NOW);
    await noteMissingCallRecording(db.client(), CALL, new Date(NOW.getTime() + 3_600_000));
    const metadata = db.rows("message")[0]?.metadata as Record<string, unknown>;
    expect(metadata[CALL_RECORDING_MISSING_METADATA_KEY]).toBe(NOW.toISOString());
  });
});
