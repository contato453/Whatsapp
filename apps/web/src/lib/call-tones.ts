import {
  CALL_BUSY_PATTERN,
  CALL_NOT_FOUND_SEQUENCE_HZ,
  CALL_NOT_FOUND_TONE_MS,
  CALL_RINGBACK_PATTERN,
  CALL_TONE_FREQUENCY_HZ,
} from "@azvchat/shared";

/**
 * Tons de progresso da ligação de SAÍDA, sintetizados com Web Audio (nada de
 * arquivo de áudio no repositório, igual ao som de notificação).
 *
 * POR QUE O TOM É LOCAL, E POR QUE ELE É A ALTERNATIVA E NÃO O PADRÃO: a
 * ligação aqui é uma chamada de WhatsApp, e o WhatsApp NÃO manda som de
 * chamada pela rede — quem toca o "tuuu" é o aplicativo de quem liga. O áudio
 * remoto já é ligado ao alto-falante assim que a primeira trilha chega (no
 * `ontrack`, antes do atendimento), então, se o provedor um dia passar a
 * mandar o próprio retorno, ele é ouvido sem nada daqui. Para os dois não
 * virarem ruído, `watchRemoteAudio` escuta o áudio remoto e CALA o tom local
 * no primeiro sinal de som de verdade vindo do outro lado (retorno do provedor
 * ou a voz do cliente que acabou de atender).
 */

/** Volume base do tom: baixo de propósito, o tom é aviso e não pode assustar. */
const TONE_GAIN = 0.12;
/** Quanto do futuro fica agendado no relógio do áudio a cada volta. */
const LOOKAHEAD_S = 10;
/** Rampa para o tom não estalar ao ligar e desligar. */
const RAMP_S = 0.015;

/** Início (ms, relativo a `fromMs`) de cada pulso de um padrão liga/desliga. Puro, testado. */
export function tonePulseStarts(
  pattern: { onMs: number; offMs: number },
  fromMs: number,
  untilMs: number,
): number[] {
  const cycle = pattern.onMs + pattern.offMs;
  if (cycle <= 0 || untilMs <= fromMs) return [];
  const starts: number[] = [];
  const first = Math.ceil(fromMs / cycle) * cycle;
  for (let t = first; t < untilMs; t += cycle) starts.push(t);
  return starts;
}

/** RMS de um trecho de áudio no domínio do tempo (-1..1). Puro, testado. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Acima disto o outro lado está mandando som DE VERDADE. Silêncio e ruído de
 * conforto do WebRTC ficam bem abaixo (~0,001 a 0,005).
 */
export const REMOTE_AUDIO_THRESHOLD = 0.015;
/** Leituras seguidas acima do limiar para contar como som (3 × 100 ms). */
export const REMOTE_AUDIO_SUSTAIN = 3;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class CallTonePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private refill: number | null = null;
  private watcher: number | null = null;
  private watchCtx: AudioContext | null = null;

  /**
   * @param volume 0..1 — o mesmo volume do elemento que toca a chamada, para
   * o retorno acompanhar a voz e nunca estourar acima dela.
   */
  constructor(private readonly volume = 1) {}

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = TONE_GAIN * Math.min(1, Math.max(0, this.volume));
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      // A pessoa acabou de clicar em "Ligar", então o navegador libera o
      // áudio; se ainda assim recusar, o tom falha calado e a ligação segue.
      void ctx.resume().catch(() => undefined);
      return ctx;
    } catch {
      return null;
    }
  }

  private pulse(atS: number, durationS: number, frequency: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    env.gain.setValueAtTime(0, atS);
    env.gain.linearRampToValueAtTime(1, atS + RAMP_S);
    env.gain.setValueAtTime(1, Math.max(atS + RAMP_S, atS + durationS - RAMP_S));
    env.gain.linearRampToValueAtTime(0, atS + durationS);
    osc.connect(env).connect(master);
    osc.start(atS);
    osc.stop(atS + durationS + 0.01);
    osc.onended = () => {
      this.oscillators = this.oscillators.filter((o) => o !== osc);
    };
    this.oscillators.push(osc);
  }

  /**
   * Agenda um padrão repetido no RELÓGIO DO ÁUDIO, e não em `setTimeout`: aba
   * em segundo plano tem os timers do JavaScript estrangulados, e o tom sairia
   * picotado. A volta de 1 s só reabastece o que já está agendado.
   */
  private repeat(pattern: { onMs: number; offMs: number }, totalMs: number | null): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const origin = ctx.currentTime + 0.05;
    let scheduledUntilMs = 0;
    const fill = () => {
      if (!this.ctx) return;
      const nowMs = (this.ctx.currentTime - origin) * 1000;
      const horizon = nowMs + LOOKAHEAD_S * 1000;
      const until = totalMs === null ? horizon : Math.min(horizon, totalMs);
      for (const start of tonePulseStarts(pattern, scheduledUntilMs, until)) {
        this.pulse(origin + start / 1000, pattern.onMs / 1000, CALL_TONE_FREQUENCY_HZ);
      }
      scheduledUntilMs = Math.max(scheduledUntilMs, until);
      if (totalMs !== null && scheduledUntilMs >= totalMs && this.refill !== null) {
        window.clearInterval(this.refill);
        this.refill = null;
      }
    };
    fill();
    this.refill = window.setInterval(fill, 1000);
  }

  /** Tom de chamada (ringback): 1 s de tom, 4 s de silêncio, até `stop()`. */
  startRingback(): void {
    this.stop();
    this.repeat(CALL_RINGBACK_PATTERN, null);
  }

  /** Tom de ocupado: pulsos curtos por alguns segundos. */
  playBusy(): void {
    this.stop();
    this.repeat(CALL_BUSY_PATTERN, CALL_BUSY_PATTERN.totalMs);
  }

  /** Três tons subindo, duas vezes: o aviso de "número não existe". */
  playNotFound(): void {
    this.stop();
    const ctx = this.ensureContext();
    if (!ctx) return;
    const tone = CALL_NOT_FOUND_TONE_MS / 1000;
    let at = ctx.currentTime + 0.05;
    for (let round = 0; round < 2; round++) {
      for (const hz of CALL_NOT_FOUND_SEQUENCE_HZ) {
        this.pulse(at, tone, hz);
        at += tone;
      }
      at += 1;
    }
  }

  /** Cala NA HORA: nada agendado sobrevive, para nunca cobrir a voz do cliente. */
  stop(): void {
    if (this.refill !== null) {
      window.clearInterval(this.refill);
      this.refill = null;
    }
    if (this.master && this.ctx) {
      try {
        this.master.gain.cancelScheduledValues(this.ctx.currentTime);
        this.master.gain.setValueAtTime(0, this.ctx.currentTime);
      } catch {
        // contexto já fechado: nada a calar
      }
    }
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // oscilador que nem começou ou já terminou
      }
    }
    this.oscillators = [];
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  /**
   * Escuta o áudio REMOTO e chama `onSound` uma vez, quando o outro lado manda
   * som de verdade. Não toca nada: o analisador não é ligado à saída.
   */
  watchRemoteAudio(stream: MediaStream, onSound: (level: number) => void): void {
    this.unwatch();
    const Ctor = audioContextCtor();
    if (!Ctor || stream.getAudioTracks().length === 0) return;
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      void ctx.resume().catch(() => undefined);
      const buffer = new Float32Array(analyser.fftSize);
      let above = 0;
      this.watchCtx = ctx;
      this.watcher = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        const level = rms(buffer);
        above = level > REMOTE_AUDIO_THRESHOLD ? above + 1 : 0;
        if (above >= REMOTE_AUDIO_SUSTAIN) {
          this.unwatch();
          onSound(level);
        }
      }, 100);
    } catch {
      this.unwatch();
    }
  }

  unwatch(): void {
    if (this.watcher !== null) {
      window.clearInterval(this.watcher);
      this.watcher = null;
    }
    const ctx = this.watchCtx;
    this.watchCtx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  dispose(): void {
    this.stop();
    this.unwatch();
  }
}
