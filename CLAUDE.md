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
| **Resposta rápida** | `QuickReply` — texto disparado por `/atalho` no composer, com mídia opcional (imagem, áudio ou vídeo) que sai junto. |
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
  `signMessages`, `notificationSound`, `notificationVolume`, `lastLoginAt`.
- `User.notificationSound` (`NotificationSound`: `none|sound_1|sound_2|sound_3`, padrão
  `sound_1`) e `User.notificationVolume` (`NotificationVolume`: `low|medium|high`, padrão
  `medium`) — preferência **pessoal** do aviso sonoro de mensagem recebida, no mesmo
  caminho de `signMessages`: `PATCH /auth/me` (Zod contra os enums), `serializeUser`,
  auditoria `user.profile_updated`. **Não saem em `serializeUserDirectory`.** Os enums e
  os rótulos vivem também em `packages/shared/src/enums.ts` (`NOTIFICATION_SOUNDS`,
  `NOTIFICATION_SOUND_LABELS`, `NOTIFICATION_SOUND_DESCRIPTIONS`, `NOTIFICATION_VOLUMES`,
  `NOTIFICATION_VOLUME_LABELS`). Os três sons são sintetizados com Web Audio em
  `apps/web/src/lib/notification-sound.ts` — **não há arquivo de áudio no repositório**.
- `UserWhatsAppInstance` (N:N) — **quais números o usuário enxerga**.
- `UserDepartment` (N:N) — **em quais departamentos o usuário atua**.
- `Department` — `name` único na org, `color`, `defaultAssigneeId` (responsável padrão).

**WhatsApp**
- `WhatsAppInstance` — `status` (`disconnected|connecting|qr_required|connected|reconnecting|error`),
  `sessionId`, `departmentId` (departamento padrão das conversas que chegam),
  `defaultAssigneeId` (responsável padrão do número), `provider`, `isBackup`
  (número de backup: ligado, **toda conversa nova nele nasce arquivada**, na
  ingestão e nos syncs de chats/grupos; ligar não arquiva retroativamente e
  desligar não desarquiva — para o retroativo existe o arquivamento em massa).
- `Contact`, `WhatsAppGroup` (com `participantCount`, `conversationId`), `GroupParticipant`
  (`name` do WhatsApp vs `customName` da equipe, `isAdmin`, `avatarUrl`, `avatarCheckedAt`,
  `clientRole`).
- `GroupParticipant.clientRole` (`ParticipantClientRole`: `partner` | `administrative` |
  `null`) — papel da pessoa **dentro do cliente**, marcado pela equipe. Coluna única, então
  a seleção é única por construção. **Não confundir com `isAdmin`**, que é administrador do
  grupo no WhatsApp e vem do sync. Desde que o texto livre "sócio" saiu da conversa
  (migration `20260816200000_drop_partner_name`), é a única marcação de quem representa
  o cliente do lado do WhatsApp. Rótulos e cores em `PARTICIPANT_CLIENT_ROLE_LABELS` /
  `PARTICIPANT_CLIENT_ROLE_COLORS` (`@azvchat/shared`).

**Atendimento**
- `Conversation.assignedToAll` (padrão `false`) — **atendimento coletivo ("@todos")**: a
  conversa é de todo o departamento por decisão, e não de uma pessoa. Convive com
  `assignedUserId` **nulo** de propósito — a visibilidade já sai da regra existente (o
  atendente enxerga o que é dele mais o que está sem responsável), então `lib/access.ts`
  **não foi tocado** e não existe usuário fictício "@todos" no banco. A constraint
  `conversations_assigned_to_all_without_user` garante que marcação e responsável nunca
  coexistem; a fonte única dos dois lados (quem grava e quem conta) é
  `lib/conversation-assignment.ts`. Rótulos em `ALL_USERS_ASSIGNEE_LABEL` /
  `ALL_USERS_ASSIGNEE_HINT` e filtro `FILTER_ALL_USERS` (`@azvchat/shared`); as ações
  `assigned_to_all` / `unassigned_from_all` de `AssignmentAction` registram entrada e saída
  do coletivo — `assigned`/`unassigned` continuam significando pessoa. Independente do
  departamento (coletiva sem departamento aparece para quem tem o número), vale para grupo e
  individual, e sobrevive a resolver, reabrir, arquivar e trocar de departamento. Papel
  mínimo `agent`, o mesmo de atribuir/desatribuir.
- `Conversation` — `type` (`individual|group`), `title` (vem do WhatsApp, o sync sobrescreve)
  vs `customTitle` (definido pela equipe, o sync **nunca** toca), `status`
  (`open|waiting_client|waiting_internal|resolved`),
  `assignedUserId`, `departmentId`, `lastMessageAt`, `lastMessagePreview`,
  `unreadCount` (**APOSENTADA** — o não lido é por usuário; ver `ConversationRead`
  logo abaixo. A coluna segue no banco com o dado histórico, sem nenhuma leitura nem
  escrita no código; a remoção é migration futura),
  `archivedAt`/`archivedByUserId` (arquivamento: a data responde "está arquivada?",
  nulo = não; **ortogonal ao status** — não é um quinto status, e ao desarquivar a
  conversa volta com o status que tinha; `archivedByUserId` nulo = arquivada pelo
  sistema, caso do número de backup), `externalReference`/`externalSource` (referência
  a sistema externo — **um campo, dois mecanismos**: `manual` guarda o código do
  cadastro digitado no escritório ("EMPRESA 001") e `azevedo-os` guarda o
  identificador da empresa no Azevedo-OS; ver a seção 15). Índice
  `(organizationId, archivedAt, lastMessageAt)` serve a lista da Inbox (não
  arquivadas por última mensagem).
- `ConversationRead` — **leitura por usuário**: até onde CADA pessoa leu uma conversa.
  Única por `(userId, conversationId)`, com `lastReadAt` (o instante da última mensagem
  lida) e `lastReadMessageId` (referência, opcional). **Guarda a marca, e não um
  contador por pessoa**: contador exigiria escrever uma linha por usuário a cada
  mensagem recebida — num grupo que dez atendentes enxergam, dez escritas por mensagem.
  Com a marca, escreve só quem lê, e o número de não lidas é **derivado** na consulta
  (mensagens `inbound` vivas acima da marca, em conversa não arquivada). **Linha ausente
  = nunca leu**, e nada é semeado: conversa que a pessoa nunca abriu aparece por ler
  inteira, que é o estado seguro. Fonte única da conta:
  `apps/api/src/lib/conversation-reads.ts`.
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

**Parâmetros de atendimento**
- `AttendanceSettings` — uma linha por organização (`organizationId` único):
  `responseLimitMinutes` (padrão 30) e `timezone` (padrão `America/Sao_Paulo`). É a política
  de SLA do escritório, lida **a cada requisição** do dashboard (nunca em cache).
- `AttendanceBusinessHours` — sete linhas por configuração, únicas por
  `(settingsId, weekday)`: `weekday` (0 = domingo ... 6 = sábado, igual a `Date#getDay()` e a
  `EXTRACT(DOW)`), `active`, `startTime`/`endTime` no formato `"HH:MM"`. Cada dia liga e
  desliga sozinho — o escritório pode passar a atender sábado de manhã.
- `AttendanceSettings.loginRestrictionEnabled` (padrão `false`) + `AttendanceLoginHours` — a
  **janela de login**: em quais dias e horas quem **não é supervisor** consegue entrar no
  sistema. Mesma forma do expediente (sete linhas, únicas por `(settingsId, weekday)`,
  padrão seg-sex 07:00–19:00), tabela separada de propósito: o expediente mede o atraso do
  dashboard, e amarrar as duas faixas obrigaria a esticar o expediente só para liberar quem
  chega mais cedo — o número de atraso passaria a mentir junto. Nasce desligada: ligada de
  saída, o deploy trancaria do lado de fora quem estivesse trabalhando.
- A filha aponta para `AttendanceSettings`, e não para a organização: parâmetro por
  departamento no futuro é só uma linha nova de settings. **Não há tabela de feriados** —
  feriado conta como dia normal.
- Padrões e rótulos em `packages/shared/src/attendance.ts` (`DEFAULT_ATTENDANCE_SETTINGS`,
  `WEEKDAY_LABELS`, `DASHBOARD_PERIODS`, `DEFAULT_LOGIN_HOURS`,
  `LOGIN_OUTSIDE_SCHEDULE_MESSAGE`). Eles semeiam a linha e servem de fallback quando
  ela ainda não existe — **o que vale em runtime é sempre o banco**.

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
| Criar/conectar número, criar departamento e etiqueta, ver auditoria, relatórios, **gravar parâmetros de atendimento** (item "Parâmetros" do menu), editar nota de terceiro, **alterar o departamento da conversa** | `supervisor` |
| Inbox, atribuição, status, notas próprias, respostas rápidas, próprio perfil e senha, **ler parâmetros de atendimento** | `agent` |

**Departamento da conversa é escrita de supervisão.** É o campo que decide *quem enxerga*
(ele alimenta `conversationScope`), então trocá-lo tira a conversa do campo de visão de um
time inteiro — ou some com ela da tela de quem trocou. O papel mínimo vive em
`CONVERSATION_DEPARTMENT_MIN_ROLE` (`@azvchat/shared`) e é usado nos dois lados: o
`requireRole` de `POST /conversations/:id/transfer-department` e o painel de contexto, que
**não desenha** o campo para `agent` (desabilitar só geraria a pergunta "por que não
funciona?"; a informação continua no chip da lista). A mesma rota de atribuição aceita
`departmentId` no corpo — ali a recusa é **do campo, não da rota**
(`canWriteConversationDepartment`, em `lib/conversation-access.ts`): sem o campo, o
atendente atribui normalmente. Conversa sem departamento não abre exceção: classificar
pela primeira vez também é decisão de supervisão.

A hierarquia vive em `packages/shared/src/enums.ts` (`hasRole`) e é a **mesma tabela** usada
por `requireRole()` na API e pelo array `NAV` em `apps/web/src/app/(app)/layout.tsx`.
Mudou uma, muda a outra.

Outras invariantes de segurança:
- **JWT é foto do passado, quem manda é o banco**: `createSessionVerifier` relê papel,
  status e nome a cada requisição autenticada. Desativar ou rebaixar vale na hora.
- **Horário permitido de login** (`lib/login-schedule.ts`, fonte única da regra): com a
  restrição ligada, quem é `agent` só entra dentro da janela do dia, lida no fuso do
  escritório. Supervisor e admin entram sempre — são eles que destrancam a porta na tela de
  Parâmetros, e um sábado desligado por engano deixaria a casa inteira do lado de fora.
  A checagem vem **depois** da senha (antes dela, a mensagem de horário revelaria quais
  e-mails existem) e devolve 403 `login_outside_schedule` com
  `LOGIN_OUTSIDE_SCHEDULE_MESSAGE`.
- **A sessão aberta obedece ao mesmo horário.** `createSessionVerifier` confere a janela a
  cada requisição autenticada (a configuração vem no mesmo `include` do usuário, sem
  segunda consulta) e devolve 401 `session_outside_schedule`. Barrar só o login deixaria a
  aba de quem entrou de manhã trabalhando a madrugada inteira. Como aba parada não faz
  requisição, `services/session-schedule-watcher.ts` varre os sockets a cada minuto:
  `session:closing` a partir de `LOGIN_SCHEDULE_WARNING_MINUTES` (5) minutos do fechamento,
  reenviado a cada volta para o aviso contar para trás sozinho, e `session:closed` +
  desconexão quando fecha. No frontend quem escuta é `components/session-schedule.tsx`, e o
  rascunho do composer já está gravado (ver `src/lib/drafts.ts`) — encerrar não perde texto.
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
GET    /whatsapp-instances/:id/archivable-count  (supervisor; quantas o arquivamento em massa pegaria)
POST   /whatsapp-instances/:id/archive-all       (supervisor; arquiva todas as conversas do número,
       em lotes de 500, auditado com a quantidade — usado no número de backup)

GET    /conversations                     GET /conversations/:id
       (a lista EXCLUI arquivadas por padrão; `?archived=true` traz só elas —
        não existe "todas misturadas")
       [&taxRegime=<valor|none>][&payroll=<valor|none>][&unlinked=true]
       (recorte por característica do cliente no Azevedo-OS; `none` é "sem
        informação" e `unlinked` são as conversas sem empresa vinculada, que
        NÃO combina com os outros dois. A resposta ganha `companyFilter`
        (`unavailable`, `truncated`, `unlinkedExcluded`), nulo quando nenhum
        dos dois filtros está ativo — ver a seção 15)
GET    /integrations/azevedo-os/company-facets
       (agent+; opções dos dois seletores, com o rótulo escrito no Azevedo-OS.
        Nunca devolve erro: `facets: null` com `unavailable: false` é
        integração desligada e com `true` é portal mudo)
POST   /conversations/:id/archive         POST /conversations/:id/unarchive
       (papel mínimo agent, o mesmo de status/atribuição; audita e emite
        conversation:updated — não há contador de conversa para zerar, a
        arquivada simplesmente não conta não lidas para ninguém)
PATCH  /conversations/:id                 PATCH /conversations/:id/reference
GET    /conversations/:id/avatar          POST /conversations/:id/avatar/refresh
GET    /group-participants/:id/avatar     PATCH /group-participants/:id
POST   /conversations/:id/read            POST /conversations/:id/unread
       (leitura POR USUÁRIO: `read` avança a marca de quem chamou até a última
        mensagem e `unread` recua de propósito ("reservar para depois"). As duas
        devolvem o contador já recalculado, valem só para quem chamou e emitem
        `conversation:read` para a sala pessoal — nunca para a audiência da
        conversa. Sem auditoria: leitura é estado pessoal de interface)
POST   /conversations/:id/status
POST   /conversations/:id/assign          POST /conversations/:id/unassign
POST   /conversations/:id/resolve         POST /conversations/:id/reopen
GET    /conversations/:id/files
POST   /conversations/:id/tags/:tagId     DELETE /conversations/:id/tags/:tagId
POST   /conversations/:id/notes           PATCH|DELETE /conversations/:id/notes/:noteId

GET    /conversations/:id/messages        GET /conversations/:id/messages/search
GET    /conversations/:id/messages/around POST /conversations/:id/messages
       (`mentions`: participantes marcados, SEPARADO do `content` — é a lista que
        notifica, conferida contra os participantes daquela conversa)
POST   /conversations/:id/quick-reply-media
       (envia a mídia da resposta rápida direto do storage da API — do navegador
        sai só JSON; valida com `departmentResourceAppliesTo` e marca `lastUsedAt`)
POST   /conversations/:id/polls           POST /messages/:id/reactions
PATCH  /messages/:id                      DELETE /messages/:id
       (editar: só o que saiu daqui, tipo com texto e dentro da janela de 15 min do
        WhatsApp; em mídia o que muda é a legenda e o arquivo é remandado do storage)
POST   /messages/:id/forward              GET  /messages/:id/media

GET    /tags                POST /tags            PATCH|DELETE /tags/:id
GET    /quick-replies       POST /quick-replies   PATCH|DELETE /quick-replies/:id
POST   /quick-replies/:id/media   DELETE /quick-replies/:id/media   GET /quick-replies/:id/media
       (anexo da resposta rápida — só imagem, áudio ou vídeo, decidido por
        `quickReplyMediaTypeFromMime` no shared; upload/remoção exigem poder
        gerenciar a resposta, o download segue o recorte de leitura)
POST   /quick-replies/:id/used
       (marca `lastUsedAt` — o composer chama depois que a mensagem SAIU; vale o
        recorte de leitura, sem auditoria: o envio em si já é auditado)
GET    /conversations/:id/scheduled-messages   POST /conversations/:id/scheduled-messages
DELETE /scheduled-messages/:id

GET    /attendance-settings  (qualquer papel — o dashboard depende dela)
PUT    /attendance-settings  (supervisor; grava SLA + expediente + janela de login,
       a semana inteira de uma vez, e vai para o AuditLog)

GET    /search              GET /reports/agents   GET /audit-logs
GET    /dashboard/stats?period=today|7d|15d|30d|custom[&from=&to=]
       [&instanceId=][&status=open|waiting_client|waiting_internal|resolved]
       [&departmentId=<uuid|none>][&assignedUserId=<uuid|none>]
       (tudo validado por Zod; `custom` exige as duas datas AAAA-MM-DD, teto de 366 dias;
        o bloco `topUsers` só vem para supervisor, senão é `null`; `timeline` traz um ponto
        por dia civil do período e `hourly` as células dia da semana × hora, esta sempre
        numa janela fixa de 30 dias)
```

Mídia é servida **somente autenticada**, escopada por organização, com proteção contra
path traversal (`lib/media-storage.ts`, interface `MediaStorage` pronta para driver S3).

---

## 7. Tempo real (Socket.IO)

Contratos em `packages/shared/src/realtime.ts` — **nomes de evento nunca são string solta**,
sempre `RealtimeEvents.X`:

`message:new`, `message:status`, `message:reaction`, `message:updated`, `call:incoming`,
`conversation:updated`, `conversation:read`, `group:participants`, `note:new`,
`instance:status`, `instance:qr`, `scheduled:pending`, `session:closing`,
`session:closed`.

`conversation:read` (`{ conversationId, unreadCount }`) é o outro evento que **não** vai
para uma audiência: ele sai para `user:<userId>`, a sala pessoal de quem leu, e existe
para a segunda aba da mesma pessoa acompanhar. Mandá-lo para a sala da conversa
apagaria o aviso de quem não leu — o defeito que a leitura por usuário conserta.

`session:closing` e `session:closed` são os únicos eventos que vão para **um socket**, e
não para uma audiência: quem decide é o horário de uso da pessoa, não o acesso à conversa.
Quem emite é o vigia (`services/session-schedule-watcher.ts`), a cada minuto.

`scheduled:pending` (`{ conversationId, pending }`) carrega quantas mensagens agendadas
ainda vão sair da conversa — é o badge no ícone de agendar do composer. Sai de
`lib/scheduled-pending.ts` (`emitScheduledPending`) em quatro momentos: agendamento criado,
cancelado, enviado pelo scheduler e marcado como `failed`. Retentativa **não** emite: sobe
`attempts` e o status segue `pending`, então o número não muda.

Salas (`apps/api/src/realtime/socket.ts`):

- `user:<userId>` — todas as abas de uma pessoa; só leitura de conversa usa esta sala;
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
- **Marcação de participantes ("@")**: `sendText` recebe um 5º parâmetro opcional
  `options?: SendTextOptions` (`@azvchat/shared`) com `mentionedExternalIds` — os JIDs que
  o Baileys grava em `contextInfo.mentionedJid`. **É essa lista que notifica**, não o texto;
  o `@<telefone>` escrito na mensagem só faz o aplicativo de quem recebe desenhar o
  destaque. Na entrada, `extractMentionedJids` (`normalize.ts`) lê o mesmo `contextInfo` e
  preenche `NormalizedMessage.mentionedExternalIds`, que a ingestão grava em
  `Message.metadata.mentions`. `sendMedia` **não** leva menção nesta entrega.
- **Edição de mensagem enviada**: `editMessage` recebe um 5º parâmetro opcional
  `options?: EditMessageOptions` com `media`. A edição do WhatsApp **substitui a mensagem
  inteira**, não só o texto: editar a LEGENDA de uma imagem sem remandar o arquivo
  transformaria a foto do cliente em mensagem de texto. Por isso a rota lê o binário do
  storage e manda junto, e `mediaContent()` é compartilhado entre `sendMedia` e
  `editMessage`.
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
`settings`. Fora do grupo: `login`. **Os rótulos do menu não seguem os nomes das rotas**:
`/inbox` aparece como "Conversas" e `/whatsapp` como "Conexões" — as rotas ficaram como
estão para não quebrar favoritos nem os links dos cards do dashboard. Nos textos da
interface, a tela se chama "Conversas" (ou "lista de conversas"); "Inbox" segue sendo o
nome técnico no código e neste documento.

- **Cor de marca: tokens `brand-*`, fonte única em `src/lib/brand.ts`** (`BRAND_COLORS`,
  `BRAND_NAVY`), de onde o `tailwind.config.ts` monta as classes `*-brand-*`. O verde é
  `#17BF6B`, tirado do próprio logotipo (`components/logo.tsx` e `app/icon.svg`) — antes
  daqui saía indigo, que não era cor de marca nenhuma. Os nomes são por **papel**, não por
  cor: 50/100 fundo suave, 400 borda leve, 500 o verde exato da marca (detalhe, ícone),
  **550 os controles verdes da tela de Conversas** (aba ativa do composer, badge de não
  lidas, botão de gravar), **600 o fundo sólido do resto do sistema** (botão primário,
  hover do 550) e texto de marca sobre claro, 700 hover do primário. O 500 puro dá só
  2,41:1 com branco: **fundo sólido nunca usa o 500**, sempre 550 (5,00:1), 600 (6,61:1)
  ou 700 (9,45:1). Nada de hex de marca solto em componente.
- **A BOLHA ENVIADA não usa a paleta de marca: ela é o verde claro do WhatsApp**, tokens
  `chat-*` (`CHAT_COLORS` em `lib/brand.ts`) — fundo `#d9fdd3` com **letra escura**
  (`chat-sent-text`, 15,75:1), e horário, citação, legenda e status em `chat-sent-meta`
  (4,83:1). É convenção visual do próprio WhatsApp, que a equipe lê há anos como "esta
  saiu daqui"; trocar a marca não deve repintar o chat, e por isso os dois grupos de
  token são separados. Dois valores **não** copiam o aplicativo ao pé da letra, porque
  reprovariam: o cinza dele (`#667781`) dá 4,19:1 e o horário tem 10px, e o azul do check
  duplo (`#53bdeb`) dá 1,92:1 contra o mínimo de 3:1 de ícone — daí `chat-sent-meta` e
  `text-sky-600`. Tudo que a bolha enviada desenha por dentro segue essa inversão:
  player de áudio, enquete, reações, mensagem apagada e o spinner do download.
- **O DASHBOARD fica no indigo, de propósito, e não consome a paleta de marca.** Os
  acentos (`DASHBOARD_ACCENT` / `_SOFT` em `app/(app)/dashboard/page.tsx`) e a rampa do
  mapa de calor são indigo porque ali os números convivem com o verde de estado e com o
  verde das barras de recebidas: acento de marca verde ao lado deles viraria um degradê de
  verdes sem hierarquia. Os hexes ficam na própria tela, fora de `lib/brand.ts`, para o
  Dashboard **não** mudar junto na próxima troca de marca.
- **Verde de MARCA e verde de ESTADO são coisas separadas, e não se misturam.** O de
  estado é `#16a34a` e mora em `@azvchat/shared` (`CONVERSATION_STATUS_COLORS.open`,
  `CONNECTION_STATUS_COLORS.connected`, e o mesmo hex no selo "Ativo"): ele responde
  "como está o atendimento". O de marca responde "de quem é o produto". Fundi-los faria a
  bolha enviada parecer um selo de status. Por isso o `brand-600` é bem mais escuro e
  saturado que o `#16a34a`, e o Dashboard inteiro ficou fora da paleta de marca. **Se um dia os dois chegarem perto demais, escurece-se o de marca — nunca
  se ajusta o de estado para caber.** Chip de marca colado em selo de estado usa
  `bg-brand-100` (e não o 50, que fica quase igual ao fundo do selo verde). Cor de
  etiqueta e de departamento escolhida no cadastro é **dado**, não tema, e não muda; só o
  valor inicial do formulário é de marca (azul-marinho, para não disputar com "Aberto").
- `src/lib/api.ts` — client HTTP único (`api.*`). Token em `localStorage` (`zapdesk.token`);
  401 limpa token e manda para `/login`. **Não faça `fetch` solto em componente**: adicione
  o método em `api.ts`.
- `src/lib/auth-context.tsx` e `src/lib/socket-context.tsx` — sessão e socket.
- `src/components/ui.tsx` — kit da casa: `Button`, `Input`, `Textarea`, `Field`, `Badge`,
  `Card`, `Avatar`, `Modal`, `Tooltip`, `Spinner`, `EmptyState`. **Reuse antes de criar
  componente novo.** `Tooltip` é só CSS (hover + `focus-within`), sem biblioteca.
- **Não lidas no frontend** (`src/lib/unread.ts` + `components/inbox/use-unread-counts.ts`):
  o contador é por usuário e **não vive no `ConversationDto`** — o mesmo DTO chega por
  socket a todo mundo que enxerga a conversa. A tela guarda um mapa `id → contador`,
  semeado pelo campo `unread` da resposta de `GET /conversations`, que sobe sozinho
  quando chega `message:new` de entrada numa conversa que não é a aberta, e que só zera
  pelo evento `conversation:read` (ou pela resposta do `POST .../read`). O hook fica
  fora do `inbox-shell` de propósito: aquele arquivo já tem ~1300 linhas.
- **Rascunho do composer** (`src/lib/drafts.ts`): o que está escrito e ainda não foi enviado
  é gravado no `localStorage` a cada tecla, por conversa, com a chave
  `zapdesk.draft.<userId>.<conversationId>`. Existe por causa do fim do horário de uso (a
  sessão é encerrada no minuto do fechamento), e de quebra cobre o F5 e a troca de conversa.
  Três detalhes que não são opcionais: a chave **inclui o usuário** (máquina compartilhada é o
  caso normal), o **modo vai junto com o texto** (nota interna restaurada em modo mensagem
  seria enviada ao cliente), e o envio **apaga** a entrada (senão voltaria no próximo login e
  seria mandada duas vezes). Nada de coluna em `Conversation` nem de rota gravando por tecla —
  é estado de uma máquina, como a barra lateral recolhida. `apps/web/test/drafts.test.ts`
  cobre a regra; é o primeiro teste do frontend (vitest com o alias `@/` do Next).
- **Filtros da tela de Usuários** (`components/users/users-filter-bar.tsx` + regra pura em
  `src/lib/users-filters.ts`): chip (número), tipo de usuário e departamento, combinando por
  E, com contador "8 de 23 usuários" e `EmptyState` quando o filtro não deixa nada passar. A
  **filtragem é no cliente**, sobre a lista que `GET /users` já devolve inteira — os vínculos
  de números e departamentos vêm dentro da própria resposta (`whatsappInstanceIds` /
  `departmentIds`, de `serializeUserWithAccess`), e são algumas dezenas de linhas: parâmetro
  de consulta e paginação seriam infraestrutura para responder o que o navegador já tem em
  memória. Chip e departamento casam por **contém** (a pessoa tem vários de cada, e a
  pergunta é "quem está ligado a este chip?"), então quem não tem vínculo nenhum — o admin de
  acesso total — aparece sem filtro e some ao filtrar por um chip ou departamento específico.
  Os rótulos de papel vêm de `USER_ROLE_LABELS`, nunca escritos à mão. A persistência é a
  mesma mecânica dos filtros da Inbox, com chave própria (`zapdesk.users-filters.<userId>`),
  porque o caminho normal é clicar em "Editar" e voltar; id de chip ou departamento excluído é
  podado pela tela (só ela sabe o que ainda existe) e volta para "todos" em silêncio. Nada
  disso encosta em `access.ts`, em `requireRole` ou na rota: a tela inteira já é de admin, e
  filtro aqui é recorte visual sobre dado que ele já recebe.
- Barra lateral recolhível no `layout.tsx`: o botão no topo alterna entre expandida (`w-56`,
  o padrão) e só ícones (`w-16`) e **empurra** o conteúdo; recolhida, o hover (ou o foco por
  teclado) expande **sobrepondo** a página, para a Inbox não remontar a cada passada de
  mouse. A escolha é preferência de navegador em `localStorage` (`zapdesk.sidebar-collapsed`)
  — nada de coluna em `User` nem rota na API para isso.
- Gráficos do dashboard em `src/components/dashboard/`: `chart-card.tsx` (moldura, legenda
  e o alternador gráfico/tabela), `messages-timeline.tsx` (barras divergentes por dia),
  `hours-heatmap.tsx` (mapa dia da semana × hora), `sparkline.tsx` (miniatura da série
  dentro do card de mensagens) e `connectivity-ring.tsx` (anel de números no ar). **Sem
  biblioteca de gráfico**: tudo é SVG inline, CSS e Tailwind, respeitando
  `prefers-reduced-motion`. A sparkline e o anel são **acessórios de card**, não gráficos:
  a sparkline é `aria-hidden` (o total está no card e o detalhe por dia, com tabela, no
  gráfico logo abaixo) e o anel é uma imagem com rótulo falado, sem interação.
- Inbox de 3 colunas em `src/components/inbox/`: `inbox-shell.tsx` (o maior arquivo do
  projeto, ~1300 linhas — orquestra lista, chat e composer), `conversation-list.tsx`,
  `message-bubble.tsx`, `context-panel.tsx` (participantes, responsável, departamento,
  etiquetas, notas, histórico, arquivos), `composer-modals.tsx`, `audio-recorder.tsx`,
  `audio-player.tsx`, `status-select.tsx`, `formatted-text.tsx`, `media-lightbox.tsx`
  (mídia ampliada em tela cheia, navegando só entre as mídias já carregadas na janela),
  `attachment-drop.tsx` (arrastar arquivo para a conversa e colar com Ctrl+V),
  `mention-picker.tsx` (o seletor do "@") e `internal-note.tsx` (a nota interna).
- **A nota interna se desenha em `components/inbox/internal-note.tsx`**, e não em cada
  tela: ela aparece em DOIS lugares — o cartão amarelo intercalado no chat
  (`InternalNoteBubble`) e o item do bloco "Notas internas" do painel lateral
  (`InternalNotePanelItem`) —, e os dois trazem os mesmos botões de editar e excluir,
  com o mesmo visual, a mesma confirmação e as mesmas rotas
  (`PATCH|DELETE /conversations/:id/notes/:noteId`). Os handlers são um só
  (`internalNoteActions`, criado no `inbox-shell` e passado ao painel), e **não há evento
  de socket para edição nem para exclusão**: os dois lugares leem a MESMA
  `detail.notes`, então recarregar o detalhe atualiza os dois na hora — só a criação
  viaja pelo `note:new`. Quem pode mexer sai de `canManageInternalNote`
  (`@azvchat/shared`, coberto por `apps/api/test/internal-note.test.ts`): autor sempre,
  supervisor e admin em nota de terceiro, sessão ainda carregando nega. A rota usa a
  mesma função — botão que a tela mostra é botão que a API aceita.
- **Marcação de participantes ("@")** em `components/inbox/mention-picker.tsx`, fora do
  `inbox-shell` — que só guarda a cola: a consulta digitada, o índice ativo e o que fazer
  ao escolher. A mecânica é a **mesma** do autocomplete de "/" (lista sobreposta ao
  composer, seta navega, Enter ou Tab escolhe, Esc fecha, clique também escolhe); as regras
  puras (quando o "@" abre, o que sai no texto, o que continua marcado) vivem em
  `packages/shared/src/mentions.ts`, porque o navegador e a API precisam decidir igual.
  Só existe em conversa de **grupo** e só na aba "Responder ao cliente" — na nota interna o
  "@" é texto literal, já que os participantes são clientes e a nota é justamente o que o
  cliente nunca vê. O nome exibido é o que a API já decidiu (`serializeGroupParticipant`),
  sem cadeia própria na tela; quem não tem telefone conhecido aparece **desabilitado**, com
  a explicação no `title` — sumir com a pessoa faria a equipe achar que ela saiu do grupo.
  A primeira linha é o coletivo `@todos`. A exibição fica em `formatted-text.tsx`
  (`splitMentionParts` + `makeMentionResolver`, nós React, nunca `dangerouslySetInnerHTML`):
  o número marcado vira nome, quem não tem cadastro vira telefone formatado e LID
  desconhecido continua como veio — nunca formatado como telefone.
- **Editar mensagem enviada acontece no COMPOSER**, não em `window.prompt`: o item "Editar"
  do menu da bolha coloca o texto no campo com o cabeçalho "Editando mensagem" (ou
  "Editando legenda"), Enter salva, Esc cancela. O rascunho que estava no campo é guardado
  e volta ao sair — entrar em edição não pode custar o que a pessoa já tinha digitado. Três
  detalhes que não são opcionais: durante a edição o campo **não** é gravado como rascunho
  (senão o texto antigo voltaria no próximo login pronto para ser reenviado), o "/" e o "@"
  não abrem seus seletores (a pessoa está corrigindo frase enviada, e reconstruir marcação
  de mensagem antiga é outra história), e a saída do modo só acontece **depois** da
  confirmação da API — recusa mantém o texto no campo.
- **Arrastar e colar arquivo** vivem em `attachment-drop.tsx`, fora do `inbox-shell` — que
  só passa a conversa aberta, o rascunho e o `disabled`. A área válida é a **coluna do
  chat**: a zona envolve a coluna inteira (e não só a janela de mensagens) porque trocar de
  conversa zera o `detail` por um instante, e uma zona dentro do ramo da conversa carregada
  seria desmontada nesse piscar, descartando a prévia em silêncio. Regras que não são
  negociáveis: **nada é enviado sem a prévia** (mensagem enviada não se desfaz no WhatsApp);
  o **paste só é interceptado quando o clipboard traz arquivo** e o campo é o composer ou a
  legenda, marcados com `data-attachment-paste` (`ATTACHMENT_PASTE_FIELD`) — colar texto, ou
  colar arquivo na busca da conversa, continua sendo do campo; `useBlockStrayFileDrop()` é
  chamado no shell para o arquivo solto **fora** da área não abrir no navegador e trocar a
  tela do atendente; o contador de profundidade (`dragenter`/`dragleave`) evita o piscar da
  sobreposição; a prévia fica **amarrada à conversa de origem** (trocar de conversa mostra o
  aviso, nunca redireciona o arquivo) e o composer só é limpo **depois** do envio confirmado.
  Miniatura é `URL.createObjectURL` revogada ao sair da prévia. Cada arquivo é uma mensagem,
  pelo caminho que já existia (`conversationMediaApi`, em `lib/api.ts` — o mesmo do clipe e
  do áudio gravado): sem rota nova, sem evento novo, sem auditoria nova.
- Limites do anexo em `@azvchat/shared` (`attachments.ts`, fonte única das duas pontas):
  `DEFAULT_MEDIA_MAX_SIZE` (25 MB, que é o padrão de `MEDIA_MAX_SIZE` da API — o `.env` da
  VPS ainda manda no valor real), `ATTACHMENT_MAX_FILES` (10 por vez) e
  `outboundMediaTypeFromMime`, que decide `image|audio|video|document` — **nenhum arquivo é
  recusado por tipo**, o que não é mídia vira documento. Pasta, arquivo de 0 KB e acima do
  limite são barrados **na prévia**, com o limite em números, antes de subir um byte.
- **Mídia de mensagem nunca é apontada por `src`/`href` direto**: a rota exige o header
  Authorization, então tudo passa por `fetchMediaBlobUrl` (`lib/api.ts`) — fetch
  autenticado + blob temporário, revogado por quem consome. O download (bolha de
  documento e lightbox) usa `lib/media-download.ts`, mesmo caminho autenticado; o nome
  salvo é o original ou um legível por tipo e data, nunca o id da mensagem.
- **Linkificação em `formatted-text.tsx`**: URL http/https (ou `www.` com domínio) vira
  `<a target="_blank" rel="noopener noreferrer">` — os dois atributos sempre, senão a
  página aberta ganha `window.opener` e pode redirecionar a aba para um login falso. A
  detecção produz **nós React**, nunca HTML (`dangerouslySetInnerHTML` é proibido ali: o
  texto vem do cliente), só aceita http/https e não linkifica dentro de trecho
  monoespaçado. Regra pura em `splitLinkParts`, coberta por `test/formatted-text.test.ts`.
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
- **Deploy — caminho principal**: a VPS se atualiza sozinha. `deploy/atualizar.sh` faz
  `fetch` + `merge --ff-only` da branch padrão e `docker compose up -d --build` só quando há
  commit novo; `deploy/instalar-atualizacao-automatica.sh` instala o timer do systemd que o
  chama a cada 2 minutos. Nenhum segredo no GitHub, nenhuma porta a mais na VPS.
- **Deploy por SSH** (`.github/workflows/deploy.yml`, opcional): dispara quando o CI da
  branch padrão fecha verde; um deploy por vez, nunca cancelado no meio. O job roda no
  environment `production` — `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (e os opcionais
  `VPS_PORT`, `VPS_KNOWN_HOSTS`, `VPS_PATH`) são **environment secrets**. Sem eles o job
  avisa e sai em verde, em vez de falhar.

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

- **Som de notificação depende de o navegador destravar o áudio.** Chrome e Safari só
  deixam tocar depois de uma interação na página, e o `AudioContext` nasce suspenso — sem
  destravar no primeiro clique ou tecla, o som não sai na primeira aba do dia e o recurso
  parece defeito. `MessageSound` (`apps/web/src/components/message-sound.tsx`) escuta
  `pointerdown`/`keydown` uma vez para isso e, se mesmo assim o áudio continuar bloqueado
  quando a mensagem chegar, mostra **um aviso discreto por sessão** — nunca modal, nunca
  repetido. Aba muito tempo em segundo plano tem o contexto suspenso pelo navegador: o
  retorno do foco só religa a saída, **não toca o que foi suprimido**. Falha de áudio é
  sempre engolida: som é acessório, recebimento de mensagem não.
- **O gatilho do som é a direção da mensagem, não o tipo.** Só `inbound` toca; envio da
  equipe, reação, edição e mudança de status nunca tocam, e nota interna também não nesta
  entrega. Silencia apenas quando as duas coisas valem juntas — aba em foco **e** conversa
  aberta —, com intervalo mínimo de 2s entre sons para rajada de grupo não virar
  metralhadora (a mensagem suprimida não fica em fila). Com duas abas abertas as duas
  tocam: não há sincronização entre abas, e isso está registrado em comentário no
  componente.
- **O título da aba conta conversas, não mensagens, e não é o `unreadCount` do banco.**
  `UnreadTitle` (`apps/web/src/components/unread-title.tsx`) acumula as conversas que
  receberam mensagem `inbound` e pisca `(n) <título>` a cada 1,2s, alternando com o
  título original. **Quem zera é abrir a Inbox**, não focar a aba: trocar para o
  Dashboard não apaga o aviso, e o piscar continua até a pessoa ir olhar as conversas.
  A condição única é `document.hasFocus()` **e** rota começando em `/inbox`
  (`isWatchingInbox`) — ela decide as duas coisas, o que acumula e o que zera. Sem
  exigir o foco, a aba esquecida na Inbox em segundo plano, que é o caso mais comum,
  nunca acumularia nada. Ler o não lido real exigiria consulta nova a cada carregamento
  para dizer o que a lista da Inbox já diz. Nenhuma rota define `metadata` própria,
  então o título base é capturado uma vez na montagem; se um dia alguma tela definir o
  seu, esse pressuposto cai.
- `title` vs `customTitle` e `name` vs `customName`: o **sync do WhatsApp sobrescreve o
  primeiro e nunca toca no segundo**. Exibição prefere o custom.
- **Nome do participante é decidido no backend**, em `serializeGroupParticipant`
  (`lib/serialize.ts`), nunca no componente — a tela recebe `name` já pronto (nunca nulo)
  mais os campos crus que a edição precisa. A cadeia, do mais forte para o mais fraco:
  1. `customName` — vence porque é a única fonte que a equipe controla e que o sync não
     sobrescreve;
  2. nome do `Contact` do número conectado — escolha de alguém do escritório, por isso vem
     antes do apelido que a pessoa pôs em si mesma;
  3. `name` do participante — o pushName, gravado na ingestão quando a pessoa escreve, mais
     o pushName da última mensagem (`sources.pushName`), que cobre quem já tinha escrito
     antes dessa gravação existir, sem backfill;
  4. telefone formatado (`formatPhone`, que mora em `@azvchat/shared` justamente porque o
     backend decide o nome com ela);
  5. `PARTICIPANT_WITHOUT_NAME_LABEL`. **Nunca o LID cru** — ele é identificador interno e
     exibi-lo faria a equipe tratá-lo como telefone.

  As fontes extras (`Contact` e pushName) são resolvidas **em lote**, dois SELECT para o
  grupo inteiro — grupo grande não pode virar consulta por participante. `nameIsPhone` avisa
  a tela para não repetir o telefone na segunda linha, e `hasKnownName` diz se existe nome
  de verdade. A ingestão grava o pushName em `name` e **nunca** em `customName`.
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
- **`QuickReply.lastUsedAt` marca o ENVIO, não a edição.** O composer grava o atalho
  aplicado e chama `POST /quick-replies/:id/used` só depois que a mensagem saiu (nota
  interna não conta; apagar o rascunho inteiro e escrever outra coisa também não). A tela
  de Respostas rápidas mostra "Último uso"/"Nunca usada" em cada linha, e o filtro por
  departamento da tela usa a mesma régua do composer (`appliesToConversation`): filtrar
  por um departamento inclui as respostas gerais, e "Somente gerais" isola as gerais.
- **Mídia de resposta rápida**: `QuickReply.mediaUrl` é chave do `MediaStorage` (diretório
  `quick-replies-<organizationId>`, sem vínculo com número) e **nunca sai da API** — o
  binário vem por `GET /quick-replies/:id/media`, autenticado. Só imagem, áudio e vídeo
  (`quickReplyMediaTypeFromMime`, no shared, é a fonte única — API e tela recusam com a
  mesma regra; documento fica de fora de propósito). **O envio pelo composer é
  servidor-a-servidor**: `POST /conversations/:id/quick-reply-media` manda o arquivo direto
  do storage da API (do navegador sai só JSON) — baixar o binário na tela para subir de
  volta dobrava a transferência e fazia vídeo grande parecer travado; o chip do composer
  vira "Enviando..." com spinner durante a espera. A mensagem gravada **reutiliza a chave
  do storage** (o arquivo nunca é apagado, então a chave não fica órfã), a rota valida com
  `departmentResourceAppliesTo` (shared, a mesma régua da tela) e marca `lastUsedAt` ali
  mesmo. Imagem e vídeo levam o texto como **legenda**; áudio não tem legenda no WhatsApp,
  então o texto sai como **mensagem separada** logo em seguida — legenda em áudio mostraria
  na Inbox um texto que o cliente nunca recebeu.
- **Dashboard: o período filtra por atividade e o status agrupa.** Cada card conta conversa
  que teve **ao menos uma mensagem no período**, pelo status **atual** dela — nunca por data
  de criação nem por data de mudança de status. Como `lastMessageAt` é sempre o timestamp da
  última mensagem, "teve mensagem no período" é `lastMessageAt >= início`, e os quatro status
  saem de **um único `groupBy`**: a soma fecha com o card de conversas ativas por construção.
  O card de atraso e o de infraestrutura **ignoram o período** — são o estado agora.
- **Os parâmetros de atendimento são lidos do banco a cada requisição** do dashboard
  (`lib/attendance-settings.ts`), sem cache em memória e sem carregar no boot. Em cache, a
  mudança do limite só valeria depois de reiniciar o container — exatamente o problema que a
  tela de Parâmetros veio resolver.
- Tempo de atraso conta **só dentro do expediente**, no fuso configurado
  (`modules/dashboard/metrics.ts`): mensagem que chega 17h50 de sexta volta a contar na
  abertura do próximo dia ativo, e dia desligado não acumula nada. Semana inteira desligada
  devolve zero em vez de procurar um próximo horário útil que não existe. Feriado não é
  tratado e conta como dia normal. Nota interna não é `Message`, então nunca conta como
  resposta ao cliente; mensagem apagada e saída ainda `pending` também não contam.
- **A janela de login também é lida no fuso do escritório, nunca no do container.** O
  container roda em UTC: às 22:00 de Brasília lá já é o dia seguinte, e a faixa de segunda
  liberaria o domingo à noite. Fuso inválido no banco cai no padrão em vez de trancar
  ninguém, e dia ausente na configuração fecha — mas a leitura normaliza a semana antes,
  então o dia volta com o padrão. Tentativa barrada entra no `AuditLog` como
  `auth.login_outside_schedule`, com a faixa do dia, e **não** atualiza `lastLoginAt`.
- **Nenhum corte de data do dashboard usa o fuso do servidor** — "hoje" é o dia civil do
  escritório, não o dia UTC do container. O `custom` pega os dois dias das pontas inteiros;
  os atalhos **não** têm corte superior, de propósito: o relógio do WhatsApp pode vir à
  frente do nosso e um `lte: agora` sumiria com a mensagem recém-chegada.
- **Os filtros do dashboard refinam o recorte, nunca o ampliam.** Número, status,
  departamento e responsável entram num `AND` junto com `conversationScope`, então pedir um
  número que o usuário não enxerga devolve vazio em vez de vazar.
  `departmentId`/`assignedUserId` aceitam `none` para "sem departamento" / "sem
  responsável". Os filtros valem para a **tela inteira** — inclusive o card de atraso e o de
  infraestrutura, que continuam ignorando só o período. O filtro de `status` é o único que
  mexe no fluxo por status: com ele as outras três colunas ficam em zero, porque a pergunta
  passou a ser "só este status" — e `resolved` zera o atraso por construção, já que lá o
  recorte convive com `status != resolved`.
- **O dashboard se recarrega sozinho a cada minuto** (`AUTO_REFRESH_MS` na página), e o
  rodapé promete isso a quem está olhando. É `setInterval` chamando a mesma rota, e **não**
  evento de socket: a tela agrega dezenas de milhares de mensagens, então empurrar cada
  mensagem nova custaria mais do que uma consulta por minuto. A recarga é silenciosa — os
  números antigos ficam na tela até os novos chegarem, sem esqueleto piscando a cada volta.
- **Os cards de status do dashboard abrem a Inbox pela URL** (`/inbox?status=...`), levando
  também `departmentId`/`instanceId` quando são ids de verdade. Quem semeia o filtro é a
  própria Inbox (`inbox-shell.tsx`), e só em estado que a tela mostra: os seletores de
  número e departamento existem apenas para supervisor e admin, então parâmetro forjado na
  URL por um `agent` é ignorado — filtro invisível deixaria a lista curta sem explicação. O
  período **não** vai junto (a Inbox lista por status, não por atividade), e a tela avisa
  que a lista pode vir maior que o card.
- **Todo gráfico tem gêmeo em tabela** (o botão na moldura do card). Cor sozinha não é canal
  acessível, e o valor exato de um dia não pode depender de acertar o mouse na barra. As
  cores saem do validador de paleta, não do olho: o par recebidas/enviadas é o mesmo dos
  cards (ΔE 16,1 sob deuteranopia) e o mapa de calor usa **uma** rampa de um tom só
  (indigo 400→800), porque magnitude não se pinta com arco-íris. Indigo e não verde: no
  card ao lado as barras de recebidas são o `#16a34a` de estado, e uma rampa verde faria
  magnitude e status parecerem a mesma escala.
- **O mapa dia × hora é o único bloco que ignora o período**: ele usa sempre os últimos
  `DASHBOARD_HEATMAP_DAYS` (30) dias, porque padrão de horário só aparece com repetição e
  "hoje" mostraria um dia em vez do hábito do cliente. Os filtros de número, departamento e
  responsável continuam valendo nele, o rótulo do card diz a janela, e com o período já em
  30 dias a rota reaproveita a mesma consulta em vez de repetir.
- **A série por dia e o mapa de hora são agregados no banco** (`loadActivityBuckets`), num
  SQL cru que corta com `AT TIME ZONE` no fuso configurado. Trinta dias viram no máximo
  30 × 24 × 2 linhas em vez de dezenas de milhares de mensagens no Node. O escopo continua
  vindo de `access.ts`: os ids das conversas saem de uma busca já filtrada, e o SQL só olha
  as mensagens deles — mesmo padrão do card de atraso. Os descartes são os mesmos dos cards
  (apagada e saída `pending` não contam), senão o gráfico contaria uma história e os cards
  outra; há teste fixando que a soma da série bate com o card.
- **`topUsers` é de supervisor para cima**, igual ao relatório por atendente: para o `agent`
  a rota nem consulta e devolve `null`, e a tela não desenha o bloco. `sent` sai de
  `Message.sentByUserId` (envio sem autor é do scheduler e não conta como trabalho de
  ninguém); `received` são as mensagens do cliente nas conversas em que a pessoa é
  **responsável** — mensagem de entrada não tem autor do nosso lado. É medida de carga, não
  de produtividade.
- **"Sem responsável" não é mais `assignedUserId IS NULL`.** Com o `@todos`, a conta
  passou a ser `assignedUserId IS NULL AND assignedToAll = false`: a conversa
  coletiva também está sem dono, mas por decisão, e somá-la de volta faz o número
  de órfãs mentir exatamente onde a marcação veio ajudar. **Toda contagem, listagem
  ou filtro novo de "sem responsável" precisa usar `unassignedConversationWhere()`
  de `lib/conversation-assignment.ts`** — nunca `assignedUserId: null` na mão. Hoje
  excluem: a lista da Inbox (`assigned=none`), o filtro do dashboard, o filtro
  rápido do frontend (`inbox-filters.ts`) e o `apply-default-assignee` em lote. O
  coletivo tem filtro próprio (`FILTER_ALL_USERS`), nunca somado ao das órfãs. O
  relatório por atendente não muda: ele já ignorava conversa sem responsável, e a
  coletiva não é creditada a ninguém nem distribuída entre as pessoas.
- **Toda atribuição automática precisa respeitar o `@todos`.** São dois pontos, e os
  dois já checam: a ingestão (`message-ingest.ts`, junto do `archivedAt`) e o
  `POST /whatsapp-instances/:id/apply-default-assignee`. Sem isso o grupo coletivo
  ganha dono sozinho na próxima mensagem do cliente e a marcação vira enfeite —
  falha silenciosa, que só aparece quando o grupo some da tela dos demais. O
  responsável padrão do departamento **não se aplica** à conversa marcada, em
  momento nenhum. Atribuir uma pessoa desliga a marcação (é a saída natural do
  coletivo), e a exclusão mútua também é garantida por constraint no banco.
- **O não lido é POR USUÁRIO, e `Conversation.unreadCount` está aposentado.** Quem
  abre uma conversa marca como lida só para si: supervisor e admin acompanham sem
  apagar o aviso de quem atende, e numa conversa sem responsável (ou marcada
  `@todos`) cada pessoa do departamento tem o próprio contador. O que se guarda é a
  MARCA (`ConversationRead.lastReadAt`, "até onde eu li"), nunca um contador por
  pessoa — contador obrigaria a escrever N linhas a cada mensagem recebida. Regras
  que valem para qualquer mexida aqui: (1) **a marca nunca retrocede sozinha** —
  rolar para cima e reler mensagem antiga não faz a conversa voltar a ter não lidas;
  recuar é a ação explícita "marcar como não lida", que volta UMA e vale só para
  quem pediu; (2) **só mensagem recebida conta** — enviada pela equipe, nota interna
  (que nem é `Message`) e apagada ficam de fora, e conversa arquivada não conta para
  ninguém; (3) a contagem sai em **uma consulta para a página inteira** e **para no
  centésimo**, porque o badge mostra "99+" e saber que são 4.000 não muda um pixel;
  (4) o número **nunca entra no DTO da conversa** — aquele payload é publicado para
  a audiência inteira, e o contador viaja na resposta da lista (mapa `unread`) e no
  evento `conversation:read`, dirigido a uma pessoa. A coluna antiga
  `Conversation.unreadCount` continua no banco com o dado histórico, sem leitura nem
  escrita: não volte a usá-la.
- **A leitura NÃO envia read receipt ao cliente.** O AZVCHAT nunca marcou visto azul
  para fora (o Baileys sobe com `markOnlineOnConnect: false` e nada chama
  `readMessages`), e agora há um motivo a mais para continuar assim: com leitura por
  usuário, um supervisor espiando faria o cliente ver o visto azul de um atendimento
  que ninguém começou.
- **Os filtros de regime tributário e folha dependem do Azevedo-OS, e degradam sozinhos.**
  Os dois campos não existem neste banco: quem responde "quais empresas são do Simples" é
  o portal, e a API usa a lista de identificadores que voltou para recortar as conversas
  por `externalReference` (`lib/azevedo-os-company-filter.ts`). Daí três consequências que
  valem para qualquer mexida aqui. (1) **O recorte é ACRESCENTADO ao `AND` do `where`,
  nunca posto no lugar dele**: `conversationScope` já ocupa esse `AND`, e sobrescrevê-lo
  faria o filtro por regime revelar ao atendente a conversa de outra pessoa — o filtro
  viraria porta de saída do controle de acesso. Há teste que fica vermelho se isso voltar.
  (2) **Portal mudo não derruba a Inbox**: a lista volta SEM o recorte, com
  `companyFilter.unavailable` e aviso na tela dizendo que ela está completa — ler uma
  lista inteira achando que está filtrada é pior do que não filtrar. (3) **O cache é de
  segundos** (60s para o recorte, 5 min para as opções), só para a mesma pergunta não sair
  a cada tecla: regime muda na virada do ano e a Inbox tem que acompanhar no mesmo dia.
  Duas coisas mais: conversa sem empresa vinculada some quando o filtro está ativo, e a
  tela diz quantas ficaram de fora com atalho para elas (senão o filtro parece quebrado);
  e o casamento no cliente (`inbox-filters.ts`) **não avalia** esses dois campos, porque a
  conversa que chega pelo socket não carrega o regime — por isso o `inbox-shell` para de
  INSERIR linha nova enquanto o recorte está ligado, e só atualiza o que o servidor já
  devolveu.
- Ingestão é idempotente por `(conversationId, externalMessageId)` — não crie caminho
  paralelo de inserção de mensagem.
- **Menção NÃO é formatação de texto.** Escrever "@Fulano" (ou até o número) na mensagem
  não marca ninguém: quem notifica é a lista de identificadores em
  `contextInfo.mentionedJid`, que viaja **ao lado** do texto — do composer
  (`DraftMention`) para `POST /conversations/:id/messages` (campo `mentions`, separado do
  `content`) e daí para `sendText(..., { mentionedExternalIds })`. Tratar isso como texto
  produz o pior defeito possível: a mensagem sai visualmente perfeita e ninguém é avisado,
  e a falha só aparece semanas depois. Três consequências que valem para qualquer mexida
  aqui: (1) o rascunho grava texto **e** menções juntos (`lib/drafts.ts`), senão o F5 as
  descarta em silêncio; (2) toda escrita no campo recalcula a lista
  (`activeMentions`) — apagar o rótulo com backspace **tem** que desmarcar a pessoa, e
  menção órfã notificaria alguém que não aparece na frase; (3) a API confere cada
  identificador contra os participantes daquela conversa (`lib/mentions.ts`), então marcar
  um número de fora do grupo é impossível. Quem saiu do grupo entre a escolha e o Enter é
  **descartado** (com log `mentions_dropped`, só a contagem), nunca derruba a mensagem
  inteira.
- **Marcar exige telefone conhecido.** O token do texto é `@<dígitos do telefone>` e o JID
  marcado é `<telefone>@s.whatsapp.net` — é assim que o cliente do WhatsApp casa uma coisa
  com a outra. Participante que só tem `@lid` **não é mencionável**: o LID não é telefone,
  e mandá-lo como marcação não notifica ninguém. Ele aparece na lista desabilitado, e o
  `@todos` avisa no composer quantos ficarão de fora **antes** do envio. O `@todos` fica
  literal no texto (não existe token de grupo no protocolo) e marca todo mundo pela lista,
  respeitando o teto de `MENTION_MAX_PER_MESSAGE` (100, teto nosso: o Baileys não impõe
  nenhum e o WhatsApp não documenta).
- LID (`@lid`) não é telefone. Existe migration só para limpar telefones que vieram de LID
  (`20260814140000_clear_lid_phone_numbers`).
- **A janela de edição é do WhatsApp, e vale nos dois lados.** Só dá para editar nos
  primeiros `MESSAGE_EDIT_WINDOW_MINUTES` (15) minutos, e só tipo com texto —
  `EDITABLE_MESSAGE_TYPES` (texto, imagem, vídeo, documento; áudio e figurinha não têm
  legenda). A regra mora em `packages/shared/src/message-edit.ts` porque a tela decide se
  mostra o botão e a API decide se aceita: sem a conferência do lado da API, o servidor do
  WhatsApp recusaria a edição e nós gravaríamos o texto novo assim mesmo — a Inbox passaria
  a mostrar ao atendente uma frase que o cliente nunca recebeu, e ninguém perceberia.
  Editar mídia é editar a **legenda**, e o arquivo é remandado do storage (ver a seção 8).
- Mensagem apagada mantém a linha (`deletedAt`) para histórico/auditoria — não faça
  `delete` físico.
- **Conversa arquivada NÃO desarquiva com mensagem nova** — de propósito, e diferente
  do WhatsApp do celular: o número de backup recebe as mesmas conversas o dia inteiro
  e desarquivaria tudo sozinho. A mensagem é gravada (histórico completo, acha pela
  busca), mas não conta como não lida para ninguém, não reabre status e não volta
  para a lista de quem está com a Inbox aberta (o frontend filtra pelo `archivedAt`
  do payload). Mensagem agendada em conversa arquivada ainda é enviada — compromisso
  com o cliente — e também não desarquiva.
- **Toda contagem ou listagem nova de `Conversation`/`Message` precisa excluir
  arquivadas** (`archivedAt: null`), POR CIMA do escopo de `access.ts` — nunca no
  lugar dele. Hoje excluem: lista da Inbox, todos os blocos do dashboard (cards,
  atraso, ranking, top de usuários, série por dia, mapa de calor), relatório por
  atendente, `apply-default-assignee` e o responsável padrão da ingestão. As duas
  exceções deliberadas: a busca global (`GET /search`) continua encontrando
  arquivada — senão não haveria como achá-la para desarquivar — e o card
  "Conversas arquivadas" do dashboard conta só elas, ignorando o período.
- Baileys é integração não oficial: risco de banimento do número. Use números dedicados.

---

## 14. Estado atual e lacunas

**Funciona**: múltiplos números com conexão por QR e status em tempo real; sessão
persistida e retomada após restart; sync de chats/contatos/grupos e fotos; recebimento e
envio de texto, imagem, áudio, vídeo, documento, figurinha, localização, contato; reações;
responder citando; encaminhar; apagar; editar mensagem enviada pelo composer (texto e
legenda de mídia, dentro da janela de 15 minutos do WhatsApp); gravação de áudio (ffmpeg, com fallback);
enquetes; mensagens agendadas com retentativa; notas internas; etiquetas; atribuição com
histórico completo; quatro status de atendimento; leitura por usuário (cada pessoa com
o próprio contador de não lidas, com "marcar como não lida" para reservar a conversa
para depois); busca na conversa e busca global;
marcação de participantes com `@` em grupo, com `@todos` e nome exibido no lugar do
número (enviadas e recebidas);
respostas rápidas com `/`, inclusive com mídia anexada (imagem, áudio ou vídeo) que sai
junto com o texto; mídia ampliada em tela cheia com navegação por teclado e download;
botão de baixar em documento recebido; arrastar arquivo para a conversa e colar com Ctrl+V,
os dois com prévia (miniatura, legenda, remover, adicionar, progresso por arquivo e
retentativa do que falhou); link clicável no texto da mensagem (nova aba,
com `noopener noreferrer`); dashboard; relatório por atendente; auditoria consultável;
perfil e troca de senha pelo próprio usuário; aviso de chamada recebida; som de
notificação de mensagem recebida, com som e volume escolhidos por cada usuário; título da
aba piscando com as conversas que receberam mensagem, até alguém abrir a Inbox; horário
permitido de login por dia da semana, aplicado a quem não é supervisor, com aviso 5 minutos
antes e encerramento da sessão no fechamento.

**Falta** (ordem sugerida): validar o pareamento QR em rede aberta (o ambiente de
desenvolvimento bloqueia `web.whatsapp.com`); votos de enquete agregados na Inbox;
biblioteca de figurinhas; read receipts de saída; fila (BullMQ/Redis) para mídia em
volume; tela de auditoria no frontend (API pronta); storage S3/Supabase (interface pronta);
testes de integração com banco; multi-organização real (cadastro e billing).

---

## 15. AZVCHAT ↔ Azevedo-OS (integração de leitura)

O **Azevedo-OS é a fonte da verdade do cadastro empresarial**; o AZVCHAT é a fonte da
verdade da comunicação. A Inbox mostra a empresa do cliente **sem replicar o cadastro**:
guarda só o ponteiro e consulta na hora de exibir.

```
Frontend AZVCHAT → API Fastify (token) → API do Azevedo-OS → base do Azevedo-OS
```

Os dois caminhos proibidos, e o motivo: **frontend → Azevedo-OS** exporia o token no
navegador; **Postgres do AZVCHAT → base do Azevedo-OS** amarraria os dois esquemas e faria
migration de um quebrar o outro. Toda comunicação é por API, servidor-a-servidor.

**Vínculo.** `Conversation.externalSource = "azevedo-os"` (`AZEVEDO_OS_SOURCE`, em
`@azvchat/shared`) e `Conversation.externalReference = <id da empresa>`. **Sem migration**:
os dois campos já existiam. O ponteiro é o id externo, então trocar razão social, nome
fantasia, CNPJ, telefone, contato ou regime tributário no Azevedo-OS **não mexe no
vínculo**. Não existe tabela de empresa no AZVCHAT, e não deve passar a existir — cache que
vira segunda base cadastral é exatamente o que esta arquitetura evita.

**Um campo, dois mecanismos.** O mesmo `externalReference` guarda o código digitado pela
equipe (fonte `manual`, "EMPRESA 001") e o id da empresa. Por isso a escrita é uma só:
`PATCH /conversations/:id/reference`, com `externalSource` validado por Zod contra a lista
conhecida (`EXTERNAL_REFERENCE_SOURCES`) — o navegador não registra origem arbitrária. Quem
decide o que cada papel pode é `lib/azevedo-os-link.ts` (`planReferenceUpdate`), e a regra
**depende do estado**, não só do papel: em conversa vinculada, limpar o campo É desvincular
e exige supervisor; gravar código manual em conversa vinculada é recusado até para o admin
(desvincular é decisão explícita). Vincular e trocar **confirmam a empresa no Azevedo-OS
antes de gravar**.

O código manual **não tem mais campo na tela**: a caixa "Cadastro" saiu do painel de
contexto. A regra do lado `manual` continua no endpoint de propósito — os códigos já
gravados seguem aparecendo no chip âmbar e sendo encontrados pela busca, e a régua de
permissão precisa continuar valendo se um dia a caixa voltar em outro lugar.

**Endpoints.**

```
GET  /conversations/:id/external-company         (agent+; sem vínculo devolve company: null)
GET  /integrations/azevedo-os/companies?conversationId=&search=   (supervisor+)
PATCH /conversations/:id/reference               (endpoint existente, evoluído)
```

A pesquisa **exige a conversa** que vai receber o vínculo e valida o acesso a ela: sem
isso a integração viraria um diretório de empresas aberto a quem tem login. O acesso sai
de `lib/conversation-access.ts`, que usa `access.ts` — nenhum `where` na mão. Conversa fora
do recorte responde 404 (padrão da casa), papel insuficiente responde 403.

**Segredo.** `AZEVEDO_OS_API_TOKEN` existe só no processo da API, dentro de
`services/azevedo-os-client.ts` — o único lugar do sistema que fala com o Azevedo-OS.
Nunca vai para o banco, para log, para o DTO nem para o Next.js (não há `NEXT_PUBLIC_`
equivalente). Mensagem de erro do Azevedo-OS **não é repassada**: resposta de erro costuma
ecoar o cabeçalho enviado, e o cabeçalho carrega o token.

**Variáveis** (todas opcionais; sem URL ou sem token a integração nasce desligada e o card
avisa): `AZEVEDO_OS_API_URL`, `AZEVEDO_OS_API_TOKEN`, `AZEVEDO_OS_WEB_URL` (endereço real
da empresa com `{id}`; sem ela o botão "Abrir no Azevedo-OS" não aparece, em vez de virar
link quebrado) e `AZEVEDO_OS_TIMEOUT_MS` (padrão 5000).

Elas chegam ao `.env` da VPS por dois caminhos, e o `DEPLOY.md` descreve os dois: pelos
segredos do GitHub, que o passo "Configurar a integração com o Azevedo-OS" do `deploy.yml`
grava a cada publicação, ou à mão na VPS. **Faltando o par URL+token, esse passo não encosta
no `.env`** — apagar a configuração de quem fez à mão seria pior do que não configurar. Ele
remove as linhas `AZEVEDO_OS_*` antes de escrever as novas, senão cada deploy empilharia uma
cópia e a última venceria em silêncio; e manda o token por stdin em base64, porque como
argumento do ssh ele apareceria em `ps` na VPS.

> **O caminho do GitHub não dispensa o SSH, ele o centraliza — e isso já enganou.** O job
> inteiro do `deploy.yml`, este passo incluído, está atrás de `configurado == 'true'`, que
> exige `VPS_HOST`, `VPS_USER` e `VPS_SSH_KEY`. Sem eles o run fecha **verde com todos os
> passos `skipped`**, que é o desenho certo (quem usa a atualização automática do systemd não
> pode ver merge vermelho por não ter chave), mas produz o pior sinal possível para quem
> confere: sucesso indistinguível de "não havia o que fazer".
>
> Em 16/08/2026 eu li `conclusion: success` de três deploys e afirmei que a VPS tinha sido
> atualizada por eles. Nenhum tinha: os três pularam tudo, e o SSH nunca esteve configurado —
> a VPS se atualiza pelo timer do systemd. **Resultado de run não é evidência de execução; a
> lista de passos é.** Ao conferir deploy aqui, olhe `conclusion` de cada step, não do run.

**Resiliência.** Timeout curto e explícito, e toda falha vira `AzevedoOsError` → erro só do
card ("Azevedo-OS temporariamente indisponível."). Abrir conversa, carregar mensagens,
enviar, atribuir, anotar e etiquetar **seguem funcionando com o Azevedo-OS fora do ar** —
a única operação que a indisponibilidade barra é gravar um vínculo novo, porque gravar um
id não conferido é pior do que adiar.

**Contrato.** O client lê o contrato com tolerância: só o `id` é obrigatório, cada campo
aceita alguns nomes (camelCase, snake_case, português) e o que faltar vira `null` e some do
card. Campos exibidos: nome, CNPJ, número da empresa, status, regime tributário, folha de
pagamento e contatos. **Não há bloco de responsáveis internos** nesta fase — nem na tela,
nem na consulta.

**Quem nomeia o status é o Azevedo-OS.** O contrato manda os dois campos de propósito:
`status` é o código estável, o único comparado em código, e `statusLabel` é o rótulo já em
português, para exibir. `normalizeAzevedoOsStatus(status, statusLabel)` usa o rótulo da
origem e decide **só o tom** pela tabela local — cor é escolha de tela, e o Azevedo-OS não
conhece a paleta da Inbox.

O primeiro desenho descartava o `statusLabel` e remontava o texto num dicionário daqui.
Custou o que dicionário duplicado sempre custa: o Azevedo-OS manda `onboarding` para
empresa em implantação, a tabela local não conhecia a chave, e o card caía no genérico
"valor desconhecido aparece como veio" — escrevendo **"Onboarding"**, palavra em inglês,
num painel em português. Nada quebrava, nada ficava vermelho, e só quem abrisse a conversa
de um cliente em implantação veria. A tabela local ganhou as chaves que faltavam, mas o que
de fato conserta é a ordem de precedência: **rótulo de fora vence rótulo de dentro.**

**Tempo real e auditoria.** Nenhum evento novo: vincular, trocar e desvincular emitem
`RealtimeEvents.ConversationUpdated` para `conversationAudience()`, que já carrega
`externalReference`/`externalSource` no DTO. Auditoria em
`conversation.azevedo_os_company_linked` / `_changed` / `_unlinked`, com `companyId` e
`previousCompanyId` — dado de cadastro da empresa não entra no `AuditLog`, o id basta.

**Filtros da Inbox por característica do cliente.** A Inbox recorta por **regime
tributário** e **folha de pagamento** (perto do vencimento do Simples, ver só os do
Simples; em fechamento de folha, só quem tem folha). Os dois campos moram lá, e os bancos
são separados, então **não há consulta capaz de cruzar as duas coisas**: o caminho é
decompor a pergunta. O portal responde quais EMPRESAS batem
(`GET /company-ids?taxRegime=&payroll=`, só os identificadores) e o AZVCHAT recorta as
conversas por `externalReference`. Uma viagem por consulta, nunca uma por conversa.

As opções dos seletores vêm de `GET /company-facets`, e **não são lista escrita aqui**:
os dois campos são enum fechado no Azevedo-OS, e cada valor vem com o rótulo em português
escrito por lá — mesma divisão de `status`/`statusLabel`, pelo mesmo motivo. A contagem de
empresas que o portal manda **não atravessa para a tela** (ela conta empresas, não
conversas, e o número ao lado do rótulo seria lido errado); ela decide só uma coisa, no
servidor: se o seletor oferece "Sem informação". Só o envio pelo caminho autenticado
prova a integração de ponta a ponta — o ambiente de desenvolvimento nasce com ela
desligada.

Nada disso encosta em `lib/access.ts`: é recorte de apresentação **por cima** do que a
pessoa já enxerga. Sem evento novo, sem auditoria (é filtro de visualização) e sem
migration. E **nenhum dado financeiro** atravessa nesta integração: honorário,
inadimplência e valor de contrato são do Financeiro e da Diretoria no Azevedo-OS, e
trazê-los para cá contornaria aquela regra por fora.

**Na tela.** Card "Cliente Azevedo-OS" em `components/inbox/azevedo-os-card.tsx`, dentro do
painel de contexto, com estado próprio de carregamento e de erro. `agent` vê o card inteiro
e nenhum botão de vínculo. O identificador do Azevedo-OS **não vira chip** na lista nem no
cabeçalho da conversa: ele é interno, e o chip âmbar continua sendo do código de cadastro
manual já gravado. O painel **não tem mais a caixa "Cadastro"** — a empresa do cliente é o
card, e um campo de texto ao lado dele escrevendo no MESMO `externalReference` era convite
a apagar o vínculo sem querer.

---

## 16. Como escrever um bom prompt para este sistema

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
