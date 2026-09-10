# AZVChat Comercial — análise da base atual e plano de execução

Resposta ao item 22 da especificação: o que já existe, o que suporta multiempresa,
onde pode vazar entre clientes, o que precisa nascer, e em que ordem.

Escrito lendo o código, não a documentação. Onde os dois divergiram, vale o código.

---

## 1. Resumo executivo

**A base é boa e a arquitetura acerta o essencial.** O sistema não precisa ser
reconstruído: 37 das 60 tabelas já carregam `organizationId`, as 23 restantes são
tabelas-filha alcançadas por um pai que o carrega, e a organização da sessão é relida
do BANCO a cada requisição, nunca do token. Isso último é o desenho mais forte
possível para SaaS, e já está pronto.

**O risco número um não é uma falha, é um método.** A fronteira entre clientes hoje
depende de alguém lembrar de escrever `organizationId` em cada consulta. Não achei
vazamento — o padrão está aplicado de forma consistente —, mas nada no sistema
IMPEDE a próxima consulta de esquecer. Com uma organização só, esquecer é invisível.
Com clientes pagantes, esquecer uma vez é o cliente A vendo a conversa do cliente B.
Trocar convenção por mecanismo é o trabalho mais importante deste projeto, e precisa
vir ANTES do Super Admin.

**O teto real é de infraestrutura, não de código.** A API é um processo único e com
estado: as sessões de WhatsApp de todos os clientes vivem na memória dele. Não é
impeditivo para o piloto e para os primeiros clientes, mas é o que decide quantos
cabem por servidor e o que cai junto quando ele cai.

---

## 2. O que já existe e serve ao SaaS

### 2.1 A organização como raiz

`Organization` já é a raiz do tenant, com relação declarada para **todas** as 37
tabelas de negócio. Não é um campo solto: é chave estrangeira em cada uma.

Tabelas com `organizationId` (37): `AiAgent`, `AiAutomation`, `AiKnowledgeSource`,
`AiProviderConfig`, `AiSession`, `AiSettings`, `AiUsageLog`, `AttendanceSettings`,
`AuditLog`, `AutomationExecution`, `AutomationFlow`, `Contact`, `Conversation`,
`ConversationAssignmentHistory`, `ConversationRead`, `CrmActivity`, `CrmLossReason`,
`CrmOpportunity`, `CrmOpportunityEvent`, `CrmPipeline`, `CrmProduct`, `CrmStage`,
`Department`, `FollowUpExecution`, `FollowUpRule`, `IntegrationToken`, `InternalNote`,
`Message`, `PersonProfile`, `PinnedItem`, `QuickReply`, `RolePermission`,
`ScheduledMessage`, `Tag`, `User`, `WhatsAppGroup`, `WhatsAppInstance`.

Tabelas sem (23): são junções (`UserDepartment`, `TagDepartment`,
`CrmPipelineDepartment`...), filhas de configuração (`FollowUpRuleStep`,
`CrmStageAction`, `AttendanceBusinessHours`...), versões (`AiAgentVersion`,
`AutomationFlowVersion`) e logs de execução. **Nenhuma delas é consultada sem passar
pelo pai** — conferi o caso de maior exposição, `GroupParticipant`, que tem rota
pública por id (`PATCH /group-participants/:id`) e filtra por
`group: { organizationId, ...groupScope(access) }`. O padrão está correto.

### 2.2 A identidade do tenant vem do banco, não do token

`createSessionVerifier` (`apps/api/src/lib/auth.ts`) relê usuário, papel, status e
**organizationId** do banco a cada requisição autenticada, usando do token apenas o
id do usuário. Consequência para o SaaS: token adulterado, roubado ou antigo não
consegue trocar de organização, e mover um usuário de empresa vale na requisição
seguinte, sem esperar o token vencer.

Isso normalmente é o item mais caro de consertar num sistema que vira SaaS. Aqui já
está certo.

### 2.3 Configuração por organização já é o padrão

Três tabelas já são "uma linha por organização" e são exatamente o molde do que a
especificação pede em personalização (item 8):

- `AttendanceSettings` (+ `AttendanceBusinessHours`, `AttendanceLoginHours`) — horário
  de atendimento, SLA, fuso, janela de login;
- `AiSettings` e `AiProviderConfig` — orçamento, política, credencial cifrada;
- `RolePermission` — o catálogo de permissões é código, mas **o que cada organização
  liga ou desliga é linha no banco dela**, e ausência de linha significa o padrão de
  fábrica. É o desenho certo: mudar um padrão no código passa a valer para todo mundo
  que não configurou.

Departamentos, etiquetas, respostas rápidas, fluxos de automação, regras de
follow-up, agentes de IA, base de conhecimento e funis de CRM já são todos por
organização. **A maior parte do item 8 da especificação já existe** — falta logo,
nome de exibição e identidade visual.

### 2.4 O interruptor de módulo já existe, e é o molde dos planos

`Organization.crmEnabled` é uma bandeira de recurso por organização, com a guarda
rodando ANTES da chave de permissão (`crmGuard`), o menu sumindo pela sessão
(`user.features`) e o desligamento cancelando trabalho pendente sem apagar dado.

Esse é precisamente o mecanismo que os planos e limites do item 11 precisam. Não
inventar outro: generalizar este.

### 2.5 Tempo real já é recortado

As salas do Socket.IO são por organização, número, departamento e responsável
(`org:<id>`, `instance:<id>`, `sup:`, `free:`, `mine:`). Evento de uma organização
não tem caminho até a aba de outra.

### 2.6 Arquivos

Mídia de mensagem é gravada sob o id da instância (uuid único), e a leitura é sempre
por rota autenticada que resolve a mensagem dentro da organização antes de ler o
arquivo, com proteção contra path traversal. Mídia de resposta rápida usa prefixo
`quick-replies-<organizationId>`. Não há vazamento, mas o prefixo por organização é
mais legível e é o que eu adotaria no Comercial.

---

## 3. O risco estrutural número um

### 3.1 O que encontrei

`conversationScope(access)` — a função que todo mundo usa para recortar conversa —
**não inclui `organizationId`**. Ela filtra por número, departamento e responsável.
Para um `admin`, cujos três são nulos, ela devolve `{}`: filtro vazio.

Quem põe a organização é cada rota, à mão:

```ts
const where = {
  organizationId: request.user.organizationId,   // <- escrito a cada vez
  ...conversationScope(access),
};
```

Levantei o número: **550 consultas** a tabelas com `organizationId` no código da API.
Dessas, 223 trazem o filtro explícito ou um helper que o carrega; as demais dependem
de estarem ancoradas num id de pai já validado. Amostrei as mais suspeitas (as que
devolvem conjunto ou alteram em massa, sem âncora aparente) e **todas as que conferi
estavam corretas**, montando o `where` numa variável antes.

**Não há vazamento conhecido hoje.** O que há é uma fronteira sustentada por
disciplina.

### 3.2 Por que isso muda de gravidade no SaaS

Hoje existe uma organização. Uma consulta que esqueça o filtro devolve exatamente o
mesmo resultado, e o defeito não tem sintoma — pode ser escrito, revisado, testado e
publicado sem ninguém notar. No dia em que a segunda empresa entrar, aquela mesma
consulta passa a devolver dados dela. O defeito não nasce no dia do vazamento; ele
já está lá, dormindo, e o cliente novo é que o acorda.

É o mesmo formato do defeito do `atualizar.sh` que consertamos: dormente porque a
condição que o revelava ainda não existia.

### 3.3 O que fazer

Três camadas, da mais barata para a mais forte. Recomendo as três, nesta ordem:

**a) Teste que reprova o esquecimento.** No molde do
`apps/api/test/permissions.test.ts`, que já varre as rotas e reprova comparação de
papel solta. Um teste equivalente que varra as consultas a tabelas de tenant e exija
filtro de organização ou âncora reconhecida. Custo baixo, pega o erro na hora de
escrever.

**b) Cliente Prisma escopado por requisição.** Uma extensão (`$extends`) que injeta
`organizationId` automaticamente em toda consulta às tabelas de tenant, e que falha
alto quando a requisição não tem organização definida. As rotas passam a receber um
prisma já amarrado ao tenant, e esquecer deixa de ser possível em vez de ser
proibido.

**c) Row Level Security no Postgres.** A fronteira passa a ser do BANCO: mesmo uma
consulta errada, ou um `psql` na mão, não alcança linha de outro tenant. É a única
camada que protege contra o erro que as outras duas não previram. Mais trabalhosa, e
o motivo de eu recomendá-la mesmo assim é simples: das três, é a única que continua
valendo quando alguém escrever SQL cru — e o sistema já tem SQL cru
(`loadActivityBuckets`, no dashboard).

**Isto precisa estar pronto antes do primeiro cliente pagante**, e antes do Super
Admin, pelo motivo da seção 7.

---

## 4. O que não existe e precisa nascer

### 4.1 Não há nível de plataforma

`UserRole` é `admin | supervisor | agent`, e os três vivem DENTRO de uma organização.
`requireRole("admin")` significa "administrador daquele escritório", não da
plataforma. Não existe hoje nenhum caminho que atravesse organizações.

**Não acrescente `superadmin` ao enum `UserRole`.** A hierarquia `hasRole` é comparada
em dezenas de pontos, na API e no menu do frontend, sempre com a pergunta "este papel
alcança aquele?". Um valor novo no topo passaria a responder "sim" a perguntas que
nunca foram feitas sobre ele, e o resultado seria um Super Admin recebendo, por
acidente, permissões de atendimento dentro de uma organização qualquer.

O caminho seguro é uma **dimensão separada**: uma tabela própria de operador de
plataforma, com autenticação própria, sessão própria e rotas sob um prefixo próprio
(`/platform/...`), que nunca passam pelo `authenticate` de organização. Um operador
da plataforma não é um usuário com papel maior; é outra coisa.

### 4.2 A organização é quase vazia

Hoje `Organization` tem `name`, `crmEnabled`, `createdAt`, `updatedAt`. A
especificação (itens 6 e 7) pede: razão social, nome fantasia, CNPJ, responsável,
telefone, e-mail, plano, data de início, status.

### 4.3 Não existe status nem suspensão

Suspender empresa sem apagar dado (item 6) não tem nenhum mecanismo. Precisa decidir
o que "suspenso" faz: bloqueia login? mantém o WhatsApp conectado recebendo? para as
automações e a IA? A resposta certa provavelmente é: **recebe e guarda, mas não
envia e não automatiza** — o cliente que voltar não perde o histórico do período, e o
escritório dele não continua atendendo de graça.

### 4.4 Não existe plano nem limite

Nada de plano, faixa ou teto. O molde para construir é o `crmEnabled`: bandeira por
organização, lida por uma guarda que roda antes da permissão.

### 4.5 Não existe provisionamento

Criar organização hoje é `INSERT` na mão. O item 7 pede criar empresa + primeiro
administrador + configurações padrão numa operação só. Já existe um seed
(`packages/database/src/seed.ts`, com `SEED_ADMIN_*`) e um bootstrap sob demanda no
CRM (`lib/crm-bootstrap.ts`) — os dois são a matéria-prima.

---

## 5. Riscos técnicos de escala

**A API é um processo único e com estado.** As sessões do Baileys vivem na memória do
`instance-manager`; a fila de turnos da IA é em memória; os agendadores são
`setInterval` no processo. Isso significa:

1. **Todos os clientes num processo.** Ele cair derruba o WhatsApp de todo mundo ao
   mesmo tempo, e voltar é reconectar todas as sessões de uma vez.
2. **Não dá para rodar duas APIs.** Duas instâncias disputariam a mesma sessão de
   WhatsApp. O `web` escala à vontade; a API, não.
3. **O teto por servidor é de memória e de sessões**, não de código.

Não é impeditivo para o piloto nem para os primeiros clientes, e não recomendo
resolver agora — mas é o que precisa ser medido durante o piloto (item 17), porque é
ele que define quantos clientes cabem antes de precisar separar por servidor.

**Outros dois pontos:**

- `AI_SECRETS_KEY` deriva do `JWT_SECRET` quando não é definida. No Comercial,
  defina-a explicitamente e guarde à parte: trocar o `JWT_SECRET` com ela derivada
  invalida as chaves de IA de todos os clientes de uma vez.
- Mídia em disco local. A interface `MediaStorage` já está pronta para um driver S3,
  mas ele não existe. Com vários clientes, isso vira limite de disco e complicação de
  backup.

---

## 6. Migrations previstas

Nenhuma delas altera dado existente; todas acrescentam.

1. `Organization` ganha campos comerciais (razão social, fantasia, CNPJ, responsável,
   telefone, e-mail, data de início) e `status` (`active | suspended | trial | ...`,
   nascendo `active` para não suspender ninguém no deploy).
2. `Plan` (ou tabela de planos) + `Organization.planId` + tabela de limites por plano.
   Limites em linha, não em código, pelo motivo do item 10 da especificação.
3. `PlatformOperator` (Super Admin) com autenticação própria.
4. `PlatformAuditLog` — auditoria das ações de plataforma, separada da `AuditLog` de
   cada organização, senão o registro do operador cai dentro do tenant que ele
   administrou.
5. Índices compostos começando por `organizationId` nas tabelas de maior volume
   (`Message`, `Conversation`). Com uma organização, o índice atual serve; com muitas,
   é o que separa consulta rápida de varredura.
6. Se for adotado RLS: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + policies, e um
   papel de aplicação no Postgres que não seja superusuário (superusuário ignora RLS,
   e é com ele que a aplicação conecta hoje).

---

## 7. Plano de execução

Segue a ordem da especificação, com **uma divergência**, explicada abaixo.

### Etapa 0 — Duplicação e isolamento (Fases 1 a 5)

Repositório novo, VPS nova, banco novo, segredos novos, domínios novos. Banco vazio,
nada copiado do Interno.

**Uma recomendação contra a especificação:** o item 2 pede remover completamente o
vínculo Git. Sugiro remover o vínculo de ESCRITA e manter o de LEITURA — o Interno
como `upstream`, sem permissão de push. O motivo é prático: os dois sistemas partem
do mesmo código, e correção de defeito no Interno vai querer atravessar. Com o
upstream, é `git merge`; sem ele, é achar o commit e copiar à mão, para sempre. A
garantia que a especificação quer ("nenhum push pode atingir o Interno") se obtém
apontando o push do upstream para um endereço inválido, que é verificável e à prova
de distração.

Fica registrado que é sugestão. Se preferir o corte total, o corte total funciona.

### Etapa 1 — Validar o que já existe (Fase 6)

Subir e testar a lista do item 16 no ambiente novo, com uma organização. Nada de
funcionalidade nova antes disso: é o que separa "defeito que eu introduzi" de
"defeito que veio junto".

### Etapa 2 — Tornar o isolamento um MECANISMO (Fases 7 e 10, antecipadas)

**Esta é a divergência.** A especificação coloca o Super Admin na Fase 8 e o
isolamento absoluto na Fase 10. Recomendo inverter.

O Super Admin é, por definição, o único ator que atravessa organizações. Construí-lo
sobre uma fronteira que depende de alguém lembrar de filtrar é construir a coisa mais
perigosa do sistema sobre a parte mais frágil dele. Além disso, a partir do Super
Admin existirão consultas que legitimamente veem várias organizações, e distinguir
"esta vê várias porque deve" de "esta vê várias porque esqueceram" fica muito mais
difícil depois que as duas coexistem.

O que fazer aqui: as três camadas da seção 3.3 (teste que reprova, prisma escopado,
RLS) e a auditoria de tenancy consulta a consulta.

### Etapa 3 — Prova de isolamento com duas organizações (Fase 13, antecipada)

Também antes do Super Admin. Duas organizações com dados parecidos, e um teste
automatizado que tenta alcançar o dado da outra por cada rota. Automatizado, não
manual: é o teste que vai rodar em todo deploy pelos próximos anos.

### Etapa 4 — Organização como entidade comercial (parte da Fase 9)

Migration dos campos comerciais e do `status`, mais a suspensão. Sem tela ainda.

### Etapa 5 — Super Admin (Fases 8 e 9)

Agora sim, sobre fronteira garantida. Autenticação separada, rotas sob prefixo
próprio, auditoria própria. Telas: lista de empresas, criar empresa com primeiro
administrador e configurações padrão, suspender, reativar, ver consumo.

### Etapa 6 — Planos e limites (Fase 11)

Planos e limites em tabela. A guarda no molde do `crmGuard`. Recomendo começar
limitando **usuários e números de WhatsApp**, que são os dois que têm custo real e
são fáceis de contar, e deixar o resto preparado sem estar ligado.

### Etapa 7 — Personalização por organização (Fase 12)

Logo, nome de exibição e identidade visual. O resto do item 8 já existe.

### Etapa 8 — Piloto (Fases 14 e 15)

Um cliente. Medir o que a seção 5 aponta: memória por sessão, comportamento com dois
clientes recebendo ao mesmo tempo, tempo de reconexão após restart.

### Etapa 9 — Escala (Fase 16)

Só depois do piloto, e com número medido em vez de estimado.

---

## 8. O que eu NÃO faria agora

- Separar a API em vários processos ou introduzir fila (Redis/BullMQ). É solução para
  um problema que ainda não tem número; medir no piloto primeiro.
- Driver S3. Disco local aguenta o piloto, e a interface já está pronta para o dia em
  que não aguentar.
- Pagamento, checkout, cadastro público — a própria especificação já os adiou, e com
  razão.
- Trocar o desenho de permissões. O catálogo por organização já resolve o item 8, e
  mexer nele agora arrisca o que funciona.

---

## 9. Resposta direta às perguntas do item 22

| Pergunta | Resposta |
| --- | --- |
| O que já existe? | Organização como raiz em 37 tabelas, sessão amarrada ao banco, configuração por organização, permissões por organização, salas de tempo real recortadas, interruptor de módulo |
| O que já suporta multiempresa? | O modelo de dados inteiro e a camada de sessão |
| Como funciona a organização hoje? | Raiz do tenant, com FK em todas as tabelas de negócio; a sessão a relê do banco a cada requisição |
| Quais tabelas têm vínculo? | 37 de 60, listadas na seção 2.1 |
| Quais precisam de isolamento? | Nenhuma tabela; o que precisa de isolamento é o CAMINHO DE CONSULTA (seção 3) |
| Como as sessões de WhatsApp se vinculam? | Por `WhatsAppInstance`, que carrega `organizationId`; arquivos de sessão separados por instância em volume |
| Como funcionam usuários e permissões? | `User` por organização; catálogo de ações no código, configuração em `RolePermission` por organização; admin passa por cima |
| Onde pode vazar? | Consulta que esqueça `organizationId` — hoje nenhuma que eu tenha encontrado, mas nada impede a próxima |
| O que muda para o Super Admin? | Dimensão nova, fora de `UserRole`; autenticação, rotas e auditoria próprias |
| O que da Fase 5 já está pronto? | O ambiente isolado por instância já é rotina (ver `deploy/instancia/DUPLICAR.md`) |
| Riscos técnicos | Fronteira por convenção; API de processo único com estado; `AI_SECRETS_KEY` derivada; mídia em disco local |
| Dependências | Nenhuma biblioteca nova obrigatória; RLS exige papel de aplicação não superusuário no Postgres |
| Migrations | Seção 6 |
