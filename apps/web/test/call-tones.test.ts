import { describe, expect, it } from "vitest";
import {
  CALL_RINGBACK_PATTERN,
  callEndReasonFromProvider,
} from "@azvchat/shared";
import { REMOTE_AUDIO_THRESHOLD, rms, tonePulseStarts } from "@/lib/call-tones";

describe("tom de chamada (padrão brasileiro)", () => {
  it("ringback: um pulso a cada 5 s (1 s de tom, 4 s de silêncio)", () => {
    expect(tonePulseStarts(CALL_RINGBACK_PATTERN, 0, 12_000)).toEqual([0, 5000, 10_000]);
  });

  it("reabastecer a partir de onde parou não repete pulso", () => {
    const first = tonePulseStarts(CALL_RINGBACK_PATTERN, 0, 10_000);
    const next = tonePulseStarts(CALL_RINGBACK_PATTERN, 10_000, 20_000);
    expect(first).toEqual([0, 5000]);
    expect(next).toEqual([10_000, 15_000]);
  });

  it("silêncio não passa do limiar; voz passa", () => {
    expect(rms(new Float32Array(1024))).toBe(0);
    const voice = new Float32Array(1024).map((_, i) => 0.2 * Math.sin(i / 5));
    expect(rms(voice)).toBeGreaterThan(REMOTE_AUDIO_THRESHOLD);
    const comfortNoise = new Float32Array(1024).map((_, i) => 0.003 * Math.sin(i));
    expect(rms(comfortNoise)).toBeLessThan(REMOTE_AUDIO_THRESHOLD);
  });
});

describe("motivo de encerramento", () => {
  const r = (reason: string | null, accepted = false, endedByUs = false) =>
    callEndReasonFromProvider({ reason, accepted, endedByUs }).reason;

  it("traduz o que o provedor manda", () => {
    expect(r(null)).toBe("no_answer");
    expect(r("timeout")).toBe("no_answer");
    expect(r("busy")).toBe("busy");
    expect(r("rejected")).toBe("rejected");
    expect(r("not_registered")).toBe("not_found");
    expect(r("algo_estranho")).toBe("failed");
  });

  it("atendida vence o motivo; nós desligando antes vence tudo", () => {
    expect(r("timeout", true)).toBe("completed");
    expect(r("busy", false, true)).toBe("canceled");
    expect(r(null, true, true)).toBe("completed");
  });
});
