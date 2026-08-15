import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** Erro de domínio com status HTTP — mensagens seguras para o cliente. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(entity = "Recurso") {
    super(`${entity} não encontrado`, 404, "not_found");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Sem permissão para esta ação") {
    super(message, 403, "forbidden");
  }
}

export class UnauthorizedError extends AppError {
  /**
   * O `code` distingue o motivo para o cliente: sessão encerrada pelo fim do
   * horário de uso não é token vencido, e a tela precisa dizer isso em vez
   * de "sessão expirada", que faria a pessoa tentar entrar de novo à toa.
   */
  constructor(message = "Não autenticado", code = "unauthorized") {
    super(message, 401, code);
  }
}

interface HttpishError {
  statusCode?: number;
  code?: string;
  message?: string;
}

function asHttpishError(error: unknown): HttpishError {
  return typeof error === "object" && error !== null ? (error as HttpishError) : {};
}

/** Handler global: nunca vaza detalhes internos; loga tudo estruturado. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "validation_error",
        message: "Dados inválidos",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code ?? "app_error",
        message: error.message,
      });
    }
    // Erros do próprio Fastify (rate limit, payload grande etc.)
    const httpish = asHttpishError(error);
    if (typeof httpish.statusCode === "number" && httpish.statusCode < 500) {
      return reply.status(httpish.statusCode).send({
        error: httpish.code ?? "request_error",
        message: httpish.message ?? "Requisição inválida",
      });
    }
    request.log.error({ err: error, url: request.url }, "unhandled_error");
    return reply.status(500).send({
      error: "internal_error",
      message: "Erro interno do servidor",
    });
  });
}
