import { spawn } from "node:child_process";

/**
 * Plumbing do ffmpeg — um único lugar que sabe abrir o processo, alimentar o
 * stdin por pipe e juntar o stdout.
 *
 * Existe porque há DOIS usos de conversão de áudio no sistema, e eles não são
 * a mesma regra: a normalização do que SAI para o WhatsApp
 * (`normalize-audio.ts`, que decide container e codec pelo que o aplicativo do
 * cliente toca) e a conversão para MP3 do que a equipe BAIXA (`mp3.ts`, que
 * decide pelo que o computador do escritório abre). Duplicar o tratamento de
 * processo entre os dois é que traria o defeito clássico daqui: um dos lados
 * esquecendo de drenar o stderr, ou de matar o processo no timeout, e a
 * requisição ficando pendurada sem ninguém entender por quê.
 *
 * O processo roda separado, lendo e escrevendo por pipe, então o laço de
 * eventos do Node não fica preso e a API segue atendendo o resto.
 */

/**
 * Conversão que não deu certo. Quem chama decide o que fazer: no envio a
 * mensagem NÃO sai (melhor o atendente ver um erro do que o cliente receber um
 * áudio que não toca); no download o atendente recebe uma frase em português e
 * a opção de baixar o original.
 */
export class AudioConversionError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "AudioConversionError";
  }
}

/** Teto de tempo do ffmpeg. Um arquivo dentro do limite de upload converte em
 *  poucos segundos; o teto existe para entrada corrompida não segurar a
 *  requisição para sempre. */
export const FFMPEG_TIMEOUT_MS = 60_000;

export function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const ffmpeg = spawn("ffmpeg", args);
    const out: Buffer[] = [];
    let stderr = "";

    const timer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      finish(() => reject(new AudioConversionError("Conversão de áudio demorou demais", "timeout")));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    // Sem drenar o stderr o buffer do sistema enche e o ffmpeg trava.
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-500);
    });
    ffmpeg.on("error", (err) => {
      finish(() =>
        reject(new AudioConversionError(`ffmpeg indisponível: ${String(err)}`, "ffmpeg_unavailable")),
      );
    });
    ffmpeg.on("close", (code) => {
      if (code === 0 && out.length > 0) finish(() => resolve(Buffer.concat(out)));
      else
        finish(() =>
          reject(
            new AudioConversionError(
              `ffmpeg terminou com ${String(code)}: ${stderr}`,
              "ffmpeg_failed",
            ),
          ),
        );
    });
    // EPIPE acontece quando o ffmpeg desiste antes de ler tudo; o motivo real
    // vem no 'close', então aqui basta não derrubar o processo.
    ffmpeg.stdin.on("error", () => undefined);
    ffmpeg.stdin.end(input);
  });
}
