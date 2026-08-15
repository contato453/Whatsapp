# AZVCHAT — Contexto do sistema para a IA

Documento de contexto do repositório `contato453/Whatsapp` (pacote raiz: `azvchat`).
Serve para dois usos:

1. **Contexto automático do Claude Code** — este arquivo é lido no início de cada sessão
   dentro do repositório;
2. **Base de conhecimento para escrever prompts** — cole no projeto do Claude (ou em uma
   skill) quando quiser que ele gere prompts de alteração já com a arquitetura, os nomes
   reais e as regras da casa na cabeça.

Se algo aqui divergir do código, **o código vence** — e este arquivo deve ser atualizado
no mesmo commit da mudança.

---

## 1. O que o sistema é

Plataforma web de atendimento por WhatsApp para escritório contábil/jurídico, com
**múltiplos números conectados** e **grupos como entidade de primeira classe**: cada
cliente pode ter vários grupos (Geral, Contábil, Fiscal, DP) e todos caem em uma **Inbox
única**.

- Uso interno hoje, mas **multi-tenant por design**: toda entidade de negócio carrega
  `organizationId`.
- Substitui o WhatsApp Web na mão da equipe: distribui atendimento, registra quem fez o
  quê, separa por departamento e mantém histórico auditável.
- Nome do produto no código: `azvchat` / `@azvchat/*`. Alguns textos legados dizem
  "ZapDesk" (chave do token no navegador é `zapdesk.token`) — não confunda com outro
  sistema.

**Não confundir com o Azevedo OS.** Se o pedido citar portais (Gestão, CS, Comercial,
Financeiro, Mídia, Apoio, Operacional, RH, CRM), Supabase, RLS ou Lovable, é outro
projeto — este aqui é Fastify + Prisma + Postgres em VPS.

---

## 2. Stack e monorepo

| Camada | Tecnologia |
| --- | --- |
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, lucide-react |
| Backend | Node 22, Fastify 5, TypeScript strict, Zod |
| Banco | PostgreSQL 16 + Prisma (migrations versionadas em SQL) |
| Tempo real | Socket.IO (salas por organização / número / departamento / responsável) |
| WhatsApp | Baileys, isolado atrás da interface `WhatsAppProvider` |
| Auth | JWT (`@fastify/jwt`) + bcrypt, papéis admin / supervisor / agent |
| Testes | Vitest (unitários) |
| Deploy | Docker Compose + Caddy (HTTPS automático) em VPS, via GitHub Actions por SSH |
| Gerenciador | pnpm 10 workspaces |

```
apps/
  api/                      # Fastify
    src/modules/<dominio>/routes.ts   # rotas HTTP por domínio
    src/services/           # instance-manager, message-ingest, scheduler
    src/realtime/socket.ts  # Socket.IO, salas e audiência
    src/lib/                # auth, access, errors, serialize, media-storage, signature...
    test/                   # vitest
  web/                      # Next.js App Router
    src/app/(app)/<rota>/page.tsx
    src/components/         # ui.tsx (kit), inbox/*, users/*
    src/lib/                # api.ts (client HTTP), auth-context, socket-context
packages/
  shared/                   # enums, tipos de provider, contratos de realtime, formatação
  database/                 # schema.prisma, migrations, seed, client singleton
  whatsapp/                 # interface WhatsAppProvider + QrCodeWhatsAppProvider (Baileys)
```

Scripts raiz: `pnpm dev` (api 4000 + web 3000), `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm db:migrate`, `pnpm db:deploy`, `pnpm db:seed`,
`pnpm db:generate`.

---

## 3. Glossário do domínio

| Termo | Significa |
| --- | --- |
| **Instância / número** | `WhatsAppInstance` — um número de WhatsApp conectado por QR Code. Cada um é independente: a queda de um não afeta os outros. |
| **Conversa** | `Conversation` — um chat (individual ou grupo) dentro de uma instância. Única por `(whatsappInstanceId, externalChatId)`. |
| **Departamento** | `Department` — recorte organizacional (Contábil, Fiscal, DP...). Define quem enxerga e pode ter responsável padrão. |
| **Responsável** | `Conversation.assignedUserId` — quem assumiu o atendimento. |
| **Nota interna** | `InternalNote` — texto que aparece intercalado no chat, **nunca vai para o WhatsApp**. |
| **Etiqueta** | `Tag` — rótulo da conversa. Vale para todos (`isGeneral`) ou para vários departamentos (N:N). |
| **Resposta rápida** | `QuickReply` — texto disparado por `/atalho` no composer. |
| **Participante** | `GroupParticipant` — quem está no grupo, com nome, telefone, foto e flag de admin. |
| **`externalId` / `externalChatId` / JID** | Identificador do WhatsApp (ex.: `5511999@s.whatsapp.net`, `...@g.us`, `...@lid`). |
| **LID** | Identificador anônimo novo do WhatsApp. `packages/whatsapp/src/qrcode/normalize.ts` cuida disso; número de LID **não** é telefone e não deve ser exibido como tal. |
| **Assinatura** | Prefixo `*Nome:*` na mensagem enviada, quando `User.signMessages` está ligado. |

---

## 4. Modelo de dados (Prisma)

Arquivo: `packages/database/prisma/schema.prisma`. Todas as tabelas usam `@@map` para
snake_case e id `uuid`.

**Organização e pessoas**
- `Organization` — raiz do tenant.
- `User` — `role` (`admin|supervisor|agent`), `status` (`active|inactive`), `avatarUrl`,
  `signMessages`, `lastLoginAt`.
- `UserWhatsAppInstance` (N:N) — **quais números o usuário enxerga**.
- `UserDepartment` (N:N) — **em quais departamentos o usuário atua**.
- `Department` — `name` único na org, `color`, `defaultAssigneeId` (responsável padrão).

**WhatsApp**
- `WhatsAppInstance` — `status` (`disconnected|connecting|qr_required|connected|reconnecting|error`),
  `sessionId`, `departmentId` (departamento padrão das conversas que chegam),
  `defaultAssigneeId` (responsável padrão do número), `provider`.
- `Contact`, `WhatsAppGroup` (com `participantCount`, `conversationId`), `GroupParticipant`
  (`name` do WhatsApp vs `customName` da equipe, `isAdmin`, `avatarUrl`, `avatarCheckedAt`).

**Atendimento**
- `Conversation` — `type` (`individual|group`), `title` (vem do WhatsApp, o sync sobrescreve)
  vs `customTitle` (definido pela equipe, o sync **nunca** toca), `partnerName` (sócio
  representante), `status` (`open|waiting_client|waiting_internal|resolved`),
  `assignedUserId`, `departmentId`, `unreadCount`, `lastMessageAt`, `lastMessagePreview`,
  `externalReference`/`externalSource` (gancho para CRM futuro).
- `Message` — `direction`, `type` (`text|image|audio|video|document|sticker|location|contact|poll|call|other`),
  `status` (`pending|sent|delivered|read|failed`), `content`, `mediaUrl`, `quotedMessageId`,
  `sentByUserId`, `deletedAt`/`deletedByUserId`, `editedAt`, `metadata` (Json, ex.: opções
  de enquete). Única por `(conversationId, externalMessageId)` → ingestão idempotente.
- `MessageReaction` — única por `(messageId, senderExternalId)`.
- `InternalNote`, `Tag` + `ConversationTag` + `TagDepartment`, `QuickReply` +
  `QuickReplyDepartment`, `ScheduledMessage`
  (`pending|sent|failed|canceled`, com `attempts`), `ConversationAssignmentHistory`
  (`assigned|transferred_user|transferred_department|unassigned|resolved|reopened`),
  `AuditLog`.

**Regra de migration**: nunca editar migration já aplicada. Criar nova pasta
`packages/database/prisma/migrations/<timestamp>_<nome>/migration.sql` seguindo o padrão
das existentes (nome descritivo em snake_case, ex.: `20260814200000_custom_names`).

---

## 5. A regra mais importante: quem enxerga o quê

Decidida em **um único lugar** — `apps/api/src/lib/access.ts` — e válida igual para HTTP
e para o tempo real. O que não pode ser buscado por API também não chega pelo socket.

| Papel | Enxerga |
| --- | --- |
| `admin` | a organização inteira, sem filtro |
| `supervisor` | todas as conversas dos **departamentos marcados**, dentro dos **números marcados** |
| `agent` ("Usuário" na tela) | mesmo recorte, mas só as conversas **atribuídas a ele** e as **sem responsável** |

Regras sem exceção:
- **número não vinculado ao login nunca aparece**, nem para supervisor;
- **sem número ou sem departamento marcado, o usuário não vê conversa alguma** — não existe
  "sem marcação = vê tudo";
- **conversa sem departamento** (`departmentId = null`) fica visível para quem tem o número.
  Ela nasce assim quando o número não tem departamento padrão — sumir com ela criaria
  mensagem de cliente que ninguém vê.

Funções de `access.ts` que **toda** consulta nova deve usar (nenhuma rota monta filtro de
acesso por conta própria):

```ts
loadConversationAccess(prisma, user)   // → { instanceIds, departmentIds, ownOnly, userId }
conversationScope(access)              // filtro Prisma para Conversation
accessibleInstanceIds / instanceScope / instanceIdScope
accessibleDepartmentIds                            // departamentos do usuário (null = admin)
departmentResourceScope(ids)                       // tags e quick replies: geral OU algum dept
canWriteGeneralResource(ids)                       // item geral continua sendo só do admin
canWriteInAllDepartments(ids, departmentIds)       // escrita exige TODOS, não um só
groupScope(access)                     // consultas que partem do grupo (usa `is:` obrigatório)
```

**Papel ≠ visibilidade.** Visibilidade responde "quais conversas"; papel responde "quais
ações":

| Ação | Papel mínimo |
| --- | --- |
| Criar/editar usuário; excluir número ou departamento | `admin` |
| Criar/conectar número, criar departamento e etiqueta, ver auditoria, relatórios, editar nota de terceiro | `supervisor` |
| Inbox, atribuição, notas próprias, respostas rápidas, próprio perfil e senha | `agent` |

A hierarquia vive em `packages/shared/src/enums.ts` (`hasRole`) e é a **mesma tabela** usada
por `requireRole()` na API e pelo array `NAV` em `apps/web/src/app/(app)/layout.tsx`.
Mudou uma, muda a outra.

Outras invariantes de segurança:
- **JWT é foto do passado, quem manda é o banco**: `createSessionVerifier` relê papel,
  status e nome a cada requisição autenticada. Desativar ou rebaixar vale na hora.
- O handshake do socket revalida a sessão; mudança de papel/status/recorte **derruba as
  conexões abertas** daquele usuário (`disconnectUser`).
- A organização **nunca fica sem admin ativo** — rebaixar/desativar o último é recusado
  dentro de transação com linhas travadas.
- Dado de cadastro não circula: usuário citado dentro do trabalho de outro sai por
  `serializeUserDirectory` (id, nome, papel, status, avatar). E-mail, último acesso e o
  mapa de acessos só saem em `GET /users` para admin.

---

## 6. API HTTP

Base: `NEXT_PUBLIC_API_URL` (dev `http://localhost:4000`). Auth por `Authorization: Bearer`.
Validação com **Zod em toda rota**. Erros pelo handler global (`lib/errors.ts`:
`AppError`, `NotFoundError` 404, `ForbiddenError` 403, `UnauthorizedError` 401,
`validation_error` 400) — nunca vaza internals. Rate limit global 300/min; login e troca de
senha 5–10/min.

```
GET    /health

POST   /auth/login          GET /auth/me   PATCH /auth/me   POST /auth/logout
POST   /auth/change-password (exige a senha atual, 5 req/min)
POST   /auth/me/avatar      DELETE /auth/me/avatar          GET /users/:id/avatar

GET    /users               POST /users              PATCH /users/:id

GET    /departments         GET /departments/mine    POST /departments
PATCH  /departments/:id     DELETE /departments/:id

GET    /tags                POST /tags               DELETE /tags/:id

GET    /whatsapp-instances                POST /whatsapp-instances
PATCH  /whatsapp-instances/:id            DELETE /whatsapp-instances/:id
POST   /whatsapp-instances/:id/connect    POST /whatsapp-instances/:id/disconnect
POST   /whatsapp-instances/:id/logout     GET  /whatsapp-instances/:id/qr
GET    /whatsapp-instances/:id/assignees  (quem pode ser responsável padrão do número)
POST   /whatsapp-instances/:id/apply-default-assignee  (aplica às conversas já sem responsável)

GET    /conversations                     GET /conversations/:id
PATCH  /conversations/:id                 PATCH /conversations/:id/reference
GET    /conversations/:id/avatar          POST /conversations/:id/avatar/refresh
GET    /group-participants/:id/avatar     PATCH /group-participants/:id
POST   /conversations/:id/read            POST /conversations/:id/status
POST   /conversations/:id/assign          POST /conversations/:id/unassign
POST   /conversations/:id/resolve         POST /conversations/:id/reopen
GET    /conversations/:id/files
POST   /conversations/:id/tags/:tagId     DELETE /conversations/:id/tags/:tagId
POST   /conversations/:id/notes           PATCH|DELETE /conversations/:id/notes/:noteId

GET    /conversations/:id/messages        GET /conversations/:id/messages/search
GET    /conversations/:id/messages/around POST /conversations/:id/messages
POST   /conversations/:id/polls           POST /messages/:id/reactions
PATCH  /messages/:id                      DELETE /messages/:id
POST   /messages/:id/forward              GET  /messages/:id/media

GET    /tags                POST /tags            PATCH|DELETE /tags/:id
GET    /quick-replies       POST /quick-replies   PATCH|DELETE /quick-replies/:id
GET    /conversations/:id/scheduled-messages   POST /conversations/:id/scheduled-messages
DELETE /scheduled-messages/:id

GET    /search              GET /dashboard/stats  GET /reports/agents  GET /audit-logs
```

Mídia é servida **somente autenticada**, escopada por organização, com proteção contra
path traversal (`lib/media-storage.ts`, interface `MediaStorage` pronta para driver S3).

---

## 7. Tempo real (Socket.IO)

Contratos em `packages/shared/src/realtime.ts` — **nomes de evento nunca são string solta**,
sempre `RealtimeEvents.X`:

`message:new`, `message:status`, `message:reaction`, `message:updated`, `call:incoming`,
`conversation:updated`, `group:participants`, `note:new`, `instance:status`, `instance:qr`,
`scheduled:pending`.

`scheduled:pending` (`{ conversationId, pending }`) carrega quantas mensagens agendadas
ainda vão sair da conversa — é o badge no ícone de agendar do composer. Sai de
`lib/scheduled-pending.ts` (`emitScheduledPending`) em quatro momentos: agendamento criado,
cancelado, enviado pelo scheduler e marcado como `failed`. Retentativa **não** emite: sobe
`attempts` e o status segue `pending`, então o número não muda.

Salas (`apps/api/src/realtime/socket.ts`):

- `org:<organizationId>` — só admin;
- `instance:<instanceId>` — eventos do número (QR, status), sem conteúdo de conversa;
- `sup:<instanceId>:<departmentKey>` — supervisores;
- `free:<instanceId>:<departmentKey>` — conversa sem responsável;
- `mine:<instanceId>:<departmentKey>:<userId>` — conversa atribuída.

`departmentKey` é o `departmentId` ou a string `"none"`. Cada socket cai em **um único
grupo por evento**, então não há entrega duplicada. Para emitir um evento de conversa use
sempre `conversationAudience(orgId, { whatsappInstanceId, departmentId, assignedUserId })`;
para evento de número, `instanceAudience(orgId, instanceId)`.

`grantInstanceAccess()` coloca abas já abertas nas salas de um número recém-criado — sem
isso o QR Code (que se renova a cada poucos segundos) só chegaria depois de recarregar.

---

## 8. Camada WhatsApp

**Regra arquitetural inegociável**: nada fora de `packages/whatsapp` importa Baileys.
Controllers, services, banco e frontend consomem **só** a interface `WhatsAppProvider`
(`packages/whatsapp/src/provider.ts`). Isso permite plugar uma `MetaCloudApiProvider`
(API oficial) sem tocar em regra de negócio.

- Eventos do provider (normalizados): `qr`, `status`, `message`, `message-status`,
  `message-reaction`, `message-deleted`, `message-edited`, `call`, `chats-sync`,
  `contacts-sync`, `groups-sync`.
- `apps/api/src/services/instance-manager.ts` orquestra provider ⇄ banco ⇄ socket
  (registro de instância, sync de chats/grupos/contatos, fotos, reconexão com backoff,
  `resumeSessions` no boot).
- `apps/api/src/services/message-ingest.ts` é o pipeline idempotente: mensagem normalizada
  → conversa (upsert) → responsável padrão do departamento se estiver órfã → mensagem →
  mídia → preview → publicação em tempo real.
- `apps/api/src/services/scheduler.ts` roda as mensagens agendadas, com retentativa quando
  a instância está momentaneamente desconectada.
- Sessões ficam em `WHATSAPP_SESSION_DIR` (volume persistente). **Deploy não exige novo QR.**
- A API é **stateful**: escale o web à vontade, mas a API roda em instância única enquanto
  não existir broker de sessões.

---

## 9. Frontend

Rotas em `apps/web/src/app/(app)/`: `dashboard`, `inbox` (+ `inbox/[conversationId]`),
`whatsapp`, `users` (+ `new`, `[id]`), `departments`, `reports`, `tags`, `quick-replies`,
`settings`. Fora do grupo: `login`.

- `src/lib/api.ts` — client HTTP único (`api.*`). Token em `localStorage` (`zapdesk.token`);
  401 limpa token e manda para `/login`. **Não faça `fetch` solto em componente**: adicione
  o método em `api.ts`.
- `src/lib/auth-context.tsx` e `src/lib/socket-context.tsx` — sessão e socket.
- `src/components/ui.tsx` — kit da casa: `Button`, `Input`, `Textarea`, `Field`, `Badge`,
  `Card`, `Avatar`, `Modal`, `Spinner`, `EmptyState`. **Reuse antes de criar componente novo.**
- Inbox de 3 colunas em `src/components/inbox/`: `inbox-shell.tsx` (o maior arquivo do
  projeto, ~1300 linhas — orquestra lista, chat e composer), `conversation-list.tsx`,
  `message-bubble.tsx`, `context-panel.tsx` (participantes, responsável, departamento,
  etiquetas, notas, histórico, arquivos), `composer-modals.tsx`, `audio-recorder.tsx`,
  `audio-player.tsx`, `status-select.tsx`, `formatted-text.tsx`.
- Rótulos, cores e hierarquia de papéis vêm de `@azvchat/shared`
  (`CONVERSATION_STATUS_LABELS`, `CONVERSATION_STATUS_COLORS`, `USER_ROLE_LABELS`,
  `hasRole`) — **não redeclare no frontend**.
- Interface inteira em **português do Brasil**. O papel `agent` aparece como "Usuário".

---

## 10. Convenções da casa

1. **Fonte única de verdade.** Enum de domínio → Prisma + `packages/shared/src/enums.ts`.
   Regra de acesso → `lib/access.ts`. Evento de socket → `shared/src/realtime.ts`.
   Rótulo/cor de UI → `shared`. Duplicar qualquer um desses é bug.
2. **Zod em toda entrada**, inclusive `params` (`z.string().uuid()`).
3. **Serialização por função dedicada** (`lib/serialize.ts`, `serializeUserDirectory`,
   `serializeInstance`) — nunca devolver a entidade do Prisma crua. Campo que só a conversa
   aberta precisa entra em `serializeConversationDetail` (hoje o `scheduledPendingCount`,
   usado por `GET /conversations/:id`), e não em `serializeConversation`: a lista renderiza
   dezenas de linhas por carga e não paga consulta por linha.
4. **Auditoria** (`deps.audit.record`) em ação relevante: login, conexão/desconexão de
   número, atribuição, envio, etiqueta, mudança de cadastro.
5. **Logs estruturados** (pino) com `instanceId`, `conversationId`, `messageId`, `event` —
   **sem conteúdo de mensagem**.
6. **Comentários explicam o porquê, não o quê**, em português, e registram a decisão
   ("sem isso a pessoa encararia um QR vencido"). Esse é o tom do repositório inteiro:
   siga-o.
7. **TypeScript strict** — sem `any`, sem `@ts-ignore`.
8. Nada de segredo no frontend: token, sessão de WhatsApp e credenciais ficam na API;
   `data/` está no `.gitignore`.
9. Antes de terminar qualquer alteração: `pnpm typecheck && pnpm lint && pnpm test`.

---

## 11. Ambiente, deploy e CI

`.env` na raiz (modelo em `.env.example`): `DATABASE_URL`, `API_PORT`, `API_HOST`,
`WEB_ORIGIN` (CORS), `JWT_SECRET`, `JWT_EXPIRES_IN`, `WHATSAPP_SESSION_DIR`,
`WHATSAPP_PROXY_URL` (opcional), `MEDIA_DIR`, `MEDIA_MAX_SIZE`, `NEXT_PUBLIC_API_URL`,
`LOG_LEVEL`.

- **Dev**: `pnpm install` → `cp .env.example .env` → `pnpm db:migrate` → `pnpm db:seed`
  (admin default `admin@example.com` / `admin123`) → `pnpm dev`.
- **Produção**: VPS Ubuntu com Docker Compose (`docker-compose.prod.yml`) + Caddy emitindo
  HTTPS para dois subdomínios — `app.<dominio>` (web) e `api.<dominio>` (API). Volumes
  nomeados `whatsapp_sessions` e `media_store` preservam sessões e arquivos entre deploys;
  migrations rodam no start da API. Passo a passo completo em `DEPLOY.md`.
- **CI** (`.github/workflows/ci.yml`): typecheck → lint → testes → build, em PR e push.
- **Deploy** (`.github/workflows/deploy.yml`): dispara por SSH quando o CI da branch padrão
  fecha verde; um deploy por vez, nunca cancelado no meio.

---

## 12. Receitas — como mudanças costumam ser feitas aqui

**Novo campo em entidade existente**
1. `schema.prisma` (com comentário `///` explicando o porquê quando não for óbvio);
2. nova migration SQL em `prisma/migrations/<timestamp>_<nome>/migration.sql`;
3. serializer em `apps/api/src/lib/serialize.ts` (ou o do módulo);
4. Zod da rota que escreve + auditoria se for relevante;
5. tipo no frontend (`apps/web/src/lib/types.ts`) e método em `api.ts`;
6. UI, usando o kit de `components/ui.tsx`.

**Novo endpoint**
1. `apps/api/src/modules/<dominio>/routes.ts` (crie o módulo e registre em `app.ts` se for novo);
2. `preHandler: authenticate` ou `requireRole("supervisor"|"admin")`;
3. filtro de acesso **sempre** por `access.ts`, nunca `where` montado à mão;
4. Zod em params/query/body; erros pelas classes de `lib/errors.ts`;
5. teste em `apps/api/test/`;
6. método em `apps/web/src/lib/api.ts`.

**Novo evento de tempo real**
1. nome + payload em `packages/shared/src/realtime.ts`;
2. emissão com `conversationAudience()` ou `instanceAudience()`;
3. listener no `socket-context` / componente do frontend;
4. conferir que o evento não vaza para quem não tem acesso à conversa.

**Nova tela**
1. `apps/web/src/app/(app)/<rota>/page.tsx`;
2. item no `NAV` do `layout.tsx` com `minRole` **igual** ao `requireRole` da API;
3. montar com o kit de UI; textos em português.

**Mudança de permissão**
Mexe em `access.ts` e/ou na tabela de papéis: atualizar `enums.ts`, os `requireRole` das
rotas, o `NAV` do frontend, as salas do socket e os testes de `apps/api/test/access.test.ts`
— os cinco, sempre juntos.

---

## 13. Armadilhas conhecidas

- `title` vs `customTitle` e `name` vs `customName`: o **sync do WhatsApp sobrescreve o
  primeiro e nunca toca no segundo**. Exibição prefere o custom.
- Relação opcional no Prisma exige `is:` (`conversation: { is: ... }`) — sem isso o filtro
  vazio do admin não casa nada. Já documentado em `groupScope`.
- Em `Tag`/`QuickReply`, **"geral" é a flag `isGeneral`, nunca a lista vazia de
  departamentos**. Se lista vazia significasse geral, excluir um departamento tornaria um
  item restrito visível para a organização inteira sem ninguém perceber; com a flag ele
  fica órfão e some para quem não é admin. Estado válido: `isGeneral` com zero
  departamentos, ou `isGeneral = false` com pelo menos um. O órfão existe no banco, só não
  pode ser criado — `lib/department-resource.ts` é a fonte única dessa regra.
- **Ler exige um departamento em comum; escrever exige todos.** Quem só acessa o Fiscal
  enxerga a etiqueta de Contábil + Fiscal, mas não consegue salvá-la (403, sem gravação
  parcial). A tela mostra a lista completa de departamentos mesmo assim: nome de
  departamento não é dado sensível, gravação parcial é.
- Etiqueta e resposta rápida só se aplicam à conversa se forem gerais ou se o departamento
  da conversa estiver entre os delas. **Conversa sem departamento aceita qualquer item
  visível** — ela existe quando o número não tem departamento padrão.
- `departmentId = null` em `Conversation` significa **"sem departamento"** (visível a quem
  tem o número) — não confunda com o "geral" de `Tag`/`QuickReply`, que agora é flag.
- **Responsável padrão tem cascata**: o do departamento vence, o do número cobre o resto
  (inclusive a conversa sem departamento). Quem recebe precisa **enxergar** a conversa —
  `lib/default-assignee.ts` (`eligibleAssigneeWhere`) é a fonte única dessa checagem, usada
  pela ingestão e pela aplicação em lote. Atribuir a quem não tem o número (ou o
  departamento) some com a conversa da fila sem ninguém ver.
- O padrão só age na **mensagem que chega**. Conversa parada continua órfã até alguém
  escrever — por isso existe `POST /whatsapp-instances/:id/apply-default-assignee`.
- Atalho de resposta rápida e nome de etiqueta são **únicos na organização inteira**, não
  por departamento.
- Ingestão é idempotente por `(conversationId, externalMessageId)` — não crie caminho
  paralelo de inserção de mensagem.
- LID (`@lid`) não é telefone. Existe migration só para limpar telefones que vieram de LID
  (`20260814140000_clear_lid_phone_numbers`).
- Mensagem apagada mantém a linha (`deletedAt`) para histórico/auditoria — não faça
  `delete` físico.
- Baileys é integração não oficial: risco de banimento do número. Use números dedicados.

---

## 14. Estado atual e lacunas

**Funciona**: múltiplos números com conexão por QR e status em tempo real; sessão
persistida e retomada após restart; sync de chats/contatos/grupos e fotos; recebimento e
envio de texto, imagem, áudio, vídeo, documento, figurinha, localização, contato; reações;
responder citando; encaminhar; apagar e editar; gravação de áudio (ffmpeg, com fallback);
enquetes; mensagens agendadas com retentativa; notas internas; etiquetas; atribuição com
histórico completo; quatro status de atendimento; busca na conversa e busca global;
respostas rápidas com `/`; dashboard; relatório por atendente; auditoria consultável;
perfil e troca de senha pelo próprio usuário; aviso de chamada recebida.

**Falta** (ordem sugerida): validar o pareamento QR em rede aberta (o ambiente de
desenvolvimento bloqueia `web.whatsapp.com`); votos de enquete agregados na Inbox;
biblioteca de figurinhas; read receipts de saída; fila (BullMQ/Redis) para mídia em
volume; tela de auditoria no frontend (API pronta); storage S3/Supabase (interface pronta);
testes de integração com banco; multi-organização real (cadastro e billing).

---

## 15. Como escrever um bom prompt para este sistema

Um prompt fica bom aqui quando responde, nesta ordem:

1. **O quê e para quem** — a mudança em uma frase, e qual papel (admin, supervisor,
   usuário) sente o efeito.
2. **Onde encosta** — cite as camadas pelo nome real: `schema.prisma` + migration,
   `modules/<dominio>/routes.ts`, `lib/access.ts`, `shared/enums.ts` ou `realtime.ts`,
   `web/src/lib/api.ts`, tela/componente.
3. **Regra de visibilidade** — quem passa a ver ou deixa de ver. Se a resposta for "não
   muda", diga isso explicitamente, para a IA não inventar filtro.
4. **Comportamento nas bordas** — conversa sem departamento, sem responsável, número
   desconectado, usuário desativado, grupo sem participante sincronizado.
5. **Tempo real** — a mudança precisa aparecer sem reload? Então tem evento e audiência.
6. **Auditoria** — a ação entra no `AuditLog`? Com qual `action`?
7. **Critério de pronto** — `pnpm typecheck && pnpm lint && pnpm test` verdes, mais o teste
   novo que prova a regra.

Esqueleto pronto:

> No AZVCHAT (monorepo `contato453/Whatsapp`, Fastify + Prisma + Next.js), quero **\<mudança\>**.
> Contexto: **\<por que, na operação do escritório\>**.
> Camadas afetadas: **\<liste\>**.
> Visibilidade: **\<quem vê / não muda\>** — usar as funções de `lib/access.ts`, sem `where` na mão.
> Bordas: **\<conversa sem departamento, sem responsável, ...\>**.
> Tempo real: **\<evento e audiência, ou "não precisa"\>**. Auditoria: **\<action, ou "não"\>**.
> Seguir as convenções do `CLAUDE.md` (Zod em toda entrada, serializer dedicado, enums em
> `@azvchat/shared`, kit de UI, textos em português, comentário explicando o porquê).
> Ao final: migration nova (nunca editar migration aplicada), teste cobrindo a regra, e
> `pnpm typecheck && pnpm lint && pnpm test` verdes. Commit e push na branch de trabalho.
