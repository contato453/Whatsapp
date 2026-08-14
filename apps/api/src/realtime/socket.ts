import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Logger } from "pino";
import type { AuthTokenPayload } from "../lib/auth.js";

export interface VerifyToken {
  (token: string): AuthTokenPayload;
}

/**
 * Camada de tempo real. Cada cliente autenticado entra na sala da sua
 * organização; todos os eventos são publicados por organização.
 */
export function createRealtime(
  httpServer: HttpServer,
  options: { corsOrigins: string[]; verifyToken: VerifyToken; logger: Logger },
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
    try {
      const payload = options.verifyToken(token);
      socket.data.user = payload;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthTokenPayload;
    void socket.join(orgRoom(user.organizationId));
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
