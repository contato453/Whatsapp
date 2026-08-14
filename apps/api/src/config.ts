import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET deve ter pelo menos 16 caracteres"),
  JWT_EXPIRES_IN: z.string().default("12h"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  WHATSAPP_SESSION_DIR: z.string().default("./data/sessions"),
  WHATSAPP_PROXY_URL: z.string().optional(),
  MEDIA_DIR: z.string().default("./data/media"),
  MEDIA_MAX_SIZE: z.coerce.number().default(25 * 1024 * 1024),
  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuração de ambiente inválida — ${issues}`);
  }
  const env = parsed.data;
  return {
    ...env,
    sessionDir: path.resolve(env.WHATSAPP_SESSION_DIR),
    mediaDir: path.resolve(env.MEDIA_DIR),
    corsOrigins: env.WEB_ORIGIN.split(",").map((origin) => origin.trim()),
  };
}
