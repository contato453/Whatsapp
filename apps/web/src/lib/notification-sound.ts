import type { NotificationSound, NotificationVolume } from "@azvchat/shared";

/**
 * Sons de notificação sintetizados na hora, com Web Audio.
 *
 * Nada de arquivo de áudio no repositório: são três toques curtos que cabem
 * em uma tabela de frequências, e assim não há binário para versionar, baixar
 * no primeiro acesso nem manter em cache.
 *
 * O componente que toca não sabe nada de Web Audio — daqui saem apenas
 * `playNotificationSound`, `previewNotificationSound` e as funções de
 * destravar/retomar o contexto.
 */

interface Tone {
  frequency: number;
  /** Seno é o timbre mais suave; triângulo dá o brilho de sino do som 2. */
  wave: OscillatorType;
  /** Início da nota, em segundos, contado do começo do som. */
  offset: number;
  duration: number;
}

/**
 * Três timbres reconhecíveis entre si e discretos: no máximo duas notas,
 * nenhum passando de 320 ms. Sirene e sequência longa estão fora de propósito
 * — o aviso concorre com o telefone da mesa, não deve competir com ele.
 */
const SOUNDS: Record<Exclude<NotificationSound, "none">, readonly Tone[]> = {
  // Dois toques subindo, A5 → D6.
  sound_1: [
    { frequency: 880, wave: "sine", offset: 0, duration: 0.12 },
    { frequency: 1174.66, wave: "sine", offset: 0.12, duration: 0.12 },
  ],
  // Sino: nota única, mais aguda, com cauda um pouco maior.
  sound_2: [{ frequency: 1567.98, wave: "triangle", offset: 0, duration: 0.32 }],
  // Dois toques graves descendo, E5 → A4.
  sound_3: [
    { frequency: 659.25, wave: "sine", offset: 0, duration: 0.15 },
    { frequency: 440, wave: "sine", offset: 0.15, duration: 0.15 },
  ],
};

/**
 * Ganho de pico por volume. Os degraus são multiplicativos (cerca de 2,5×
 * entre um e outro) porque audição é logarítmica: passos iguais soariam
 * quase idênticos. O topo fica em 0,4 de propósito — acima disso um seno
 * curto já incomoda em fone de ouvido.
 */
const VOLUME_GAIN: Record<NotificationVolume, number> = {
  low: 0.06,
  medium: 0.16,
  high: 0.4,
};

/** Piso do envelope: `exponentialRampToValueAtTime` não aceita zero. */
const SILENCE = 0.0001;
/** Ataque curto, mas não instantâneo: sem isso o som estala. */
const ATTACK_SECONDS = 0.012;

let context: AudioContext | null = null;
let blockedAnnounced = false;
const blockedListeners = new Set<() => void>();

type AudioContextConstructor = new () => AudioContext;

/**
 * Cria o contexto na primeira necessidade. Quem escolheu "Nenhum" nunca chega
 * aqui, então não paga nada em runtime.
 */
function audioContext(): AudioContext | null {
  if (context) return context;
  if (typeof window === "undefined") return null;
  const withWebkit = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  const Constructor: AudioContextConstructor | undefined =
    window.AudioContext ?? withWebkit.webkitAudioContext;
  // Navegador sem Web Audio degrada em silêncio: nada na tela, nada no console.
  if (!Constructor) return null;
  try {
    context = new Constructor();
  } catch {
    return null;
  }
  return context;
}

function announceBlocked(): void {
  if (blockedAnnounced) return;
  blockedAnnounced = true;
  for (const listener of blockedListeners) {
    try {
      listener();
    } catch {
      // Aviso na tela nunca pode derrubar o recebimento da mensagem.
    }
  }
}

/**
 * Avisa uma única vez por sessão que o navegador está segurando o áudio.
 * Devolve a função de cancelar a inscrição.
 */
export function onNotificationAudioBlocked(listener: () => void): () => void {
  blockedListeners.add(listener);
  return () => {
    blockedListeners.delete(listener);
  };
}

/**
 * Destrava o áudio aproveitando um clique ou uma tecla do usuário.
 *
 * Chrome e Safari só deixam tocar depois de alguma interação na página. Sem
 * isso o som não sai na primeira aba do dia — a pessoa recebe a mensagem em
 * silêncio e conclui que o recurso está com defeito.
 */
export function unlockNotificationAudio(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state === "running") return;
  void ctx.resume().catch(() => undefined);
}

/**
 * Retoma o contexto que o navegador suspendeu com a aba muito tempo em
 * segundo plano. Só religa a saída de áudio: nada do que foi suprimido
 * enquanto ela dormia volta a tocar.
 */
export function resumeNotificationAudio(): void {
  if (!context || context.state === "running") return;
  void context.resume().catch(() => undefined);
}

function schedule(ctx: AudioContext, tones: readonly Tone[], peak: number): void {
  const start = ctx.currentTime;
  for (const tone of tones) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.frequency, start + tone.offset);

    // Envelope suave: sobe rápido e cai exponencialmente até o fim da nota.
    const from = start + tone.offset;
    const to = from + tone.duration;
    gain.gain.setValueAtTime(SILENCE, from);
    gain.gain.exponentialRampToValueAtTime(peak, from + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(SILENCE, to);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(from);
    oscillator.stop(to);
  }
}

/**
 * Toca o som escolhido. Falha de áudio nunca sobe para a tela: se o navegador
 * bloqueia, o dispositivo não tem saída ou o contexto morreu, a função apenas
 * volta em silêncio (avisando os inscritos, no caso do bloqueio).
 */
export function playNotificationSound(
  sound: NotificationSound,
  volume: NotificationVolume,
): void {
  if (sound === "none") return;
  const ctx = audioContext();
  if (!ctx) return;
  const tones = SOUNDS[sound];
  const peak = VOLUME_GAIN[volume];

  if (ctx.state === "running") {
    try {
      schedule(ctx, tones, peak);
    } catch {
      // Silêncio de propósito: som é acessório, mensagem é o que importa.
    }
    return;
  }

  // Suspenso: tenta religar e, se o navegador recusar, avisa uma vez só.
  void ctx
    .resume()
    .then(() => {
      if (ctx.state !== "running") {
        announceBlocked();
        return;
      }
      schedule(ctx, tones, peak);
    })
    .catch(() => announceBlocked());
}

/**
 * Preview da tela de Configurações. Sempre parte de um clique, então o
 * contexto já está destravado — e, ao contrário do aviso de mensagem, não
 * passa pelo intervalo mínimo: quem está escolhendo o som precisa poder
 * comparar dois toques em seguida.
 */
export function previewNotificationSound(
  sound: NotificationSound,
  volume: NotificationVolume,
): void {
  unlockNotificationAudio();
  playNotificationSound(sound, volume);
}
