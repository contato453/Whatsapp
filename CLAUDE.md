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
| **Resposta rápida** | `QuickReply` — texto disparado por `/atalho` no composer, com mídia opcional (imagem, áudio ou vídeo) que sai junto e com **variáveis** (`{{empresa.cnpj}}`) resolvidas na inserção. |
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
- `Department` — `name` único na org, `color`, `defaultAssigneeId` (responsável padrão),
  `isInternal` (padrão `false`) — **departamento interno: as conversas dele não entram em
  número nenhum** (cards e gráficos do dashboard, "Atrasados agora" e relatório por
  atendente). Existe porque grupo interno da equipe não é atendimento a cliente, e o
  estrago maior era no atraso: num grupo interno a última mensagem é quase sempre de
  entrada, ninguém "responde" a ela, e a conversa acumulava atraso para sempre — o painel
  passava a medir conversa nossa em vez de cliente esperando. **Não é arquivamento**: a
  conversa continua na lista, contando não lidas, tocando o som e piscando o título da aba;
  e **não é visibilidade** — `access.ts` não foi tocado. Como o recorte é por junção, e não
  por marca copiada na conversa, ligar já vale para os grupos que existem e desligar
  devolve tudo, sem backfill. Fonte única em `apps/api/src/lib/internal-department.ts`.

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
- `PersonProfile` — **onde mora a identidade da PESSOA, única na organização**, chaveada
  por `(organizationId, externalId)` (o mesmo JID de `GroupParticipant.externalContactId`;
  LID é estável e também unifica). Guarda o que é da pessoa e vem da equipe: `customName`,
  `clientRole` e `phoneNumber` (ponte de EXIBIÇÃO para a conversa individual — nunca chave
  de fusão). Existe porque a mesma pessoa está nos grupos Geral, Contábil, Fiscal e DP do
  cliente, e a edição por grupo obrigava a repetir a correção. **Linha existente vale
  inteira, mesmo com campos nulos** (limpar é decisão); linha ausente cai no legado da
  linha do grupo, que a migration `20260818150000_person_profiles` deixou no banco de
  propósito (fallback dos conflitados + caminho de volta). A leitura/escrita é fonte única
  em `apps/api/src/lib/person-profile.ts`; o sync nunca escreve aqui.
- `GroupParticipant.clientRole` e `customName` são o **legado por grupo** dessa identidade:
  continuam no banco e valem só para quem ainda não tem `PersonProfile` (pessoa que estava
  com valores divergentes entre grupos — a primeira edição pelo lápis resolve). `clientRole`
  (`ParticipantClientRole`: `partner` | `administrative` | `null`) — papel da pessoa
  **dentro do cliente**, marcado pela equipe. Coluna única, então
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
- `PinnedItem` — **fixação de mensagem ("pin"), INTERNA ao AZVCHAT e nunca propagada ao
  WhatsApp** (não usa o recurso de pin do Baileys, não chama o provider). É a faixa fixa no
  topo da conversa, para a equipe destacar link de formulário, de pasta ou de agendamento sem
  rolar a conversa inteira para achar de novo. Alvo **polimórfico**: `messageId` OU `noteId`,
  nunca os dois (constraint `pinned_items_one_target` na migration) — nota interna também
  pode ser fixada, e ela não é `Message`. `pinnedByUserId` (nulo = quem fixou não existe mais
  no cadastro, mesmo padrão de `archivedByUserId`) e `pinnedAt` **sem prazo de validade**, de
  propósito: diferente do WhatsApp, fica até alguém desafixar. Teto de `MAX_PINNED_ITEMS` (3)
  por conversa, aplicado em `lib/pinned-items.ts` — a quarta é recusada com 409
  `pin_limit_reached`, e a tela oferece substituir a mais antiga (`replaceItemId`, troca as
  duas numa transação só). Mensagem apagada (pelo cliente ou por nós) **desafixa sozinha**
  (`unpinMessageIfPinned`, chamado nos dois pontos de exclusão); nota interna é apagada
  fisicamente, então o `ON DELETE CASCADE` do banco já resolve sozinho. Fonte única de
  leitura/escrita e da serialização: `apps/api/src/lib/pinned-items.ts` e
  `serializePinnedItem(s)` (`lib/serialize.ts`). Nada aqui encosta em `lib/access.ts`: quem
  já enxerga a conversa enxerga a fixação, sem recorte a mais.
- `InternalNote`, `Tag` + `ConversationTag` + `TagDepartment`, `QuickReply` +
  `QuickReplyDepartment`, `ScheduledMessage`
  (`pending|sent|failed|canceled`, com `attempts`), `ConversationAssignmentHistory`
  (`assigned|transferred_user|transferred_department|unassigned|resolved|reopened`),
  `AuditLog`.

**Permissões**
- `RolePermission` — o que cada perfil PODE FAZER nesta organização, por par
  (`role`, `action`), único por `(organizationId, role, action)`. **Só grava o que difere do
  catálogo**: ausência de linha significa o padrão de `PERMISSION_ACTIONS`
  (`packages/shared/src/permissions.ts`) — semear as 26 ações por papel congelaria os padrões
  no banco, e mudar um padrão no código deixaria de valer para quem já existe. `action` é
  **texto**, não enum: ação removida do código não exige migration, e a linha órfã é ignorada
  em silêncio pela leitura. Constraint `role_permissions_role_not_admin` impede linha de
  `admin` — administrador passa por cima de tudo, senão a organização se trancaria do lado de
  fora sem ninguém para religar. `updatedById` é quem mexeu por último, exibido na tela.

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

conversationAssigneeWhere(orgId, conversa)   // quem pode RECEBER esta conversa
canAssignBeyondConversationReach(role)       // quem transfere para fora do alcance
```

As duas últimas são o **avesso** de `conversationScope`: em vez de "quais conversas esta
pessoa enxerga", "quais pessoas enxergam esta conversa". Elas decidem a ESCRITA do
responsável, e não a leitura — nada de `loadConversationAccess` ou `conversationScope`
mudou por causa delas. Candidato é quem tem o **número** da conversa **e**, quando ela está
classificada, o **departamento dela** (o da conversa, nunca o de quem transfere: valesse o
de quem move, uma pessoa de vários departamentos empurraria o atendimento para outra área
sem passar por `transfer-department`, que é de supervisão). Conversa sem departamento só
exige o número, inativo nunca é candidato e o admin entra sem vínculo nenhum, porque ele
realmente enxerga tudo. Supervisor e admin podem transferir para fora do alcance — a tela
confirma antes de gravar —, o atendente é recusado com `ForbiddenError` no
`POST /conversations/:id/assign`, e `lib/default-assignee.ts` delega à mesma função para o
responsável padrão não divergir do seletor.

**Papel ≠ visibilidade.** Visibilidade responde "quais conversas"; permissão responde "quais
ações" — e desde o menu de Permissões **a segunda não é mais tabela de papel: é o catálogo**.

A fonte única é `packages/shared/src/permissions.ts` (`PERMISSION_ACTIONS`): 26 ações com nome
técnico, rótulo, explicação, área e o **padrão por papel**. A API decide por
`apps/api/src/lib/permissions.ts` (`requirePermission` / `loadPermissions().can()`), a tela de
Permissões é **gerada** a partir da mesma lista, e o admin **sempre pode**, sem chave. Ação
nova entra no catálogo e já vale nos dois lados.

O que **não** tem chave, e é fixo no código de propósito:

| Ação fixa | Regra |
| --- | --- |
| Criar usuário, editar cadastro (nome, e-mail, papel, vínculos), redefinir senha de terceiro; excluir número; excluir departamento; abrir e gravar a tela de Permissões | `admin` (`requireRole("admin")`) |
| **Exceção única no cadastro de usuário**: o campo `status` tem chave (`user.deactivate`, padrão não/não) — recusa de CAMPO dentro do `PATCH /users/:id`, e nunca alcança um administrador | catálogo |
| Nunca deixar a organização sem admin ativo | transação com linhas travadas |
| Ler conversa, enviar mensagem, mudar status, escrever e editar a **própria** nota | sempre liberado — não existe caminho para trancar o atendente fora do próprio trabalho |
| Etiqueta **geral** (`isGeneral`) | `admin` (resposta rápida geral, sim, tem chave: `quick_reply.create_shared`) |

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
       (os dois primeiros devolvem `user.permissions`: as ações liberadas para a sessão,
        já resolvidas com catálogo + configuração — a tela NUNCA deduz pelo papel)
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
       TODO filtro aceita LISTA (parâmetro repetido ou separado por vírgula):
       [&status=][&type=][&assignment=][&instanceId=][&tagId=][&taxRegime=][&payroll=]
       (OU dentro do filtro, E entre filtros; lista vazia = "todos". Item
        inválido é RECUSADO com 400, nunca ignorado. `assignment` é o filtro
        UNIFICADO de departamento e responsável, em tokens: `none`,
        `all_users`, `no_department`, `dept:<uuid>`, `user:<uuid>` — ver a
        seção 13. A resposta traz `total`, que a barra mostra sempre)
       [&resolvedBy=<uuid>&resolvedFrom=&resolvedTo=]
       (conversas CONCLUÍDAS por alguém dentro de um intervalo — o drill-down
        da coluna "Concluídas" do relatório. Os três andam juntos ou nenhum
        vem. Mede o EVENTO de conclusão, não o status atual nem o responsável
        de agora: a conversa concluída ontem e reaberta hoje continua contando)
       [&excludeInternal=true]
       (tira as conversas dos departamentos INTERNOS. A Inbox nunca manda —
        grupo interno continua na lista dela; quem manda é o painel do
        relatório, que precisa listar exatamente o que a célula conta. O
        filtro `overdue` NÃO precisa dele: a exclusão mora dentro de
        `lib/overdue.ts` e vale nas duas pontas)
       [&overdue=true]
       (a lista do card "Atrasados agora": não resolvidas, com a última
        mensagem do cliente, esperando além do limite em tempo de expediente.
        A régua é `lib/overdue.ts`, a MESMA do dashboard)
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
GET    /conversations/:id/assignees
       (candidatos a responsável desta conversa, por `conversationAssigneeWhere`;
        para supervisor e admin vem também `others`, os ativos que NÃO a enxergam,
        que a tela oferece com confirmação — a lista é conveniência, a recusa
        de verdade está no assign)
POST   /conversations/:id/assign          POST /conversations/:id/unassign
POST   /conversations/:id/resolve         POST /conversations/:id/reopen
GET    /conversations/:id/files
POST   /conversations/:id/tags/:tagId     DELETE /conversations/:id/tags/:tagId
POST   /conversations/:id/notes           PATCH|DELETE /conversations/:id/notes/:noteId
POST   /conversations/:id/notes/:noteId/pin    POST /conversations/:id/notes/:noteId/unpin
       (fixa/desafixa uma NOTA interna — mesma faixa das mensagens, papel mínimo
        agent (chave `message.pin`); ver POST /messages/:id/pin logo abaixo)

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
POST   /messages/:id/pin                  POST /messages/:id/unpin
       (fixação (pin) INTERNA ao AZVCHAT — nunca chama o provider nem usa o pin do
        WhatsApp. Papel mínimo agent (`message.pin`, padrão liberado). Teto de 3 por
        conversa: acima disso devolve 409 `pin_limit_reached`; body opcional
        `{ replaceItemId }` troca a mais antiga pela nova numa transação só.
        Resposta `{ items }` é a LISTA INTEIRA das fixadas, sempre — a mesma que sai
        em `serializeConversationDetail` e no evento `conversation:pinned-items`)

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

GET    /integration-tokens   (admin; tokens da API de integração — nunca o token em claro)
POST   /integration-tokens   (admin; cria e devolve o token em claro UMA vez)
POST   /integration-tokens/:id/revoke   (admin; desativa, nunca apaga — histórico fica)
POST   /integrations/messages           (token de máquina, NÃO sessão; ver a seção 17)
       { telefone, mensagem, idempotencyKey?, instanceId? }
       (envia por sistema externo pela instância do token; telefone normalizado
        antes de tudo (422 se inválido/grupo), instância errada 403,
        desconectada/excluída 409, idempotência de 24h, rate limit por token 429.
        Reaproveita o caminho do envio manual — não expõe leitura nenhuma)

GET    /permissions          (admin; o que a organização gravou por cima do catálogo —
       o catálogo em si NÃO vem por aqui, a tela o importa de @azvchat/shared)
PUT    /permissions          (admin; grava em bloco, apaga a linha quando o valor volta ao
       padrão, invalida o cache e audita cada par com valor anterior e novo)

GET    /attendance-settings  (qualquer papel — o dashboard depende dela)
PUT    /attendance-settings  (supervisor; grava SLA + expediente + janela de login,
       a semana inteira de uma vez, e vai para o AuditLog)

GET    /search              GET /audit-logs
GET    /reports/agents?from=&to=[&departmentId=<uuid|none>][&instanceId=<uuid>]
       (os dois filtros aceitam LISTA, somam dentro de si e CRUZAM entre si —
        e cruzam também com o responsável da linha, como no Dashboard e ao
        contrário da Inbox. Entram por cima de `conversationScope`. A resposta
        devolve `filters` com o que a API aplicou.
        Relatório por atendente. Além das linhas de pessoa, devolve `unassigned`
        e `allUsers`: as conversas SEM RESPONSÁVEL e as coletivas ("@todos"),
        que antes ficavam fora do relatório inteiro. As duas só têm fila —
        mensagens, tempo médio e concluídas são medidas de uma pessoa —, e
        entram no `totals.queue`, que é o número do cabeçalho de cada coluna.
        `conversationsResolved` conta CONVERSAS distintas concluídas no
        período, e não linhas de histórico: é o que o painel consegue listar)
GET    /dashboard/stats?period=today|7d|15d|30d|custom[&from=&to=]
       (o PERÍODO é o único filtro de valor único — intervalo não é conjunto)
       Os quatro demais aceitam LISTA (parâmetro repetido ou separado por vírgula):
       [&instanceId=][&status=open|waiting_client|waiting_internal|resolved]
       [&departmentId=<uuid|none>][&assignedUserId=<uuid|none|all_users>]
       (OU dentro do filtro, E entre filtros; lista vazia = "todos". Aqui
        departamento e responsável são DOIS filtros e CRUZAM — divergência
        proposital em relação à Inbox, ver a seção 13. Item fora do enum, uuid
        torto, id que não existe na organização e lista acima de 200 itens são
        RECUSADOS com 400, nunca ignorados. `custom` exige as duas datas
        AAAA-MM-DD, teto de 366 dias; o bloco `topUsers` só vem para supervisor,
        senão é `null`; `timeline` traz um ponto por dia civil do período e
        `hourly` as células dia da semana × hora, esta sempre numa janela fixa
        de 30 dias. A resposta devolve `filters` com as quatro listas como a
        API as aplicou)
```

Mídia é servida **somente autenticada**, escopada por organização, com proteção contra
path traversal (`lib/media-storage.ts`, interface `MediaStorage` pronta para driver S3).

---

## 7. Tempo real (Socket.IO)

Contratos em `packages/shared/src/realtime.ts` — **nomes de evento nunca são string solta**,
sempre `RealtimeEvents.X`:

`message:new`, `message:status`, `message:reaction`, `message:updated`, `call:incoming`,
`conversation:updated`, `conversation:read`, `group:participants`, `note:new`,
`conversation:pinned-items`, `instance:status`, `instance:qr`, `scheduled:pending`,
`session:closing`, `session:closed`.

`conversation:pinned-items` (`{ conversationId, items }`) sai sempre que a fixação (pin) de
uma conversa muda — fixar, desafixar, substituir a mais antiga, ou a mensagem fixada ser
apagada/editada. `items` é a **lista inteira** das fixadas (no máximo 3), nunca um patch: é
mais simples reenviar tudo do que sincronizar incrementalmente, e o tamanho já é pequeno por
construção. Evento próprio, e não `conversation:updated` nem `message:updated`: o primeiro é
o DTO leve da lista da Inbox (carregar fixações nele pagaria a consulta em toda linha, o
mesmo motivo de `scheduledPendingCount` ficar fora), e o segundo não serve porque a fixação
pode ser de uma NOTA interna, que não é `Message`.

`call:incoming` avisa que uma ligação está tocando (o sistema nunca atende nem recusa) e
chega com a identidade de quem liga **já resolvida pela API** — a tela só desenha, sem
consulta própria: `{ conversationId, conversationTitle, callerName, callerPhone,
callerGroups, callerAvatar, isVideo, isGroup, assignedUserId, instanceId, instanceName,
at }`. A resolução (`lib/call-identity.ts`) para na primeira fonte que acertar — conversa
individual (`customTitle`/`title`, descartando título que é o próprio JID), `Contact` da
agenda do número, `GroupParticipant` (`customName`/`name`) — e `callerGroups` traz os
grupos do sistema de que a pessoa participa naquele número (é como o aviso diz "de qual
cliente" é quem liga). `callerName` nulo = contato não identificado; `callerPhone` só vem
quando é número real (LID nunca vira telefone); `callerAvatar` aponta a fonte da foto
(`conversation`/`participant`) para o frontend buscar pelo endpoint autenticado;
`instanceName` é o chip por onde a chamada entrou. Audiência: a mesma
`conversationAudience()` de sempre.

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
  `message-reaction`, `message-deleted`, `message-edited`, `message-edit-encrypted`,
  `call`, `chats-sync`,
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
- **Edição e exclusão FEITAS PELO CLIENTE chegam como pacote de protocolo**, nunca como
  mensagem, e o pacote vem embrulhado (`editedMessage`, com ou sem um `message` no meio,
  conforme a versão do aplicativo). `extractProtocolAction` (`qrcode/normalize.ts`)
  desembrulha e traduz em `message-deleted` ou `message-edited` — este último com o id da
  mensagem **ORIGINAL**, o texto (ou a legenda) novo e o `editedAt` informado pelo
  WhatsApp. **São DOIS os canais de entrada, e os dois estão ligados de propósito**: o
  `messages.upsert` e o `messages.update`, para onde o Baileys converte o pacote de
  `MESSAGE_EDIT` e de `REVOKE`. Ouvir só o primeiro, ou ler do segundo apenas o `status`,
  descarta a edição em silêncio — foi exatamente esse o defeito. Receber duas vezes não
  incomoda: quem aplica é idempotente. **O ANINHAMENTO DO TEXTO NOVO VARIA com a versão do
  aplicativo**, então `findEditedText` varre o pacote inteiro em vez de apostar num
  caminho fixo (dentro de um pacote de edição o único texto que existe é o novo).
  Reconhecer o pacote e não achar o texto é a pior falha das duas: não sobra bolha lixo
  para denunciar, e a mensagem velha continua na tela. Por isso esse caso, e só ele, loga
  `message_edit_without_content` com as CHAVES do pacote — nunca o conteúdo.
- **A EDIÇÃO FEITA PELO CLIENTE CHEGA CIFRADA, e nenhuma versão do Baileys abre — nós
  abrimos.** O
  WhatsApp trocou o mecanismo: em vez do `protocolMessage` com o texto novo em claro, manda
  um `secretEncryptedMessage` (`secretEncType = MESSAGE_EDIT`) com a chave da mensagem
  ORIGINAL e um payload cifrado. A chave sai de HKDF-SHA256 sem sal sobre o
  `messageContextInfo.messageSecret` da ORIGINAL, com o "info" sendo
  `id da original + JID de quem a mandou + JID de quem editou + "Message Edit"`, nessa
  ordem, e sem AAD (voto de enquete tem AAD; copiá-lo de lá faz a etiqueta nunca conferir).
  Tudo isso mora em `packages/whatsapp/src/qrcode/message-secret.ts`, e a API consome
  `decryptEditedText`, que devolve TEXTO — nada fora do pacote conhece o formato.
  Consequências: (1) o `messageSecret` de toda mensagem recebida é gravado em
  `Message.metadata` (`MESSAGE_SECRET_METADATA_KEY`), senão a edição dela nunca poderá ser
  aberta; (2) mensagem anterior a essa gravação **não tem** como ter a edição lida — é o
  desenho do protocolo, não defeito, e o caso vira log `message_edit_secret_missing`;
  **quando a abertura falha, a bolha AVISA** (`EDIT_CONTENT_UNAVAILABLE_METADATA_KEY`, chip
  âmbar "editada pelo cliente"): o texto antigo continua na tela, porque é o que temos, mas
  ninguém age achando que está atualizado — silêncio aqui é o defeito original na sua forma
  mais perigosa, e nunca é opção;
  (3) o JID de quem mandou e de quem editou é passado como LISTA DE CANDIDATOS, porque o
  WhatsApp endereça a mesma pessoa ora pelo telefone, ora pelo `@lid`, e o que gravamos nem
  sempre é o que ele usou na chave — a etiqueta do AES-GCM só confere com o certo, então
  testar não abre errado, e o log `message_edit_decrypted` registra a combinação vencedora;
  (3b) **quem prova que a chave está certa é a ETIQUETA DE AUTENTICAÇÃO do AES-GCM, nunca o
  formato do que veio dentro.** Considerar sucesso só quando o texto sai no formato
  esperado descarta decifragem CORRETA cujo conteúdo veio embrulhado, e o sintoma é
  idêntico ao de chave errada — foi esse engano que escondeu o problema por várias rodadas.
  Abriu e não achou texto vira log `message_edit_opened_without_text` com os CAMINHOS das
  chaves, que é outra investigação, não a mesma;
  (4) errar qualquer um dos quatro campos da derivação faz o AES-GCM recusar em SILÊNCIO,
  com o mesmo sintoma de não ter recebido nada, e por isso `test/message-secret.test.ts`
  cifra com o mesmo esquema e confere que a função abre. O caminho antigo do
  `protocolMessage` continua ligado: aparelho desatualizado ainda o usa.
- **QUANDO A EDIÇÃO CIFRADA NÃO ABRE, PEDIMOS O REENVIO AO SERVIDOR.** É a segunda via, e
  não depende de criptografia nenhuma: o WhatsApp guarda a mensagem no estado ATUAL (é
  assim que um aparelho novo já a vê editada), então `requestMessageResend` traz o texto
  novo em claro pelo caminho normal de recebimento. A ingestão reconhece a reentrega com
  conteúdo DIFERENTE e aplica como edição, em vez de descartar como duplicata — texto igual
  continua sendo duplicata e não faz nada. Sem rota nova, sem evento novo: o ciclo fecha
  reusando `applyEdit`. O reenvio é pedido só depois de a decifragem falhar, e o próprio
  Baileys guarda quais já foram pedidos, então não vira enxurrada.
- **NÃO FIXE A VERSÃO DO WHATSAPP WEB PARA CONTORNAR A EDIÇÃO CIFRADA. JÁ FOI TENTADO E
  DERRUBOU O SISTEMA.** O raciocínio é sedutor: é por anunciarmos a versão mais recente
  que o servidor manda a edição cifrada, então fixar uma anterior faria voltar o formato em
  claro, que já tratamos. Na prática o WhatsApp **recusa a conexão** com versão antiga, e o
  número inteiro sai do ar — não é degradação, é queda. Em 20/08/2026 isso desconectou a
  produção e só voltou removendo a variável e reconstruindo. A alavanca foi retirada do
  código de propósito: `fetchLatestBaileysVersion` é o único caminho, e a espera pelo
  suporte do Baileys ao envelope cifrado é o caminho certo.
- **A LISTA DE INVÓLUCROS É UMA APOSTA, e por isso existe a BUSCA PROFUNDA.** Enumerar
  `editedMessage`, `ephemeralMessage`, `viewOnce...` cobre o que o WhatsApp já usou, não o
  que ele vai usar: em produção o pacote de edição chegou dentro de uma chave fora da
  lista, escapou do reconhecimento e caiu na trava de conteúdo — sem bolha lixo (a trava
  funcionou) e sem edição aplicada, que é a falha mais silenciosa das duas. Agora, quando a
  mensagem não tem NADA de exibível, `extractProtocolAction(..., { deep: true })` procura o
  `protocolMessage` em qualquer chave e em qualquer profundidade. A varredura só roda nesse
  ponto de propósito: mensagem de verdade nunca chega até ali, então uma citação embutida
  jamais é confundida com pacote de protocolo. Não achando nada, o log
  `message_without_content_skipped` sai com os CAMINHOS das chaves (`messageKeyPaths`),
  que é o que permite reconhecer a próxima estrutura sem registrar o que o cliente escreveu.
- **RESPOSTA A BOTÃO, A LISTA OU A BOTÃO DE MODELO É CONTEÚDO, NÃO "MENSAGEM SEM NADA".**
  `buttonsResponseMessage`, `listResponseMessage` e `templateButtonReplyMessage` não tinham
  ramo em `extractContent`: a pessoa TOCAVA numa opção, o pacote caía no fallback `other` sem
  texto e sem mídia, e `isDisplayableContent` descartava em silêncio — sem bolha lixo (a
  trava funcionou), mas também sem o clique do cliente chegar à Inbox. Os três agora saem
  como tipo `text`, com o rótulo escolhido (ou o id, quando o WhatsApp não manda o texto de
  exibição) como conteúdo. `unwrapMessage` e `findProtocolMessage` também desembrulham
  `deviceSentMessage` — mensagem que a atendente manda do PRÓPRIO celular, de outro aparelho
  ligado à mesma conta, chega embrulhada nele, e sem desembrulhar caía no mesmo fallback sem
  conteúdo.
- **Mensagem sem `key.id` utilizável** (raro, mas existe) usa `fallbackExternalMessageId`
  (chat + remetente + timestamp) em vez de `unknown-${Date.now()}`: o fallback antigo mudava
  a cada chamada, então a MESMA mensagem reprocessada (reconexão, reentrega) virava uma linha
  NOVA a cada vez em vez de bater na deduplicação por `(conversationId, externalMessageId)`.
- **FORMATO DE ÁUDIO: o WhatsApp toca mensagem de voz em OGG/Opus, mono, 16 kHz, com a
  flag `ptt` e a DURAÇÃO em segundos.** Nada disso é o que o navegador grava (ver a
  armadilha na seção 13), então todo áudio que sai é normalizado no SERVIDOR, por ffmpeg,
  antes do envio: `packages/whatsapp/src/audio/normalize-audio.ts`
  (`normalizeAudioForWhatsApp`) é a fonte única, e `apps/api/src/lib/outbound-audio.ts`
  (`prepareOutboundAudio`) é o que as rotas chamam. Dois perfis: `voice` (microfone,
  OGG/Opus mono 16 kHz, `ptt` ligado, com waveform) e `file` (arquivo anexado, que
  **continua arquivo** e só troca de container quando o WhatsApp não sabe tocar o que
  veio). O ffmpeg roda como processo separado lendo e escrevendo por pipe, então o laço de
  eventos nunca fica preso: dois minutos de áudio convertem em cerca de 3 segundos com a
  API atendendo o resto normalmente. **Falha na conversão INTERROMPE o envio** com 422
  `audio_conversion_failed` e uma frase em português; enviar assim mesmo é o defeito que
  isso veio consertar.
- **A MENSAGEM DE VOZ ESTÁ LIGADA** (`VOICE_NOTE_ENABLED`, em
  `apps/api/src/lib/outbound-audio.ts`, com o histórico inteiro). **A CONVERSÃO É SEMPRE A
  DE ARQUIVO**, inclusive na mensagem de voz: OGG/Opus 48 kHz, linha de tempo zerada e sem
  waveform, que é a forma de bytes provada em produção. A única coisa que a gravação muda
  em relação ao anexo é o **bitrate** (`MICROPHONE_BITRATE`, 32 kbps contra 96): fala em
  Opus não precisa de mais, e um minuto caiu de 829 KB para 334 KB. O perfil de voz (mono
  16 kHz, `-application voip`, com waveform) é o que o WhatsApp usa e encolheria mais, mas
  mexe na cadeia de resampling, que é onde morava o atraso de codec deste defeito: se for
  experimentar, troque UMA variável por vez e mande um áudio de verdade a cada passo. Desligar a
  constante faz a gravação sair como arquivo de áudio comum, que toca do mesmo jeito, só
  sem a onda e sem o 1.5x.
- **A MENSAGEM DE VOZ NÃO SAI PELO `sendMessage` do Baileys**, e sim por
  `relayVoiceNote` (`qrcode-provider.ts`), que monta a mensagem com
  `generateWAMessage`, devolve a waveform e chama `relayMessage`. O motivo é uma perda
  silenciosa: com `ptt` ligado, o Baileys recalcula a waveform chamando `audio-decode`,
  uma biblioteca que ele **não declara como dependência**. O import falha, o erro é
  engolido, a função devolve `undefined` e isso **sobrescreve a waveform que a API
  calculou**. Esse trecho do Baileys só roda quando `ptt === true`, então atinge a
  mensagem de voz e nada mais. O desvio vale **só** para ela: imagem, vídeo, documento e
  áudio comum continuam no `sendMessage` de sempre. Quem relaya também precisa reemitir
  `messages.upsert` com tipo `append`, que é o que o `sendMessage` faria, senão a
  mensagem de voz seria a única que o resto do sistema não veria passar.
- **Quem decide o mime type do áudio são os BYTES, nunca a flag de quem chamou**
  (`resolveAudioDeclaration`, em `packages/whatsapp/src/audio/container.ts`).
  `asVoiceNote` com bytes que não são OGG/Opus **lança**, e não degrada: era exatamente
  essa combinação (flag pedindo voz, WebM no arquivo, mime anunciando OGG) que fazia o
  áudio chegar como indisponível no celular do cliente. Conhecimento sobre formato aceito
  mora aqui em `packages/whatsapp`, junto com o Baileys, e a API o consome pelas funções
  exportadas: nada fora do pacote precisa saber o que o WhatsApp aceita.
- `apps/api/src/services/instance-manager.ts` orquestra provider ⇄ banco ⇄ socket
  (registro de instância, sync de chats/grupos/contatos, fotos, reconexão com backoff,
  `resumeSessions` no boot).
- `apps/api/src/services/message-ingest.ts` é o pipeline idempotente: mensagem normalizada
  → conversa (upsert) → responsável padrão do departamento se estiver órfã → mensagem →
  mídia → preview → publicação em tempo real. É dele também o `applyEdit`, que **atualiza a
  mensagem original** achada por `(conversationId, externalMessageId)`, guarda o conteúdo
  ANTERIOR no histórico de versões (`metadata.versions`, via `appendMessageVersion` do
  shared) e refaz a prévia quando a editada é a última da conversa. Original desconhecida
  (anterior à conexão do número, ou nunca sincronizada) é ignorada com log
  `message_edit_target_missing` — sem registro novo e sem bolha de erro.
- **`ingest()` nunca lança.** Qualquer falha não recuperada nas etapas de dentro vira log
  `message_ingest_failed` com `instanceId`, `externalChatId`, `externalMessageId` e `type` —
  nunca conteúdo — e devolve `null`, em vez de subir até um `catch` genérico que só sabia o
  `instanceId`. Duas corridas conhecidas JÁ se recuperam sozinhas, sem log de incidente: duas
  mensagens do mesmo lote de `messages.upsert` (que roda cada mensagem com `void`, sem
  esperar a anterior) criando a MESMA conversa nova ao mesmo tempo, e duas chamadas
  concorrentes gravando o MESMO `externalMessageId` (ao vivo cruzando com o backfill de
  histórico, ver abaixo) — as duas colidem no índice único do Postgres (`P2002`), e quem
  perde a corrida busca a linha que a vencedora acabou de criar em vez de desistir da
  mensagem. Mídia que falha ao BAIXAR (já tinha retentativa) ou ao SALVAR no storage (disco
  cheio, permissão — não tinha) também não derruba a mensagem: grava sem `mediaUrl`, marcando
  `metadata.mediaDownloadFailed` (`@azvchat/shared`, `MEDIA_DOWNLOAD_FAILED_METADATA_KEY`)
  para a equipe achar depois o que ficou sem arquivo.
- **Backfill da janela de desconexão.** Mensagem que chega com a instância em
  `reconnecting`/`qr_required` não desaparece de vez: com `syncFullHistory: false`, o
  WhatsApp ainda manda as mensagens recentes perdidas no PRÓPRIO evento
  `messaging-history.set` (campo `messages`, ao lado de `chats`/`contacts`, que já eram
  lidos). `QrCodeWhatsAppProvider.handleHistoryMessages` processa esse lote pelo MESMO
  `handleIncomingMessage` do recebimento ao vivo — sequencial, e não `void` em paralelo,
  porque aqui o volume por rodada é maior — e quem deduplica é a ingestão de sempre, por
  `(conversationId, externalMessageId)`. Mensagem malformada no lote só pula ela mesma (log
  `history_message_failed`), nunca trava o resto. Como o histórico pode reentregar algo fora
  de ordem, `ingest()` **não regride** `lastMessageAt` nem reabre conversa concluída por uma
  mensagem mais ANTIGA que a última já conhecida — a guarda é `message.timestamp >=
  conversation.lastMessageAt`; mensagem ao vivo sempre chega mais nova, então o caminho
  comum nunca muda.
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
  `Card`, `Avatar`, `Modal`, `Tooltip`, `Spinner`, `EmptyState`, `MultiSelect`. **Reuse
  antes de criar componente novo.** `Tooltip` é só CSS (hover + `focus-within`), sem
  biblioteca.
- **`MultiSelect` é o único componente de seleção múltipla**, e todos os filtros da Inbox
  (atendimento, tipo, conexão, etiqueta, folha e regime) e do Dashboard (status,
  departamento, responsável e número) passam por ele. Aceita blocos com
  cabeçalho e um campo de busca que filtra os blocos ao mesmo tempo; fecha por clique fora
  e por `Esc`, nunca por `blur` (clicar numa caixa de seleção tira o foco do botão e
  fecharia a lista no primeiro clique). Sem biblioteca de select. Quatro implementações
  separadas divergiriam no teclado e no clique fora, e a equipe sentiria sem saber nomear.
  O rótulo fechado mostra "Contábil +2" e é cortado por CSS: marcar dez itens não pode
  empurrar a barra para fora da coluna.
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
- **Relatório por atendente** (`app/(app)/reports/page.tsx` + regra pura em
  `src/lib/report-cells.ts` + painel em `components/reports/slice-panel.tsx`): as três
  colunas de fila têm célula colorida, com a cor saindo de `CONVERSATION_STATUS_COLORS`
  (`@azvchat/shared`) e o tom acompanhando o volume relativo DENTRO da coluna. **Zero fica
  apagado, sem cor e sem clique** — colorir célula vazia pinta a tabela inteira e some com
  o sinal, e botão que não faz nada ensina a equipe a desconfiar dos que fazem. Concluídas
  tem forma própria (contorno, não preenchimento) porque é do PERÍODO e as outras três são
  de AGORA. Clicar numa célula com valor abre o painel lateral com as conversas daquele
  recorte; em tela estreita ele vira sobreposição (`lg:static` no `aside`). O total de cada
  coluna vai no cabeçalho ("ABERTO (35)") e soma a coluna inteira, incluindo as linhas de
  **Sem responsável** e **@todos**, que ficam no topo da tabela. A barra tem dois
  filtros em `MultiSelect` (departamento, com "Sem departamento", e conexão), que
  somam dentro de si e CRUZAM entre si e com a linha; eles valem para a tabela, os
  cards e o painel de uma vez, e trocá-los fecha o painel aberto. Não são
  persistidos de propósito: o período desta tela também não é, e persistir só
  metade do recorte faria a tela voltar num estado que ninguém escolheu.
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

### Catálogo de variáveis da resposta rápida

Fonte única em `packages/shared/src/quick-reply-variables.ts` — a tela de cadastro monta o
menu com ele, a API valida o texto com ele (`unknownQuickReplyVariables`, no Zod de
`POST|PATCH /quick-replies`) e o composer resolve a substituição com ele. Sintaxe:
**chaves duplas**, `{{empresa.cnpj}}` — não colide com a formatação do WhatsApp
(`*_~` e crase) nem com os marcadores de colchete que a equipe já escreve à mão.

| Grupo | Variáveis |
| --- | --- |
| Empresa (do Azevedo-OS) | `empresa.razao_social`, `empresa.nome_fantasia`, `empresa.numero`, `empresa.cnpj`, `empresa.situacao`, `empresa.regime_tributario`, `empresa.folha_pagamento` |
| Conversa | `conversa.nome` (`customTitle` vence `title`), `conversa.telefone`, `conversa.departamento`, `conversa.responsavel` |
| Atendente | `atendente.primeiro_nome` |
| Data (calculadas) | `data.hoje` (DD/MM/AAAA), `data.competencia` (MM/AAAA do mês corrente), `data.competencia_anterior` |

Variável nova entra no catálogo com nome técnico, rótulo, descrição, grupo, exemplo (para
a pré-visualização do cadastro) e a função que resolve — os três consumidores passam a
conhecê-la sozinhos. **Dado financeiro nunca entra**: ver a seção 13.

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

**Tratar um pacote de protocolo novo do WhatsApp** (editar, apagar, o que vier depois)
1. `packages/whatsapp/src/qrcode/normalize.ts`: ensinar `extractProtocolAction` a
   reconhecê-lo, DESEMBRULHANDO os invólucros — nada fora do pacote importa Baileys, nem
   para entender o formato;
2. emitir o evento normalizado nos DOIS pontos de recepção do provider (`messages.upsert`
   e `messages.update`), porque a forma do pacote varia com a versão do aplicativo;
3. o consumidor atualiza a mensagem existente em `message-ingest.ts` — **pacote de
   protocolo nunca vira `Message` nova** — e devolve null quando não há o que fazer;
4. publicar com `RealtimeEvents.MessageUpdated` e `conversationAudience()`, sem evento novo;
5. teste em `packages/whatsapp/test/protocol-action.test.ts` (a forma do pacote) e em
   `apps/api/test/message-edit-inbound.test.ts` (o efeito no banco).

**Novo evento de tempo real**
1. nome + payload em `packages/shared/src/realtime.ts`;
2. emissão com `conversationAudience()` ou `instanceAudience()`;
3. listener no `socket-context` / componente do frontend;
4. conferir que o evento não vaza para quem não tem acesso à conversa.

**Nova tela**
1. `apps/web/src/app/(app)/<rota>/page.tsx`;
2. item no `NAV` do `layout.tsx` com `minRole` **igual** ao `requireRole` da API;
3. montar com o kit de UI; textos em português.

**Nova ação configurável (o caminho normal hoje)**
1. entrada em `PERMISSION_ACTIONS` (`packages/shared/src/permissions.ts`) com rótulo,
   explicação, área e o padrão por papel — a tela de Permissões passa a mostrá-la sozinha;
2. a rota (ou o campo) passa a decidir por `requirePermission(deps, "<chave>")` ou
   `loadPermissions(...).assert("<chave>")`;
3. a tela esconde o controle pelo mesmo `can("<chave>")` — esconder e recusar sempre juntos;
4. caso em `apps/api/test/permissions.test.ts` (padrão de fábrica) e, se a rota for nova,
   em `permissions-routes.test.ts`.
Nada disso encosta em `access.ts`: **permissão é ação, visibilidade é alcance**.

**Mudança de VISIBILIDADE** (quem enxerga qual conversa)
Mexe em `access.ts` e nos vínculos de número/departamento: atualizar as salas do socket e os
testes de `apps/api/test/access.test.ts`. **Não** existe chave de permissão para isso, e criar
uma seria entender o desenho errado.

**Mudança na hierarquia de papéis** (o que continua fixo em `admin`)
Atualizar `enums.ts`, os `requireRole("admin")` das rotas, o `NAV` do frontend e os testes —
sempre juntos.

---

## 13. Armadilhas conhecidas

- **PERMISSÃO É AÇÃO, VISIBILIDADE É ALCANCE — e os dois nunca se misturam.** O menu de
  Permissões (`packages/shared/src/permissions.ts` + `apps/api/src/lib/permissions.ts`) decide
  o que cada perfil pode FAZER. Ele **não** decide, e não pode passar a decidir, QUAIS
  conversas alguém enxerga: isso continua saindo inteiro de `lib/access.ts`, dos vínculos de
  número (`UserWhatsAppInstance`) e de departamento (`UserDepartment`). Uma chave ligada dá
  poder sobre o que a pessoa **já** enxerga; nenhuma chave amplia o recorte. Por isso não
  existe (e não deve nascer) chave do tipo "ver todas as conversas" ou "ver conversa de outro
  departamento" — a permissão entra **por cima** de `conversationScope`, nunca no lugar dele.
  `apps/api/test/access.test.ts` tranca a invariante: com o catálogo inteiro ligado, o filtro
  de conversa de um atendente sai idêntico ao de quem não tem chave nenhuma.
- **Nenhum `if` de papel dentro de handler.** Toda decisão de ação passa por
  `requirePermission()` (preHandler) ou `loadPermissions().assert()` (recusa de CAMPO, quando
  a rota faz mais de uma coisa — é o caso de `isBackup` no PATCH do número, de `departmentId`
  no corpo da atribuição, da nota de terceiro e do agendamento de outra pessoa). `requireRole`
  sobrou **só** com `"admin"`, no que é fixo por decisão. `apps/api/test/permissions.test.ts`
  varre as rotas e reprova comparação de papel solta, `requireRole` fora de admin e chave do
  catálogo que nenhuma rota consulta.
- **Esconder e recusar andam sempre juntos.** A tela decide pelo `can()` do `auth-context`,
  alimentado por `user.permissions` de `/auth/me` — **nunca** deduzindo pelo papel. Deduzir faz
  a configuração virar mentira visual: o dono desliga a chave, o botão continua lá e só dá
  erro; ou liga a chave e o campo não volta. Mudança de permissão vale **na ação seguinte**
  (cache de 5s com invalidação na gravação), sem relogar e sem reiniciar o container; se a aba
  antiga ainda mostrar um botão que a API passou a recusar, o 403 vem com
  `permission_denied` e a mensagem **nomeia a chave**, em vez de um "acesso negado" genérico.
- **Vincular e trocar vínculo do Azevedo-OS são DUAS chaves**, não uma. Preencher empresa em
  conversa que está sem empresa é rotina de classificação (padrão sim/sim); trocar ou desfazer
  vínculo que outra pessoa já fez é mexer em classificação alheia, e errar anexa a conversa ao
  cliente errado (padrão não/sim). Uma chave só obrigaria o escritório a escolher entre travar
  a rotina e liberar o estrago. Quem decide continua sendo `planReferenceUpdate`, que olha o
  ESTADO da conversa antes das chaves.
- **`user.deactivate` abre UM CAMPO, não a tela de cadastro.** A rota que atende o campo
  `status` é a mesma que troca papel e redefine senha, então a checagem é de CAMPO: quem não é
  admin precisa da chave, o corpo tem de trazer `status` e mais nada, e o alvo não pode ser
  administrador. Sem a conferência do corpo, ligar a chave entregaria o cadastro inteiro —
  inclusive `role: "admin"` para si mesmo; sem a trava do alvo, um supervisor desligaria a
  administração toda até sobrar o último (o único que a trava do último admin barra). O item
  "Usuários" do menu passa a aparecer para quem tem a chave, mas `/users/new` e `/users/:id`
  seguem exclusivos do admin (`adminOnlySubRoutes` no `NAV`), e `GET /users` só entrega a
  agenda interna a quem não é admin — com os inativos junto, senão não haveria como reativar
  ninguém. **A chave dá uma AÇÃO, nunca um recorte de dados a mais.**
- **Voltar uma chave ao padrão APAGA a linha**, em vez de gravar o mesmo valor. Guardar o
  padrão como linha congelaria o padrão de hoje para aquela organização, e mudá-lo no código
  deixaria de valer para ela.
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
- `title` vs `customTitle`: o **sync do WhatsApp sobrescreve o primeiro e nunca toca no
  segundo**. Na conversa INDIVIDUAL o título efetivo tem três degraus:
  `customTitle` (apelido desta conversa) → `PersonProfile.customName` (nome da pessoa,
  casado por `externalChatId` e, quando o endereçamento difere, pela ponte de telefone) →
  `title`. Quem resolve é `resolveConversationPersonName(s)` (`lib/person-profile.ts`),
  chamado em TODO ponto que serializa conversa para lista ou evento — um ponto que
  publique o DTO sem isso regride o nome corrigido na tela dos outros.
- **EDITAR PARTICIPANTE EDITA A PESSOA, não a linha do grupo.** O lápis
  (`PATCH /group-participants/:id`) grava em `PersonProfile` e vale para todos os grupos
  da pessoa, todas as telas e a conversa individual, de uma vez. A tela avisa antes de
  salvar com a contagem (`groupCount` no DTO do participante), a auditoria registra
  `affectedGroups`, e o `group:participants` sai UM POR CONVERSA de grupo afetada, cada um
  para a própria `conversationAudience` — nunca para a organização inteira. Não existe (e
  não deve nascer) exceção "só neste grupo"; o registro da pessoa sobrevive à saída dela
  de todos os grupos, de propósito. Regra de precedência: **linha de perfil presente vale
  inteira, mesmo nula** — voltar a ler o legado do grupo quando o perfil diz "sem nome"
  ressuscitaria valor apagado.
- **Nome do participante é decidido no backend**, em `serializeGroupParticipant`
  (`lib/serialize.ts`), nunca no componente — a tela recebe `name` já pronto (nunca nulo)
  mais os campos crus que a edição precisa. A cadeia, do mais forte para o mais fraco:
  1. o nome da equipe — `PersonProfile.customName` quando o perfil existe (mesmo nulo:
     perfil presente vale inteiro), senão o legado `customName` da linha do grupo. Vence
     porque é a única fonte que a casa controla e que o sync não sobrescreve;
  2. nome do `Contact` do número conectado — escolha de alguém do escritório, por isso vem
     antes do apelido que a pessoa pôs em si mesma;
  3. `name` do participante — o pushName, gravado na ingestão quando a pessoa escreve, mais
     o pushName da última mensagem (`sources.pushName`), que cobre quem já tinha escrito
     antes dessa gravação existir, sem backfill;
  4. telefone formatado (`formatPhone`, que mora em `@azvchat/shared` justamente porque o
     backend decide o nome com ela);
  5. `PARTICIPANT_WITHOUT_NAME_LABEL`. **Nunca o LID cru** — ele é identificador interno e
     exibi-lo faria a equipe tratá-lo como telefone.

  As fontes extras (`Contact`, pushName, `PersonProfile` e `groupCount`) são resolvidas
  **em lote**, um SELECT cada para o grupo inteiro — grupo grande não pode virar consulta
  por participante. `nameIsPhone` avisa a tela para não repetir o telefone na segunda
  linha, e `hasKnownName` diz se existe nome de verdade. A ingestão grava o pushName em
  `name` e **nunca** em `customName` nem em `PersonProfile`.
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
- **A VARIÁVEL DA RESPOSTA RÁPIDA É RESOLVIDA NA INSERÇÃO, NUNCA NO ENVIO.** Quando a
  atendente digita o `/atalho`, o texto já cai no composer com a razão social, o CNPJ e o
  resto preenchidos — ela LÊ o que o cliente vai receber e corrige antes do Enter.
  Resolvendo no envio, a substituição aconteceria depois do último ponto em que alguém
  poderia revisar, e nome errado ou competência trocada só apareceriam com a mensagem já
  no celular do cliente, onde não se desfaz. O custo aceito é o texto envelhecer entre
  inserir e enviar. Consequências para qualquer mexida aqui: (1) a resolução usa a empresa
  que a tela JÁ tem em mãos (`useConversationCompany`, o mesmo carregamento que alimenta o
  card do painel de contexto) — nada de consulta nova ao Azevedo-OS por inserção, senão a
  resposta rápida passa a esperar a rede; (2) variável que não resolveu **não vira vazio**
  (buraco na frase que ninguém vê) **nem continua como `{{chave}}`** (o nome técnico
  chegaria ao cliente): vira `[Rótulo]`, destacado numa faixa âmbar embaixo do composer;
  (3) sobrando `[Rótulo]` na hora do envio, a tela **avisa e deixa seguir** — o marcador
  pode estar ali de propósito, e travar o envio por causa de um colchete seria pior; (4) o
  aviso é conferido contra o TEXTO do composer, então preencher à mão o apaga na mesma
  tecla. Sem empresa vinculada, com campo em branco no cadastro e com o portal fora do ar,
  o comportamento é o mesmo — muda só a linha extra do aviso, que nomeia o portal mudo. A
  regra pura mora em `@azvchat/shared` e a cola da tela em
  `components/inbox/quick-reply-variables.ts`, fora do `inbox-shell.tsx`.
- **NENHUM DADO FINANCEIRO VIRA VARIÁVEL.** Honorário, inadimplência e valor de contrato
  existem no Azevedo-OS, e a integração até conseguiria trazê-los. Lá esses campos são do
  Financeiro e da Diretoria; uma variável aqui os entregaria a qualquer atendente com um
  atalho de duas letras — seria a porta dos fundos daquela regra, aberta de dentro do
  AZVCHAT. Não estão no catálogo, e há teste que fica vermelho se alguém os acrescentar.
  Quem precisar do dado pede a liberação lá, não uma variável aqui.
- **Marcador escrito à mão NÃO é convertido sozinho.** Texto antigo com "[nome do cliente]"
  continua exatamente como está: o trecho entre colchetes pode ser um recado de verdade, e
  trocá-lo na cara dura mudaria a mensagem que a equipe escreveu. A tela de cadastro aponta
  o marcador e oferece a variável correspondente; quem decide é quem cadastra.
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
  departamento e responsável — os quatro em MULTISSELEÇÃO, somando dentro e cruzando entre
  si — entram num `AND` junto com `conversationScope`, então pedir um número que o usuário
  não enxerga devolve vazio em vez de vazar. `departmentId` aceita `none` ("sem
  departamento") e `assignedUserId` aceita `none` e `all_users`, os dois separados de
  propósito. Os filtros valem para a **tela inteira** — inclusive o card de atraso e o de
  arquivadas, que continuam ignorando só o período (o de infraestrutura conta números, e
  respeita só o filtro de número: ver a nota da seção 13). O filtro de `status` é o único
  que mexe no fluxo por status: com ele as colunas não marcadas ficam em zero, porque a
  pergunta passou a ser "só estes status" — e marcar só `resolved` zera o atraso por
  construção, já que lá o recorte convive com `status != resolved`.
- **Os filtros do dashboard são guardados por usuário, em chave PRÓPRIA**
  (`zapdesk.dashboard-filters.<userId>`, em `web/src/lib/dashboard-filters.ts`), com a
  mesma mecânica da Inbox e sem se misturar com ela: filtrar as Conversas não pode mexer no
  Dashboard, porque as duas telas respondem perguntas diferentes. O formato antigo, de um
  valor por filtro, é CONVERTIDO em lista de um item (e as chaves velhas, sem usuário, são
  lidas uma vez e apagadas). Item que deixou de existir é podado pela TELA, em silêncio,
  antes de virar consulta — a rota recusa id desconhecido com 400, e esse erro não pode
  aparecer para quem só voltou à tela depois de um cadastro ter mudado.
- **O período do dashboard tem UM controle só, e continua de valor único.** Ele já teve
  dois seletores (um no topo e um na barra) ligados ao mesmo estado: nunca discordaram, mas
  dois campos dizendo "Hoje" na mesma tela fazem quem olha procurar a diferença entre eles.
  Ficou o da barra, que é onde os campos "De" e "Até" do personalizado aparecem. E ele não
  vira caixa de seleção: período é intervalo, não conjunto — "Hoje" mais "30 dias" ou é o
  intervalo maior, ou é contradição.
- **O dashboard se recarrega sozinho a cada minuto** (`AUTO_REFRESH_MS` na página), e o
  rodapé promete isso a quem está olhando. É `setInterval` chamando a mesma rota, e **não**
  evento de socket: a tela agrega dezenas de milhares de mensagens, então empurrar cada
  mensagem nova custaria mais do que uma consulta por minuto. A recarga é silenciosa — os
  números antigos ficam na tela até os novos chegarem, sem esqueleto piscando a cada volta.
- **Os cards de status do dashboard abrem a Inbox pela URL** (`/inbox?status=...`), levando
  também `departmentId`/`instanceId` — os três agora com o parâmetro REPETIDO, porque o
  Dashboard virou multisseleção e ler só o primeiro valor levaria um recorte menor do que o
  número que a pessoa acabou de ler. Quem semeia o filtro é a própria Inbox
  (`inbox-shell.tsx`), e só em estado que a tela mostra: os seletores de número e
  departamento existem apenas para supervisor e admin, então parâmetro forjado na URL por um
  `agent` é ignorado — filtro invisível deixaria a lista curta sem explicação. O
  **responsável não vai junto**, e não por falta de controle na Inbox: lá ele SOMA com o
  departamento, então mandá-lo viraria "o Contábil MAIS a fulana", o contrário do
  cruzamento que o número do card representa. O período também não vai (a Inbox lista por
  status, não por atividade), e a tela avisa que a lista pode vir maior que o card.
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
- **Transferir para quem não tem o NÚMERO faz a conversa sumir do radar de todos.** É a
  falha silenciosa que `conversationAssigneeWhere` (`lib/access.ts`) existe para impedir:
  a atribuição grava sem erro nenhum, a conversa sai da fila de quem estava livre e some
  da tela de todo mundo — inclusive da de quem transferiu —, e a equipe só descobre quando
  o cliente cobra a resposta. Por isso as duas condições valem JUNTAS: departamento **da
  conversa** e número. Departamento sozinho parece bastar e não basta, porque a
  visibilidade tem o número como condição absoluta. Consequências para qualquer mexida
  aqui: (1) a lista do seletor sai da API (`GET /conversations/:id/assignees`), nunca de
  filtro montado no componente — duas réguas saem de sincronia; (2) a rota **valida sempre**,
  porque lista filtrada na tela não é controle de acesso; (3) supervisor e admin escapam da
  regra, mas nunca em silêncio: a tela confirma nomeando quem não vai enxergar a conversa;
  (4) conversa que mudou de departamento depois de atribuída **não** é desatribuída sozinha
  — a regra vale para transferências novas, e tirar o atendimento de quem já está
  conversando com o cliente seria pior que a inconsistência.
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
- **OU DENTRO do filtro, E ENTRE filtros. É a regra que alguém vai inverter.** Todo filtro
  da Inbox aceita vários valores: os marcados dentro de um filtro SOMAM, e filtros
  diferentes CRUZAM. Marcar Contábil e Fiscal mostra os dois; marcar Contábil e o status
  "Aberto" mostra só as abertas do Contábil; filtro sem nada marcado é "todos", nunca
  "nenhum". Invertida, a Inbox devolve lista vazia em quase toda marcação múltipla (uma
  conversa não está em dois departamentos ao mesmo tempo), e o defeito parece "o filtro não
  acha nada" em vez de "a regra está trocada". A regra mora em três lugares que precisam
  concordar: `shared/inbox-filters.ts` (o contrato), o `AND` de `GET /conversations` (cada
  filtro é UM item da lista, e dentro dele o `in` ou o `OR`) e `web/lib/inbox-filters.ts`
  (o espelho que o tempo real usa). Há teste que fica vermelho ao trocar o `OR` por `AND`.
- **NO DASHBOARD, DEPARTAMENTO E RESPONSÁVEL SÃO DOIS FILTROS, E CRUZAM.** É o
  contrário da Inbox, de propósito, e vai parecer inconsistência para quem olhar as
  duas telas de longe. Na Inbox eles viraram um filtro só que SOMA porque lá a
  pergunta é de triagem e o resultado é uma lista de linhas que a pessoa varre; no
  Dashboard a pergunta é de análise e o resultado é um NÚMERO, e somar recortes
  diferentes dentro do mesmo total produz número sem significado ("as conversas do CS
  mais as da Tatiana" não responde nada, e ainda conta duas vezes o trabalho dela
  dentro do CS). Cruzando, "CS + Tatiana" é "os números dela dentro do CS", que é o
  que a supervisão pergunta. Consequência aceita: marcar um departamento junto de
  alguém que não atende nele devolve ZERO — está certo, e por isso a tela troca o
  texto do aviso de recorte vazio quando os dois estão marcados. A regra e o porquê
  moram em `packages/shared/src/dashboard-filters.ts`, o `AND` está em
  `dashboardFilterConditions` (`modules/dashboard/routes.ts`) e há teste que fica
  vermelho se os dois virarem um `OR`. **Não "uniformize" as duas telas.**
- **DEPARTAMENTO INTERNO NÃO É ARQUIVAMENTO, e confundir os dois é o erro fácil aqui.**
  Arquivar faz DUAS coisas juntas: some da lista (sem badge de não lidas, sem som, sem
  piscar o título) e sai dos números. `Department.isInternal` faz **só a segunda**. A
  equipe usa os grupos internos o dia inteiro e precisa ser avisada de mensagem neles, então
  `lib/conversation-reads.ts`, `message-sound.tsx` e `unread-title.tsx` **não sabem que isto
  existe, e não devem passar a saber** — "uniformizar" com o arquivamento faria os grupos
  internos sumirem da tela da equipe. Consequências para qualquer mexida aqui: (1) o recorte
  sai inteiro de `lib/internal-department.ts` e é **acrescentado** ao `AND` que já carrega
  `conversationScope`, nunca posto no lugar dele; (2) a conversa **sem departamento continua
  contando**, e por isso o ramo explícito do `null` — em SQL, `departmentId NOT IN (...)`
  descarta a coluna nula, e sumiria justamente com a conversa que o número não classificou;
  (3) a exclusão do atraso mora **dentro** de `scanOverdueConversations`, e não em quem
  chama, senão o card e a lista dele divergiriam; (4) o painel do relatório pede
  `excludeInternal=true` porque a célula já não conta o interno. Nada disso é chave de
  permissão nem recorte de visibilidade.
- **A régua do atraso é UMA SÓ, em `apps/api/src/lib/overdue.ts`.** O card
  "Atrasados agora" mostra o número e `GET /conversations?overdue=true` mostra quais
  são — as duas pontas saem da mesma função, e o card é um link para ela. Duas contas
  separadas fariam o clique abrir uma lista que não fecha com o número, e é esse tipo
  de divergência que faz a equipe parar de confiar no painel. Aproximar por "as não
  resolvidas" seria pior ainda: lista muito maior, e ordenada por última mensagem
  **desc**, ou seja, com as mais atrasadas no fundo. Três consequências: o recorte sai
  POR CIMA do `where` já escopado por `access.ts` (a função só estreita, nunca traz
  conversa de volta); o casamento no cliente (`inbox-filters.ts`) **não avalia** o
  atraso — o DTO não carrega a direção da última mensagem nem o expediente —, então
  `hasServerOnlyFilter` impede a INSERÇÃO de linha nova enquanto o filtro está ligado,
  do mesmo jeito que o recorte por empresa; e o card só vira link quando há atraso,
  porque clique que abre lista vazia não responde nada.
- **O card de infraestrutura do Dashboard conta NÚMEROS, não conversas.** Ele respeita
  o filtro de número (e antes nem isso: o escopo de acesso era espalhado por cima do
  filtro, os dois escreviam em `id`, e o card ignorava a escolha de quem não é admin),
  mas **não** é recortado por departamento nem por responsável: os dois são atributos
  da conversa, e restringir a lista de conexões por eles esconderia justamente o número
  que parou de receber conversa — por estar fora do ar —, que é o contrário do que o
  card serve. O de atraso e o de arquivadas, esses sim, contam conversa e respeitam
  todos os filtros; o que os três ignoram junto é só o PERÍODO, porque são estado de
  agora.
- **Departamento e responsável são UM filtro só, e somam** (na INBOX — ver a nota do
  Dashboard logo acima, onde a decisão é a oposta). O caso normal do escritório é
  "quero ver o Contábil inteiro MAIS a fulana", e ela costuma ser de outro departamento:
  com dois filtros separados isso cruzaria por E e voltaria vazio. Juntos num `assignment`
  de tokens (`none`, `all_users`, `no_department`, `dept:<id>`, `user:<id>`), tudo que está
  marcado entra num `OR` só — é o comportamento do programa antigo que a equipe usava, e a
  diferença entre somar e cruzar é o motivo de eles terem virado um. `OR` sobre a mesma
  tabela **não repete linha**: a conversa do Contábil atribuída à fulana casa com dois
  ramos e aparece uma vez só, sem `distinct`. Quem monta é
  `assignmentFilterWhere` (`lib/conversation-assignment.ts`), a mesma fonte única que já
  respondia por atribuição.
- **Id de filtro que não existe é RECUSADO, não ignorado** (`lib/conversation-filters.ts`).
  Ignorar em silêncio devolveria uma lista plausível recortada por um critério diferente do
  que a pessoa marcou, e ela leria a tela achando ver "Contábil mais Fiscal" com o Fiscal
  descartado. Isso não briga com a poda silenciosa da tela: lá o item extinto sai do estado
  guardado ANTES de virar consulta, justamente para o atendente nunca ver esse 400. A
  mensagem diz qual filtro tem o problema, nunca o id.
- **O formato antigo dos filtros guardados, de valor único, é CONVERTIDO e não descartado**
  (`readLegacy`, em `web/lib/inbox-filters.ts`). Cada valor vira lista de um item e o antigo
  seletor `quick` é traduzido para o campo que passou a responder por ele. Só `mine` abre a
  lista inteira: a leitura do storage não sabe quem está logado, e abrir a lista de outra
  pessoa seria pior. É código de transição e pode sair quando ninguém mais tiver o formato
  velho no navegador.
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
- **A célula do relatório e o painel dela saem do MESMO arquivo**
  (`apps/api/src/lib/report-slice.ts`). A contagem vem de um `groupBy` e a lista vem de
  `GET /conversations`; se cada lado montar o recorte por conta própria, a célula diz "4"
  e o painel lista 3 — o defeito que já custou a confiança da equipe nos cards do
  Dashboard. O painel **não tem rota de listagem própria** de propósito: duas listagens de
  conversa divergiriam no escopo, no serializer ou na paginação, e a que quase ninguém abre
  seria a que passaria a mostrar demais. `apps/api/test/report-panel-consistency.test.ts`
  roda as duas rotas sobre a mesma base e compara célula a célula.
- **Existem DUAS formas de filtrar por departamento em `GET /conversations`, e
  elas fazem coisas opostas.** O `dept:<uuid>` dentro de `assignment` é o da
  TRIAGEM: soma com o responsável, porque na Inbox a pergunta é "o Contábil inteiro
  MAIS a fulana". O parâmetro `departmentId` é o da ANÁLISE: cruza, porque no
  relatório a pergunta é "os números dela DENTRO do Contábil", e o resultado é um
  número, não uma lista. É a mesma divergência que o Dashboard já carrega, pelo
  mesmo motivo. A Inbox **nunca** manda `departmentId`; se um dia mandar, a
  multisseleção dela passa a devolver vazio em quase toda marcação múltipla, e o
  defeito parece "o filtro não acha nada" em vez de "a regra está trocada". Quem
  monta os dois é fonte única: `assignmentFilterWhere` (soma) e
  `reportFilterConditions` (cruza), e há teste fixando que continuam diferentes.
- **`archived=false` na URL significa ARQUIVADAS.** O parâmetro é lido com
  `z.coerce.boolean()`, e `Boolean("false")` é `true` — quem quer as não arquivadas
  **omite** o parâmetro, que já é o padrão. Mandá-lo achando que desliga o filtro devolve
  exatamente o conjunto oposto, e a lista parece só "estranha", nunca errada.
- **A coluna "Concluídas" mede o EVENTO, não o dono nem o status.** Ela conta as conversas
  com um `resolved` no `ConversationAssignmentHistory` dentro do período, então o painel
  dela **não** filtra por `status` nem pelo responsável de agora: a conversa concluída
  ontem, reaberta hoje e já na mão de outra pessoa continua sendo trabalho fechado por quem
  fechou. Filtrar por responsável ali faria o painel listar menos do que a célula mostra.
- **O NAVEGADOR GRAVA WEBM E O WHATSAPP ESPERA OGG/OPUS.** `new MediaRecorder(stream)`
  sem `mimeType` (que é o caso do `audio-recorder.tsx`) entrega WebM/Opus no Chrome e no
  Edge, MP4/AAC no Safari, e só no Firefox entrega OGG/Opus. **O WhatsApp não decodifica
  WebM**: o áudio chega no celular do cliente como indisponível, pedindo para reenviar, e
  o pior é que **este lado registra sucesso** (a mensagem sai, o status vira `sent`, o
  atendente não vê nada) e o arquivo **toca dentro do AZVCHAT**, porque o navegador
  reproduz WebM sem esforço. O defeito só aparece do outro lado, dias depois, pelo cliente
  reclamando. Consequências para qualquer mexida aqui: (1) a conversão é no SERVIDOR, uma
  só, e não no navegador, senão o resultado passa a variar por máquina e por versão;
  (2) **nunca faça a conversão opcional** com fallback silencioso para o arquivo original,
  que foi a forma anterior desta falha; (3) o mime type declarado ao WhatsApp sai dos
  bytes, e `ptt` só liga com OGG/Opus de verdade; (4) a **duração** vai junto, senão parte
  dos clientes desenha a mensagem de voz quebrada mesmo com o container certo; (5) o
  arquivo guardado é o CONVERTIDO (encaminhar não converte de novo), e o original fica em
  `Message.metadata.originalMediaUrl` para reprocessar. O ffmpeg é dependência da imagem
  da API (`apps/api/Dockerfile`) e do CI, e os testes de conversão se **pulam sozinhos**
  onde ele não existe.
- **MANDE O MESMO ARQUIVO PELO CLIPE E PELO MICROFONE. É o teste que separa tudo.** Foi
  ele que isolou este defeito depois de várias hipóteses erradas: o arquivo anexado tocava
  no celular e a gravação não, com container, codec, mime type, duração, upload e sessão
  iguais. O que sobrou foi a linha de tempo, e era isso. **Cuidado com a leitura fácil**:
  na época pareceu que a culpada era a flag `ptt`, porque ela também diferia entre os dois
  caminhos, e a mensagem de voz chegou a ser desligada por causa disso. Com o atraso de
  codec zerado, o `ptt` voltou a funcionar sem tocar em mais nada. A lição é a do teste,
  não a da flag: quando dois caminhos divergem, iguale-os em UMA variável por vez, senão a
  primeira diferença que aparecer leva a culpa.
- **Arquivo de áudio ANEXADO do computador continua arquivo, e não vira mensagem de voz.**
  Quem clicou no clipe escolheu um arquivo; transformar um mp3 de dez minutos em áudio de
  voz mudaria o que a pessoa quis mandar. Ele só troca de container quando o WhatsApp não
  sabe tocar o que veio (WAV, WebM, FLAC): mp3, m4a, AMR e OGG/Opus seguem byte a byte,
  porque recodificar o que já funciona só perde qualidade. Mesma regra na mídia da
  resposta rápida, normalizada **uma vez no cadastro** em vez de a cada envio.
- Ingestão é idempotente por `(conversationId, externalMessageId)` — não crie caminho
  paralelo de inserção de mensagem. E **conteúdo que não dá para exibir não vira linha**:
  `isDisplayableContent` (`qrcode/normalize.ts`) barra o que cai no fallback `other` sem
  texto e sem arquivo, com log `message_without_content_skipped`. É a trava final contra o
  próximo formato que o WhatsApp inventar — não dá para prever qual será, dá para garantir
  que ele não suje a conversa com "Mídia indisponível".
- **"MÍDIA INDISPONÍVEL" NA TELA NÃO SIGNIFICA QUE O ARQUIVO SUMIU DO WHATSAPP** — o cliente
  seguia vendo o PDF/imagem no celular dele o tempo todo, só o AZVCHAT ficava cego. O
  download da mídia (`message.media.download()`, com `reuploadRequest` do Baileys por
  baixo) pode falhar de forma TRANSITÓRIA — um tropeço de rede, ou o reupload chegando cedo
  demais, antes do WhatsApp acabar de disponibilizar o arquivo — e sem retentativa uma
  falha na primeira tentativa virava "Mídia indisponível" PARA SEMPRE: a edição de legenda
  que o cliente faz depois (`applyEdit`) só atualiza texto, nunca baixa mídia de novo, então
  não havia segunda chance. `downloadMediaWithRetry` (`message-ingest.ts`) tenta até
  `MEDIA_DOWNLOAD_MAX_ATTEMPTS` (3) vezes, com espera crescente entre elas, antes de desistir
  e gravar `mediaUrl: null` — só aí sai o log `media_download_failed`, agora com `attempts`.
  Falha nas três tentativas continua sem derrubar a ingestão (a mensagem entra sem mídia, e
  o texto/legenda não se perde), e não existe hoje um caminho de retentativa MAIS TARDE
  (fila de mídia é item da seção 14) — ela some de vez se as três tentativas esgotarem.
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
- **Chamada recebida por LID pode não ter telefone — e isso é esperado.** O aviso de
  chamada mostra o nome resolvido e o telefone só quando alguma fonte o conhece de
  verdade (JID `@s.whatsapp.net`, `Contact` ou `GroupParticipant`); chamada de um `@lid`
  desconhecido chega com `callerPhone` nulo e a tela mostra "Contato não identificado",
  sem linha de número. Exibir os dígitos do LID como telefone faria alguém tentar ligar
  de volta para um número que não existe. O evento de chamada do Baileys também traz o
  JID **com sufixo de aparelho** ("...:51@lid") — o provider o remove
  (`stripDeviceSuffix`, em `normalize.ts`) antes de emitir, senão a chamada não casaria
  com contato nem conversa e criaria conversa duplicada.
- **EDIÇÃO CHEGA COMO PACOTE DE PROTOCOLO, E NUNCA PODE VIRAR MENSAGEM NOVA.** Quando o
  cliente edita no celular, o WhatsApp não manda uma mensagem: manda um `protocolMessage`
  apontando para a original, quase sempre embrulhado em `editedMessage`. Lido como
  mensagem, ele escapa do teste de protocolo, cai no classificador de conteúdo e vira uma
  linha de tipo `other` sem texto e sem mídia — a bolha **"Mídia indisponível"** — enquanto
  a original segue exibindo o texto ANTIGO. **O defeito não é visual**: a atendente
  continua lendo o valor, o CNPJ ou a competência que o cliente já corrigiu, e ninguém
  percebe, porque nada fica vermelho. Consequências para qualquer mexida aqui: (1) o
  reconhecimento DESEMBRULHA antes de testar (`extractProtocolAction`), e o `return` depois
  de um pacote de protocolo é incondicional — mesmo sem entender o que ele pede, seguir
  daqui cria lixo no histórico; (2) a edição é `update` da linha achada por
  `(conversationId, externalMessageId)`, jamais `create`; (3) a mesma edição chega pelos
  dois canais do Baileys, então quem aplica compara o conteúdo antes de gravar — igual ao
  que já está lá é no-op, e é isso que impede versão duplicada; (4) **apagar é o mesmo
  caminho** e quebra junto se um dos dois for mexido sozinho.
- **O resumo da mensagem citada (reply) mora em `Message.metadata.quoted`, congelado na
  gravação.** A referência (`Message.quotedMessageId`, id externo da original) sozinha só
  desenha o bloco quando a original está no banco — e resposta a mensagem anterior à
  conexão do número chegava sem citação nenhuma, descartada em silêncio. O resumo (id
  local quando conhecido, autor, trecho, tipo) é gravado pela ingestão (a partir do
  `contextInfo.quotedMessage` do payload) e pelo envio (a partir da original), e
  `serializeMessage` cai nele quando ninguém passou a leitura ao vivo — era a falta desse
  fallback que fazia a resposta RECÉM-ENVIADA aparecer sem o bloco (a resposta do POST e
  o `message:new` serializam sem `loadQuotedPreviews`), mesmo com a citação chegando
  certinha no celular do cliente. A leitura ao vivo continua preferida quando existe
  (nome corrigido pela equipe, id para o clique navegar — `GET .../messages/around`
  aceita `messageId` além de `at`). Fonte única de leitura/escrita e dos rótulos por tipo
  ("🎤 Áudio" no lugar de bloco vazio): `packages/shared/src/message-quote.ts`
  (`readQuotedSnapshot` / `withQuotedSnapshot` / `quotedSenderLabel` /
  `quotedPreviewText`). **Citação nunca é descartada em silêncio**: sem original no
  banco o bloco aparece do mesmo jeito, só sem navegação.
- **O histórico de versões mora em `Message.metadata`, e guarda o conteúdo ANTERIOR.** Não
  há coluna nova: a maioria das mensagens nunca é editada, e o `metadata` já viaja inteiro
  no DTO e no `message:updated` — o histórico chegou à tela sem ampliar contrato de tempo
  real nenhum. Quem lê e escreve é fonte única em `packages/shared/src/message-edit.ts`
  (`readMessageVersions` / `appendMessageVersion`), e o `appendMessageVersion` PRESERVA o
  resto do objeto: as marcações do "@" moram no mesmo lugar e sumiriam num spread
  descuidado. Vale para os dois lados — edição do cliente e `PATCH /messages/:id` da equipe.
- **A janela de edição é do WhatsApp, e vale nos dois lados.** Só dá para editar nos
  primeiros `MESSAGE_EDIT_WINDOW_MINUTES` (15) minutos, e só tipo com texto —
  `EDITABLE_MESSAGE_TYPES` (texto, imagem, vídeo, documento; áudio e figurinha não têm
  legenda). A regra mora em `packages/shared/src/message-edit.ts` porque a tela decide se
  mostra o botão e a API decide se aceita: sem a conferência do lado da API, o servidor do
  WhatsApp recusaria a edição e nós gravaríamos o texto novo assim mesmo — a Inbox passaria
  a mostrar ao atendente uma frase que o cliente nunca recebeu, e ninguém perceberia.
  Editar mídia é editar a **legenda**, e o arquivo é remandado do storage (ver a seção 8).
- **FIXAÇÃO (PIN) É INTERNA AO AZVCHAT, E NUNCA VAI PARA O WHATSAPP.** A faixa fixa no
  topo da conversa (`PinnedItem`) é para a EQUIPE destacar link de formulário, de pasta ou
  de agendamento — o recurso de pin do próprio WhatsApp não é usado, e nenhum caminho de
  fixar/desafixar chama `deps.provider`. O motivo é o mesmo da nota interna: no WhatsApp,
  fixar em GRUPO fixa para todos os participantes, e o cliente veria o escritório fixando
  coisas no chat dele — algo que a equipe nunca pediu e não deveria acontecer sozinho. Pelo
  mesmo motivo, a fixação **não expira**: link de formulário precisa continuar no topo até
  alguém desafixar, diferente do pin do WhatsApp (que soma prazo). `apps/api/test/
  pinned-items.test.ts` cobre que a rota de fixar não chama o provider — quem mexer aqui e
  acrescentar uma chamada a `deps.provider` quebra esse teste de propósito.
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
- **VARIÁVEL PÚBLICA DO NEXT.JS (`NEXT_PUBLIC_`) É GRAVADA NO BUILD, NÃO EM TEMPO DE
  EXECUÇÃO — e por isso NENHUMA credencial de integração pode usar esse prefixo.** O
  Next.js substitui `process.env.NEXT_PUBLIC_*` pelo valor literal dentro do bundle na
  hora de compilar (aqui, `apps/web/Dockerfile`, via `NEXT_PUBLIC_API_URL` como `ARG` do
  `docker build`). Depois disso o valor está gravado em `.js` estático: mudar o `.env` do
  servidor, reiniciar o contêiner ou trocar o segredo do GitHub **não tem efeito nenhum**
  — só uma imagem nova, construída de novo, pega o valor novo. É o tipo de causa que
  produz o sintoma "funcionava e parou depois de um deploy, sem ninguém mexer na
  variável": alguém mexeu, só que na hora de CONSTRUIR uma imagem anterior, e o efeito só
  aparece dias depois. Verificado em 03/09/2026 (incidente do modal "Vincular empresa do
  Azevedo-OS"): a leitura correta é `apps/api/src/config.ts` e nenhuma
  `NEXT_PUBLIC_AZEVEDO_*` existe em lugar nenhum do repositório — a integração já nasceu
  desenhada como a seção 15 descreve, servidor-a-servidor, e a suspeita inicial (variável
  pública gravada no build) não se confirmou. A regra fica pela mesma razão da seção 15:
  **nenhuma credencial de integração pode ter equivalente `NEXT_PUBLIC_`**, porque
  qualquer coisa com esse prefixo vai para o navegador de todo mundo, gravada, sem volta
  fácil.
- **RESULTADO DE DEPLOY VERDE NÃO PROVA QUE A INTEGRAÇÃO FOI CONFIGURADA — a prova é a
  LISTA DE PASSOS, não o `conclusion` do run.** Achado do mesmo incidente de 03/09/2026,
  antes de a causa em si ser descartada: conferi os workflow runs de `Deploy` do primeiro
  logo após a integração nascer (16/08/2026) até o mais recente, e em **todos** o passo
  "Configurar a integração com o Azevedo-OS" aparece `skipped`, porque `VPS_HOST`/
  `VPS_USER`/`VPS_SSH_KEY` nunca foram cadastrados neste repositório — é exatamente o caso
  que o aviso da seção 15 já descrevia, só que junto da prova de que ele vale desde
  sempre aqui. Consequência prática: o único caminho que já pôde ter ligado
  `AZEVEDO_OS_API_URL`/`AZEVEDO_OS_API_TOKEN` em produção é a Opção B do `DEPLOY.md`
  (edição direta do `.env` na VPS) — o caminho automático pelos segredos do GitHub nunca
  rodou uma vez. Se a integração algum dia parar de novo sem commit nenhum mexendo nela, a
  causa está fora do repositório, e o primeiro comando a rodar NA VPS é
  `grep -c '^AZEVEDO_OS_' .env` dentro de `~/Whatsapp` — o `DEPLOY.md` já avisa que a
  resposta certa é `4`, e que `8` significa linha colada duas vezes, com a última
  vencendo em silêncio.
- Baileys é integração não oficial: risco de banimento do número. Use números dedicados.

---

## 14. Estado atual e lacunas

**Funciona**: múltiplos números com conexão por QR e status em tempo real; sessão
persistida e retomada após restart; sync de chats/contatos/grupos e fotos; recebimento e
envio de texto, imagem, áudio, vídeo, documento, figurinha, localização, contato; reações;
responder citando; encaminhar; apagar; editar mensagem enviada pelo composer (texto e
legenda de mídia, dentro da janela de 15 minutos do WhatsApp); gravação de áudio como
mensagem de voz de verdade, normalizada no servidor para OGG/Opus com a linha de tempo
zerada, com recusa clara quando a conversão falha;
enquetes; edição e exclusão feitas pelo cliente refletidas na mensagem original, com marca
"editada" e histórico das versões anteriores, inclusive quando o WhatsApp entrega a edição
CIFRADA (validado em produção em 20/08/2026); mensagens agendadas com retentativa; notas internas; etiquetas; atribuição com
histórico completo; quatro status de atendimento; leitura por usuário (cada pessoa com
o próprio contador de não lidas, com "marcar como não lida" para reservar a conversa
para depois); busca na conversa e busca global;
marcação de participantes com `@` em grupo, com `@todos` e nome exibido no lugar do
número (enviadas e recebidas); edição de participante valendo para a PESSOA inteira
(nome e papel corrigidos uma vez aparecem em todos os grupos dela e na conversa
individual, com aviso da contagem antes de salvar);
respostas rápidas com `/`, inclusive com mídia anexada (imagem, áudio ou vídeo) que sai
junto com o texto e com variáveis de empresa, conversa, atendente e data preenchidas na
inserção (o que não resolve fica destacado no composer, e avisa antes de enviar); mídia ampliada em tela cheia com navegação por teclado e download;
botão de baixar em documento recebido; arrastar arquivo para a conversa e colar com Ctrl+V,
os dois com prévia (miniatura, legenda, remover, adicionar, progresso por arquivo e
retentativa do que falhou); link clicável no texto da mensagem (nova aba,
com `noopener noreferrer`); dashboard; relatório por atendente com células coloridas e clicáveis, linha de conversas sem responsável e de @todos, e painel lateral listando as conversas de cada recorte; auditoria consultável;
perfil e troca de senha pelo próprio usuário; aviso de chamada recebida; som de
notificação de mensagem recebida, com som e volume escolhidos por cada usuário; título da
aba piscando com as conversas que receberam mensagem, até alguém abrir a Inbox; horário
permitido de login por dia da semana, aplicado a quem não é supervisor, com aviso 5 minutos
antes e encerramento da sessão no fechamento; departamento marcado como interno, cujas
conversas ficam fora do dashboard, do card de atrasados e do relatório por atendente sem
sair da lista de conversas nem perder o aviso de mensagem nova; fixar mensagem (ou nota
interna) no topo da conversa, faixa interna que nunca vai ao WhatsApp, com até 3 fixadas
por conversa, sem prazo de validade, navegação entre elas e atualização em tempo real para
todo mundo com a conversa aberta; API de integração para sistema externo disparar mensagem
por token de máquina (amarrado a um número, com idempotência de 24h, rate limit por token e
tela de administração de tokens para admin), reaproveitando o caminho do envio manual — a
mensagem aparece na Inbox como qualquer outra.

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

**Nunca mais falhar em silêncio (03/09/2026).** Até aqui o defeito de configuração ausente
só aparecia para quem tentava vincular uma empresa, no meio do atendimento — quem administra
não tinha como saber sem abrir a tela. Três reforços, todos em cima do que já existia (nada
de migration, nada em `lib/access.ts`):

1. **Aviso no BOOT.** Se `azevedoOs.enabled` é falso, `index.ts` loga
   `azevedo_os_integration_disabled` uma vez, destacado, com `missingVars` — os NOMES das
   variáveis que faltam, nunca o valor. `AzevedoOsClient.missingVars` é calculado uma vez
   na criação do client (`AZEVEDO_OS_ENV_VARS`, em `services/azevedo-os-client.ts`).
2. **A mensagem do card tem DOIS textos.** Quem atende continua vendo "Integração com o
   Azevedo-OS não configurada. Avise o administrador do sistema." — o mesmo de sempre, só
   com o pedido explícito. Quem é admin vê QUAL variável falta
   (`azevedoOsErrorMessage(code, { isAdmin, details })`, em `lib/azevedo-os.ts`). O nome
   chega pela API só quando o pedido é de admin: `withAdminDetails` (mesmo arquivo do
   client) reescreve o `AzevedoOsError` de falha `disabled` como `AppError` com
   `details: { missingVars }`, e só quando `request.user.role === "admin"` — as outras
   falhas (timeout, 404, resposta estranha) já dizem o que houve e não passam por aqui.
   `AppError.details` é gênerico e nunca segredo; a rota decide o que soma, este campo só
   carrega.
3. **Verificação de saúde, só admin.** `GET /integrations/azevedo-os/health`
   (`requireRole("admin")`) responde `configured`, `missingVars`, `reachable` e
   `lastSuccessAt` (`AzevedoOsHealthDto`, em `@azvchat/shared`). `reachable` não é
   suposição: a rota FAZ uma consulta ao vivo (`companyFacets()`, o mesmo endpoint dos
   seletores da Inbox, que não depende de conversa) quando `configured` é true — e essa
   própria consulta, se funcionar, já atualiza `lastSuccessAt`, porque não existe um
   caminho de "ping" separado do caminho real de uso. `lastSuccessAt` é **só em memória**
   (fechamento dentro de `createAzevedoOsClient`, atualizado no fim de cada chamada que
   validou com sucesso): reinicia com o processo, e o pior caso é responder "nunca" cedo
   demais depois de um restart, nunca mentir sobre um sucesso que não aconteceu. Na tela,
   `components/settings/azevedo-os-health.tsx`, ao lado de `IntegrationTokensCard` em
   Configurações, sob o mesmo padrão (`user?.role === "admin"` na tela E a rota recusando
   de novo) — carrega só sob clique em "Checar agora", nunca sozinho ao abrir a tela.

Os filtros de regime/folha e o card já degradavam sozinhos antes disso (ver mais abaixo);
o que faltava era warning de quem administra saber SEM abrir uma tela de atendimento.

---

## 16. Azevedo-OS ↔ AZVCHAT (lembrete de cobrança — sentido inverso)

Espelho da seção 15, mas ao contrário: ali o AZVCHAT chama o Azevedo-OS para
**ler** cadastro de empresa; aqui é o Azevedo-OS (Financeiro) chamando o
AZVCHAT para **mandar** WhatsApp — lembrete de cobrança gerado pela régua do
Financeiro (`fin_lembretes_gerar()`, do lado de lá).

```
Serviço de e-mail do Azevedo-OS (Node) → API Fastify (token) → provider → WhatsApp
```

**Escopo fixo, decisão do Lincoln (26/08/2026).** Um único
`FINANCEIRO_WHATSAPP_INSTANCE_ID`, pré-cadastrado só no `.env` — o corpo da
chamada NUNCA escolhe instância nem departamento. Reduz o raio de dano: um
token vazado manda mensagem só por este número, nunca pelos outros
conectados da empresa. Se um dia outro módulo do Azevedo-OS precisar de
outro número, é outra variável e (se fizer sentido) outra rota — não um
parâmetro a mais nesta.

**Primeiro caminho de auth de serviço-para-serviço ENTRANDO no AZVCHAT.** A
seção 15 tinha o quê copiar (`AZEVEDO_OS_API_TOKEN`, só que na direção
contrária); esta não tinha nada — é a primeira rota do sistema que não é
JWT de sessão de navegador. `FINANCEIRO_LEMBRETE_TOKEN` é um bearer estático,
conferido num preHandler próprio (`autenticarServicoFinanceiro`, em
`modules/integrations/financeiro-lembrete.ts`), não em `lib/auth.ts` — não é
sessão, não tem usuário, não passa por `verifySession`.

**Endpoint.**

```
POST /integrations/financeiro/lembrete   { telefone, mensagem, externalReference? }
```

**Sem token OU sem instância configurados, a rota responde 503** —
`financeiro_lembrete_nao_configurado` — nunca fica aberta por omissão, mesmo
que alguém acerte por acaso um `Authorization` qualquer. Instância
configurada mas desconectada também não é 500 genérico: é 503
`instance_offline`, checado com `provider.getConnectionStatus` ANTES de
tentar enviar.

**Conversa nova, ao vivo.** Diferente de toda rota de `messages/routes.ts`
(que sempre partem de uma `Conversation` já existente — `findConversationOr404`),
a maioria dos telefones que chegam aqui não tem conversa nem contato prévios.
A rota usa `deps.ingest.ensureConversation(...)`, o mesmo caminho que
`POST /group-participants/:id/conversation` já usa para abrir conversa a
partir de um telefone solto — não é lógica nova, é reaproveitada. O
`organizationId` vem do próprio `WhatsAppInstance` (`findUnique` pelo id
fixo), não de um env var separado: duas variáveis que precisassem
concordar entre si é o tipo de configuração que diverge no primeiro deploy
em que alguém mexe numa e esquece a outra.

**Mensagem pronta, não gerada aqui.** `mensagem` chega já composta pelo
Financeiro (valor, vencimento, Pix copia-e-cola ou link do boleto, tudo
escrito do lado de lá) — o AZVCHAT só entrega. Isso é o oposto da seção 15,
onde nenhum dado financeiro atravessa: ali seria o Azevedo-OS mostrando
segredo de negócio DENTRO da tela do AZVCHAT; aqui é o Azevedo-OS decidindo
o que dizer e o AZVCHAT só sendo o telefone. O texto do lembrete não é
auditado em conteúdo (mesma regra dos logs — `sem conteúdo de mensagem`);
o que fica registrado é a **ação** (`message.sent.integration`) e o
`externalReference` (o id da cobrança, do lado do Financeiro).

**Sem `sentByUserId`.** Não é uma pessoa logada mandando — o campo é opcional
exatamente para isto. `senderName` grava `"Financeiro (Azevedo OS)"`, para
quem olhar o histórico da conversa entender de onde a mensagem saiu.

**Tempo real e persistência — os mesmos passos de `POST /conversations/:id/messages`,
replicados à mão** (esta rota não reutiliza o handler daquela, que espera uma
conversa já resolvida por `request.user`): `Message.create`, atualizar
`lastMessageAt`/`lastMessagePreview` da conversa, emitir
`RealtimeEvents.MessageNew` + `ConversationUpdated` em
`conversationAudience()`. Pular qualquer um destes faz a mensagem sair de
verdade pelo WhatsApp e a Inbox não mostrar — pior que não enviar, porque
ninguém saberia que foi enviada.

**Sem fila, sem retentativa própria.** Quem decide REPETIR o envio (uma
cobrança sem sucesso) é o lado de lá: `fin_lembretes.status = 'erro'` fica
visível, e o Financeiro decide se tenta de novo — esta rota não guarda
estado de tentativa nenhum.

**Variáveis** (as duas obrigatórias juntas — falta uma, e a integração nasce
desligada): `FINANCEIRO_LEMBRETE_TOKEN`, `FINANCEIRO_WHATSAPP_INSTANCE_ID`.

---

## 17. API de integração — envio por sistema externo (token de máquina)

Rota genérica para **qualquer sistema do escritório disparar UMA mensagem** no
WhatsApp do cliente logo após uma ação lá (o caso de origem: o agendador de
reuniões manda a confirmação quando o cliente conclui a reserva). O sistema
externo **só envia** — não recebe, não é robô de atendimento —, e a mensagem
aparece na Inbox como qualquer outra, para o atendimento ver o histórico.

Diferente da seção 16 (Financeiro), o escopo **não** é uma instância fixa no
`.env`: cada token carrega a sua. É o **primeiro caminho autenticado por token
de banco por-tenant** — a seção 16 usa bearer estático do `.env`.

**Token** (`IntegrationToken`, migration `20260829120000_integration_message_tokens`).
Guarda `name`, `tokenPrefix` (visível), `tokenHash` (**sha256 — o valor em
claro é mostrado UMA vez na criação e nunca mais**), `whatsappInstanceId`
(amarração a **exatamente uma** instância), `active`, `createdById` (nulo não
invalida: o token é da integração, não da pessoa), `lastUsedAt`, `usageCount`.
Crypto em `apps/api/src/lib/integration-token.ts` (sha256, não bcrypt: alta
entropia). Revogar é `active = false`, **nunca apagar** — o histórico fica.

**Guard** (`modules/integrations/message-api.ts`, `authenticateIntegrationToken`):
bearer no `Authorization`, conferido por hash num `findFirst`. Sem token, token
inexistente e token revogado respondem **todos 401** (não se revela qual). Não
passa por `verifySession`/`authenticate`/`requireRole` — não há usuário. O token
autenticado fica em `request.integrationToken`.

**Envio** — `POST /integrations/messages` (token), corpo Zod
`{ telefone, mensagem, idempotencyKey?, instanceId? }`:
- **normaliza o telefone ANTES de tudo** (`normalizeBrazilPhone`, em
  `@azvchat/shared` — com ou sem 55, com ou sem pontuação; número inválido é
  **422**, grupo é **422**, nunca tenta enviar);
- `mensagem` vem **pronta** do sistema externo (sem motor de template aqui),
  com teto e recusa de texto vazio (422);
- `instanceId` no corpo é opcional e serve só para **recusar (403)** tentativa
  de enviar por instância diferente da do token — o envio é sempre pela do
  token;
- **idempotência**: `idempotencyKey` repetida dentro de 24h **não reenvia** e
  devolve o resultado original (`IntegrationMessageLog`, única por
  `(token, chave)`, janela móvel);
- instância excluída ou desconectada/`qr_required` responde **409** (não
  enfileira em silêncio);
- reaproveita o caminho do envio manual: `ingest.ensureConversation` (mesma
  criação de número novo — **sem inventar departamento nem responsável**),
  `provider.sendText`, `Message.create` outbound (sem `sentByUserId`,
  `senderName` = `Integração (<nome>)`, `metadata.origem = "api-integration"`),
  atualização de prévia e os eventos `MessageNew` + `ConversationUpdated` na
  `conversationAudience()`. Sucesso devolve `{ status, messageId,
  conversationId, phone, idempotent }`;
- **rate limit por token** (429), `INTEGRATION_TOKEN_RATE_LIMIT_PER_MINUTE`
  (padrão 60), keyed pelo hash do bearer.

**Administração** (`admin`, papel fixo no código, como criar/excluir número):
`GET /integration-tokens`, `POST /integration-tokens` (devolve o token em claro
UMA vez), `POST /integration-tokens/:id/revoke`. Tela: card **Tokens de
integração** em Configurações, só para admin
(`components/settings/integration-tokens.tsx`), que lista, cria (mostrando o
token uma vez com botão copiar) e revoga, e exibe a URL do endpoint + exemplo
de chamada pronto.

**Visibilidade**: nada muda — a conversa criada segue `lib/access.ts` como
qualquer outra, e o endpoint **não expõe leitura** de conversa/mensagem/contato.
**Auditoria**: `integration_token.created`, `integration_token.revoked` e
`message.sent.integration` (com token, instância, conversa e resultado — nunca
conteúdo nem token em claro).

---

## 18. Como escrever um bom prompt para este sistema

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
