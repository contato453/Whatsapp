import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@azvchat/shared";
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
 * Regras de permissão por papel. Pura e testável.
 * admin > supervisor > agent.
 */
const ROLE_LEVEL: Record<UserRole, number> = {
  admin: 3,
  supervisor: 2,
  agent: 1,
};

export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[minimumRole];
}

/** preHandler que exige papel mínimo. */
export function requireRole(minimumRole: UserRole) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request);
    if (!hasRole(request.user.role, minimumRole)) {
      throw new ForbiddenError();
    }
  };
}
