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
import { authenticate, requireRole } from "../../lib/auth.js";
import { serializeAttendanceSettings } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const businessHourSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  active: z.boolean(),
  startTime: z.string().regex(TIME_OF_DAY_PATTERN, "Hora deve estar no formato HH:MM"),
  endTime: z.string().regex(TIME_OF_DAY_PATTERN, "Hora deve estar no formato HH:MM"),
});

/**
 * Gravação dos parâmetros: a tela manda a semana inteira de uma vez, então a
 * validação também olha a semana inteira.
 *
 * O fuso é conferido contra a lista do runtime porque texto livre aqui
 * silenciaria todo corte de data do dashboard, que passaria a usar o UTC do
 * servidor sem ninguém perceber.
 */
export const attendanceSettingsSchema = z.object({
  responseLimitMinutes: z
    .number()
    .int()
    .min(RESPONSE_LIMIT_MIN_MINUTES)
    .max(RESPONSE_LIMIT_MAX_MINUTES),
  timezone: z.string().min(1).max(64).refine(isValidTimezone, {
    message: "Fuso horário inválido",
  }),
  businessHours: z
    .array(businessHourSchema)
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
        // Dia desligado não acumula tempo nenhum, então horário invertido
        // ali é inofensivo — só o dia ativo precisa fechar.
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
    }),
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
   * Gravação a partir de supervisor — o mesmo papel do item "Parâmetros" no
   * menu do frontend. Admin passa pela hierarquia de `hasRole`.
   *
   * Alterar o SLA muda o número que a diretoria olha, então a gravação vai
   * para a auditoria com o antes e o depois.
   */
  app.put(
    "/attendance-settings",
    { preHandler: requireRole("supervisor") },
    async (request) => {
      const input = attendanceSettingsSchema.parse(request.body);
      const organizationId = request.user.organizationId;
      const before = await loadAttendanceSettings(deps.prisma, organizationId);

      const saved = await deps.prisma.$transaction(async (tx) => {
        const settings = await tx.attendanceSettings.upsert({
          where: { organizationId },
          // Organização que ainda não tem linha ganha uma aqui: o PUT cria,
          // em vez de exigir um passo separado de criação.
          create: {
            organizationId,
            responseLimitMinutes: input.responseLimitMinutes,
            timezone: input.timezone,
          },
          update: {
            responseLimitMinutes: input.responseLimitMinutes,
            timezone: input.timezone,
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
        },
        ip: request.ip,
      });

      return { settings: serializeAttendanceSettings(after) };
    },
  );
}
