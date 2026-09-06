import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@azvchat/database";

/**
 * Prisma EM MEMÓRIA, só o suficiente para exercitar o motor de IA de ponta
 * a ponta sem banco: tabelas como arrays, `where` com igualdade, `in`,
 * `gt/lt/gte`, `not`, `OR`, relação aninhada (`agent: { status }`), `some`;
 * `include` por convenção de chave estrangeira (`agentId` → `aiAgent`).
 *
 * Não é um Prisma: é o dublê que os testes do motor precisam. Método que o
 * código chamar e este arquivo não implementar lança na hora, com o nome —
 * assim o teste reprova pelo motivo certo em vez de passar em silêncio.
 */

type Row = Record<string, unknown>;

interface Relation {
  /** Coluna nesta tabela com o id da outra (belongs-to)... */
  localKey?: string;
  /** ...ou coluna na outra tabela apontando para esta (has-many). */
  foreignKey?: string;
  table: string;
  many?: boolean;
}

const RELATIONS: Record<string, Record<string, Relation>> = {
  aiSession: {
    agent: { localKey: "agentId", table: "aiAgent" },
    agentVersion: { localKey: "agentVersionId", table: "aiAgentVersion" },
    endedBy: { localKey: "endedByUserId", table: "user" },
    automation: { localKey: "automationId", table: "aiAutomation" },
  },
  aiAutomation: { agent: { localKey: "agentId", table: "aiAgent" } },
  aiAgent: {
    departments: { foreignKey: "agentId", table: "aiAgentDepartment", many: true },
    knowledgeSources: { foreignKey: "agentId", table: "aiAgentKnowledgeSource", many: true },
    versions: { foreignKey: "agentId", table: "aiAgentVersion", many: true },
    sessions: { foreignKey: "agentId", table: "aiSession", many: true },
    createdBy: { localKey: "createdById", table: "user" },
  },
  aiAgentDepartment: { department: { localKey: "departmentId", table: "department" } },
  aiAgentVersion: { createdBy: { localKey: "createdById", table: "user" } },
  conversation: {
    assignedUser: { localKey: "assignedUserId", table: "user" },
    department: { localKey: "departmentId", table: "department" },
    instance: { localKey: "whatsappInstanceId", table: "whatsAppInstance" },
    archivedBy: { localKey: "archivedByUserId", table: "user" },
    tags: { foreignKey: "conversationId", table: "conversationTag", many: true },
  },
  conversationTag: { tag: { localKey: "tagId", table: "tag" } },
  tag: { departments: { foreignKey: "tagId", table: "tagDepartment", many: true } },
  aiUsageLog: { conversation: { localKey: "conversationId", table: "conversation" } },
  followUpExecution: { rule: { localKey: "ruleId", table: "followUpRule" } },
  followUpRule: {
    departments: { foreignKey: "ruleId", table: "followUpRuleDepartment", many: true },
    steps: { foreignKey: "ruleId", table: "followUpRuleStep", many: true },
  },
  aiKnowledgeSource: { agents: { foreignKey: "sourceId", table: "aiAgentKnowledgeSource", many: true } },
  attendanceSettings: {
    businessHours: { foreignKey: "settingsId", table: "attendanceBusinessHours", many: true },
    loginHours: { foreignKey: "settingsId", table: "attendanceLoginHours", many: true },
  },
};

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number | string);
  const bv = b instanceof Date ? b.getTime() : (b as number | string);
  if (av === bv) return 0;
  return (av as number) > (bv as number) ? 1 : -1;
}

export class MemoryPrisma {
  readonly tables = new Map<string, Row[]>();

  constructor() {
    for (const name of [
      "organization", "user", "department", "whatsAppInstance", "conversation", "message", "tag", "tagDepartment",
      "conversationTag", "internalNote", "scheduledMessage", "conversationAssignmentHistory", "personProfile",
      "attendanceSettings", "attendanceBusinessHours", "attendanceLoginHours", "quickReply", "rolePermission",
      "userWhatsAppInstance", "userDepartment", "auditLog",
      "aiProviderConfig", "aiSettings", "aiAgent", "aiAgentDepartment", "aiAgentVersion", "aiKnowledgeSource",
      "aiAgentKnowledgeSource", "aiAutomation", "aiSession", "aiUsageLog",
      "followUpRule", "followUpRuleDepartment", "followUpRuleStep", "followUpExecution", "followUpExecutionLog",
    ]) {
      this.tables.set(name, []);
    }
  }

  seed(table: string, row: Row): Row {
    const full = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...row };
    this.rows(table).push(full);
    return full;
  }

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`MemoryPrisma: tabela desconhecida ${table}`);
    return rows;
  }

  /** O objeto que se passa como `PrismaClient`. */
  client(): PrismaClient {
    const self = this;
    const handler: ProxyHandler<object> = {
      get(_target, prop: string) {
        if (prop === "$transaction") {
          return async (input: unknown) => {
            if (typeof input === "function") return (input as (tx: unknown) => Promise<unknown>)(self.client());
            return Promise.all(input as Promise<unknown>[]);
          };
        }
        if (prop === "then") return undefined;
        if (!self.tables.has(prop)) throw new Error(`MemoryPrisma: modelo não implementado: ${prop}`);
        return self.delegate(prop);
      },
    };
    return new Proxy({}, handler) as unknown as PrismaClient;
  }

  private delegate(table: string) {
    const self = this;
    return {
      findUnique: async (args: { where: Row; include?: Row; select?: Row }) => self.first(table, args),
      findUniqueOrThrow: async (args: { where: Row; include?: Row; select?: Row }) => {
        const row = self.first(table, args);
        if (!row) throw new Error("not found");
        return row;
      },
      findFirst: async (args: { where?: Row; include?: Row; select?: Row; orderBy?: Row | Row[] } = {}) => self.first(table, args),
      findMany: async (args: { where?: Row; include?: Row; select?: Row; orderBy?: Row | Row[]; take?: number; distinct?: string[] } = {}) =>
        self.many(table, args),
      count: async (args: { where?: Row } = {}) => self.filter(table, args.where).length,
      create: async (args: { data: Row; include?: Row; select?: Row }) => {
        const row = self.insert(table, args.data);
        return self.shape(table, row, args);
      },
      update: async (args: { where: Row; data: Row; include?: Row; select?: Row }) => {
        const row = self.filter(table, args.where)[0];
        if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        self.apply(row, args.data, table);
        return self.shape(table, row, args);
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        const rows = self.filter(table, args.where);
        for (const row of rows) self.apply(row, args.data);
        return { count: rows.length };
      },
      upsert: async (args: { where: Row; create: Row; update: Row; include?: Row; select?: Row }) => {
        const existing = self.filter(table, args.where)[0];
        if (existing) {
          self.apply(existing, args.update);
          return self.shape(table, existing, args);
        }
        return self.shape(table, self.insert(table, args.create), args);
      },
      delete: async (args: { where: Row }) => {
        const rows = self.rows(table);
        const index = rows.findIndex((row) => self.matches(table, row, args.where));
        if (index >= 0) rows.splice(index, 1);
        return {};
      },
      deleteMany: async (args: { where?: Row } = {}) => {
        const rows = self.rows(table);
        const keep = rows.filter((row) => !self.matches(table, row, args.where ?? {}));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
      aggregate: async (args: { where?: Row; _sum?: Row; _count?: Row }) => {
        const rows = self.filter(table, args.where);
        const sum: Row = {};
        for (const key of Object.keys(args._sum ?? {})) {
          sum[key] = rows.reduce((total, row) => total + ((row[key] as number | null) ?? 0), 0);
        }
        return { _sum: sum, _count: { _all: rows.length } };
      },
      groupBy: async (args: { by: string[]; where?: Row; _sum?: Row; _count?: Row }) => {
        const groups = new Map<string, Row[]>();
        for (const row of self.filter(table, args.where)) {
          const key = JSON.stringify(args.by.map((field) => row[field] ?? null));
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        return [...groups.entries()].map(([key, rows]) => {
          const values = JSON.parse(key) as unknown[];
          const result: Row = {};
          args.by.forEach((field, index) => (result[field] = values[index]));
          const sum: Row = {};
          for (const field of Object.keys(args._sum ?? {})) {
            sum[field] = rows.reduce((total, row) => total + ((row[field] as number | null) ?? 0), 0);
          }
          return { ...result, _sum: sum, _count: { _all: rows.length } };
        });
      },
    };
  }

  private insert(table: string, data: Row): Row {
    const row: Row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
    for (const [key, value] of Object.entries(data)) {
      // Escrita aninhada `{ create: [...] }` em relação has-many.
      const relation = RELATIONS[table]?.[key];
      if (relation?.many && value && typeof value === "object" && "create" in (value as Row)) {
        const items = (value as { create: Row | Row[] }).create;
        for (const item of Array.isArray(items) ? items : [items]) {
          this.insert(relation.table, { ...item, [relation.foreignKey as string]: row.id });
        }
        continue;
      }
      row[key] = value;
    }
    if (table === "aiSession" && row.status === undefined) row.status = "active";
    if (table === "aiSession") {
      row.startedAt ??= new Date();
      row.lastActivityAt ??= new Date();
      for (const key of ["aiMessageCount", "customerMessageCount", "failedAttempts", "inputTokens", "outputTokens", "costMicros"]) {
        row[key] ??= 0;
      }
      row.lastProcessedMessageId ??= null;
      row.endedAt ??= null;
      row.endReason ??= null;
      row.endedByUserId ??= null;
      row.summary ??= null;
      // Índice parcial: uma ativa por conversa.
      const clash = this.rows(table).find((other) => other.conversationId === row.conversationId && other.status === "active");
      if (clash) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
    }
    if (table === "message") {
      row.timestamp ??= new Date();
      row.deletedAt ??= null;
      row.metadata ??= null;
    }
    if (table === "aiUsageLog") {
      row.inputTokens ??= 0;
      row.outputTokens ??= 0;
      row.costMicros ??= null;
    }
    this.rows(table).push(row);
    return row;
  }

  private apply(row: Row, data: Row, table?: string): void {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Row)) {
        row[key] = ((row[key] as number) ?? 0) + ((value as { increment: number }).increment ?? 0);
      } else if (value && typeof value === "object" && !(value instanceof Date) && "create" in (value as Row)) {
        // Escrita aninhada em update numa relação has-many (versões,
        // departamentos do agente).
        const relation = table ? RELATIONS[table]?.[key] : undefined;
        if (relation?.many) {
          const items = (value as { create: Row | Row[] }).create;
          for (const item of Array.isArray(items) ? items : [items]) {
            this.insert(relation.table, { ...item, [relation.foreignKey as string]: row.id });
          }
        }
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = new Date();
  }

  private first(table: string, args: { where?: Row; include?: Row; select?: Row; orderBy?: Row | Row[] }): Row | null {
    const rows = this.many(table, { ...args, take: 1 });
    return rows[0] ?? null;
  }

  private many(table: string, args: { where?: Row; include?: Row; select?: Row; orderBy?: Row | Row[]; take?: number; distinct?: string[] }): Row[] {
    let rows = this.filter(table, args.where);
    const orders = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
    for (const order of [...orders].reverse()) {
      const [field, direction] = Object.entries(order)[0] as [string, string];
      rows = [...rows].sort((a, b) => (direction === "desc" ? -1 : 1) * compare(a[field], b[field]));
    }
    if (args.distinct) {
      const seen = new Set<string>();
      rows = rows.filter((row) => {
        const key = JSON.stringify(args.distinct?.map((field) => row[field]));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (args.take != null) rows = rows.slice(0, args.take);
    return rows.map((row) => this.shape(table, row, args));
  }

  private filter(table: string, where: Row | undefined): Row[] {
    return this.rows(table).filter((row) => this.matches(table, row, where ?? {}));
  }

  private matches(table: string, row: Row, where: Row): boolean {
    for (const [key, condition] of Object.entries(where)) {
      if (key === "OR") {
        if (!(condition as Row[]).some((sub) => this.matches(table, row, sub))) return false;
        continue;
      }
      if (key === "AND") {
        if (!(condition as Row[]).every((sub) => this.matches(table, row, sub))) return false;
        continue;
      }
      if (key === "NOT") {
        if (this.matches(table, row, condition as Row)) return false;
        continue;
      }
      const relation = RELATIONS[table]?.[key];
      if (relation && condition && typeof condition === "object") {
        if (relation.many) {
          const children = this.rows(relation.table).filter((child) => child[relation.foreignKey as string] === row.id);
          const some = (condition as { some?: Row }).some;
          if (some && !children.some((child) => this.matches(relation.table, child, some))) return false;
          continue;
        }
        const parent = this.rows(relation.table).find((candidate) => candidate.id === row[relation.localKey as string]);
        const inner = (condition as { is?: Row }).is ?? (condition as Row);
        if (!parent || !this.matches(relation.table, parent, inner)) return false;
        continue;
      }
      // Chave composta `campoA_campoB: { campoA, campoB }`.
      if (key.includes("_") && condition && typeof condition === "object" && !(condition instanceof Date) && !("in" in (condition as Row)) && !("gt" in (condition as Row)) && !("not" in (condition as Row)) && !("lt" in (condition as Row)) && !("gte" in (condition as Row)) && !("lte" in (condition as Row)) && !("equals" in (condition as Row))) {
        if (!this.matches(table, row, condition as Row)) return false;
        continue;
      }
      const value = row[key];
      if (condition === null || condition === undefined || typeof condition !== "object" || condition instanceof Date) {
        if (condition instanceof Date ? compare(value, condition) !== 0 : value !== condition) return false;
        continue;
      }
      const ops = condition as Row;
      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) return false;
      if ("not" in ops && (ops.not === null ? value === null : value === ops.not)) return false;
      if ("gt" in ops && !(compare(value, ops.gt) > 0)) return false;
      if ("gte" in ops && !(compare(value, ops.gte) >= 0)) return false;
      if ("lt" in ops && !(compare(value, ops.lt) < 0)) return false;
      if ("lte" in ops && !(compare(value, ops.lte) <= 0)) return false;
      if ("equals" in ops && value !== ops.equals) return false;
      if ("contains" in ops && !String(value ?? "").toLowerCase().includes(String(ops.contains).toLowerCase())) return false;
    }
    return true;
  }

  private shape(table: string, row: Row, args: { include?: Row; select?: Row }): Row {
    const result: Row = args.select ? {} : { ...row };
    if (args.select) {
      for (const [key, wanted] of Object.entries(args.select)) {
        if (!wanted) continue;
        const relation = RELATIONS[table]?.[key];
        if (relation) {
          result[key] = this.related(row, relation, typeof wanted === "object" ? (wanted as Row) : {});
        } else {
          result[key] = row[key];
        }
      }
    }
    for (const [key, wanted] of Object.entries(args.include ?? {})) {
      if (!wanted) continue;
      if (key === "_count") {
        const counts: Row = {};
        for (const relationName of Object.keys((wanted as { select?: Row }).select ?? {})) {
          const relation = RELATIONS[table]?.[relationName];
          counts[relationName] = relation?.many
            ? this.rows(relation.table).filter((child) => child[relation.foreignKey as string] === row.id).length
            : 0;
        }
        result._count = counts;
        continue;
      }
      const relation = RELATIONS[table]?.[key];
      if (!relation) continue;
      result[key] = this.related(row, relation, typeof wanted === "object" ? (wanted as Row) : {});
    }
    return result;
  }

  private related(row: Row, relation: Relation, nested: Row): unknown {
    if (relation.many) {
      return this.rows(relation.table)
        .filter((child) => child[relation.foreignKey as string] === row.id)
        .map((child) => this.shape(relation.table, child, nested as { include?: Row; select?: Row }));
    }
    const parent = this.rows(relation.table).find((candidate) => candidate.id === row[relation.localKey as string]);
    return parent ? this.shape(relation.table, parent, nested as { include?: Row; select?: Row }) : null;
  }
}
