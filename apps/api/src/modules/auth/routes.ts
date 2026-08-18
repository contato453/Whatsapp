import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  LOGIN_OUTSIDE_SCHEDULE_MESSAGE,
  NOTIFICATION_SOUNDS,
  NOTIFICATION_VOLUMES,
} from "@azvchat/shared";
import { loadAttendanceSettings } from "../../lib/attendance-settings.js";
import { authenticate } from "../../lib/auth.js";
import { AppError, NotFoundError, UnauthorizedError } from "../../lib/errors.js";
import { checkLoginSchedule } from "../../lib/login-schedule.js";
import { extensionFromMime } from "../../lib/media-storage.js";
import { loadPermissions } from "../../lib/permissions.js";
import { serializeSessionUser } from "../../lib/serialize.js";
import type { AppDeps } from "../../types.js";

const loginSchema = z.object({
  email: z.string().email("E-mail inválido"),
  password: z.string().min(1, "Senha é obrigatória"),
});

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post(
    "/auth/login",
    {
      config: {
        // Proteção extra contra força bruta no login
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request) => {
      const { email, password } = loginSchema.parse(request.body);
      const user = await deps.prisma.user.findUnique({ where: { email } });
      if (!user || user.status !== "active") {
        throw new UnauthorizedError("Credenciais inválidas");
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        deps.audit.record({
          organizationId: user.organizationId,
          action: "auth.login_failed",
          entityType: "User",
          entityId: user.id,
          ip: request.ip,
        });
        throw new UnauthorizedError("Credenciais inválidas");
      }

      /**
       * Janela de login do escritório, conferida **depois** da senha: antes
       * dela, a mensagem de horário diria a quem errou a senha que aquele
       * e-mail existe.
       *
       * Vale só para quem não é supervisor, e os parâmetros são lidos do
       * banco na hora — abrir o dia na tela de Parâmetros libera a entrada na
       * tentativa seguinte, sem reiniciar nada. Essa é a autorização que a
       * mensagem manda pedir.
       */
      const settings = await loadAttendanceSettings(deps.prisma, user.organizationId);
      const schedule = checkLoginSchedule(settings, user.role, new Date());
      if (!schedule.allowed) {
        deps.audit.record({
          organizationId: user.organizationId,
          userId: user.id,
          action: "auth.login_outside_schedule",
          entityType: "User",
          entityId: user.id,
          metadata: {
            timezone: settings.timezone,
            window: schedule.window,
          },
          ip: request.ip,
        });
        throw new AppError(LOGIN_OUTSIDE_SCHEDULE_MESSAGE, 403, "login_outside_schedule");
      }

      const token = await app.jwt.sign(
        {
          sub: user.id,
          organizationId: user.organizationId,
          role: user.role,
          name: user.name,
          email: user.email,
        },
        { expiresIn: deps.config.JWT_EXPIRES_IN },
      );
      deps.audit.record({
        organizationId: user.organizationId,
        userId: user.id,
        action: "auth.login",
        ip: request.ip,
      });
      // Registrado depois da autenticação: tentativa falha não conta como acesso.
      const loggedIn = await deps.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      // As permissões saem junto com a sessão: a tela decide o que mostrar
      // por esta lista, nunca deduzindo pelo papel — deduzir faria a
      // configuração da tela de Permissões virar mentira visual.
      const permissions = await loadPermissions(deps.prisma, {
        sub: loggedIn.id,
        organizationId: loggedIn.organizationId,
        role: loggedIn.role,
        name: loggedIn.name,
        email: loggedIn.email,
      });
      return { token, user: serializeSessionUser(loggedIn, permissions.allowed()) };
    },
  );

  app.get("/auth/me", { preHandler: authenticate }, async (request) => {
    const user = await deps.prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user || user.status !== "active") {
      throw new UnauthorizedError();
    }
    const permissions = await loadPermissions(deps.prisma, request.user);
    return { user: serializeSessionUser(user, permissions.allowed()) };
  });

  /**
   * O que a pessoa muda em si mesma. E-mail fica de fora de propósito: é a
   * credencial de entrada, então continua na mão do administrador, junto de
   * papel, status e recorte de acesso.
   */
  const updateProfileSchema = z.object({
    name: z.string().min(2, "Nome deve ter no mínimo 2 caracteres").max(120).optional(),
    signMessages: z.boolean().optional(),
    // Enum fechado: valor fora da lista é recusado aqui, antes de chegar ao
    // banco, com a mesma mensagem de qualquer outro campo inválido.
    notificationSound: z.enum(NOTIFICATION_SOUNDS).optional(),
    notificationVolume: z.enum(NOTIFICATION_VOLUMES).optional(),
  });

  /**
   * Devolve token novo porque o nome viaja dentro do JWT (é ele que carimba
   * quem enviou cada mensagem). Sem reemitir, o nome antigo continuaria
   * assinando o envio até a sessão expirar.
   */
  app.patch("/auth/me", { preHandler: authenticate }, async (request) => {
    const body = updateProfileSchema.parse(request.body);
    const current = await deps.prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!current || current.status !== "active") throw new UnauthorizedError();

    const user = await deps.prisma.user.update({
      where: { id: current.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.signMessages === undefined ? {} : { signMessages: body.signMessages }),
        ...(body.notificationSound === undefined
          ? {}
          : { notificationSound: body.notificationSound }),
        ...(body.notificationVolume === undefined
          ? {}
          : { notificationVolume: body.notificationVolume }),
      },
    });
    deps.audit.record({
      organizationId: user.organizationId,
      userId: user.id,
      action: "user.profile_updated",
      entityType: "User",
      entityId: user.id,
      ip: request.ip,
    });
    const token = await app.jwt.sign(
      {
        sub: user.id,
        organizationId: user.organizationId,
        role: user.role,
        name: user.name,
        email: user.email,
      },
      { expiresIn: deps.config.JWT_EXPIRES_IN },
    );
    const permissions = await loadPermissions(deps.prisma, request.user);
    return { token, user: serializeSessionUser(user, permissions.allowed()) };
  });

  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "Informe a senha atual"),
    newPassword: z.string().min(6, "A nova senha deve ter no mínimo 6 caracteres").max(72),
  });

  /**
   * Troca de senha pela própria pessoa. Exige a senha atual: token roubado
   * ou máquina destravada não vira troca de senha silenciosa.
   *
   * A sessão em uso continua valendo — quem trocou a própria senha não tem
   * por que ser deslogado.
   */
  app.post(
    "/auth/change-password",
    {
      preHandler: authenticate,
      // Mesmo motivo do login: a senha atual não pode virar alvo de tentativa em massa.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request) => {
      const body = changePasswordSchema.parse(request.body);
      const user = await deps.prisma.user.findUnique({ where: { id: request.user.sub } });
      if (!user || user.status !== "active") throw new UnauthorizedError();

      const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!valid) {
        deps.audit.record({
          organizationId: user.organizationId,
          userId: user.id,
          action: "auth.password_change_failed",
          entityType: "User",
          entityId: user.id,
          ip: request.ip,
        });
        throw new AppError("Senha atual incorreta", 400, "invalid_password");
      }
      if (await bcrypt.compare(body.newPassword, user.passwordHash)) {
        throw new AppError("A nova senha deve ser diferente da atual", 400, "same_password");
      }

      await deps.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(body.newPassword, 10) },
      });
      deps.audit.record({
        organizationId: user.organizationId,
        userId: user.id,
        action: "user.password_changed",
        entityType: "User",
        entityId: user.id,
        ip: request.ip,
      });
      return { ok: true };
    },
  );

  /**
   * Foto de perfil interna: aparece só dentro do sistema, para a equipe se
   * reconhecer. Não tem relação com a foto dos números de WhatsApp.
   *
   * O recorte e o zoom são feitos no navegador; aqui chega a imagem já
   * pronta, quadrada. Guardar o original não traria ganho e ocuparia disco.
   */
  app.post("/auth/me/avatar", { preHandler: authenticate }, async (request) => {
    const file = await request.file();
    if (!file) throw new AppError("Arquivo é obrigatório", 400, "file_required");
    if (!file.mimetype?.startsWith("image/")) {
      throw new AppError("Envie uma imagem", 400, "invalid_image");
    }
    const buffer = await file.toBuffer();
    // Teto de 2 MB: a imagem já chega recortada e redimensionada.
    if (buffer.byteLength > 2 * 1024 * 1024) {
      throw new AppError("Imagem muito grande", 413, "image_too_large");
    }
    const key = await deps.storage.save(buffer, {
      instanceId: "avatars",
      extension: extensionFromMime(file.mimetype) ?? "png",
    });
    const user = await deps.prisma.user.update({
      where: { id: request.user.sub },
      data: { avatarUrl: key },
    });
    deps.audit.record({
      organizationId: user.organizationId,
      userId: user.id,
      action: "user.avatar_updated",
      entityType: "User",
      entityId: user.id,
    });
    const permissions = await loadPermissions(deps.prisma, request.user);
    return { user: serializeSessionUser(user, permissions.allowed()) };
  });

  app.delete("/auth/me/avatar", { preHandler: authenticate }, async (request) => {
    const user = await deps.prisma.user.update({
      where: { id: request.user.sub },
      data: { avatarUrl: null },
    });
    const permissions = await loadPermissions(deps.prisma, request.user);
    return { user: serializeSessionUser(user, permissions.allowed()) };
  });

  /**
   * Serve a foto de qualquer colega da mesma organização: ela aparece na
   * lista de usuários, no relatório e ao lado das mensagens enviadas.
   */
  app.get("/users/:id/avatar", { preHandler: authenticate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await deps.prisma.user.findFirst({
      where: { id, organizationId: request.user.organizationId },
      select: { avatarUrl: true },
    });
    if (!user?.avatarUrl) throw new NotFoundError("Foto de perfil");
    const buffer = await deps.storage.read(user.avatarUrl);
    return reply.type("image/*").send(buffer);
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (request) => {
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: "auth.logout",
      ip: request.ip,
    });
    return { ok: true };
  });
}
