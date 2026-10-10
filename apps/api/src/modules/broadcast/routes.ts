import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BROADCAST_CRM_MODES,
  BROADCAST_DELIVERY_STATUSES,
  BROADCAST_LIMITS,
  normalizeBrazilPhone,
  normalizeColumnKey,
  resolveBroadcastTemplate,
} from "@azvchat/shared";
import { requirePermission } from "../../lib/permissions.js";
import { AppError, NotFoundError } from "../../lib/errors.js";
import { accessibleInstanceIds } from "../../lib/access.js";
import {
  generateDeliveries,
  loadCampaignCounts,
  loadCountsForCampaigns,
  loadOptedOutPhones,
  readContactFields,
  registerOptOut,
  serializeAudience,
  serializeCampaign,
  serializeContact,
  serializeDelivery,
  serializeOptOut,
  type CampaignRow,
} from "../../lib/broadcast.js";
import {
  buildImportPreview,
  buildImportTemplate,
  prepareContacts,
  readSpreadsheet,
  type ImportMapping,
} from "../../lib/broadcast-import.js";
import type { AppDeps } from "../../types.js";

/**
 * DISPAROS EM MASSA — audiências, campanhas, fila e descadastro.
 *
 * Três chaves diferentes, e a separação é deliberada (ver o catálogo em
 * `@azvchat/shared/permissions`): `broadcast.view` abre a tela,
 * `broadcast.audience.manage`/`broadcast.campaign.manage` MONTAM, e
 * `broadcast.send` é a única que faz mensagem sair. Montar a campanha errada
 * se corrige antes de apertar o botão; mandar para cinco mil pessoas, não —
 * por isso `broadcast.send` nasce só para o administrador.
 *
 * VISIBILIDADE: nada aqui encosta em `lib/access.ts` para decidir quem vê
 * qual campanha — campanha não tem departamento nem responsável. O ÚNICO
 * recorte herdado é o do NÚMERO: a campanha só pode sair por uma conexão que
 * a pessoa enxerga (`accessibleInstanceIds`), senão um supervisor do Fiscal
 * dispararia pelo chip do Contábil sem nunca ver a conversa que criou.
 */
export async function broadcastRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const idParams = z.object({ id: z.string().uuid() });

  /** A conexão escolhida precisa estar no alcance de quem está montando. */
  async function assertInstanceReachable(
    request: { user: { organizationId: string; sub: string; role: string } },
    instanceId: string,
  ): Promise<void> {
    const ids = await accessibleInstanceIds(deps.prisma, request.user as never);
    if (ids !== null && !ids.includes(instanceId)) {
      throw new AppError(
        "Você não tem acesso a esta conexão de WhatsApp.",
        403,
        "instance_out_of_reach",
      );
    }
    const instancia = await deps.prisma.whatsAppInstance.findFirst({
      where: { id: instanceId, organizationId: request.user.organizationId },
      select: { id: true },
    });
    if (!instancia) throw new NotFoundError("Conexão");
  }

  // ==========================================================
  // Audiências
  // ==========================================================

  app.get(
    "/broadcast/audiences",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const audiencias = await deps.prisma.broadcastAudience.findMany({
        where: { organizationId: request.user.organizationId },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { contacts: true } } },
      });
      if (audiencias.length === 0) return { audiences: [] };

      // Quantos contatos de cada audiência estão descadastrados. Sai numa
      // consulta só para a página inteira — o número aparece em toda linha da
      // lista, e uma consulta por audiência viraria N+1 na tela.
      const contatos = await deps.prisma.broadcastContact.findMany({
        where: { audienceId: { in: audiencias.map((item) => item.id) } },
        select: { audienceId: true, phone: true },
      });
      const descadastrados = await loadOptedOutPhones(
        deps.prisma,
        request.user.organizationId,
        [...new Set(contatos.map((item) => item.phone))],
      );
      const porAudiencia = new Map<string, number>();
      for (const contato of contatos) {
        if (!descadastrados.has(contato.phone)) continue;
        porAudiencia.set(contato.audienceId, (porAudiencia.get(contato.audienceId) ?? 0) + 1);
      }

      return {
        audiences: audiencias.map((item) =>
          serializeAudience(item, item._count.contacts, porAudiencia.get(item.id) ?? 0),
        ),
      };
    },
  );

  const audienceBody = z.object({
    name: z.string().min(2, "Dê um nome à audiência").max(120),
    description: z.string().max(500).nullish(),
  });

  app.post(
    "/broadcast/audiences",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request, reply) => {
      const body = audienceBody.parse(request.body);
      const existente = await deps.prisma.broadcastAudience.findFirst({
        where: { organizationId: request.user.organizationId, name: body.name },
        select: { id: true },
      });
      if (existente) {
        throw new AppError("Já existe uma audiência com este nome.", 409, "audience_name_taken");
      }
      const audiencia = await deps.prisma.broadcastAudience.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          description: body.description ?? null,
          createdById: request.user.sub,
        },
      });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.audience_created",
        entityType: "BroadcastAudience",
        entityId: audiencia.id,
        metadata: { name: audiencia.name },
      });
      return reply.status(201).send({ audience: serializeAudience(audiencia, 0, 0) });
    },
  );

  app.get(
    "/broadcast/audiences/:id",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const audiencia = await deps.prisma.broadcastAudience.findFirst({
        where: { id, organizationId: request.user.organizationId },
        include: { _count: { select: { contacts: true } } },
      });
      if (!audiencia) throw new NotFoundError("Audiência");

      const contatos = await deps.prisma.broadcastContact.findMany({
        where: { audienceId: id },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      const descadastrados = await loadOptedOutPhones(
        deps.prisma,
        request.user.organizationId,
        contatos.map((item) => item.phone),
      );
      return {
        audience: serializeAudience(audiencia, audiencia._count.contacts, descadastrados.size),
        contacts: contatos.map((item) => serializeContact(item, descadastrados.has(item.phone))),
      };
    },
  );

  app.patch(
    "/broadcast/audiences/:id",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = audienceBody.partial().parse(request.body);
      const existente = await deps.prisma.broadcastAudience.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!existente) throw new NotFoundError("Audiência");
      const audiencia = await deps.prisma.broadcastAudience.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        },
        include: { _count: { select: { contacts: true } } },
      });
      return { audience: serializeAudience(audiencia, audiencia._count.contacts, 0) };
    },
  );

  app.delete(
    "/broadcast/audiences/:id",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const audiencia = await deps.prisma.broadcastAudience.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true, name: true },
      });
      if (!audiencia) throw new NotFoundError("Audiência");

      // Audiência usada por campanha NÃO some: o histórico do disparo aponta
      // para ela, e apagar deixaria o relatório sem dizer para quem foi.
      const emUso = await deps.prisma.broadcastCampaign.count({ where: { audienceId: id } });
      if (emUso > 0) {
        throw new AppError(
          `Esta audiência está em ${emUso} campanha(s) e não pode ser excluída — o histórico delas aponta para ela.`,
          409,
          "audience_in_use",
        );
      }

      await deps.prisma.broadcastAudience.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.audience_deleted",
        entityType: "BroadcastAudience",
        entityId: id,
        metadata: { name: audiencia.name },
      });
      return { ok: true };
    },
  );

  // ==========================================================
  // Contatos
  // ==========================================================

  const contactBody = z.object({
    phone: z.string().min(8).max(32),
    name: z.string().max(160).nullish(),
    company: z.string().max(160).nullish(),
    fields: z.record(z.string().max(500)).optional(),
  });

  app.post(
    "/broadcast/audiences/:id/contacts",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ contacts: z.array(contactBody).min(1).max(500) }).parse(request.body);

      const audiencia = await deps.prisma.broadcastAudience.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!audiencia) throw new NotFoundError("Audiência");

      const atuais = await deps.prisma.broadcastContact.count({ where: { audienceId: id } });
      if (atuais + body.contacts.length > BROADCAST_LIMITS.MAX_AUDIENCE_SIZE) {
        throw new AppError(
          `A audiência passa de ${BROADCAST_LIMITS.MAX_AUDIENCE_SIZE} contatos, que é o teto do módulo.`,
          422,
          "audience_too_large",
        );
      }

      let imported = 0;
      let invalid = 0;
      const rejected: { row: number; phone: string; reason: string }[] = [];

      for (const [indice, contato] of body.contacts.entries()) {
        const normalizado = normalizeBrazilPhone(contato.phone);
        if (!normalizado.ok) {
          invalid += 1;
          if (rejected.length < 20) {
            rejected.push({
              row: indice + 1,
              phone: contato.phone,
              reason:
                normalizado.reason === "group"
                  ? "É um grupo, não um telefone"
                  : "Telefone inválido",
            });
          }
          continue;
        }
        const fields: Record<string, string> = {};
        for (const [chave, valor] of Object.entries(contato.fields ?? {})) {
          fields[normalizeColumnKey(chave)] = valor;
        }
        // `upsert` e não `create`: cadastrar de novo o mesmo número ATUALIZA o
        // nome em vez de estourar o único — é o que a pessoa espera ao
        // corrigir um contato pela tela.
        await deps.prisma.broadcastContact.upsert({
          where: { audienceId_phone: { audienceId: id, phone: normalizado.phone } },
          create: {
            organizationId: request.user.organizationId,
            audienceId: id,
            phone: normalizado.phone,
            name: contato.name ?? null,
            company: contato.company ?? null,
            fields: Object.keys(fields).length > 0 ? fields : undefined,
            source: "manual",
          },
          update: {
            name: contato.name ?? null,
            company: contato.company ?? null,
            ...(Object.keys(fields).length > 0 ? { fields } : {}),
          },
        });
        imported += 1;
      }

      const descadastrados = await loadOptedOutPhones(
        deps.prisma,
        request.user.organizationId,
        body.contacts
          .map((item) => normalizeBrazilPhone(item.phone))
          .filter((item): item is { ok: true; phone: string; jid: string } => item.ok)
          .map((item) => item.phone),
      );

      return reply.status(201).send({
        result: {
          imported,
          duplicated: 0,
          invalid,
          optedOut: descadastrados.size,
          rejected,
        },
      });
    },
  );

  app.delete(
    "/broadcast/contacts/:id",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const contato = await deps.prisma.broadcastContact.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!contato) throw new NotFoundError("Contato");
      await deps.prisma.broadcastContact.delete({ where: { id } });
      return { ok: true };
    },
  );

  // ==========================================================
  // Importação de planilha (dois passos: prévia → importar)
  // ==========================================================

  // O modelo de planilha para baixar e preencher. Mesma chave da importação:
  // quem não pode montar audiência não tem para que baixar o modelo dela.
  app.get(
    "/broadcast/import/template",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (_request, reply) => {
      const arquivo = await buildImportTemplate();
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", 'attachment; filename="modelo-audiencia-azvchat.xlsx"')
        .send(arquivo);
    },
  );

  app.post(
    "/broadcast/import/preview",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const arquivo = await request.file();
      if (!arquivo) throw new AppError("Selecione a planilha.", 400, "file_required");
      const buffer = await arquivo.toBuffer();
      const data = await readSpreadsheet(buffer, arquivo.filename);
      if (data.rows.length === 0) {
        throw new AppError("A planilha não tem nenhuma linha com dados.", 422, "planilha_sem_linhas");
      }
      return { preview: buildImportPreview(data) };
    },
  );

  app.post(
    "/broadcast/audiences/:id/import",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const audiencia = await deps.prisma.broadcastAudience.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true, name: true },
      });
      if (!audiencia) throw new NotFoundError("Audiência");

      const arquivo = await request.file();
      if (!arquivo) throw new AppError("Selecione a planilha.", 400, "file_required");

      // O mapeamento vem nos CAMPOS do multipart, ao lado do arquivo — a
      // tela já perguntou qual coluna é o quê na prévia.
      const campos = arquivo.fields as Record<string, { value?: unknown } | undefined>;
      const texto = (chave: string): string | null => {
        const valor = campos[chave]?.value;
        return typeof valor === "string" && valor.trim() ? valor.trim() : null;
      };
      const phoneColumn = texto("phoneColumn");
      if (!phoneColumn) {
        throw new AppError("Diga qual coluna tem o telefone.", 422, "phone_column_required");
      }
      const extrasBruto = texto("extraColumns");
      const mapping: ImportMapping = {
        phone: phoneColumn,
        name: texto("nameColumn"),
        company: texto("companyColumn"),
        extras: extrasBruto ? extrasBruto.split("\n").map((item) => item.trim()).filter(Boolean) : [],
      };

      const buffer = await arquivo.toBuffer();
      const data = await readSpreadsheet(buffer, arquivo.filename);
      if (!data.columns.includes(mapping.phone)) {
        throw new AppError(
          `A coluna "${mapping.phone}" não existe nesta planilha.`,
          422,
          "phone_column_missing",
        );
      }

      const preparados = prepareContacts(data, mapping);
      const atuais = await deps.prisma.broadcastContact.count({ where: { audienceId: id } });
      if (atuais + preparados.contacts.length > BROADCAST_LIMITS.MAX_AUDIENCE_SIZE) {
        throw new AppError(
          `A importação passaria de ${BROADCAST_LIMITS.MAX_AUDIENCE_SIZE} contatos na audiência, que é o teto do módulo.`,
          422,
          "audience_too_large",
        );
      }

      // Quem já está na audiência conta como repetido em vez de virar linha
      // nova — importar a mesma planilha duas vezes não duplica ninguém.
      const existentes = await deps.prisma.broadcastContact.findMany({
        where: { audienceId: id, phone: { in: preparados.contacts.map((item) => item.phone) } },
        select: { phone: true },
      });
      const jaExistem = new Set(existentes.map((item) => item.phone));

      const novos = preparados.contacts.filter((item) => !jaExistem.has(item.phone));
      if (novos.length > 0) {
        await deps.prisma.broadcastContact.createMany({
          data: novos.map((item) => ({
            organizationId: request.user.organizationId,
            audienceId: id,
            phone: item.phone,
            name: item.name,
            company: item.company,
            fields: Object.keys(item.fields).length > 0 ? item.fields : undefined,
            source: "import" as const,
          })),
          skipDuplicates: true,
        });
      }

      const descadastrados = await loadOptedOutPhones(
        deps.prisma,
        request.user.organizationId,
        preparados.contacts.map((item) => item.phone),
      );

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.audience_imported",
        entityType: "BroadcastAudience",
        entityId: id,
        metadata: {
          audience: audiencia.name,
          imported: novos.length,
          duplicated: jaExistem.size + preparados.duplicatedInFile,
          invalid: preparados.rejected.length,
        },
      });

      return {
        result: {
          imported: novos.length,
          duplicated: jaExistem.size + preparados.duplicatedInFile,
          invalid: data.rows.length - preparados.contacts.length - preparados.duplicatedInFile,
          optedOut: descadastrados.size,
          rejected: preparados.rejected,
        },
      };
    },
  );

  // ==========================================================
  // Descadastro
  // ==========================================================

  app.get(
    "/broadcast/opt-outs",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const linhas = await deps.prisma.broadcastOptOut.findMany({
        where: { organizationId: request.user.organizationId },
        orderBy: { createdAt: "desc" },
        take: 1000,
      });
      return { optOuts: linhas.map(serializeOptOut) };
    },
  );

  app.post(
    "/broadcast/opt-outs",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request, reply) => {
      const body = z.object({ phone: z.string().min(8).max(32) }).parse(request.body);
      const normalizado = normalizeBrazilPhone(body.phone);
      if (!normalizado.ok) {
        throw new AppError("Telefone inválido.", 422, "telefone_invalido");
      }
      await registerOptOut(deps.prisma, {
        organizationId: request.user.organizationId,
        phone: normalizado.phone,
        reason: "manual",
        createdById: request.user.sub,
      });
      const linha = await deps.prisma.broadcastOptOut.findUnique({
        where: {
          organizationId_phone: {
            organizationId: request.user.organizationId,
            phone: normalizado.phone,
          },
        },
      });
      return reply.status(201).send({ optOut: linha ? serializeOptOut(linha) : null });
    },
  );

  app.delete(
    "/broadcast/opt-outs/:id",
    { preHandler: requirePermission(deps, "broadcast.audience.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const linha = await deps.prisma.broadcastOptOut.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true, phone: true },
      });
      if (!linha) throw new NotFoundError("Descadastro");
      await deps.prisma.broadcastOptOut.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.opt_out_removed",
        entityType: "BroadcastOptOut",
        entityId: id,
        metadata: { phone: linha.phone },
      });
      return { ok: true };
    },
  );

  // ==========================================================
  // Campanhas
  // ==========================================================

  const campaignInclude = {
    audience: { select: { name: true } },
    instance: { select: { name: true } },
    pipeline: { select: { name: true } },
    stage: { select: { name: true } },
    tag: { select: { name: true } },
  } as const;

  app.get(
    "/broadcast/campaigns",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const campanhas = await deps.prisma.broadcastCampaign.findMany({
        where: { organizationId: request.user.organizationId },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: campaignInclude,
      });
      const contadores = await loadCountsForCampaigns(
        deps.prisma,
        campanhas.map((item) => item.id),
      );
      return {
        campaigns: campanhas.map((item) =>
          serializeCampaign(item as unknown as CampaignRow, contadores.get(item.id)!),
        ),
      };
    },
  );

  const campaignBody = z.object({
    name: z.string().min(2, "Dê um nome à campanha").max(120),
    audienceId: z.string().uuid(),
    whatsappInstanceId: z.string().uuid(),
    message: z.string().min(1, "Escreva a mensagem").max(BROADCAST_LIMITS.MESSAGE_MAX_LENGTH),
    messageVariants: z
      .array(z.string().min(1).max(BROADCAST_LIMITS.MESSAGE_MAX_LENGTH))
      .max(BROADCAST_LIMITS.MAX_MESSAGE_VARIANTS)
      .optional(),
    scheduledFor: z.string().datetime().nullish(),
    minIntervalSeconds: z
      .number()
      .int()
      .min(BROADCAST_LIMITS.MIN_INTERVAL_SECONDS)
      .max(BROADCAST_LIMITS.MAX_INTERVAL_SECONDS)
      .default(BROADCAST_LIMITS.DEFAULT_MIN_INTERVAL_SECONDS),
    maxIntervalSeconds: z
      .number()
      .int()
      .min(BROADCAST_LIMITS.MIN_INTERVAL_SECONDS)
      .max(BROADCAST_LIMITS.MAX_INTERVAL_SECONDS)
      .default(BROADCAST_LIMITS.DEFAULT_MAX_INTERVAL_SECONDS),
    dailyLimit: z.number().int().min(1).max(BROADCAST_LIMITS.MAX_DAILY_LIMIT).nullish(),
    respectBusinessHours: z.boolean().default(true),
    crmMode: z.enum(BROADCAST_CRM_MODES).default("on_reply"),
    crmPipelineId: z.string().uuid().nullish(),
    crmStageId: z.string().uuid().nullish(),
    tagId: z.string().uuid().nullish(),
  });

  /** Regras que valem na criação e na edição — uma função, dois pontos. */
  async function validarCampanha(
    organizationId: string,
    body: Partial<z.infer<typeof campaignBody>>,
  ): Promise<void> {
    if (
      body.minIntervalSeconds !== undefined &&
      body.maxIntervalSeconds !== undefined &&
      body.minIntervalSeconds > body.maxIntervalSeconds
    ) {
      throw new AppError(
        "O intervalo mínimo não pode ser maior que o máximo.",
        422,
        "interval_inverted",
      );
    }
    if (body.audienceId) {
      const audiencia = await deps.prisma.broadcastAudience.findFirst({
        where: { id: body.audienceId, organizationId },
        select: { id: true },
      });
      if (!audiencia) throw new NotFoundError("Audiência");
    }
    if (body.crmPipelineId) {
      const funil = await deps.prisma.crmPipeline.findFirst({
        where: { id: body.crmPipelineId, organizationId },
        select: { id: true },
      });
      if (!funil) throw new NotFoundError("Funil");
      if (body.crmStageId) {
        const etapa = await deps.prisma.crmStage.findFirst({
          where: { id: body.crmStageId, pipelineId: body.crmPipelineId },
          select: { id: true },
        });
        if (!etapa) {
          throw new AppError("Esta etapa não é do funil escolhido.", 422, "stage_not_in_pipeline");
        }
      }
    }
    if (body.crmMode && body.crmMode !== "never" && !body.crmPipelineId) {
      throw new AppError(
        "Escolha o funil do CRM para onde a oportunidade vai.",
        422,
        "pipeline_required",
      );
    }
    if (body.tagId) {
      const etiqueta = await deps.prisma.tag.findFirst({
        where: { id: body.tagId, organizationId },
        select: { id: true },
      });
      if (!etiqueta) throw new NotFoundError("Etiqueta");
    }
  }

  app.post(
    "/broadcast/campaigns",
    { preHandler: requirePermission(deps, "broadcast.campaign.manage") },
    async (request, reply) => {
      const body = campaignBody.parse(request.body);
      await assertInstanceReachable(request, body.whatsappInstanceId);
      await validarCampanha(request.user.organizationId, body);

      const campanha = await deps.prisma.broadcastCampaign.create({
        data: {
          organizationId: request.user.organizationId,
          name: body.name,
          audienceId: body.audienceId,
          whatsappInstanceId: body.whatsappInstanceId,
          message: body.message,
          messageVariants: body.messageVariants ?? undefined,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          minIntervalSeconds: body.minIntervalSeconds,
          maxIntervalSeconds: body.maxIntervalSeconds,
          dailyLimit: body.dailyLimit ?? null,
          respectBusinessHours: body.respectBusinessHours,
          crmMode: body.crmMode,
          crmPipelineId: body.crmPipelineId ?? null,
          crmStageId: body.crmStageId ?? null,
          tagId: body.tagId ?? null,
          createdById: request.user.sub,
        },
        include: campaignInclude,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.campaign_created",
        entityType: "BroadcastCampaign",
        entityId: campanha.id,
        metadata: { name: campanha.name, audienceId: campanha.audienceId },
      });

      return reply.status(201).send({
        campaign: serializeCampaign(campanha as unknown as CampaignRow, {
          total: 0,
          pending: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
          replied: 0,
        }),
      });
    },
  );

  app.get(
    "/broadcast/campaigns/:id",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const campanha = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
        include: campaignInclude,
      });
      if (!campanha) throw new NotFoundError("Campanha");
      const counts = await loadCampaignCounts(deps.prisma, id);
      return { campaign: serializeCampaign(campanha as unknown as CampaignRow, counts) };
    },
  );

  app.patch(
    "/broadcast/campaigns/:id",
    { preHandler: requirePermission(deps, "broadcast.campaign.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = campaignBody.partial().parse(request.body);
      const atual = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!atual) throw new NotFoundError("Campanha");

      // CAMPANHA QUE JÁ COMEÇOU NÃO SE EDITA. A fila está materializada e
      // parte das mensagens já saiu: trocar o texto no meio faria metade da
      // audiência receber uma coisa e metade outra, sem o histórico dizer
      // quem recebeu o quê. Para mudar, cancele e duplique.
      if (atual.status !== "draft" && atual.status !== "scheduled") {
        throw new AppError(
          "Campanha que já começou não pode ser editada. Cancele e crie outra.",
          409,
          "campaign_locked",
        );
      }
      if (body.whatsappInstanceId) await assertInstanceReachable(request, body.whatsappInstanceId);
      await validarCampanha(request.user.organizationId, {
        ...body,
        minIntervalSeconds: body.minIntervalSeconds ?? atual.minIntervalSeconds,
        maxIntervalSeconds: body.maxIntervalSeconds ?? atual.maxIntervalSeconds,
        crmMode: body.crmMode ?? (atual.crmMode as never),
        crmPipelineId: body.crmPipelineId ?? atual.crmPipelineId,
      });

      const campanha = await deps.prisma.broadcastCampaign.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.audienceId !== undefined ? { audienceId: body.audienceId } : {}),
          ...(body.whatsappInstanceId !== undefined
            ? { whatsappInstanceId: body.whatsappInstanceId }
            : {}),
          ...(body.message !== undefined ? { message: body.message } : {}),
          ...(body.messageVariants !== undefined ? { messageVariants: body.messageVariants } : {}),
          ...(body.scheduledFor !== undefined
            ? { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null }
            : {}),
          ...(body.minIntervalSeconds !== undefined
            ? { minIntervalSeconds: body.minIntervalSeconds }
            : {}),
          ...(body.maxIntervalSeconds !== undefined
            ? { maxIntervalSeconds: body.maxIntervalSeconds }
            : {}),
          ...(body.dailyLimit !== undefined ? { dailyLimit: body.dailyLimit ?? null } : {}),
          ...(body.respectBusinessHours !== undefined
            ? { respectBusinessHours: body.respectBusinessHours }
            : {}),
          ...(body.crmMode !== undefined ? { crmMode: body.crmMode } : {}),
          ...(body.crmPipelineId !== undefined
            ? { crmPipelineId: body.crmPipelineId ?? null }
            : {}),
          ...(body.crmStageId !== undefined ? { crmStageId: body.crmStageId ?? null } : {}),
          ...(body.tagId !== undefined ? { tagId: body.tagId ?? null } : {}),
        },
        include: campaignInclude,
      });
      const counts = await loadCampaignCounts(deps.prisma, id);
      return { campaign: serializeCampaign(campanha as unknown as CampaignRow, counts) };
    },
  );

  app.delete(
    "/broadcast/campaigns/:id",
    { preHandler: requirePermission(deps, "broadcast.campaign.manage") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const campanha = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true, name: true, status: true },
      });
      if (!campanha) throw new NotFoundError("Campanha");
      if (campanha.status === "running") {
        throw new AppError("Pause a campanha antes de excluí-la.", 409, "campaign_running");
      }
      await deps.prisma.broadcastCampaign.delete({ where: { id } });
      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.campaign_deleted",
        entityType: "BroadcastCampaign",
        entityId: id,
        metadata: { name: campanha.name },
      });
      return { ok: true };
    },
  );

  // ==========================================================
  // Controle do envio — a chave `broadcast.send`
  // ==========================================================

  app.post(
    "/broadcast/campaigns/:id/start",
    { preHandler: requirePermission(deps, "broadcast.send") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const campanha = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
        include: campaignInclude,
      });
      if (!campanha) throw new NotFoundError("Campanha");
      if (campanha.status !== "draft" && campanha.status !== "scheduled") {
        throw new AppError(
          "Esta campanha já foi iniciada. Use retomar, se estiver pausada.",
          409,
          "campaign_already_started",
        );
      }

      const instancia = await deps.prisma.whatsAppInstance.findUnique({
        where: { id: campanha.whatsappInstanceId },
        select: { status: true, name: true },
      });
      if (!instancia || instancia.status !== "connected") {
        throw new AppError(
          `A conexão "${instancia?.name ?? "escolhida"}" não está no ar. Conecte antes de disparar.`,
          409,
          "instance_offline",
        );
      }

      // Outra campanha rodando no MESMO número dobraria o ritmo real sem
      // ninguém perceber — o banco também barra (índice parcial), mas a
      // mensagem clara vem daqui.
      const ocupada = await deps.prisma.broadcastCampaign.findFirst({
        where: {
          whatsappInstanceId: campanha.whatsappInstanceId,
          status: "running",
          id: { not: id },
        },
        select: { name: true },
      });
      if (ocupada) {
        throw new AppError(
          `A campanha "${ocupada.name}" já está disparando por esta conexão. Espere ela terminar.`,
          409,
          "instance_busy",
        );
      }

      const resultado = await generateDeliveries(deps.prisma, campanha);
      if (resultado.queued === 0) {
        throw new AppError(
          "Nenhum contato desta audiência pode receber (lista vazia, telefones inválidos ou todos descadastrados).",
          422,
          "nothing_to_send",
        );
      }

      const agora = new Date();
      const agendada = campanha.scheduledFor && campanha.scheduledFor.getTime() > agora.getTime();
      const atualizada = await deps.prisma.broadcastCampaign.update({
        where: { id },
        data: agendada
          ? { status: "scheduled", pausedReason: null, nextSendAt: campanha.scheduledFor }
          : {
              status: "running",
              startedAt: agora,
              nextSendAt: agora,
              pausedReason: null,
              consecutiveFailures: 0,
            },
        include: campaignInclude,
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.campaign_started",
        entityType: "BroadcastCampaign",
        entityId: id,
        metadata: {
          name: campanha.name,
          queued: resultado.queued,
          skippedOptOut: resultado.skippedOptOut,
          skippedInvalid: resultado.skippedInvalid,
          scheduled: agendada,
        },
      });

      const counts = await loadCampaignCounts(deps.prisma, id);
      return {
        campaign: serializeCampaign(atualizada as unknown as CampaignRow, counts),
        queued: resultado.queued,
        skippedOptOut: resultado.skippedOptOut,
        skippedInvalid: resultado.skippedInvalid,
      };
    },
  );

  /** Pausar/retomar/cancelar — três verbos, um caminho. */
  async function mudarEstado(
    request: { user: { organizationId: string; sub: string } },
    id: string,
    acao: "pause" | "resume" | "cancel",
  ) {
    const campanha = await deps.prisma.broadcastCampaign.findFirst({
      where: { id, organizationId: request.user.organizationId },
      include: campaignInclude,
    });
    if (!campanha) throw new NotFoundError("Campanha");

    const agora = new Date();
    let data: Record<string, unknown>;
    if (acao === "pause") {
      if (campanha.status !== "running" && campanha.status !== "scheduled") {
        throw new AppError("Só dá para pausar campanha em andamento.", 409, "campaign_not_running");
      }
      data = { status: "paused", pausedReason: "manual", nextSendAt: null };
    } else if (acao === "resume") {
      if (campanha.status !== "paused") {
        throw new AppError("Esta campanha não está pausada.", 409, "campaign_not_paused");
      }
      // Retomar ZERA o contador de falhas seguidas: a pessoa olhou o motivo
      // e decidiu continuar, então a contagem recomeça — senão a campanha
      // pausaria de novo no primeiro erro seguinte.
      data = { status: "running", pausedReason: null, consecutiveFailures: 0, nextSendAt: agora };
    } else {
      if (campanha.status === "completed" || campanha.status === "canceled") {
        throw new AppError("Esta campanha já terminou.", 409, "campaign_finished");
      }
      // Cancelar marca o que NÃO saiu como pulado, com motivo: o histórico
      // precisa distinguir "não recebeu porque cancelamos" de "falhou".
      await deps.prisma.broadcastDelivery.updateMany({
        where: { campaignId: id, status: "pending" },
        data: { status: "skipped", skipReason: "canceled" },
      });
      data = { status: "canceled", finishedAt: agora, nextSendAt: null };
    }

    const atualizada = await deps.prisma.broadcastCampaign.update({
      where: { id },
      data,
      include: campaignInclude,
    });
    deps.audit.record({
      organizationId: request.user.organizationId,
      userId: request.user.sub,
      action: `broadcast.campaign_${acao === "pause" ? "paused" : acao === "resume" ? "resumed" : "canceled"}`,
      entityType: "BroadcastCampaign",
      entityId: id,
      metadata: { name: campanha.name },
    });
    const counts = await loadCampaignCounts(deps.prisma, id);
    return { campaign: serializeCampaign(atualizada as unknown as CampaignRow, counts) };
  }

  for (const acao of ["pause", "resume", "cancel"] as const) {
    app.post(
      `/broadcast/campaigns/:id/${acao}`,
      { preHandler: requirePermission(deps, "broadcast.send") },
      async (request) => {
        const { id } = idParams.parse(request.params);
        return mudarEstado(request, id, acao);
      },
    );
  }

  /**
   * MANDAR O TESTE PARA UM NÚMERO SÓ, antes de disparar para a lista.
   *
   * É a trava mais barata do módulo e a que mais evita estrago: o texto com
   * variável errada, a saudação trocada ou o link quebrado aparecem no
   * celular de quem está montando, e não na lista inteira — onde não se
   * desfaz. Usa o MESMO caminho de envio do worker, então o que chega no
   * teste é exatamente o que a campanha vai mandar.
   */
  app.post(
    "/broadcast/campaigns/:id/test-send",
    { preHandler: requirePermission(deps, "broadcast.send") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ phone: z.string().min(8).max(32) }).parse(request.body);
      const campanha = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
      });
      if (!campanha) throw new NotFoundError("Campanha");

      const normalizado = normalizeBrazilPhone(body.phone);
      if (!normalizado.ok) throw new AppError("Telefone inválido.", 422, "telefone_invalido");

      const instancia = await deps.prisma.whatsAppInstance.findUnique({
        where: { id: campanha.whatsappInstanceId },
        select: { id: true, status: true },
      });
      if (!instancia || instancia.status !== "connected") {
        throw new AppError("A conexão desta campanha não está no ar.", 409, "instance_offline");
      }

      // O teste usa um contato REAL da audiência quando existe, para as
      // variáveis aparecerem preenchidas como vão aparecer no disparo. Sem
      // contato, cai em valores de exemplo.
      const amostra = await deps.prisma.broadcastContact.findFirst({
        where: { audienceId: campanha.audienceId },
        orderBy: { createdAt: "asc" },
      });

      const texto = resolveBroadcastTemplate(campanha.message, {
        name: amostra?.name ?? "Maria Souza",
        company: amostra?.company ?? "Souza Comércio",
        phone: body.phone,
        fields: readContactFields(amostra?.fields),
      });

      const conversation = await deps.ingest.ensureConversation(
        {
          instanceId: instancia.id,
          externalChatId: normalizado.jid,
          isGroup: false,
          callerName: null,
          callerPhone: normalizado.phone,
        },
        request.user.organizationId,
      );
      const resultado = await deps.provider.sendText(instancia.id, normalizado.jid, texto);
      await deps.prisma.message.create({
        data: {
          organizationId: request.user.organizationId,
          conversationId: conversation.id,
          externalMessageId: resultado.externalMessageId,
          direction: "outbound",
          type: "text",
          content: texto,
          senderName: `Teste de disparo (${campanha.name})`,
          timestamp: resultado.timestamp,
          status: "sent",
          sentByUserId: request.user.sub,
          metadata: { origem: "broadcast-test", broadcastCampaignId: campanha.id },
        },
      });

      deps.audit.record({
        organizationId: request.user.organizationId,
        userId: request.user.sub,
        action: "broadcast.campaign_tested",
        entityType: "BroadcastCampaign",
        entityId: id,
        metadata: { name: campanha.name },
      });

      return { sent: true, content: texto };
    },
  );

  // ==========================================================
  // Histórico
  // ==========================================================

  app.get(
    "/broadcast/campaigns/:id/deliveries",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const query = z
        .object({
          status: z.enum(BROADCAST_DELIVERY_STATUSES).optional(),
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const campanha = await deps.prisma.broadcastCampaign.findFirst({
        where: { id, organizationId: request.user.organizationId },
        select: { id: true },
      });
      if (!campanha) throw new NotFoundError("Campanha");

      const linhas = await deps.prisma.broadcastDelivery.findMany({
        where: { campaignId: id, ...(query.status ? { status: query.status } : {}) },
        orderBy: { createdAt: "asc" },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      const temMais = linhas.length > query.limit;
      const pagina = temMais ? linhas.slice(0, query.limit) : linhas;
      return {
        deliveries: pagina.map(serializeDelivery),
        nextCursor: temMais ? (pagina[pagina.length - 1]?.id ?? null) : null,
      };
    },
  );

  /** As opções que o formulário precisa, numa chamada só. */
  app.get(
    "/broadcast/options",
    { preHandler: requirePermission(deps, "broadcast.view") },
    async (request) => {
      const instanceIds = await accessibleInstanceIds(deps.prisma, request.user);
      const [instances, pipelines, tags] = await Promise.all([
        deps.prisma.whatsAppInstance.findMany({
          where: {
            organizationId: request.user.organizationId,
            ...(instanceIds ? { id: { in: instanceIds } } : {}),
          },
          orderBy: { name: "asc" },
          select: { id: true, name: true, status: true },
        }),
        deps.prisma.crmPipeline.findMany({
          where: { organizationId: request.user.organizationId },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            stages: { orderBy: { position: "asc" }, select: { id: true, name: true } },
          },
        }),
        deps.prisma.tag.findMany({
          where: { organizationId: request.user.organizationId },
          orderBy: { name: "asc" },
          select: { id: true, name: true, color: true },
        }),
      ]);
      return { instances, pipelines, tags };
    },
  );

  // Não existe rota de "esta conversa nasceu de disparo?" de propósito: a
  // etiqueta da campanha já marca a conversa, e uma consulta a mais por linha
  // da lista da Inbox seria o mesmo erro que manteve `scheduledPendingCount`
  // fora do DTO da lista.
}
