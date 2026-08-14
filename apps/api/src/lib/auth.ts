import type { FastifyReply, FastifyRequest } from "fastify";
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

export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new UnauthorizedError();
  }
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
