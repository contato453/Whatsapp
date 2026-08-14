import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Logger } from "pino";
import type { AuthTokenPayload } from "../lib/auth.js";

export interface VerifyToken {
  (token: string): AuthTokenPayload;
}

export interface ResolveInstanceAccess {
  /** Conexões liberadas para o usuário — `null` = todas. */
  (user: AuthTokenPayload): Promise<string[] | null>;
}

/**
 * Camada de tempo real. Quem enxerga todas as conexões entra na sala da
 * organização; quem tem acesso restrito entra apenas nas salas dos números
 * liberados — assim eventos de outros números nunca chegam ao navegador.
 */
export function createRealtime(
  httpServer: HttpServer,
  options: {
    corsOrigins: string[];
    verifyToken: VerifyToken;
    resolveInstanceAccess: ResolveInstanceAccess;
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
      .resolveInstanceAccess(payload)
      .then((allowed) => {
        socket.data.allowedInstanceIds = allowed;
        next();
      })
      .catch((err) => {
        options.logger.warn({ event: "socket_access_failed", error: String(err) });
        next(new Error("unauthorized"));
      });
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthTokenPayload;
    const allowed = socket.data.allowedInstanceIds as string[] | null;
    if (allowed) {
      for (const instanceId of allowed) {
        void socket.join(instanceRoom(instanceId));
      }
    } else {
      void socket.join(orgRoom(user.organizationId));
    }
    options.logger.debug({ event: "socket_connected", userId: user.sub });
    socket.on("disconnect", () => {
      options.logger.debug({ event: "socket_disconnected", userId: user.sub });
    });
  });

  return io;
}

export function orgRoom(organizationId: string): string {
  return `org:${organizationId}`;
}

export function instanceRoom(instanceId: string): string {
  return `instance:${instanceId}`;
}

/**
 * Destinatários de um evento ligado a um número: quem vê a organização
 * inteira mais quem tem acesso apenas àquele número. Cada socket está em
 * um único desses grupos, então não há entrega duplicada.
 */
export function instanceAudience(organizationId: string, instanceId: string): string[] {
  return [orgRoom(organizationId), instanceRoom(instanceId)];
}
