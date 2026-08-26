# Relatório técnico — AZVCHAT

Documento preparado para um desenvolvedor externo orçar trabalho de implementação de
chamadas via API e revisão de estrutura. Todo conteúdo abaixo vem de inspeção direta do
código e do ambiente do repositório `contato453/whatsapp` (branch
`claude/azvchat-technical-report-k0k0ic`, commit `15232c6`), incluindo execução real de
typecheck, lint, testes e build. Onde a inspeção não permitiu confirmar algo (por exemplo,
por não haver acesso ao servidor de produção), está marcado explicitamente como
"não confirmado".

Nenhum dado de cliente, segredo, credencial ou informação de servidor de produção está
neste documento. Ver a seção de verificação ao final.

---

## 1. Resumo executivo

O AZVCHAT é uma plataforma web de atendimento por WhatsApp, construída sob medida para um
escritório contábil/jurídico. Ela conecta vários números de WhatsApp ao mesmo tempo (cada
um pareado por QR Code, como o WhatsApp Web) e reúne todas as conversas — individuais e de
grupo — numa única caixa de entrada compartilhada pela equipe. Cada cliente do escritório
costuma ter vários grupos (Geral, Contábil, Fiscal, Departamento Pessoal), e o sistema trata
cada grupo como uma conversa de primeira classe, com departamento, responsável, etiquetas e
histórico próprios.

A equipe usa o sistema para distribuir o atendimento entre atendentes, supervisores e
administradores, medir tempo de resposta (SLA), guardar notas internas que nunca chegam ao
cliente, disparar respostas prontas com variáveis do cadastro do cliente, e manter um
histórico auditável de tudo. O sistema roda como substituto direto do WhatsApp Web manual:
por trás, ele fala com o WhatsApp através de uma biblioteca não oficial (Baileys), não pela
API oficial do WhatsApp Business.

Hoje é uso interno de um único escritório, mas o modelo de dados já é multi-tenant (toda
entidade carrega um `organizationId`), preparando o terreno para múltiplas organizações no
futuro, ainda que isso não esteja implementado (sem cadastro de organização nem cobrança).

---

## 2. Linguagens e versões

- **Linguagem principal**: TypeScript em modo `strict` (`tsconfig.base.json`: `strict: true`,
  `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`), tanto no backend quanto no
  frontend.
- **Runtime**: Node.js. O `package.json` raiz declara `"engines": { "node": ">=20" }`, mas os
  `Dockerfile` de produção (`apps/api/Dockerfile`, `apps/web/Dockerfile`) e o workflow de CI
  usam `node:22-slim` / `node-version: 22`. O ambiente onde este relatório foi gerado tem
  **Node v22.22.2** instalado — é essa a versão efetivamente usada para rodar o projeto hoje.
- **Gerenciador de pacotes**: **pnpm 10.33.0**, fixado em `package.json` por
  `"packageManager": "pnpm@10.33.0"` (o `corepack` dos `Dockerfile` respeita esse campo).
- **Monorepo com workspaces**: sim, `pnpm-workspace.yaml` declara `apps/*` e `packages/*`
  como pacotes do workspace — 6 pacotes ao todo (2 apps, 4 packages), listados na seção 4.
- Não há outra linguagem de aplicação além de TypeScript/JavaScript. O único componente
  externo não-Node é o **ffmpeg**, instalado como binário do sistema operacional (não é
  dependência npm) e usado para normalizar áudio.

---

## 3. Frameworks e bibliotecas principais

Todas as versões abaixo foram lidas de `package.json` e conferidas contra a versão
efetivamente resolvida no `pnpm-lock.yaml` (formato de lockfile `'9.0'`).

### Backend (`apps/api`, pacote `@azvchat/api`)

| Biblioteca | Declarada | Resolvida no lockfile |
| --- | --- | --- |
| Fastify | `^5.1.0` | **5.12.0** |
| @fastify/jwt | `^9.0.1` | 9.1.0 |
| @fastify/cors | `^10.0.1` | 10.1.0 |
| @fastify/multipart | `^9.0.1` | 9.4.0 |
| @fastify/rate-limit | `^10.1.1` | 10.3.0 |
| Socket.IO (servidor) | `^4.8.1` | **4.8.3** |
| Zod | `^3.23.8` | **3.25.76** |
| bcryptjs | `^3.0.2` | 3.0.2 |
| pino (logs) | `^9.5.0` | 9.14.0 |
| TypeScript | `^5.6.3` | **5.9.3** |
| Vitest (testes) | `^3.0.0` | **3.2.7** |

### Frontend (`apps/web`, pacote `@azvchat/web`)

| Biblioteca | Declarada | Resolvida no lockfile |
| --- | --- | --- |
| Next.js (App Router) | `^15.3.0` | **15.5.23** |
| React | `^19.0.0` | **19.2.8** |
| React DOM | `^19.0.0` | 19.2.8 |
| Socket.IO client | `^4.8.1` | 4.8.3 |
| Tailwind CSS | `^3.4.15` | 3.4.19 |
| lucide-react (ícones) | `^0.468.0` | 0.468.0 |
| clsx / tailwind-merge | `^2.1.1` / `^2.5.5` | 2.1.1 / 2.6.1 |
| TypeScript | `^5.6.3` | 5.9.3 |
| Vitest | `^3.2.7` | 3.2.7 |

Não há biblioteca de gráficos (dashboard é SVG inline) nem biblioteca de componentes de UI
de terceiros — o kit de interface (`components/ui.tsx`) é escrito à mão sobre Tailwind.

### Banco de dados (`packages/database`, pacote `@azvchat/database`)

| Item | Versão |
| --- | --- |
| PostgreSQL (imagem Docker) | `postgres:16-alpine` (`docker-compose.prod.yml`) |
| Prisma ORM + Prisma Client | **6.19.3** (ambos, `^6.10.0` declarado) |

### WhatsApp (`packages/whatsapp`, pacote `@azvchat/whatsapp`)

| Biblioteca | Versão | Observação |
| --- | --- | --- |
| **@whiskeysockets/baileys** | **6.7.24** (fixada, sem `^`) | biblioteca **não oficial** — ver seção 7 |
| @hapi/boom | ^10.0.1 | usada pelo próprio Baileys para erros de conexão |
| qrcode | ^1.5.4 | gera a imagem do QR Code exibida na tela |
| https-proxy-agent | ^7.0.6 | suporte a proxy HTTPS opcional para a conexão |

### Autenticação e validação

- **Autenticação de sessão de navegador**: JWT via `@fastify/jwt` (que usa `fast-jwt`
  internamente) + `bcryptjs` para hash de senha.
- **Autenticação servidor-a-servidor** (rota do Financeiro, seção 16 do `CLAUDE.md`): bearer
  token estático comparado em preHandler próprio, sem `@fastify/jwt`.
- **Validação de entrada**: Zod em toda rota (params, query e body), sem exceção declarada.

### Dependências de peso adicionais

- **Socket.IO** — canal de tempo real entre API e frontend (salas por organização, número,
  departamento e responsável).
- **sharp** — processamento de imagem, puxado como dependência transitiva do Next.js
  (otimização de imagem do framework), não usado diretamente pelo código da aplicação.
- **Prisma Migrate** — todas as migrações do banco são arquivos SQL versionados em
  `packages/database/prisma/migrations/`.
- **eslint 9 + typescript-eslint 8** — lint em todos os pacotes, configuração raiz em
  `eslint.config.mjs` (flat config).

---

## 4. Estrutura do repositório

Árvore até dois níveis, com o papel de cada parte:

```
apps/
  api/                          → Backend Fastify (a "API")
    src/modules/<dominio>/      → Uma pasta por domínio de negócio, cada uma com routes.ts
    src/services/                → Processos de fundo: gerenciador de instâncias WhatsApp,
                                    ingestão de mensagens, agendador de mensagens
    src/realtime/                → Configuração do Socket.IO (salas, audiência)
    src/lib/                     → Regras transversais: acesso, auth, erros, serialização,
                                    armazenamento de mídia, permissões etc.
    test/                        → Testes com Vitest (46 arquivos)
  web/                          → Frontend Next.js (a "Inbox" / interface da equipe)
    src/app/(app)/<rota>/        → Uma pasta por tela dentro do layout autenticado
    src/components/              → Componentes de UI, agrupados por área (inbox/, dashboard/,
                                    users/, reports/, quick-replies/, permissions/)
    src/lib/                     → Cliente HTTP, contexto de autenticação/socket, regras puras
                                    compartilhadas com testes
    test/                        → Testes com Vitest (11 arquivos)

packages/
  shared/                       → Enums, tipos, rótulos, contratos de tempo real e regras
                                    puras usadas por API e frontend ao mesmo tempo
  database/                     → schema.prisma, migrations SQL versionadas, seed, cliente
                                    Prisma singleton
  whatsapp/                     → Interface WhatsAppProvider + implementação concreta sobre
                                    Baileys (isolamento da biblioteca de WhatsApp)
    src/qrcode/                  → A implementação Baileys em si (conexão, normalização de
                                    eventos, criptografia de edição, etc.)
    src/audio/                   → Conversão de áudio para o formato do WhatsApp (ffmpeg)
    test/                        → Testes com Vitest (8 arquivos)
```

Fora de `apps/` e `packages/`: `deploy/` (scripts de atualização da VPS e `Caddyfile`),
`.github/workflows/` (CI e deploy), `docker-compose.yml` (desenvolvimento),
`docker-compose.prod.yml` (produção), `DEPLOY.md` (passo a passo de infraestrutura),
`README.md`, `CLAUDE.md` (documento de arquitetura e convenções, mantido junto do código).

### Tamanho, em arquivos `.ts`/`.tsx` e linhas (contados nesta inspeção)

| Pacote | Arquivos | Linhas |
| --- | --- | --- |
| `apps/api` | 110 | 27.588 |
| `apps/web` | 93 | 22.024 |
| `packages/whatsapp` | 16 | 4.249 |
| `packages/shared` | 18 | 3.207 |
| `packages/database` | 3 | 230 (fora do `schema.prisma`, que tem 969 linhas) |
| **Total** | **240** | **~58.300** |

---

## 5. Como o serviço roda em produção

- **É Docker Compose**, não pm2 nem systemd rodando a aplicação diretamente. A prova é
  `docker-compose.prod.yml` na raiz do repositório, referenciado pelo script de deploy
  (`deploy/atualizar.sh`, linha `docker compose -f "$COMPOSE" up -d --build`) e pelo workflow
  `deploy.yml` (`docker compose -f docker-compose.prod.yml up -d --build`). O systemd só
  entra para agendar a **verificação de atualização** (ver seção 6), não para rodar os
  processos da aplicação.

- **Contêineres/processos**, conforme `docker-compose.prod.yml`:
  - `postgres` — imagem `postgres:16-alpine`, com healthcheck (`pg_isready`);
  - `api` — build de `apps/api/Dockerfile` (Node 22), expõe a porta 4000 só internamente
    (sem `ports:` mapeado para o host); roda o backend Fastify e a camada Baileys no mesmo
    processo;
  - `web` — build de `apps/web/Dockerfile`, serve o Next.js compilado, porta 3000 só interna;
  - `caddy` — imagem `caddy:2-alpine`, único contêiner com portas expostas ao host
    (`80:80`, `443:443`).

- **Servidor web / proxy**: **Caddy 2**, configurado por `deploy/Caddyfile`. Ele resolve
  **HTTPS automaticamente** via Let's Encrypt (comportamento padrão do Caddy quando recebe um
  domínio real) para dois subdomínios: `{$APP_DOMAIN}` (proxy para `web:3000`) e
  `{$API_DOMAIN}` (proxy para `api:4000`, com WebSocket do Socket.IO passando pelo mesmo
  `reverse_proxy` — Caddy faz upgrade de conexão automaticamente).

- **Volumes nomeados que persistem entre deploys** (declarados em `docker-compose.prod.yml`):
  `pgdata` (dados do Postgres), `whatsapp_sessions` (credenciais de sessão do Baileys —
  perder isso força reconectar todos os números por QR Code de novo), `media_store` (arquivos
  de mídia recebidos/enviados), `caddy_data`/`caddy_config` (certificados TLS emitidos).

- **A API é stateful e roda em instância única.** Duas razões, confirmadas no código:
  (1) as sessões do WhatsApp (Baileys) mantêm um socket de conexão vivo em memória por
  número, gerenciado por `apps/api/src/services/instance-manager.ts` — não há nada
  compartilhando esse estado entre processos; (2) o `docker-compose.prod.yml` não declara
  `replicas` nem qualquer mecanismo de balanceamento para o serviço `api`. O `CLAUDE.md` do
  próprio repositório documenta essa limitação de propósito: "escale o web à vontade, mas a
  API roda em instância única enquanto não existir broker de sessões". **Escalar
  horizontalmente a API hoje não é suportado** sem um trabalho de arquitetura adicional
  (mover a sessão do WhatsApp para um serviço compartilhado). O frontend (`web`), por não
  guardar estado de sessão do WhatsApp, poderia em tese ser replicado, mas o compose atual
  também o roda como um único contêiner.

- **Migrations rodam no boot do contêiner da API**, não em um passo de deploy separado — é o
  próprio `CMD` do `apps/api/Dockerfile`:
  `pnpm --filter @azvchat/database migrate:deploy && pnpm --filter @azvchat/api start`. Isso
  significa que toda subida do contêiner tenta aplicar migrations pendentes antes de abrir a
  porta 4000.

- **Sistema operacional e recursos do servidor**: **não confirmado neste ambiente** (esta
  inspeção não teve acesso à VPS de produção). O `DEPLOY.md` **recomenda** Ubuntu 24.04 com
  no mínimo 2 vCPU, 4 GB de RAM e 40 GB de disco, citando como opções de provedor Hetzner
  (CX22, ~€4/mês), DigitalOcean, Vultr, Contabo e Hostinger VPS — mas isso é a recomendação
  do guia de instalação, não uma confirmação de que o servidor real usa exatamente essa
  configuração.

---

## 6. Pipeline de deploy

Existem **dois caminhos**, e o repositório documenta os dois — o segundo é o principal hoje:

### Caminho 1 — atualização automática da VPS (o principal, sem segredo no GitHub)

- **Gatilho**: um timer do systemd (`azvchat-atualizar.timer`), instalado uma vez por
  `deploy/instalar-atualizacao-automatica.sh`, que roda a cada 2 minutos por padrão
  (`OnUnitActiveSec=2min`, configurável).
- **Etapas** (`deploy/atualizar.sh`): busca a branch de deploy (`git fetch`); se HEAD local e
  remoto já coincidem, sai sem fazer nada (chamar de minuto em minuto não tem custo); se há
  novidade, faz `git merge --ff-only` (falha em vez de gerar merge, caso alguém tenha editado
  um arquivo versionado direto na VPS); sobe os contêineres com
  `docker compose -f docker-compose.prod.yml up -d --build`; espera até 100 segundos
  (20 tentativas de 5s) pela mensagem `api_started` no log do contêiner `api` antes de
  declarar sucesso.
- **Quem faz o quê**: nenhum segredo sai do servidor — a própria VPS puxa o código do GitHub.
  Não há chave privada nem porta adicional aberta.
- **Rollback hoje**: não há comando de rollback automatizado no repositório. Como o script só
  avança por `git merge --ff-only`, reverter exigiria, na prática, apontar a branch de deploy
  para um commit anterior no GitHub (ou rodar `git reset`/`checkout` manual na VPS) e então
  chamar `bash deploy/atualizar.sh --force` para reconstruir os contêineres — isso é inferido
  da leitura do script, e **não confirmado** como procedimento documentado ou testado.

### Caminho 2 — deploy por SSH via GitHub Actions (opcional)

- **Arquivo**: `.github/workflows/deploy.yml`.
- **Gatilho**: dispara quando o workflow `CI` termina com sucesso na branch padrão
  (`workflow_run` sobre o workflow `CI`), ou manualmente por `workflow_dispatch`.
- **Etapas**: (1) confere se os segredos `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` existem no
  environment `production` — se faltar algum, o job **termina em verde sem fazer nada**
  (avisa com `::warning::`, não falha o CI de quem não usa esse caminho); (2) prepara a chave
  SSH; (3) opcionalmente grava as variáveis `AZEVEDO_OS_*` no `.env` da VPS via SSH (o token
  viaja em base64 por stdin, nunca como argumento de linha de comando); (4) conecta por SSH,
  faz `git fetch` + `git merge --ff-only` e roda `docker compose -f docker-compose.prod.yml
  up -d --build`; (5) confirma que a API subiu, olhando o log em busca de `api_started` por
  até 100 segundos.
- **Concorrência**: `concurrency: { group: deploy-vps, cancel-in-progress: false }` — um
  deploy por vez, e um deploy em andamento nunca é cancelado por outro que dispare depois
  (evita deixar o `docker compose up` interrompido no meio).
- **Tempo**: não medido nesta inspeção (não há execução real disponível para cronometrar) —
  **não confirmado**.
- **Rollback**: mesmo caminho do caminho 1 (o script remoto também é `--ff-only`); sem
  comando de rollback automatizado.

### CI (pré-requisito dos dois caminhos)

- **Arquivo**: `.github/workflows/ci.yml`. Dispara em todo PR e em push nas branches
  `main`/`master`/`claude/whatsapp-support-platform-ezyvx0`.
- **Etapas**: checkout → instalar pnpm (versão lida do `packageManager`) → instalar Node 22 →
  reescrever dependência git do Baileys para HTTPS (o runner não tem chave SSH) → instalar
  ffmpeg → `pnpm install --frozen-lockfile` → `pnpm db:generate` → `pnpm -r typecheck` →
  `pnpm -r lint` → `pnpm -r test` → `pnpm -r build`.

---

## 7. A camada de WhatsApp

### Biblioteca e natureza da integração

- **@whiskeysockets/baileys, versão 6.7.24** (fixada sem `^` no `package.json` — atualizar
  exige editar o número manualmente, não vem por `pnpm update`).
- É uma **integração não oficial**: o Baileys reimplementa o protocolo do WhatsApp Web
  (WebSocket + criptografia Signal), sem usar a API Business oficial do Meta. O próprio
  `CLAUDE.md` do projeto registra isso como risco aceito ("Baileys é integração não oficial:
  risco de banimento do número. Use números dedicados"). Isso significa que o WhatsApp pode,
  a qualquer momento, mudar o protocolo ou banir números que usem esse tipo de cliente — não
  há garantia contratual de estabilidade, diferente da API oficial paga.

### Isolamento arquitetural

Existe uma interface própria, `WhatsAppProvider` (`packages/whatsapp/src/provider.ts`), e a
regra do projeto é que **nenhum código fora de `packages/whatsapp` pode importar Baileys
diretamente** — controllers, serviços, banco e frontend só conhecem essa interface. Isso foi
confirmado lendo o arquivo: métodos e eventos são todos tipados sobre estruturas próprias do
projeto (`NormalizedMessage`, `CallEvent`, etc.), nunca sobre tipos do Baileys.

**Métodos do contrato `WhatsAppProvider`**: `connect`, `disconnect`, `logout`, `getQRCode`,
`getConnectionStatus`, `getPhoneNumber`, `getProfilePicture`, `sendText`, `sendMedia`,
`sendReaction`, `sendPoll`, `deleteMessage`, `requestMessageResend`, `editMessage`,
`getChats`, `getGroups`, `getContacts`, `on`/`off` (assinatura de eventos), `shutdownAll`.

**Eventos normalizados que a implementação emite**: `qr`, `status`, `message`,
`message-status`, `message-reaction`, `message-deleted`, `message-edited`,
`message-edit-encrypted`, `call`, `chats-sync`, `contacts-sync`, `groups-sync`.

A única implementação hoje é `QrCodeWhatsAppProvider`
(`packages/whatsapp/src/qrcode/qrcode-provider.ts`, 1.209 linhas — o maior arquivo do pacote),
sobre Baileys. O desenho existe para permitir, em tese, plugar uma implementação para a API
oficial (`MetaCloudApiProvider`) sem alterar regra de negócio — mas **essa segunda
implementação não existe no código hoje**, é só o motivo declarado do desenho.

### O que já é suportado hoje (confirmado no código e nos testes)

- **Envio e recebimento** de texto, imagem, áudio (inclusive mensagem de voz — ver adiante),
  vídeo, documento, figurinha, localização, contato e enquete.
- **Reações** a mensagens.
- **Edição** de mensagem enviada pela equipe (dentro da janela de 15 minutos do WhatsApp) e
  **edição feita pelo cliente** — inclusive quando o WhatsApp entrega o texto novo
  **criptografado** (mecanismo `secretEncryptedMessage`), com decifragem própria em
  `packages/whatsapp/src/qrcode/message-secret.ts` e fallback de "pedir reenvio ao servidor"
  quando a decifragem falha.
- **Exclusão** de mensagem, feita pela equipe ou pelo cliente.
- **Sincronização** de chats, contatos e grupos ao conectar.
- **Reconexão** com backoff, gerenciada por `instance-manager.ts`.
- **Sessão persistida e retomada** — ver próximo item.
- **Backfill de mensagens perdidas** durante uma janela de desconexão, via
  `messaging-history.set`.

### Como a conexão é autenticada e como as sessões são guardadas

- **Pareamento**: por **QR Code**, exatamente como no WhatsApp Web do navegador — a pessoa
  escaneia o código com o WhatsApp do celular, e não existe login por usuário/senha do lado
  do WhatsApp.
- **Guarda das credenciais**: o Baileys usa `useMultiFileAuthState`, que grava as chaves de
  sessão em arquivos dentro de um diretório por instância
  (`WHATSAPP_SESSION_DIR`/`<instanceId>`). Em produção, `WHATSAPP_SESSION_DIR` aponta para
  `/app/data/sessions` dentro do contêiner, que é o volume nomeado `whatsapp_sessions` — por
  isso a sessão sobrevive a um `docker compose up -d --build` (rebuild/redeploy) sem exigir
  escanear o QR de novo. Perder esse volume força reconectar todos os números.
- **Versão do protocolo**: sempre a mais recente, via `fetchLatestBaileysVersion` — o
  `CLAUDE.md` registra um incidente real (20/08/2026) em que fixar uma versão antiga para
  contornar um formato de mensagem derrubou a conexão de produção inteira, e a alavanca para
  fixar versão foi removida do código de propósito.

### Quantos números podem ficar conectados e como isso é gerenciado

- Não há limite fixo no código (nenhuma constante do tipo `MAX_INSTANCES` foi encontrada).
  Cada linha da tabela `WhatsAppInstance` é uma sessão Baileys independente, orquestrada por
  `instance-manager.ts`; a queda de uma não afeta as demais, pois cada uma é um socket
  separado.
- O limite prático é de recursos do servidor (memória e CPU para cada socket ativo, mais
  risco de banimento em massa se muitos números do mesmo provedor forem conectados de forma
  suspeita) — isso não está codificado como regra, é uma decorrência de infraestrutura.
  **Quantidade real hoje em produção: não confirmado** (sem acesso ao banco de produção).

### Riscos conhecidos, sem suavizar

- **Não oficial**: risco real de banimento de número pelo WhatsApp, reconhecido pelo próprio
  time no `CLAUDE.md`. Não há SLA nem suporte contratual do WhatsApp/Meta para esse tipo de
  conexão.
- **API stateful de instância única** (seção 5): a sessão do WhatsApp vive só na memória e no
  disco de um único contêiner. Não há hoje um caminho para alta disponibilidade da conexão
  com o WhatsApp — se o contêiner da API cair, todas as conexões caem juntas até ele subir de
  novo.
- **Dependência de comportamento não documentado**: vários trechos do código (ver
  `CLAUDE.md`, seção 8) tratam de comportamento do protocolo do WhatsApp descoberto por
  tentativa e erro em produção (formato de edição cifrada, chaves de mensagem sem `key.id`,
  invólucros de pacote de protocolo variáveis por versão do app do cliente). Isso indica que
  o protocolo não é estável nem plenamente documentado, e mudanças futuras do WhatsApp podem
  quebrar esses tratamentos sem aviso prévio.
- **Dependência do Baileys em si**: fixada em uma versão específica (6.7.24); a mais recente
  disponível no momento desta inspeção é uma `7.0.0-rc14` (release candidate), então mesmo a
  atualização "oficial" mais recente da biblioteca ainda não é considerada estável pelos
  mantenedores dela.

---

## 8. Estado atual das chamadas (o que será orçado)

### O que o sistema faz hoje quando entra uma chamada

Confirmado lendo `packages/whatsapp/src/qrcode/qrcode-provider.ts` (evento `call` do Baileys)
e `apps/api/src/services/instance-manager.ts` (consumidor do evento):

1. O Baileys emite o evento nativo `call` do WhatsApp (chamada de voz ou vídeo tocando,
   recusada, perdida ou atendida em outro aparelho).
2. O provider normaliza isso em um evento próprio `call`, com `instanceId`, `callId`,
   `externalChatId`, `fromExternalId`, se é vídeo, e um status normalizado
   (`ringing`/`missed`/`rejected`, conforme o status bruto do Baileys).
3. `instance-manager.ts` escuta esse evento e:
   - garante que existe uma `Conversation` para quem ligou (cria na primeira chamada, se
     necessário — mesmo quem nunca escreveu aparece na fila);
   - **grava a chamada como uma linha em `Message`**, com `type: "call"`,
     `direction: "inbound"`, um `externalMessageId` sintético (`call:<callId>`) e
     `metadata` com o status da chamada e se é vídeo;
   - resolve a identidade de quem ligou (nome e telefone, quando conhecidos, por
     `lib/call-identity.ts`) e emite o evento de tempo real `call:incoming` para a sala do
     responsável pela conversa, com os dados já resolvidos para a tela desenhar.
4. Na interface, isso aparece como um **aviso de chamada tocando** (a tela nunca atende nem
   recusa) e uma **mensagem no histórico da conversa** registrando que houve uma chamada.

### O sistema consegue atender ou recusar uma chamada hoje?

**Não.** Confirmado por leitura completa da interface `WhatsAppProvider`
(`packages/whatsapp/src/provider.ts`): não existe nenhum método como `answerCall`,
`rejectCall` ou equivalente. O evento `call` é **somente leitura** — o sistema só registra
que uma chamada aconteceu e avisa a equipe; ele nunca interage com a chamada em si. Uma busca
pelo restante do backend e do frontend não encontrou nenhuma rota HTTP, botão de interface ou
lógica que tente atender, recusar ou encerrar uma chamada.

### O que a interface do provider expõe sobre chamadas, e o que o Baileys suporta

- A interface `WhatsAppProvider` expõe **apenas o evento `call`** (leitura). Não há método de
  escrita relacionado a chamada em todo o contrato.
- Sobre o que o Baileys em si suporta: o evento `call` do Baileys nativo entrega apenas a
  notificação de que uma chamada está acontecendo (com metadados como `from`, `id`, `status`,
  `isVideo`) — ele **não expõe** uma API para efetivamente atender, recusar ou receber o
  áudio/vídeo de uma chamada. O protocolo de chamada de voz/vídeo do WhatsApp é implementado
  sobre WebRTC entre os aplicativos oficiais, e o Baileys, sendo um cliente do protocolo de
  **mensagens**, não implementa esse lado de mídia em tempo real. Esta afirmação sobre os
  limites do Baileys é baseada no comportamento observado no código do projeto (que só usa o
  evento de notificação) e no conhecimento geral, publicamente disponível, sobre o escopo do
  projeto Baileys — **a documentação oficial do Baileys em si não foi consultada
  ao vivo nesta inspeção, então trate a extensão exata do que a biblioteca oferece sobre
  chamadas como não confirmado por fonte primária**, ainda que o comportamento no código
  deste repositório seja fato observado, não suposição.

### Existe integração de voz, VoIP, SIP ou telefonia?

**Não.** Confirmado por busca textual em todo o código-fonte (`apps/` e `packages/`) por
`sip`, `voip`, `webrtc`, `twilio`, `freeswitch`, `asterisk` (case-insensitive). As únicas duas
ocorrências de "voip" no repositório são o parâmetro `-application voip` passado ao **ffmpeg**
na normalização de **áudio gravado** (não tem relação com chamada), em
`packages/whatsapp/src/audio/normalize-audio.ts`. Não há biblioteca de SIP, WebRTC, Twilio ou
qualquer telefonia instalada nas dependências, e não há nenhum serviço, rota ou componente de
interface relacionado a atender chamada.

**Resumindo para o orçamento**: hoje "chamadas" no AZVCHAT é só um registro passivo (aviso na
tela + linha no histórico) de que o WhatsApp notificou uma chamada. Implementar "chamadas via
API" no sentido de atender/fazer chamadas de voz reais é trabalho novo, não uma extensão de
algo parcialmente pronto — provavelmente exigindo uma abordagem inteiramente diferente da
atual (API oficial do WhatsApp Business Calling, quando/se disponível, ou uma solução de
telefonia separada integrada por fora do Baileys), já que o Baileys não implementa a mídia de
chamada.

---

## 9. Modelo de dados

- **Fonte**: `packages/database/prisma/schema.prisma` (969 linhas).
- **28 models** (tabelas) e **13 enums**.
- **34 migrations** aplicadas, uma pasta por migration em
  `packages/database/prisma/migrations/` (nome com timestamp + descrição, de
  `20260810...` até `20260820170000_pinned_items`, mais o arquivo de controle
  `migration_lock.toml`), cada uma com SQL puro versionado — nunca editado depois de aplicado
  (regra do projeto, seguida na prática: cada mudança de schema é uma pasta nova).

### Entidades principais e como se relacionam (resumo)

- **`Organization`** é a raiz do tenant; toda entidade relevante referencia
  `organizationId`.
- **`User`** (papel admin/supervisor/agent) se relaciona com `WhatsAppInstance` via
  `UserWhatsAppInstance` (N:N — quais números o usuário enxerga) e com `Department` via
  `UserDepartment` (N:N — em quais departamentos atua).
- **`WhatsAppInstance`** (um número conectado) tem várias `Conversation`.
- **`Conversation`** (um chat, individual ou de grupo) pertence a uma instância, opcionalmente
  a um `Department` e a um `User` responsável (`assignedUserId`); tem muitas `Message`,
  `InternalNote`, `PinnedItem`, `ConversationTag` (N:N com `Tag`), `ScheduledMessage`,
  `ConversationAssignmentHistory` e uma linha de leitura por usuário em `ConversationRead`.
- **`WhatsAppGroup`** e **`GroupParticipant`** representam a estrutura de grupo do WhatsApp em
  si; `GroupParticipant` pode apontar para um **`PersonProfile`** — a identidade única da
  pessoa na organização, que unifica o mesmo contato presente em vários grupos do mesmo
  cliente.
- **`Message`** pertence a uma `Conversation`, pode ter `MessageReaction` (N:1 mensagem → N
  reações) e pode citar outra mensagem (`quotedMessageId`).
- **`Tag`** e **`QuickReply`** (respostas rápidas) se relacionam com `Department` via tabelas
  de junção (`TagDepartment`, `QuickReplyDepartment`).
- **`RolePermission`** guarda só as permissões que **divergem** do padrão do catálogo (uma
  linha por par papel/ação alterado, não uma linha por ação existente).
- **`AttendanceSettings`** (uma linha por organização) se relaciona com
  `AttendanceBusinessHours` e `AttendanceLoginHours` (sete linhas cada, uma por dia da
  semana).
- **`AuditLog`** guarda o histórico de ações relevantes, referenciando `User` e a entidade
  afetada por id/tipo genéricos.

### Volume real das tabelas (contagem de linhas)

**Não confirmado.** Não há banco de dados PostgreSQL acessível neste ambiente de inspeção
(nem instância local rodando, nem credencial de produção) — não foi possível rodar `SELECT
count(*)` em nenhuma tabela. Quem for orçar o trabalho deve pedir esses números
diretamente a quem administra o banco de produção, se o volume de dados for relevante para o
escopo.

---

## 10. API e tempo real

### HTTP

- **98 rotas HTTP** registradas (contagem direta de chamadas `app.get/post/patch/put/delete`
  nos arquivos `routes.ts` de todos os módulos + `app.ts`), agrupadas em **17 módulos de
  domínio** dentro de `apps/api/src/modules/`: `attendance-settings`, `audit`, `auth`,
  `conversations` (o maior, com 35 rotas — inclui mensagens dentro do mesmo agrupamento
  lógico de conversa), `dashboard`, `departments`, `integrations` (Azevedo-OS e o lembrete de
  cobrança do Financeiro), `messages`, `permissions`, `quick-replies`, `reports`,
  `scheduled-messages`, `search`, `tags`, `users`, `whatsapp-instances`.
- **Autenticação**: `Authorization: Bearer <JWT>` em praticamente toda rota, verificado pelo
  preHandler `authenticate` (`apps/api/src/lib/auth.ts`). A exceção conhecida e isolada é a
  rota de integração do Financeiro (`POST /integrations/financeiro/lembrete`), que usa um
  bearer estático próprio, não o JWT de sessão.
- **Autorização**: majoritariamente por chave de permissão (`requirePermission`/
  `loadPermissions().assert()`, catálogo em `packages/shared/src/permissions.ts`), com um
  conjunto pequeno e deliberado de ações fixas por `requireRole("admin")` (criar usuário,
  excluir número, tela de Permissões, etc.). Visibilidade de conversa (quem vê qual conversa)
  é uma camada **separada** de "o que a pessoa pode fazer", decidida só por
  `apps/api/src/lib/access.ts` — nunca por `if` de papel dentro de um handler.
- **Validação**: Zod em toda rota, inclusive parâmetros de URL (`z.string().uuid()`).
- **Tratamento de erro**: classes próprias em `lib/errors.ts` (`AppError`, `NotFoundError`,
  `ForbiddenError`, `UnauthorizedError`) capturadas por um handler global — nenhuma rota
  vaza stack trace ou detalhe interno.
- **Rate limit**: global de 300 requisições/minuto (`@fastify/rate-limit`), com limites mais
  apertados (5–10/min) em login e troca de senha.

### Tempo real (Socket.IO)

- **12 eventos** definidos em `packages/shared/src/realtime.ts` (fonte única — nomes de
  evento nunca são string solta no resto do código): `message:new`, `message:status`,
  `message:reaction`, `message:updated`, `call:incoming`, `conversation:updated`,
  `conversation:read`, `group:participants`, `note:new`, `conversation:pinned-items`,
  `instance:status`, `instance:qr`, `scheduled:pending`, mais `session:closing`/
  `session:closed` (aviso de fim de janela de login).
- **Audiência decidida por sala**, nunca por broadcast geral: `user:<userId>` (todas as abas
  de uma pessoa — usado só para leitura de conversa e avisos de sessão),
  `org:<organizationId>` (só admin), `instance:<instanceId>` (status/QR de um número, sem
  conteúdo de conversa), `sup:<instanceId>:<departmentKey>` (supervisores),
  `free:<instanceId>:<departmentKey>` (conversa sem responsável),
  `mine:<instanceId>:<departmentKey>:<userId>` (conversa atribuída). Cada socket cai em uma
  sala por evento, então não há entrega duplicada. Duas funções centralizam o cálculo de
  audiência (`conversationAudience` e `instanceAudience`), e o princípio documentado é que
  "o que não pode ser buscado por API também não chega pelo socket".

---

## 11. Autenticação e controle de acesso

- **Login**: `POST /auth/login` recebe e-mail e senha, valida a senha com `bcrypt.compare`
  contra o hash guardado, confere se o usuário está `active`, confere a **janela de horário
  de login** (quando ligada, e não para supervisor/admin), e devolve um JWT assinado
  (`@fastify/jwt`) com o payload contendo o id do usuário, papel e organização. Falha de
  senha e bloqueio por horário são ambos auditados (`AuditLog`).
- **Papéis**: três — `admin`, `supervisor`, `agent` (exibido como "Usuário" na interface).
  Hierarquia definida em `packages/shared/src/enums.ts` (`hasRole`), usada tanto por
  `requireRole()` na API quanto pelo menu de navegação do frontend, para os dois nunca
  divergirem.
- **Onde a regra de "quem vê o quê" é decidida**: em um único lugar,
  `apps/api/src/lib/access.ts`. Em texto: administrador enxerga a organização inteira, sem
  filtro; supervisor enxerga todas as conversas dos departamentos marcados para ele, mas só
  dentro dos números de WhatsApp vinculados ao login dele; usuário comum tem o mesmo recorte
  de número/departamento do supervisor, mas só vê as conversas atribuídas a ele mais as que
  ainda não têm responsável. Um número não vinculado ao login **nunca aparece**, nem para
  supervisor; sem nenhum número ou departamento marcado, o usuário não vê conversa alguma —
  não existe "sem marcação enxerga tudo".
- **Separação explícita entre permissão (ação) e visibilidade (alcance)**: uma chave de
  permissão dá poder sobre o que a pessoa **já** enxerga por `access.ts`; nenhuma chave amplia
  esse recorte. Não existe (por desenho) uma permissão do tipo "ver todas as conversas".
- **A sessão é revalidada a cada requisição contra o banco**, não confiando apenas no JWT: o
  token é tratado como "foto do passado" — desativar ou rebaixar um usuário, ou mudar a janela
  de horário permitido, vale imediatamente na próxima requisição autenticada, sem precisar
  relogar. O handshake do socket faz a mesma revalidação, e uma mudança de papel/status
  derruba as conexões de socket abertas daquele usuário.
- **A organização nunca fica sem um administrador ativo** — rebaixar ou desativar o último
  admin é recusado dentro de uma transação com linhas travadas no banco.

---

## 12. Qualidade e dívida técnica

### Testes

Executados nesta inspeção (`pnpm -r test`), com o ambiente instalado do zero e o Prisma
Client gerado — resultado real, não estimado:

```
apps/api:            46 arquivos de teste — 677 testes passaram, 4 pulados
apps/web:            11 arquivos de teste — 123 testes passaram
packages/whatsapp:    8 arquivos de teste (7 rodaram, 1 pulado por completo) —
                      104 testes passaram, 9 pulados
packages/database:   sem testes (placeholder "no tests")
packages/shared:     sem testes (placeholder "no tests")

Total: 904 testes passaram, 13 pulados, 0 falharam.
```

Todos os testes são **unitários com Vitest** — não há suíte de integração contra um banco
Postgres real nem testes end-to-end de navegador. Os testes pulados no pacote `whatsapp`
(9 de 113, incluindo o arquivo inteiro `voice-note-send.test.ts`) são os que dependem do
binário `ffmpeg`, ausente neste ambiente de inspeção — o próprio projeto documenta esse
comportamento como intencional ("os testes de conversão se pulam sozinhos onde ele não
existe"), e o CI instala ffmpeg explicitamente para não deixar essa lacuna passar despercebida
em produção.

Cobertura por assunto, pelo nome dos arquivos: controle de acesso e permissões (`access`,
`permissions`, `permissions-routes`, `conversation-access`), ingestão e edição de mensagem
(`message-ingest-pipeline`, `message-ingest-media-retry`, `message-edit`,
`message-edit-inbound`, `message-quote`), regras de atribuição (`default-assignee`,
`conversation-assigned-to-all`), dashboard e relatórios (`dashboard-stats`,
`dashboard-metrics`, `report-slice`, `report-panel-consistency`, `report-metrics`), integração
com o Azevedo-OS (`azevedo-os-client`, `azevedo-os-link`, e o teste de frontend
`azevedo-os`), a rota de lembrete do Financeiro (`financeiro-lembrete`), áudio
(`normalize-audio`, `audio-container`, `outbound-audio`, `voice-note-send`), protocolo do
WhatsApp (`protocol-action`, `normalize`, `message-secret`, `lid`, `history-backfill`), entre
outros.

### Typecheck e lint

Executados nesta inspeção, ambos **passaram sem erro em todos os 5 pacotes com script**
(`apps/api`, `apps/web`, `packages/database`, `packages/shared`, `packages/whatsapp`):

```
pnpm -r typecheck  → Done em todos os pacotes, sem erro
pnpm -r lint       → Done em todos os pacotes, sem erro
pnpm -r build      → build do apps/web concluído com sucesso (Next.js compilou e gerou
                     as 18 páginas estáticas/dinâmicas; os demais pacotes não têm script
                     de build próprio, por serem consumidos como TypeScript fonte)
```

### Pontos de dívida conhecidos (arquivos grandes)

Os maiores arquivos do repositório, por linha:

| Arquivo | Linhas | Observação |
| --- | --- | --- |
| `apps/web/src/components/inbox/inbox-shell.tsx` | 2.422 | o maior do projeto — orquestra lista, chat e composer da Inbox inteira; o próprio `CLAUDE.md` já o reconhece como grande demais e evita crescê-lo mais (outros hooks, como o de não lidas, foram deliberadamente extraídos dele) |
| `apps/api/src/modules/conversations/routes.ts` | 1.799 | maior módulo de rotas — concentra conversa, arquivamento, notas, etiquetas, agendamento |
| `apps/web/src/app/(app)/dashboard/page.tsx` | 1.348 | tela de dashboard, com filtros, cards e gráficos na mesma página |
| `packages/whatsapp/src/qrcode/qrcode-provider.ts` | 1.209 | toda a implementação concreta sobre Baileys |
| `apps/api/src/modules/messages/routes.ts` | 1.170 | rotas de mensagem (editar, apagar, reagir, encaminhar, mídia) |
| `apps/api/src/services/instance-manager.ts` | 1.347 | orquestração provider ⇄ banco ⇄ socket |
| `apps/web/src/components/inbox/message-bubble.tsx` | 823 | renderização de cada balão de mensagem |

Um desenvolvedor novo que for mexer em conversa, mensagem ou na conexão com o WhatsApp vai
inevitavelmente passar por um desses arquivos grandes — vale reservar tempo de leitura antes
de estimar qualquer mudança que os toque.

### Dependências desatualizadas ou com vulnerabilidade conhecida

`pnpm audit --prod` (executado nesta inspeção) encontrou **12 avisos** (3 críticos, 5 altos,
4 moderados), todos em **dependências transitivas**, não em pacotes que o código do projeto
importa diretamente:

- **`fast-jwt`** (usada internamente por `@fastify/jwt`, que É usado diretamente para o login
  e a verificação de sessão) — a versão resolvida está abaixo da corrigida para várias falhas,
  incluindo duas classificadas como críticas por confusão de algoritmo/cache de JWT e bypass
  de autenticação com segredo HMAC vazio. **Isto merece atenção prioritária**, porque, ao
  contrário dos outros itens da lista, `fast-jwt` está no caminho direto da autenticação da
  aplicação (via `@fastify/jwt`). A correção prática é atualizar `@fastify/jwt` para uma
  versão que traga uma versão corrigida de `fast-jwt` — hoje `@fastify/jwt` está em `9.1.0`
  quando a major mais recente é `10.x`, então a atualização provavelmente exige subir a major
  do pacote.
- **`postcss`** (dependência transitiva do Next.js, usada só em build) — múltiplas falhas de
  leitura de arquivo arbitrário e XSS na saída de CSS, relevantes principalmente em contexto
  de build, não em runtime servido ao usuário final.
- **`sharp`** (dependência transitiva do Next.js, para otimização de imagem do próprio
  framework) — vulnerabilidades herdadas da biblioteca nativa `libvips`.
- **`deepmerge-ts`** (dependência transitiva da CLI do Prisma) — risco de exaustão de pilha
  processando objetos recursivos; superfície de exposição baixa, pois roda só em tempo de
  build/migração, nunca em runtime da API.

`pnpm -r outdated` mostra, entre outros, que **Next.js** (15.5.23 → 16.3.3), **Prisma**
(6.19.3 → 7.10.0), **Zod** (3.25.76 → 4.4.3), **@fastify/jwt** (9.1.0 → 10.2.2), **Baileys**
(6.7.24 → 7.0.0-rc14, ainda release candidate) e **TypeScript** (5.9.3 → 7.0.2) têm majors mais
novas disponíveis. Nenhuma foi testada por esta inspeção — subir major de qualquer uma delas
é trabalho de migração próprio, não um `pnpm update` simples, e deve ser orçado à parte se o
cliente quiser isso.

### O que eu olharia primeiro se fosse revisar a estrutura do zero

1. **`fast-jwt`/`@fastify/jwt`** — é autenticação de produção com CVEs conhecidos na cadeia;
   prioridade de segurança acima de qualquer refatoração de conveniência.
2. **`inbox-shell.tsx`** (2.422 linhas) e o par `conversations/routes.ts` +
   `instance-manager.ts` — são o coração do produto (a Inbox e a conexão com o WhatsApp), e
   são também os maiores e mais críticos arquivos do repositório. Qualquer trabalho de
   "chamadas via API" vai encostar nesses três.
3. **A ausência de teste de integração contra um Postgres real** — os testes atuais são bons
   e numerosos (904), mas todos unitários; um bug de interação entre Prisma e o schema real
   (índice, constraint, transação) não seria pego por eles.
4. **O caminho de escalabilidade da API** (instância única, stateful) — se o escopo do
   trabalho novo incluir volume maior de chamadas simultâneas ou mais números conectados,
   essa é a limitação de arquitetura mais séria hoje.

---

## 13. O que o desenvolvedor vai precisar

### Variáveis de ambiente (nomes, sem valores)

| Variável | Para que serve |
| --- | --- |
| `DATABASE_URL` | String de conexão do PostgreSQL usada pelo Prisma |
| `API_PORT` | Porta em que o Fastify escuta |
| `API_HOST` | Endereço em que o Fastify escuta |
| `WEB_ORIGIN` | Origem permitida no CORS (URL do frontend) |
| `JWT_SECRET` | Segredo de assinatura dos tokens de sessão |
| `JWT_EXPIRES_IN` | Validade do token de acesso |
| `WHATSAPP_SESSION_DIR` | Diretório onde as credenciais de sessão do Baileys são persistidas |
| `WHATSAPP_PROXY_URL` | Proxy HTTPS opcional para a conexão do WhatsApp (redes restritas) |
| `MEDIA_DIR` | Diretório onde os arquivos de mídia recebidos/enviados são guardados |
| `MEDIA_MAX_SIZE` | Tamanho máximo de upload, em bytes |
| `AZEVEDO_OS_API_URL` | URL base da API do sistema de gestão interno (integração opcional de leitura) |
| `AZEVEDO_OS_API_TOKEN` | Token de autenticação dessa mesma integração |
| `AZEVEDO_OS_WEB_URL` | Endereço da tela do sistema de gestão, usado para montar um link "abrir lá" |
| `AZEVEDO_OS_TIMEOUT_MS` | Timeout, em milissegundos, das chamadas a essa integração |
| `FINANCEIRO_LEMBRETE_TOKEN` | Token de serviço que autentica a rota de lembrete de cobrança (sentido inverso: outro sistema chamando o AZVCHAT) |
| `FINANCEIRO_WHATSAPP_INSTANCE_ID` | Id do número de WhatsApp usado para enviar esses lembretes |
| `NEXT_PUBLIC_API_URL` | URL da API que o frontend Next.js chama (pública, vai para o navegador) |
| `LOG_LEVEL` | Nível de verbosidade dos logs |

As duas integrações (Azevedo-OS e Financeiro) nascem **desligadas** quando as variáveis
correspondentes estão vazias — não travam o resto do sistema.

### Como subir o projeto localmente

Passo a passo, conforme `README.md` e confirmado pela execução real feita nesta inspeção
(exceto o passo de banco, que não foi executado por falta de Postgres neste ambiente):

1. Ter instalado: **Node.js 22**, **pnpm** (a versão exata, `10.33.0`, é fixada pelo
   `packageManager` do `package.json` — o `corepack enable`, já presente nos scripts e
   Dockerfiles, resolve isso automaticamente), **Docker** e **Docker Compose** (para subir o
   Postgres local mais fácil), e o binário de sistema **ffmpeg** (para os testes e o envio de
   áudio funcionarem por completo).
2. `pnpm install` na raiz do repositório — instala todos os workspaces de uma vez.
   **Atenção**: uma dependência do Baileys (`libsignal-node`) é puxada via Git por SSH
   (`git@github.com:...`); num ambiente sem chave SSH publicada no GitHub, o install falha,
   e é preciso reescrever a URL para HTTPS antes (o mesmo truque que o CI usa):
   ```
   git config --global url."https://github.com/".insteadOf "git@github.com:"
   git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   ```
3. `cp .env.example .env` e preencher pelo menos `DATABASE_URL` e `JWT_SECRET`.
4. Subir o Postgres (por exemplo, `docker compose up -d postgres`, usando o
   `docker-compose.yml` de desenvolvimento) e rodar `pnpm db:migrate` (aplica as 34
   migrations) seguido de `pnpm db:seed` (cria um usuário admin padrão,
   `admin@example.com` / `admin123` — **trocar antes de qualquer uso real**).
5. `pnpm dev` sobe API (porta 4000) e frontend (porta 3000) juntos.

### Quanto tempo leva a instalação e o primeiro build

Medido nesta inspeção, num ambiente já com Node/pnpm instalados e rede disponível:
- `pnpm install` (com o Prisma Client e as demais dependências, incluindo compilação nativa
  de `sharp`/`esbuild`): poucos segundos quando o pacote já está em cache local do pnpm; a
  primeira vez, sem cache, deve levar mais por causa dos downloads — **tempo exato "a frio"
  não confirmado** nesta inspeção, pois o ambiente já tinha parte dos pacotes resolvidos.
- `pnpm db:generate` (gerar o Prisma Client): menos de 1 segundo.
- `pnpm -r typecheck` + `pnpm -r lint` (5 pacotes): poucos segundos ao todo.
- `pnpm -r test` (todos os pacotes, 904 testes): ~12 segundos ao todo.
- `pnpm -r build` do frontend (Next.js, único pacote com build de produção): cerca de
  12 segundos de compilação.

Para orçamento, um ambiente limpo (clone + instalação de Node/pnpm/Docker do zero num
computador novo) deve ser estimado à parte — esta inspeção rodou num ambiente que já tinha as
ferramentas de base prontas.

### O que não dá para testar localmente, e por quê

- **Conexão real com o WhatsApp**: exige escanear um QR Code com um número de telefone de
  verdade e depende da rede não bloquear `web.whatsapp.com` — o próprio projeto documenta essa
  lacuna ("validar o pareamento QR em rede aberta" está na lista de pendências, porque o
  ambiente de desenvolvimento onde o time trabalha bloqueia esse domínio).
  **Chamadas de voz/vídeo reais** também exigem essa conexão de verdade.
- **A integração com o Azevedo-OS**: precisa das credenciais reais desse sistema externo, que
  não fazem parte deste repositório.
- **A rota de lembrete de cobrança do Financeiro**: mesma limitação — depende do outro sistema
  chamando de verdade.
- **Envio de mensagem de voz convertida de verdade**: precisa do ffmpeg instalado; sem ele os
  testes de conversão de áudio se pulam sozinhos (comportamento intencional, não falha).
- **Volume real de produção**: sem acesso ao banco de produção, não dá para reproduzir
  localmente o comportamento em escala (milhares de conversas/mensagens).

---

## 14. Perguntas em aberto

Itens que a inspeção não conseguiu responder e que o desenvolvedor externo provavelmente vai
precisar perguntar diretamente ao dono do sistema:

1. **Volume real de dados em produção** (linhas por tabela, principalmente `Message` e
   `Conversation`) — não confirmável sem acesso ao banco de produção.
2. **Especificação real do servidor de produção** (CPU, RAM, disco, sistema operacional
   exato) — o `DEPLOY.md` só recomenda um mínimo, não descreve o servidor real.
3. **Quantos números de WhatsApp estão conectados hoje em produção**, e se algum já sofreu
   qualquer restrição do WhatsApp.
4. **Qual é, na prática, o escopo desejado de "chamadas via API"**: apenas melhorar o registro
   passivo já existente (por exemplo, atender/recusar dentro do próprio app do WhatsApp
   continuando a ser feito por fora), ou construir algo que efetivamente processe áudio/vídeo
   de chamada — o que, como descrito na seção 8, não é uma extensão do Baileys, e sim uma
   frente de trabalho separada (API oficial de chamadas do WhatsApp Business, quando/se
   disponível, ou uma solução de telefonia integrada por fora).
5. **Se o caminho de deploy por SSH (`deploy.yml`) está de fato configurado hoje** — os
   segredos vivem no GitHub e não foram inspecionados aqui; o histórico do próprio
   `CLAUDE.md` registra um caso anterior em que esse workflow rodou "verde" sem executar nada,
   por falta de segredo configurado.
6. **Tempo real de execução do pipeline de deploy por SSH**, do início ao fim — não medido
   nesta inspeção.
7. **Política de rollback formal**, caso exista uma fora do que está documentado nos scripts.
8. **Prioridade de correção da cadeia `fast-jwt`** (seção 12) frente ao escopo orçado — vale
   alinhar se essa correção de segurança entra no mesmo contrato ou é tratada à parte.

---

## Verificação de segurança do próprio relatório

Antes de entregar este documento, ele foi relido inteiro por mim, item a item, checando cada
um dos pontos proibidos:

- Nenhum valor de variável de ambiente aparece — só nomes e o que cada uma faz (seção 13).
- Nenhum conteúdo do `.env` real foi lido nem citado (o arquivo `.env` não existe neste
  ambiente de inspeção; apenas `.env.example`, que já vem sem valores no repositório, foi
  lido).
- Nenhum dado de cliente (nome, telefone, CNPJ, conteúdo de mensagem) aparece — não houve
  acesso a banco de produção nesta inspeção, então não havia dado de cliente disponível para
  vazar.
- Nenhuma credencial de VPS, chave SSH, host, IP ou usuário de servidor aparece — a seção 5
  e 6 descrevem *como* o deploy funciona, sem citar nenhum valor real de host, usuário ou
  chave (que, de resto, também não estavam disponíveis nesta inspeção).
- Nenhum conteúdo da pasta `data/` ou de sessão do WhatsApp aparece — essa pasta não existe
  neste ambiente (está no `.gitignore` e nunca foi commitada, confirmado por
  `git log --all -- .env` e checagem do diretório).

**O relatório passou nessa revisão.**

Nenhum arquivo de código do projeto foi alterado durante esta inspeção — apenas dependências
foram instaladas localmente (`node_modules/`, ignorado pelo Git) para permitir rodar
typecheck, lint, testes e build de verdade.
