import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  RESPONSE_LIMIT_MAX_MINUTES,
  RESPONSE_LIMIT_MIN_MINUTES,
  TIME_OF_DAY_PATTERN,
  WEEKDAY_LABELS,
  type Weekday,
} from "@azvchat/shared";
import {
  isValidTimezone,
  loadAttendanceSettings,
  minutesOfDay,
} from "../../lib/attendance-settings.js";
import { authenticate } from "../../lib/auth.js";
import { AppError } from "../../lib/errors.js";
import { requirePermission } from "../../lib/permissions.js";
import { serializeAttendanceSettings } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const dayScheduleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  active: z.boolean(),
  startTime: z.string().regex(TIME_OF_DAY_PATTERN, "Hora deve estar no formato HH:MM"),
  endTime: z.string().regex(TIME_OF_DAY_PATTERN, "Hora deve estar no formato HH:MM"),
});

/**
 * A semana inteira, com os sete dias exatamente uma vez.
 *
 * Vale igual para o expediente e para a janela de login: as duas faixas são
 * a mesma forma e precisam da mesma checagem, e duplicar a validação faria
 * uma das duas ficar para trás na primeira mudança de regra.
 */
function weekScheduleSchema() {
  return z
    .array(dayScheduleSchema)
    .length(7)
    .superRefine((days, ctx) => {
      const seen = new Set<number>();
      for (const [index, day] of days.entries()) {
        if (seen.has(day.weekday)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "weekday"],
            message: "Dia da semana repetido",
          });
        }
        seen.add(day.weekday);
        // Dia desligado não acumula tempo nenhum (e não libera login nenhum),
        // então horário invertido ali é inofensivo — só o dia ativo precisa fechar.
        if (day.active && minutesOfDay(day.endTime) <= minutesOfDay(day.startTime)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "endTime"],
            message: `${WEEKDAY_LABELS[day.weekday as Weekday]}: a hora de fim precisa ser maior que a de início`,
          });
        }
      }
      if (seen.size !== 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: "É preciso enviar os sete dias da semana",
        });
      }
    });
}

/**
 * Gravação dos parâmetros: a tela manda a semana inteira de uma vez, então a
 * validação também olha a semana inteira.
 *
 * O fuso é conferido contra a lista do runtime porque texto livre aqui
 * silenciaria todo corte de data do dashboard, que passaria a usar o UTC do
 * servidor sem ninguém perceber. Ele vale para as duas faixas: o horário de
 * login é lido no relógio do escritório, nunca no UTC do container.
 */
const greetingSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(2000),
  firstContactOnly: z.boolean(),
  cooldownMinutes: z.number().int().min(0).max(10_080),
  whatsappInstanceId: z.string().uuid().nullable(),
});

const outOfHoursSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(2000),
  cooldownMinutes: z.number().int().min(0).max(10_080),
  whatsappInstanceId: z.string().uuid().nullable(),
});

export const attendanceSettingsSchema = z.object({
  responseLimitMinutes: z
    .number()
    .int()
    .min(RESPONSE_LIMIT_MIN_MINUTES)
    .max(RESPONSE_LIMIT_MAX_MINUTES),
  timezone: z.string().min(1).max(64).refine(isValidTimezone, {
    message: "Fuso horário inválido",
  }),
  businessHours: weekScheduleSchema(),
  loginRestrictionEnabled: z.boolean(),
  loginHours: weekScheduleSchema(),
  greeting: greetingSchema,
  outOfHours: outOfHoursSchema,
});

export type AttendanceSettingsInput = z.infer<typeof attendanceSettingsSchema>;

export async function attendanceSettingsRoutes(
  app: FastifyInstance,
  deps: AppDeps,
): Promise<void> {
  /**
   * Leitura liberada para todo mundo: o dashboard de qualquer papel depende
   * do limite de resposta e do expediente para desenhar o card de atraso e
   * para cortar o período no fuso certo.
   *
   * Sem linha no banco a resposta são os padrões de `@azvchat/shared`, e não
   * 404 — organização nova não pode abrir o sistema quebrado.
   */
  app.get("/attendance-settings", { preHandler: authenticate }, async (request) => {
    const settings = await loadAttendanceSettings(deps.prisma, request.user.organizationId);
    return { settings: serializeAttendanceSettings(settings) };
  });

  /**
   * Quem grava é decidido pela chave `attendance_settings.manage` do
   * catálogo de permissões (padrão: supervisor para cima). A leitura acima
   * fica livre porque o dashboard de qualquer papel depende dela.
   *
   * Alterar o SLA muda o número que a diretoria olha, então a gravação vai
   * para a auditoria com o antes e o depois.
   */
  app.put(
    "/attendance-settings",
    { preHandler: requirePermission(deps, "attendance_settings.manage") },
    async (request) => {
      const input = attendanceSettingsSchema.parse(request.body);
      const organizationId = request.user.organizationId;
      const before = await loadAttendanceSettings(deps.prisma, organizationId);

      // Número específico da saudação/fora-do-expediente precisa ser desta
      // organização — senão a mensagem automática apontaria para um número
      // de outro tenant (ou id inventado) e nunca dispararia.
      for (const instanceId of [input.greeting.whatsappInstanceId, input.outOfHours.whatsappInstanceId]) {
        if (!instanceId) continue;
        const instance = await deps.prisma.whatsAppInstance.findFirst({ where: { id: instanceId, organizationId } });
        if (!instance) {
          throw new AppError("Número de WhatsApp inválido para a mensagem automática.", 404, "not_found");
        }
      }

      const saved = await deps.prisma.$transaction(async (tx) => {
        const settings = await tx.attendanceSettings.upsert({
          where: { organizationId },
          // Organização que ainda não tem linha ganha uma aqui: o PUT cria,
          // em vez de exigir um passo separado de criação.
          create: {
            organizationId,
            responseLimitMinutes: input.responseLimitMinutes,
            timezone: input.timezone,
            loginRestrictionEnabled: input.loginRestrictionEnabled,
            greetingEnabled: input.greeting.enabled,
            greetingMessage: input.greeting.message,
            greetingFirstContactOnly: input.greeting.firstContactOnly,
            greetingCooldownMinutes: input.greeting.cooldownMinutes,
            greetingInstanceId: input.greeting.whatsappInstanceId,
            outOfHoursEnabled: input.outOfHours.enabled,
            outOfHoursMessage: input.outOfHours.message,
            outOfHoursCooldownMinutes: input.outOfHours.cooldownMinutes,
            outOfHoursInstanceId: input.outOfHours.whatsappInstanceId,
          },
          update: {
            responseLimitMinutes: input.responseLimitMinutes,
            timezone: input.timezone,
            loginRestrictionEnabled: input.loginRestrictionEnabled,
            greetingEnabled: input.greeting.enabled,
            greetingMessage: input.greeting.message,
            greetingFirstContactOnly: input.greeting.firstContactOnly,
            greetingCooldownMinutes: input.greeting.cooldownMinutes,
            greetingInstanceId: input.greeting.whatsappInstanceId,
            outOfHoursEnabled: input.outOfHours.enabled,
            outOfHoursMessage: input.outOfHours.message,
            outOfHoursCooldownMinutes: input.outOfHours.cooldownMinutes,
            outOfHoursInstanceId: input.outOfHours.whatsappInstanceId,
          },
        });
        // A semana chega inteira e substitui a inteira: é mais simples de
        // acertar do que sete upserts, e não deixa dia órfão para trás.
        await tx.attendanceBusinessHours.deleteMany({ where: { settingsId: settings.id } });
        await tx.attendanceBusinessHours.createMany({
          data: input.businessHours.map((day) => ({
            settingsId: settings.id,
            weekday: day.weekday,
            active: day.active,
            startTime: day.startTime,
            endTime: day.endTime,
          })),
        });
        // Mesma troca para a janela de login, na mesma transação: meia
        // semana gravada decidiria quem entra no sistema.
        await tx.attendanceLoginHours.deleteMany({ where: { settingsId: settings.id } });
        await tx.attendanceLoginHours.createMany({
          data: input.loginHours.map((day) => ({
            settingsId: settings.id,
            weekday: day.weekday,
            active: day.active,
            startTime: day.startTime,
            endTime: day.endTime,
          })),
        });
        return settings;
      });

      const after = await loadAttendanceSettings(deps.prisma, organizationId);

      deps.audit.record({
        organizationId,
        userId: request.user.sub,
        action: "attendance_settings.updated",
        entityType: "attendance_settings",
        entityId: saved.id,
        metadata: {
          responseLimitMinutes: { before: before.responseLimitMinutes, after: after.responseLimitMinutes },
          timezone: { before: before.timezone, after: after.timezone },
          businessHours: { before: before.businessHours, after: after.businessHours },
          // Quem trancou (ou destrancou) a entrada da equipe, e com qual
          // faixa, é exatamente o tipo de mudança que alguém vai querer
          // reconstituir depois.
          loginRestrictionEnabled: {
            before: before.loginRestrictionEnabled,
            after: after.loginRestrictionEnabled,
          },
          loginHours: { before: before.loginHours, after: after.loginHours },
          greeting: { before: before.greeting, after: after.greeting },
          outOfHours: { before: before.outOfHours, after: after.outOfHours },
        },
        ip: request.ip,
      });

      return { settings: serializeAttendanceSettings(after) };
    },
  );
}
