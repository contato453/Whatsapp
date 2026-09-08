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

  /**
   * Qual implementação de WhatsAppProvider usar. `qrcode` é o Baileys de
   * sempre (padrão, para não mudar a produção por omissão); `astracalls` é a
   * API HTTP externa do AstraCalls (whatsmeow), que o `index.ts` instancia no
   * lugar do Baileys. A troca é num ponto só — ver o comentário lá.
   */
  WHATSAPP_PROVIDER: z.enum(["qrcode", "astracalls"]).default("qrcode"),
  /**
   * AstraCalls (só quando WHATSAPP_PROVIDER=astracalls). Tudo opcional no
   * schema para não travar o boot do provider Baileys; a validação de
   * "está tudo presente?" é feita no `index.ts`, ao escolher o provider.
   *
   * `ASTRACALLS_API_URL` é a base (ex.: https://astracalls.azvchat.com.br) e
   * `ASTRACALLS_API_KEY` vai no header `X-API-Key` de toda chamada — vive só
   * no processo da API, nunca no navegador (sem `NEXT_PUBLIC_`).
   */
  ASTRACALLS_API_URL: optionalEnv(z.string().url()),
  ASTRACALLS_API_KEY: optionalEnv(z.string().min(1)),
  /**
   * URL pública que o AstraCalls chama (POST) com os eventos da sessão —
   * mensagem recebida, status, etc. Precisa ser alcançável de fora (ex.:
   * https://api.azvchat.com.br/integrations/astracalls/webhook), porque o
   * container do AstraCalls fala com a API pela internet, não pela rede
   * interna do compose.
   */
  ASTRACALLS_WEBHOOK_URL: optionalEnv(z.string().url()),
  /**
   * Segredo que protege a rota de webhook: o AstraCalls não manda o nosso
   * bearer de sessão, então embutimos este segredo na URL/num header e a rota
   * recusa quem não o apresenta. Sem ele a rota fica fechada (503).
   */
  ASTRACALLS_WEBHOOK_SECRET: optionalEnv(z.string().min(16)),
  /**
   * Diretório onde o AstraCalls grava os MP3 das chamadas, compartilhado com
   * a API por volume (ex.: `/recordings`). Só serve para a ferramenta de
   * EXCLUSÃO de gravações por período liberar espaço na VPS — sem ele, a
   * exclusão só limpa o ponteiro no banco e avisa que não pôde apagar o
   * arquivo. Nunca usado para LER a gravação (isso é sempre pela API do
   * AstraCalls, autenticado).
   */
  CALL_RECORDINGS_DIR: optionalEnv(z.string().min(1)),

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

  /**
   * Integração de escrita, sentido inverso da anterior: o Azevedo-OS chama
   * PARA CÁ, para mandar lembrete de cobrança por WhatsApp. Escopo fixo de
   * propósito — um único WhatsAppInstance pré-cadastrado, nunca escolhido
   * por parâmetro da chamada. Um token vazado manda mensagem só por este
   * número, nunca pelos outros da empresa.
   *
   * As duas juntas: sem token OU sem instance, a rota nasce desligada
   * (503), nunca aberta por omissão.
   */
  FINANCEIRO_LEMBRETE_TOKEN: optionalEnv(z.string().min(16)),
  FINANCEIRO_WHATSAPP_INSTANCE_ID: optionalEnv(z.string().uuid()),

  /**
   * Limite de envios por MINUTO de cada token da API de integração
   * (`POST /integrations/messages`). Folgado de saída — confirmação de
   * agendamento é evento esporádico —, mas fica em configuração para o
   * escritório apertar sem mexer no código. O 429 sai por token, não por IP.
   */
  INTEGRATION_TOKEN_RATE_LIMIT_PER_MINUTE: z.coerce.number().min(1).max(100_000).default(60),

  /**
   * Chave de cifra (32 bytes em hex, `openssl rand -hex 32`) da chave de API
   * dos provedores de IA, que fica cifrada no banco (ver `lib/ai-secrets.ts`).
   * Opcional: sem ela a cifra deriva do JWT_SECRET, e o boot avisa — trocar
   * o JWT_SECRET nesse modo invalida a chave gravada (a tela pede de novo).
   */
  AI_SECRETS_KEY: optionalEnv(z.string().regex(/^[0-9a-fA-F]{64}$/, "AI_SECRETS_KEY deve ter 64 caracteres hexadecimais")),
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
