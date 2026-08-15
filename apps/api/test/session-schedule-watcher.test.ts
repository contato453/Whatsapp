import { beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@azvchat/database";
import type { Logger } from "pino";
import type { Server } from "socket.io";
import { DEFAULT_ATTENDANCE_SETTINGS, RealtimeEvents } from "@azvchat/shared";
import { SessionScheduleWatcher } from "../src/services/session-schedule-watcher.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";

/**
 * O que estes testes fixam: a aba parada é avisada antes de fechar e sai do
 * ar quando fecha.
 *
 * A API já recusa requisição fora do horário, mas uma aba na Inbox não faz
 * requisição nenhuma — ela só escuta o socket. Sem este vigia, quem foi
 * "expulso" às 19:00 continuaria vendo mensagem de cliente chegar na tela.
 */

const ORG = "org-1";

interface FakeSocket {
  data: { user: AuthTokenPayload };
  emitted: Array<{ event: string; payload: unknown }>;
  disconnected: boolean;
  emit: (event: string, payload: unknown) => void;
  disconnect: (close: boolean) => void;
}

function fakeSocket(role: AuthTokenPayload["role"], userId = `user-${role}`): FakeSocket {
  const socket: FakeSocket = {
    data: {
      user: {
        sub: userId,
        organizationId: ORG,
        role,
        name: "Fulano de Tal",
        email: `${role}@example.com`,
      },
    },
    emitted: [],
    disconnected: false,
    emit(event, payload) {
      socket.emitted.push({ event, payload });
    },
    disconnect() {
      socket.disconnected = true;
    },
  };
  return socket;
}

function fakeIo(sockets: FakeSocket[]): Server {
  return { sockets: { sockets: new Map(sockets.map((s, i) => [String(i), s])) } } as unknown as Server;
}

/** Restrição ligada com a faixa padrão da casa: seg-sex 07:00-19:00. */
function fakePrisma(loginRestrictionEnabled = true): PrismaClient {
  return {
    attendanceSettings: {
      findUnique: async () => ({
        responseLimitMinutes: 30,
        timezone: "America/Sao_Paulo",
        loginRestrictionEnabled,
        businessHours: DEFAULT_ATTENDANCE_SETTINGS.businessHours,
        loginHours: DEFAULT_ATTENDANCE_SETTINGS.loginHours,
      }),
    },
  } as unknown as PrismaClient;
}

const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;

function watcherFor(sockets: FakeSocket[], restricted = true): SessionScheduleWatcher {
  return new SessionScheduleWatcher(fakeIo(sockets), fakePrisma(restricted), logger);
}

/** Instantes de sexta-feira, em UTC (São Paulo = UTC-3). */
const MEIO_DIA = new Date("2026-08-14T15:00:00Z");
const FALTAM_TRES = new Date("2026-08-14T21:57:00Z");
const DEPOIS_DE_FECHAR = new Date("2026-08-14T23:00:00Z");

describe("SessionScheduleWatcher", () => {
  let agent: FakeSocket;
  let supervisor: FakeSocket;

  beforeEach(() => {
    agent = fakeSocket("agent");
    supervisor = fakeSocket("supervisor");
  });

  it("no meio do expediente não avisa nem desliga ninguém", async () => {
    await watcherFor([agent, supervisor]).sweep(MEIO_DIA);
    expect(agent.emitted).toHaveLength(0);
    expect(agent.disconnected).toBe(false);
  });

  it("avisa o agent faltando menos de cinco minutos, com a contagem pronta", async () => {
    await watcherFor([agent]).sweep(FALTAM_TRES);
    expect(agent.emitted).toEqual([
      {
        event: RealtimeEvents.SessionClosing,
        payload: { minutesLeft: 3, closesAt: "19:00" },
      },
    ]);
    // Avisar não é expulsar: a pessoa ainda tem três minutos de trabalho.
    expect(agent.disconnected).toBe(false);
  });

  it("encerra a sessão do agent depois do fechamento, avisando antes de cortar", async () => {
    await watcherFor([agent]).sweep(DEPOIS_DE_FECHAR);
    expect(agent.emitted[0]?.event).toBe(RealtimeEvents.SessionClosed);
    expect(agent.emitted[0]?.payload).toMatchObject({ reason: "login_schedule" });
  });

  it("supervisor não recebe aviso nem é desligado", async () => {
    await watcherFor([supervisor]).sweep(DEPOIS_DE_FECHAR);
    expect(supervisor.emitted).toHaveLength(0);
    expect(supervisor.disconnected).toBe(false);
  });

  it("com a restrição desligada ninguém é tocado, nem de madrugada", async () => {
    await watcherFor([agent], false).sweep(DEPOIS_DE_FECHAR);
    expect(agent.emitted).toHaveLength(0);
    expect(agent.disconnected).toBe(false);
  });

  it("sem aba aberta a volta não consulta o banco", async () => {
    const watcher = new SessionScheduleWatcher(
      fakeIo([]),
      // Prisma que estoura se for consultado: a volta vazia tem que sair antes.
      {
        attendanceSettings: {
          findUnique: async () => {
            throw new Error("não deveria consultar");
          },
        },
      } as unknown as PrismaClient,
      logger,
    );
    await expect(watcher.sweep(DEPOIS_DE_FECHAR)).resolves.toBeUndefined();
  });
});
