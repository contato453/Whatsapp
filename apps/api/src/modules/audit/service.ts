import type { PrismaClient } from "@zapdesk/database";
import type { Logger } from "pino";

export interface AuditEntry {
  organizationId?: string | null;
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Registro de auditoria — nunca deve derrubar a operação principal:
 * falha de auditoria é logada e engolida.
 */
export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  record(entry: AuditEntry): void {
    void this.prisma.auditLog
      .create({
        data: {
          organizationId: entry.organizationId ?? null,
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : undefined,
          ip: entry.ip ?? null,
        },
      })
      .catch((err) => {
        this.logger.warn({ event: "audit_write_failed", action: entry.action, error: String(err) });
      });
  }
}
