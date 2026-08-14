import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Logger } from "pino";
import type { AuthTokenPayload } from "../lib/auth.js";

export interface VerifyToken {
  (token: string): AuthTokenPayload;
}

/** O que o usuário enxerga — `null` em instanceIds/departmentIds = admin. */
export interface RealtimeAccess {
  instanceIds: string[] | null;
  departmentIds: string[] | null;
}

export interface ResolveRealtimeAccess {
  (user: AuthTokenPayload): Promise<RealtimeAccess>;
}

/**
 * Camada de tempo real. As salas espelham exatamente as regras de acesso da
 * API — o que o usuário não pode buscar por HTTP também não chega no socket.
 *
 * - admin entra só na sala da organização e recebe tudo;
 * - supervisor entra nas salas dos números que tem, cruzadas com os
 *   departamentos dele;
 * - usuário comum entra nas mesmas salas, mas separadas entre "sem
 *   responsável" e "atribuída a mim", para não receber o atendimento que
 *   um colega já assumiu.
 *
 * Cada socket cai em um único grupo por evento, então não há entrega
 * duplicada.
 */
export function createRealtime(
  httpServer: HttpServer,
  options: {
    corsOrigins: string[];
    verifyToken: VerifyToken;
    resolveAccess: ResolveRealtimeAccess;
    logger: Logger;
  },
): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: options.corsOrigins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("unauthorized"));
      return;
    }
    let payload: AuthTokenPayload;
    try {
      payload = options.verifyToken(token);
    } catch {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.user = payload;
    options
      .resolveAccess(payload)
      .then((access) => {
        socket.data.access = access;
        next();
      })
      .catch((err) => {
        options.logger.warn({ event: "socket_access_failed", error: String(err) });
        next(new Error("unauthorized"));
      });
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthTokenPayload;
    const access = socket.data.access as RealtimeAccess;

    if (!access.instanceIds || !access.departmentIds) {
      // admin: organização inteira
      void socket.join(orgRoom(user.organizationId));
    } else {
      for (const instanceId of access.instanceIds) {
        joinInstanceRooms(socket, instanceId);
      }
    }

    options.logger.debug({ event: "socket_connected", userId: user.sub });
    socket.on("disconnect", () => {
      options.logger.debug({ event: "socket_disconnected", userId: user.sub });
    });
  });

  return io;
}

const NO_DEPARTMENT = "none";

/**
 * Salas de um número para um socket já autenticado. Conversa sem
 * departamento entra no balde "none" — é o caso de número sem departamento
 * padrão configurado.
 */
function joinInstanceRooms(socket: Socket, instanceId: string): void {
  const user = socket.data.user as AuthTokenPayload;
  const access = socket.data.access as RealtimeAccess;
  // Admin recebe tudo pela sala da organização; não usa sala por número.
  if (!access.departmentIds) return;

  // Eventos do próprio número (QR, status da conexão) não dependem de
  // departamento nem de responsável.
  void socket.join(instanceRoom(instanceId));
  for (const departmentKey of [...access.departmentIds, NO_DEPARTMENT]) {
    if (user.role === "supervisor") {
      void socket.join(supervisorRoom(instanceId, departmentKey));
    } else {
      void socket.join(unassignedRoom(instanceId, departmentKey));
      void socket.join(assigneeRoom(instanceId, departmentKey, user.sub));
    }
  }
}

/**
 * Acesso a número concedido no meio da sessão — hoje, o supervisor que
 * acabou de criar o número. As abas abertas dele entram nas salas na hora.
 *
 * Sem isso o QR Code, que se renova a cada poucos segundos, só chegaria
 * depois de recarregar a página: a pessoa ficaria encarando um código
 * vencido que o celular se recusa a ler.
 */
export function grantInstanceAccess(io: Server, userId: string, instanceId: string): void {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as AuthTokenPayload | undefined;
    if (user?.sub !== userId) continue;
    const access = socket.data.access as RealtimeAccess | undefined;
    if (access?.instanceIds && !access.instanceIds.includes(instanceId)) {
      access.instanceIds.push(instanceId);
    }
    joinInstanceRooms(socket, instanceId);
  }
}

export function orgRoom(organizationId: string): string {
  return `org:${organizationId}`;
}

export function instanceRoom(instanceId: string): string {
  return `instance:${instanceId}`;
}

function supervisorRoom(instanceId: string, departmentKey: string): string {
  return `sup:${instanceId}:${departmentKey}`;
}

function unassignedRoom(instanceId: string, departmentKey: string): string {
  return `free:${instanceId}:${departmentKey}`;
}

function assigneeRoom(instanceId: string, departmentKey: string, userId: string): string {
  return `mine:${instanceId}:${departmentKey}:${userId}`;
}

/**
 * Destinatários de um evento do número em si — QR Code e status da conexão.
 * Não carrega conteúdo de conversa, então basta ter o número liberado.
 */
export function instanceAudience(organizationId: string, instanceId: string): string[] {
  return [orgRoom(organizationId), instanceRoom(instanceId)];
}

/** O que o emissor precisa saber da conversa para calcular quem recebe. */
export interface ConversationAudienceRef {
  whatsappInstanceId: string;
  departmentId: string | null;
  assignedUserId: string | null;
}

/**
 * Destinatários de um evento de conversa: admin, os supervisores do
 * departamento que têm o número e, do lado dos usuários comuns, ou o
 * responsável atual ou todos quando ainda não há responsável.
 */
export function conversationAudience(
  organizationId: string,
  conversation: ConversationAudienceRef,
): string[] {
  const instanceId = conversation.whatsappInstanceId;
  const departmentKey = conversation.departmentId ?? NO_DEPARTMENT;
  return [
    orgRoom(organizationId),
    supervisorRoom(instanceId, departmentKey),
    conversation.assignedUserId
      ? assigneeRoom(instanceId, departmentKey, conversation.assignedUserId)
      : unassignedRoom(instanceId, departmentKey),
  ];
}
