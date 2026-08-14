# ZapDesk — Plataforma de Atendimento por WhatsApp

Plataforma web para centralizar atendimentos realizados por **múltiplos números de WhatsApp**, com **grupos como entidade de primeira classe** — cada cliente pode ter vários grupos (Geral, Contábil, Fiscal, DP...) e todos convergem para uma Inbox única.

Uso interno inicialmente, mas arquitetada desde o início para virar SaaS (multi-tenant via `organizationId` em todas as entidades de negócio).

## Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS |
| Backend | Node.js 22, Fastify 5, TypeScript strict |
| Banco | PostgreSQL 16 + Prisma (migrations versionadas) |
| Tempo real | Socket.IO (salas por organização) |
| WhatsApp | Baileys (isolado atrás da interface `WhatsAppProvider`) |
| Auth | JWT + bcrypt, autorização por papéis (admin / supervisor / agent) |

### Por que Baileys (e não whatsapp-web.js)?

- **Baileys** fala o protocolo do WhatsApp Web diretamente via WebSocket — **não precisa de navegador**. Cada sessão consome poucos MB de RAM.
- **whatsapp-web.js** exige um Chromium headless (Puppeteer) **por sessão**. Com 5+ números simultâneos o custo de memória/CPU e a fragilidade (crashes de browser) tornam a operação muito pior.
- Para multi-sessão, persistência de credenciais em arquivos e reconexão programática, Baileys é a opção tecnicamente superior.

A escolha é **substituível por design**: nada fora de `packages/whatsapp` importa Baileys (regra reforçada por revisão — controllers, services, banco e frontend consomem apenas a interface `WhatsAppProvider`). Uma futura `MetaCloudApiProvider` (API oficial) entra sem tocar na regra de negócio.

> Aviso: integrações não oficiais (sessão via QR Code) violam os termos de serviço do WhatsApp e têm risco de banimento do número. Use números dedicados ao atendimento e considere migrar para a API oficial (Meta Cloud) quando fizer sentido — a arquitetura já está pronta para isso.

## Estrutura do monorepo

```
apps/
  api/          # Fastify: auth, usuários, departamentos, tags, instâncias,
                # conversas, mensagens, mídia, busca, dashboard, auditoria, Socket.IO
  web/          # Next.js: login, dashboard, inbox 3 colunas, gestão
packages/
  shared/       # Enums, tipos neutros de provider, contratos de eventos realtime
  database/     # Prisma schema, migrations, seed, client singleton
  whatsapp/     # Interface WhatsAppProvider + QrCodeWhatsAppProvider (Baileys)
```

Módulos da API (em `apps/api/src/modules` + `services`): `auth`, `users`, `departments`, `tags`, `whatsapp-instances`, `conversations` (atribuição, notas, etiquetas), `messages` (texto + mídia), `search`, `dashboard`, `audit`, `realtime`, `instance-manager` (orquestração provider ⇄ banco ⇄ socket) e `message-ingest` (pipeline de ingestão idempotente).

## Rodando em desenvolvimento

Pré-requisitos: Node 22+, pnpm 10+, PostgreSQL 16 (local ou `docker compose up postgres`).

```bash
# 1. Instalar dependências
pnpm install

# 2. Configurar ambiente
cp .env.example .env
# edite DATABASE_URL e JWT_SECRET (openssl rand -hex 32)

# 3. Criar banco e aplicar migrations
pnpm db:migrate        # prisma migrate dev

# 4. Seed (organização + admin + departamentos padrão)
pnpm db:seed
# credenciais default de DEV: admin@example.com / admin123
# (customize com SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)

# 5. Subir API (porta 4000) e web (porta 3000)
pnpm dev
```

Fluxo do primeiro atendimento:

1. Acesse `http://localhost:3000` e faça login;
2. Vá em **WhatsApp → Adicionar WhatsApp**, crie a instância;
3. Clique em **Conectar** — o QR Code aparece no modal (e se renova sozinho);
4. Escaneie com o celular (WhatsApp → Dispositivos conectados);
5. O status muda para **Conectado** sem reload; grupos são sincronizados automaticamente;
6. Abra a **Inbox**: converse, veja quem escreveu cada mensagem no grupo, envie arquivos, atribua responsável/departamento, adicione notas internas e etiquetas.

A sessão sobrevive a restart do backend: as credenciais ficam em `WHATSAPP_SESSION_DIR` e as instâncias ativas são retomadas no boot (`resumeSessions`). Deploy **não** exige novo QR Code.

### Scripts úteis

```bash
pnpm lint         # ESLint em todos os pacotes
pnpm typecheck    # tsc strict em todos os pacotes
pnpm test         # vitest (normalização, permissões, preview)
pnpm build        # build de produção (inclui Next.js)
pnpm db:deploy    # prisma migrate deploy (produção)
```

## Deploy (VPS Linux)

**Guia completo e passo a passo: [DEPLOY.md](./DEPLOY.md)** — inclui `docker-compose.prod.yml` com proxy HTTPS automático (Caddy), backups e checklist de segurança.

### Com Docker Compose (desenvolvimento/rede local)

```bash
cp .env.example .env   # defina JWT_SECRET, POSTGRES_PASSWORD, WEB_ORIGIN, NEXT_PUBLIC_API_URL
docker compose up -d --build
```

- `whatsapp_sessions` e `media_store` são volumes nomeados — **preservam sessões e arquivos entre deploys**;
- as migrations são aplicadas automaticamente no start da API;
- rode o seed uma única vez: `docker compose exec api pnpm --filter @zapdesk/database seed`.

Frontend e API podem rodar em servidores diferentes: o web só precisa de `NEXT_PUBLIC_API_URL` apontando para a API pública (e a API de `WEB_ORIGIN` para o CORS). O serviço que segura as sessões de WhatsApp é a API — escale o web à vontade; a API deve rodar em instância única (sessões são stateful) até existir um broker de sessões.

### Sem Docker

`pnpm install && pnpm db:deploy && pnpm --filter @zapdesk/api start` atrás de um systemd/pm2, e `pnpm --filter @zapdesk/web build && start` para o web. Use um reverse proxy (Caddy/Nginx) com TLS na frente.

### Redes restritas

Se a saída de rede passa por proxy corporativo, defina `WHATSAPP_PROXY_URL` — o WebSocket do WhatsApp será tunelado por ele.

## Segurança

- JWT com expiração; senha com bcrypt; endpoints protegidos por papel (admin/supervisor/agent);
- rate limiting global (300 req/min) e específico no login (10/min);
- validação de entrada com Zod em todas as rotas; tratamento global de erros sem vazar internals;
- mídia servida somente autenticada e escopada por organização; proteção contra path traversal;
- credenciais de sessão do WhatsApp ficam **fora do Git** (`data/` ignorado) em diretório dedicado;
- nenhum token/secret/sessão é exposto ao frontend; auditoria (`AuditLog`) de login, conexões, atribuições, envios e etiquetas;
- logs estruturados (pino) com `instanceId`, `conversationId`, `messageId`, `event`, sem conteúdo sensível.

Para produção séria, considere ainda: tokens httpOnly + refresh (hoje o token fica em `localStorage`, aceitável para ferramenta interna), 2FA e backup automatizado do Postgres + volume de sessões.

## O que está funcionando

- Login/JWT, papéis, cadastro de usuários, departamentos e etiquetas;
- múltiplas instâncias de WhatsApp, cada uma independente (queda de uma não afeta as outras);
- conexão via QR Code com atualização automática do QR e status em tempo real (sem reload);
- persistência de sessão em disco + retomada automática após restart/deploy;
- reconexão automática com backoff exponencial; `logged_out` limpa credenciais e pede novo QR;
- sincronização de chats, contatos e grupos (com participantes e admins);
- recebimento de mensagens em tempo real (texto, imagem, áudio, vídeo, documento, sticker, localização, contato) com download e armazenamento de mídia;
- identificação do participante que enviou cada mensagem de grupo (nome + telefone, cor por remetente);
- envio de texto e de arquivos/áudios/imagens/PDFs pela Inbox;
- status de entrega (enviado/entregue/lido) quando o WhatsApp reporta;
- Inbox de 3 colunas: lista com filtros (minhas, sem responsável, grupos, individuais, não lidas, status, departamento, número, etiqueta) e busca; chat central; painel de contexto (participantes, responsável, departamento, etiquetas, notas internas, histórico de atribuições);
- assumir/transferir/liberar/finalizar/reabrir atendimento com histórico completo (`ConversationAssignmentHistory`);
- notas internas (nunca vão para o WhatsApp) visualmente distintas;
- busca global (conversas, mensagens, documentos, participantes) via `/search`;
- dashboard com contadores operacionais;
- auditoria consultável (`GET /audit-logs`);
- Docker Compose com volumes persistentes; lint + typecheck + 32 testes verdes.

## O que ainda falta (próximos passos sugeridos)

- **Validação em produção do pareamento QR**: o ambiente onde este código foi desenvolvido bloqueia a saída para `web.whatsapp.com`, então o handshake final com o WhatsApp não pôde ser exercitado de ponta a ponta aqui. O fluxo (QR → conexão → eventos) usa o caminho padrão e estável do Baileys, mas o primeiro pareamento real deve ser feito em ambiente com rede aberta;
- foto de perfil de contatos/grupos (campo já existe; falta buscar via provider);
- envio de áudio gravado no navegador (hoje envia arquivos de áudio; gravação nativa é próximo passo);
- mensagens citadas (reply) na UI — o dado já é persistido (`quotedMessageId`);
- paginação infinita na lista de mensagens (hoje carrega as últimas 60);
- marcação de lida no WhatsApp (read receipts de saída);
- fila (BullMQ/Redis) para ingestão de mídia em volume alto — hoje o download é inline;
- tela de auditoria no frontend (API pronta);
- storage S3/Supabase para mídia (interface `MediaStorage` pronta para o driver);
- testes de integração da API com banco (hoje unitários);
- multi-organização real (cadastro de organizações, billing) — o modelo de dados já suporta.
