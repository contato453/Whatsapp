import { z } from "zod";
import {
  AI_ASSIGNEE_MODES,
  AI_BEHAVIOR_KEYS,
  AI_CAPABILITY_KEYS,
  AI_COLLECTION_ORDERS,
  AI_CONFIG_LIMITS,
  AI_EMOJI_USAGES,
  AI_HANDOFF_TRIGGER_KEYS,
  AI_RESPONSE_LENGTHS,
  AI_TONES,
  defaultAiAgentConfig,
  type AiAgentConfig,
} from "@azvchat/shared";

/**
 * Zod da configuração do agente — a MESMA forma de `AiAgentConfig`
 * (`@azvchat/shared`). Tudo o que entra por `POST|PATCH /ai/agents` passa
 * aqui: o JSON gravado é sempre completo e válido, então quem lê (motor,
 * testador, tela) nunca precisa se defender de campo faltando.
 */

const TEXT_MAX = 8000;

function booleanRecord<K extends string>(keys: readonly K[]) {
  return z.object(
    Object.fromEntries(keys.map((key) => [key, z.boolean()])) as Record<K, z.ZodBoolean>,
  );
}

const collectFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Use só letras minúsculas, números e _"),
  label: z.string().min(1).max(60),
  required: z.boolean(),
  hint: z.string().max(200),
});

export const aiAgentConfigSchema: z.ZodType<AiAgentConfig> = z.object({
  identity: z.object({
    greeting: z.string().max(1000),
    sendGreeting: z.boolean(),
  }),
  objective: z.string().max(TEXT_MAX),
  canDo: z.object({
    instructions: z.string().max(TEXT_MAX),
    capabilities: booleanRecord(AI_CAPABILITY_KEYS),
    allowedLinks: z
      .array(z.string().url().max(500))
      .max(AI_CONFIG_LIMITS.allowedLinks.max),
  }),
  cannotDo: z.string().max(TEXT_MAX),
  limits: z.object({
    maxAiMessages: z
      .number()
      .int()
      .min(AI_CONFIG_LIMITS.maxAiMessages.min)
      .max(AI_CONFIG_LIMITS.maxAiMessages.max),
    maxFailedAttempts: z
      .number()
      .int()
      .min(AI_CONFIG_LIMITS.maxFailedAttempts.min)
      .max(AI_CONFIG_LIMITS.maxFailedAttempts.max),
    maxDurationMinutes: z
      .number()
      .int()
      .min(AI_CONFIG_LIMITS.maxDurationMinutes.min)
      .max(AI_CONFIG_LIMITS.maxDurationMinutes.max)
      .nullable(),
  }),
  handoff: z.object({
    triggers: booleanRecord(AI_HANDOFF_TRIGGER_KEYS),
    customTriggers: z.string().max(TEXT_MAX),
    departmentId: z.string().uuid().nullable(),
    assigneeMode: z.enum(AI_ASSIGNEE_MODES),
    assigneeUserId: z.string().uuid().nullable(),
    transferMessage: z.string().max(1000),
    fallbackMessage: z.string().max(1000),
  }),
  communication: z.object({
    tone: z.enum(AI_TONES),
    customTone: z.string().max(1000),
    responseLength: z.enum(AI_RESPONSE_LENGTHS),
    emojis: z.enum(AI_EMOJI_USAGES),
    useFirstName: z.boolean(),
    oneQuestionAtATime: z.boolean(),
    avoidJargon: z.boolean(),
    customInstructions: z.string().max(TEXT_MAX),
  }),
  behaviors: booleanRecord(AI_BEHAVIOR_KEYS),
  dataCollection: z.object({
    order: z.enum(AI_COLLECTION_ORDERS),
    fields: z
      .array(collectFieldSchema)
      .max(AI_CONFIG_LIMITS.collectFields.max)
      .refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, {
        message: "Campo repetido na lista de dados a coletar",
      }),
  }),
  knowledge: z.object({
    includeQuickReplies: z.boolean(),
    allowGeneralKnowledge: z.boolean(),
  }),
  advanced: z.object({
    additionalInstructions: z.string().max(TEXT_MAX),
    model: z.string().min(1).max(100).nullable(),
    temperature: z
      .number()
      .min(AI_CONFIG_LIMITS.temperature.min)
      .max(AI_CONFIG_LIMITS.temperature.max)
      .nullable(),
    contextMessageLimit: z
      .number()
      .int()
      .min(AI_CONFIG_LIMITS.contextMessageLimit.min)
      .max(AI_CONFIG_LIMITS.contextMessageLimit.max),
  }),
});

/**
 * Lê a configuração gravada no banco com tolerância: agente salvo antes de
 * um campo novo existir ganha o padrão daquele campo, em vez de derrubar o
 * atendimento por JSON "velho". Mescla rasa por seção, que é a forma do
 * objeto.
 */
export function parseStoredAgentConfig(stored: unknown): AiAgentConfig {
  const base = defaultAiAgentConfig();
  if (!stored || typeof stored !== "object") return base;
  const input = stored as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [section, defaults] of Object.entries(base)) {
    const given = input[section];
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      const nested = { ...(defaults as Record<string, unknown>) };
      if (given && typeof given === "object" && !Array.isArray(given)) {
        for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
          const defaultValue = nested[key];
          // Mapas de booleanos (capacidades, gatilhos, condutas) também
          // ganham chave nova com o padrão dela.
          if (
            defaultValue &&
            typeof defaultValue === "object" &&
            !Array.isArray(defaultValue) &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            nested[key] = { ...(defaultValue as Record<string, unknown>), ...(value as Record<string, unknown>) };
          } else {
            nested[key] = value;
          }
        }
      }
      merged[section] = nested;
    } else {
      merged[section] = given ?? defaults;
    }
  }
  const result = aiAgentConfigSchema.safeParse(merged);
  return result.success ? result.data : base;
}
