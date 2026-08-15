import type { Server } from "socket.io";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import {
  LOGIN_SCHEDULE_WARNING_MINUTES,
  RealtimeEvents,
  SESSION_CLOSED_MESSAGE,
  type SessionClosedPayload,
  type SessionClosingPayload,
} from "@azvchat/shared";
import { loadAttendanceSettings } from "../lib/attendance-settings.js";
import { checkLoginSchedule } from "../lib/login-schedule.js";
import type { AuthTokenPayload } from "../lib/auth.js";

/**
 * Vigia do horário de uso nas abas abertas.
 *
 * A API já recusa qualquer requisição de quem está fora da janela — mas uma
 * aba parada na Inbox não faz requisição nenhuma: ela fica escutando o
 * socket. Sem este vigia, quem fosse "expulso" às 19:00 continuaria vendo
 * mensagem de cliente chegar na tela até tocar em alguma coisa.
 *
 * A cada minuto (a configuração tem precisão de minuto, então varrer mais
 * vezes não descobriria nada novo):
 *
 * 1. avisa quem está a cinco minutos ou menos do fechamento, reenviando a
 *    cada volta para o aviso contar para trás sozinho;
 * 2. encerra a sessão de quem passou do horário — evento primeiro, para a
 *    tela poder explicar, e desconexão logo depois.
 *
 * Os parâmetros são lidos do banco a cada volta, uma consulta por
 * organização com aba aberta: esticar o horário na tela de Parâmetros
 * cancela o aviso na volta seguinte, sem reiniciar nada.
 */
export class SessionScheduleWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly io: Server,
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error({ event: "session_schedule_sweep_failed", err }, "sweep_failed"),
      );
    }, this.intervalMs);
    // Não segura o processo no ar sozinho: quem manda no ciclo de vida é o
    // servidor HTTP, não este relógio.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma volta do vigia. Exposta para o teste chamar sem esperar um minuto. */
  async sweep(now = new Date()): Promise<void> {
    const sockets = [...this.io.sockets.sockets.values()];
    if (sockets.length === 0) return;

    const organizationIds = new Set<string>();
    for (const socket of sockets) {
      const user = socket.data.user as AuthTokenPayload | undefined;
      if (user) organizationIds.add(user.organizationId);
    }

    const settingsByOrg = new Map(
      await Promise.all(
        [...organizationIds].map(
          async (organizationId) =>
            [organizationId, await loadAttendanceSettings(this.prisma, organizationId)] as const,
        ),
      ),
    );

    for (const socket of sockets) {
      const user = socket.data.user as AuthTokenPayload | undefined;
      if (!user) continue;
      const settings = settingsByOrg.get(user.organizationId);
      if (!settings) continue;

      const status = checkLoginSchedule(settings, user.role, now);
      if (!status.enforced) continue;

      if (!status.allowed) {
        const payload: SessionClosedPayload = {
          reason: "login_schedule",
          message: SESSION_CLOSED_MESSAGE,
        };
        socket.emit(RealtimeEvents.SessionClosed, payload);
        this.logger.info({ event: "session_closed_by_schedule", userId: user.sub });
        // Um respiro antes de fechar o transporte, para o evento chegar. Não
        // abre brecha: a API já recusa toda requisição desta pessoa.
        setTimeout(() => socket.disconnect(true), 1_000).unref?.();
        continue;
      }

      if (
        status.minutesUntilClose !== null &&
        status.minutesUntilClose <= LOGIN_SCHEDULE_WARNING_MINUTES &&
        status.window
      ) {
        const payload: SessionClosingPayload = {
          minutesLeft: status.minutesUntilClose,
          closesAt: status.window.endTime,
        };
        socket.emit(RealtimeEvents.SessionClosing, payload);
      }
    }
  }
}
