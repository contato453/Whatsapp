import path from "node:path";
import { z } from "zod";
import { DEFAULT_MEDIA_MAX_SIZE } from "@azvchat/shared";

/**
 * Variável opcional que também aceita valor vazio. No `.env` de produção o
 * normal é a linha existir sem conteúdo (`AZEVEDO_OS_API_URL=`), e string
 * vazia reprovando no schema derrubaria a API inteira por causa de uma
 * integração desligada.
 */
function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    schema.optional(),
  );
}

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
  // O padrão vem do shared: a tela barra o arquivo grande na prévia com o
  // mesmo número, antes de subir byte nenhum. Apertar ou soltar o limite
  // real continua sendo coisa do `.env` da VPS.
  MEDIA_MAX_SIZE: z.coerce.number().default(DEFAULT_MEDIA_MAX_SIZE),
  LOG_LEVEL: z.string().default("info"),

  /**
   * Integração de leitura com o Azevedo-OS. Tudo opcional: sem URL ou sem
   * token a integração nasce desligada e o card avisa que não está
   * configurada — nenhuma outra parte do sistema é afetada.
   *
   * O token vive SÓ aqui, no processo da API. Não existe variável
   * `NEXT_PUBLIC_` equivalente, e nada disso é serializado para o navegador.
   */
  AZEVEDO_OS_API_URL: optionalEnv(z.string().url()),
  AZEVEDO_OS_API_TOKEN: optionalEnv(z.string().min(1)),
  /**
   * Endereço da empresa na web do Azevedo-OS, com `{id}` onde entra o
   * identificador (ex.: `https://gestao.exemplo.com.br/empresas/{id}`).
   * A rota real é do Azevedo-OS, não daqui: sem esta variável o botão
   * "Abrir no Azevedo-OS" simplesmente não aparece, em vez de levar a um
   * link inventado.
   */
  AZEVEDO_OS_WEB_URL: optionalEnv(
    z.string().url().refine((value) => value.includes("{id}"), {
      message: "deve conter {id}, onde entra o identificador da empresa",
    }),
  ),
  /** Timeout da chamada ao Azevedo-OS, curto de propósito (ver o client). */
  AZEVEDO_OS_TIMEOUT_MS: z.coerce.number().min(500).max(30_000).default(5000),
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
