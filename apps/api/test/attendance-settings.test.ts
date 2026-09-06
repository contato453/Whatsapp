import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@azvchat/database";
import { DEFAULT_ATTENDANCE_SETTINGS } from "@azvchat/shared";
import { registerErrorHandler } from "../src/lib/errors.js";
import type { AuthTokenPayload } from "../src/lib/auth.js";
import {
  isValidTimezone,
  minutesOfDay,
  normalizeBusinessHours,
} from "../src/lib/attendance-settings.js";
import {
  attendanceSettingsRoutes,
  attendanceSettingsSchema,
} from "../src/modules/attendance-settings/routes.js";
import type { AppDeps } from "../src/types.js";
import { rolePermissionStub } from "./helpers/permissions.js";

/**
 * O que estes testes fixam: quem lê, quem grava e o que a validação recusa.
 *
 * Ler é de todo mundo porque o dashboard depende do parâmetro; gravar é de
 * supervisor para cima, porque mexer no SLA muda o número que a diretoria
 * olha. Papel errado aqui abre a regra do escritório para quem só atende.
 */

const ORG = "org-1";

/** Linha guardada em memória — o suficiente para o upsert e a leitura. */
interface StoredSettings {
  id: string;
  responseLimitMinutes: number;
  timezone: string;
  loginRestrictionEnabled: boolean;
  businessHours: Array<{ weekday: number; active: boolean; startTime: string; endTime: string }>;
  loginHours: Array<{ weekday: number; active: boolean; startTime: string; endTime: string }>;
  greetingEnabled: boolean;
  greetingMessage: string | null;
  greetingFirstContactOnly: boolean;
  greetingCooldownMinutes: number;
  greetingInstanceId: string | null;
  outOfHoursEnabled: boolean;
  outOfHoursMessage: string | null;
  outOfHoursCooldownMinutes: number;
  outOfHoursInstanceId: string | null;
}

let stored: StoredSettings | null = null;
const auditActions: string[] = [];

function fakePrisma(): PrismaClient {
  const attendanceSettings = {
    findUnique: async () => (stored ? { ...stored, organizationId: ORG } : null),
    upsert: async ({
      create,
      update,
    }: {
      create: Partial<StoredSettings>;
      update: Omit<StoredSettings, "id" | "businessHours" | "loginHours">;
    }) => {
      if (!stored) {
        stored = {
          id: "settings-1",
          responseLimitMinutes: create.responseLimitMinutes ?? 30,
          timezone: create.timezone ?? "America/Sao_Paulo",
          loginRestrictionEnabled: create.loginRestrictionEnabled ?? false,
          businessHours: [],
          loginHours: [],
          greetingEnabled: create.greetingEnabled ?? false,
          greetingMessage: create.greetingMessage ?? null,
          greetingFirstContactOnly: create.greetingFirstContactOnly ?? true,
          greetingCooldownMinutes: create.greetingCooldownMinutes ?? 360,
          greetingInstanceId: create.greetingInstanceId ?? null,
          outOfHoursEnabled: create.outOfHoursEnabled ?? false,
          outOfHoursMessage: create.outOfHoursMessage ?? null,
          outOfHoursCooldownMinutes: create.outOfHoursCooldownMinutes ?? 180,
          outOfHoursInstanceId: create.outOfHoursInstanceId ?? null,
        };
      } else {
        stored.responseLimitMinutes = update.responseLimitMinutes;
        stored.timezone = update.timezone;
        stored.loginRestrictionEnabled = update.loginRestrictionEnabled;
        stored.greetingEnabled = update.greetingEnabled;
        stored.greetingMessage = update.greetingMessage;
        stored.greetingFirstContactOnly = update.greetingFirstContactOnly;
        stored.greetingCooldownMinutes = update.greetingCooldownMinutes;
        stored.greetingInstanceId = update.greetingInstanceId;
        stored.outOfHoursEnabled = update.outOfHoursEnabled;
        stored.outOfHoursMessage = update.outOfHoursMessage;
        stored.outOfHoursCooldownMinutes = update.outOfHoursCooldownMinutes;
        stored.outOfHoursInstanceId = update.outOfHoursInstanceId;
      }
      return { ...stored, organizationId: ORG };
    },
  };
  const attendanceBusinessHours = {
    deleteMany: async () => {
      if (stored) stored.businessHours = [];
      return { count: 0 };
    },
    createMany: async ({ data }: { data: StoredSettings["businessHours"] }) => {
      if (stored) stored.businessHours = data;
      return { count: data.length };
    },
  };
  const attendanceLoginHours = {
    deleteMany: async () => {
      if (stored) stored.loginHours = [];
      return { count: 0 };
    },
    createMany: async ({ data }: { data: StoredSettings["loginHours"] }) => {
      if (stored) stored.loginHours = data;
      return { count: data.length };
    },
  };
  return {
    rolePermission: rolePermissionStub,
    attendanceSettings,
    attendanceBusinessHours,
    attendanceLoginHours,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ attendanceSettings, attendanceBusinessHours, attendanceLoginHours }),
  } as unknown as PrismaClient;
}

function fakeDeps(): AppDeps {
  return {
    prisma: fakePrisma(),
    audit: {
      record: (entry: { action: string }) => {
        auditActions.push(entry.action);
      },
    },
  } as unknown as AppDeps;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: "segredo-de-teste" });
  // O verificador de sessão real vai ao banco; aqui o token já é o estado
  // atual, porque o que está em teste é o papel mínimo da rota.
  app.decorate("verifySession", async (payload: AuthTokenPayload) => payload);
  registerErrorHandler(app);
  await attendanceSettingsRoutes(app, fakeDeps());
  await app.ready();
  return app;
}

function tokenFor(app: FastifyInstance, role: AuthTokenPayload["role"]): string {
  return app.jwt.sign({
    sub: `user-${role}`,
    organizationId: ORG,
    role,
    name: "Fulano de Tal",
    email: `${role}@example.com`,
  });
}

const VALID_BODY = {
  responseLimitMinutes: 45,
  timezone: "America/Sao_Paulo",
  businessHours: DEFAULT_ATTENDANCE_SETTINGS.businessHours,
  loginRestrictionEnabled: false,
  loginHours: DEFAULT_ATTENDANCE_SETTINGS.loginHours,
  greeting: DEFAULT_ATTENDANCE_SETTINGS.greeting,
  outOfHours: DEFAULT_ATTENDANCE_SETTINGS.outOfHours,
};

describe("rotas de parâmetros de atendimento", () => {
  beforeEach(() => {
    stored = null;
    auditActions.length = 0;
  });

  it("agent lê os parâmetros — o dashboard dele depende disso", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.responseLimitMinutes).toBe(30);
    expect(response.json().settings.businessHours).toHaveLength(7);
    await app.close();
  });

  it("organização sem linha recebe os padrões de shared, não 404", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toEqual({
      responseLimitMinutes: DEFAULT_ATTENDANCE_SETTINGS.responseLimitMinutes,
      timezone: DEFAULT_ATTENDANCE_SETTINGS.timezone,
      businessHours: DEFAULT_ATTENDANCE_SETTINGS.businessHours,
      // A restrição de login nasce desligada: organização sem configuração
      // nenhuma não pode trancar a equipe do lado de fora.
      loginRestrictionEnabled: false,
      loginHours: DEFAULT_ATTENDANCE_SETTINGS.loginHours,
      greeting: DEFAULT_ATTENDANCE_SETTINGS.greeting,
      outOfHours: DEFAULT_ATTENDANCE_SETTINGS.outOfHours,
    });
    await app.close();
  });

  it("sem token não lê nem grava", async () => {
    const app = await buildTestApp();
    const read = await app.inject({ method: "GET", url: "/attendance-settings" });
    const write = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      payload: VALID_BODY,
    });
    expect(read.statusCode).toBe(401);
    expect(write.statusCode).toBe(401);
    await app.close();
  });

  it("agent não grava, mesmo chamando a rota direto", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "agent")}` },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(stored).toBeNull();
    await app.close();
  });

  it("supervisor grava e a alteração vai para a auditoria", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
      payload: VALID_BODY,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.responseLimitMinutes).toBe(45);
    expect(stored?.businessHours).toHaveLength(7);
    expect(auditActions).toContain("attendance_settings.updated");
    await app.close();
  });

  it("admin grava pela hierarquia de papéis", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "admin")}` },
      payload: { ...VALID_BODY, responseLimitMinutes: 15 },
    });
    expect(response.statusCode).toBe(200);
    expect(stored?.responseLimitMinutes).toBe(15);
    await app.close();
  });

  it("recusa hora de fim menor que a de início em dia ativo", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
      payload: {
        ...VALID_BODY,
        businessHours: VALID_BODY.businessHours.map((day) =>
          day.weekday === 1 ? { ...day, startTime: "18:00", endTime: "08:00" } : day,
        ),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
    expect(stored).toBeNull();
    await app.close();
  });

  it("supervisor liga a restrição de login e grava a semana inteira", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
      payload: {
        ...VALID_BODY,
        loginRestrictionEnabled: true,
        loginHours: VALID_BODY.loginHours.map((day) =>
          day.weekday === 6 ? { ...day, active: true, startTime: "08:00", endTime: "12:00" } : day,
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.loginRestrictionEnabled).toBe(true);
    expect(stored?.loginRestrictionEnabled).toBe(true);
    expect(stored?.loginHours).toHaveLength(7);
    expect(stored?.loginHours.find((day) => day.weekday === 6)).toMatchObject({
      active: true,
      startTime: "08:00",
      endTime: "12:00",
    });
    await app.close();
  });

  it("semana de login inválida não grava nem o expediente", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/attendance-settings",
      headers: { authorization: `Bearer ${tokenFor(app, "supervisor")}` },
      payload: {
        ...VALID_BODY,
        loginHours: VALID_BODY.loginHours.map((day) =>
          day.weekday === 3 ? { ...day, startTime: "19:00", endTime: "07:00" } : day,
        ),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(stored).toBeNull();
    await app.close();
  });
});

describe("validação dos parâmetros (Zod)", () => {
  it("aceita o corpo padrão da casa", () => {
    expect(attendanceSettingsSchema.safeParse(VALID_BODY).success).toBe(true);
  });

  it("recusa fuso que o runtime não conhece", () => {
    const result = attendanceSettingsSchema.safeParse({
      ...VALID_BODY,
      timezone: "America/Nao_Existe",
    });
    expect(result.success).toBe(false);
  });

  it("recusa limite zero, negativo, fracionado ou acima do teto", () => {
    for (const responseLimitMinutes of [0, -5, 1.5, 100_000]) {
      expect(
        attendanceSettingsSchema.safeParse({ ...VALID_BODY, responseLimitMinutes }).success,
      ).toBe(false);
    }
  });

  it("exige os sete dias, sem repetição", () => {
    const semDomingo = VALID_BODY.businessHours.slice(1);
    expect(attendanceSettingsSchema.safeParse({ ...VALID_BODY, businessHours: semDomingo }).success)
      .toBe(false);

    const repetido = VALID_BODY.businessHours.map((day) =>
      day.weekday === 6 ? { ...day, weekday: 5 } : day,
    );
    expect(attendanceSettingsSchema.safeParse({ ...VALID_BODY, businessHours: repetido }).success)
      .toBe(false);
  });

  it("recusa hora fora do formato HH:MM", () => {
    const result = attendanceSettingsSchema.safeParse({
      ...VALID_BODY,
      businessHours: VALID_BODY.businessHours.map((day) =>
        day.weekday === 2 ? { ...day, startTime: "8h" } : day,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("exige a semana de login com a mesma régua do expediente", () => {
    for (const loginHours of [
      VALID_BODY.loginHours.slice(1),
      VALID_BODY.loginHours.map((day) => (day.weekday === 6 ? { ...day, weekday: 5 } : day)),
      VALID_BODY.loginHours.map((day) =>
        day.weekday === 1 ? { ...day, startTime: "19:00", endTime: "07:00" } : day,
      ),
    ]) {
      expect(attendanceSettingsSchema.safeParse({ ...VALID_BODY, loginHours }).success).toBe(false);
    }
  });

  it("exige a flag da restrição de login — omitir não é o mesmo que desligar", () => {
    const { loginRestrictionEnabled: _ignored, ...semFlag } = VALID_BODY;
    expect(attendanceSettingsSchema.safeParse(semFlag).success).toBe(false);
  });

  it("deixa passar horário invertido em dia desligado — ele não acumula tempo", () => {
    const result = attendanceSettingsSchema.safeParse({
      ...VALID_BODY,
      businessHours: VALID_BODY.businessHours.map((day) =>
        day.weekday === 0 ? { ...day, active: false, startTime: "18:00", endTime: "08:00" } : day,
      ),
    });
    expect(result.success).toBe(true);
  });
});

describe("apoio dos parâmetros", () => {
  it("normaliza sempre os sete dias, em ordem, preenchendo o que faltar", () => {
    const days = normalizeBusinessHours([
      { weekday: 3, active: false, startTime: "09:00", endTime: "17:00" },
    ]);
    expect(days.map((day) => day.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(days[3]).toEqual({ weekday: 3, active: false, startTime: "09:00", endTime: "17:00" });
    // Dia ausente cai no padrão da casa, e não em buraco silencioso.
    expect(days[1]?.active).toBe(true);
    expect(days[6]?.active).toBe(false);
  });

  it("reconhece fuso válido e recusa inventado", () => {
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Mundo/Lugar_Nenhum")).toBe(false);
  });

  it("converte HH:MM em minutos desde a meia-noite", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("08:30")).toBe(510);
    expect(minutesOfDay("23:59")).toBe(1439);
  });
});
