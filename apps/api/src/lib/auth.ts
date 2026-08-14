import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@azvchat/database";
import { hasRole, type UserRole } from "@azvchat/shared";
import { ForbiddenError, UnauthorizedError } from "./errors.js";

/** Payload do JWT — nunca incluir dados sensíveis aqui. */
export interface AuthTokenPayload {
  sub: string;
  organizationId: string;
  role: UserRole;
  name: string;
  email: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}

/** Confere no banco a sessão que o token afirma ter. */
export interface SessionVerifier {
  (payload: AuthTokenPayload): Promise<AuthTokenPayload>;
}

declare module "fastify" {
  interface FastifyInstance {
    verifySession: SessionVerifier;
  }
}

/**
 * O JWT é uma foto do momento do login e vale por dias. Papel, status e
 * nome podem ter mudado desde então, e quem manda é o banco:
 *
 * - desativar alguém tira o acesso na hora, não quando o token vencer.
 *   Antes, quem saía do escritório continuava lendo e respondendo cliente
 *   pelo WhatsApp da casa até o token expirar;
 * - rebaixar alguém tira a administração na hora;
 * - o nome vem do banco, então a assinatura da mensagem nunca sai com o
 *   nome antigo.
 *
 * Custa uma consulta por chave primária em cada requisição autenticada.
 */
export function createSessionVerifier(prisma: PrismaClient): SessionVerifier {
  return async (payload) => {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, organizationId: true, role: true, name: true, email: true, status: true },
    });
    if (!user || user.status !== "active") throw new UnauthorizedError();
    return {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
      name: user.name,
      email: user.email,
    };
  };
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new UnauthorizedError();
  }
  // A partir daqui `request.user` é o estado atual do banco, não o do token.
  request.user = await request.server.verifySession(request.user);
}

/**
 * A hierarquia admin > supervisor > agent vive em `@azvchat/shared`, para o
 * menu do frontend obedecer exatamente à mesma regra que protege a rota.
 */
export { hasRole };

/** preHandler que exige papel mínimo. */
export function requireRole(minimumRole: UserRole) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    if (!hasRole(request.user.role, minimumRole)) {
      throw new ForbiddenError();
    }
  };
}
