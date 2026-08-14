# Guia de Deploy — AZVCHAT em produção (VPS)

Passo a passo para colocar o sistema no ar num servidor Linux, com HTTPS automático. Tempo estimado: 30–45 minutos.

## O que você precisa

1. **Uma VPS** (servidor virtual sempre ligado) com Ubuntu 24.04:
   - Mínimo recomendado: **2 vCPU, 4 GB de RAM, 40 GB de disco**;
   - Opções populares: Hetzner (CX22, ~€4/mês), DigitalOcean, Vultr, Contabo, Hostinger VPS.
2. **Um domínio** que você controle (ex.: `advogadosazevedo.com.br`), para criar dois subdomínios:
   - `app.seudominio.com.br` → interface do sistema;
   - `api.seudominio.com.br` → API/WhatsApp.

## Passo 1 — Criar a VPS

Crie o servidor com Ubuntu 24.04 no provedor escolhido e anote o **IP público** (ex.: `203.0.113.10`). Guarde a chave/senha SSH que o provedor fornecer.

## Passo 2 — Apontar o DNS

No painel do seu domínio (Registro.br, Cloudflare, GoDaddy...), crie **dois registros A**:

| Tipo | Nome | Valor |
| --- | --- | --- |
| A | `app` | IP da VPS |
| A | `api` | IP da VPS |

Se usar Cloudflare, deixe o proxy (nuvem laranja) **desligado** (DNS only) pelo menos até o primeiro certificado ser emitido.

## Passo 3 — Acessar a VPS e instalar o Docker

No seu computador:

```bash
ssh root@IP_DA_VPS
```

Dentro da VPS:

```bash
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
```

Firewall básico (opcional, recomendado):

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

## Passo 4 — Baixar o projeto

```bash
git clone https://github.com/contato453/Whatsapp.git
cd Whatsapp
git checkout claude/whatsapp-support-platform-ezyvx0
```

> Repositório privado? Gere um Personal Access Token no GitHub (Settings → Developer settings → Tokens) e use `https://SEU_TOKEN@github.com/contato453/Whatsapp.git`.

## Passo 5 — Configurar o ambiente de produção

Crie o arquivo `.env` na raiz do projeto:

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
APP_DOMAIN=app.seudominio.com.br
API_DOMAIN=api.seudominio.com.br
EOF
nano .env   # confira e ajuste os domínios
```

⚠️ Troque `seudominio.com.br` pelos seus subdomínios reais. As senhas já são geradas aleatórias.

## Passo 6 — Subir o sistema

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

A primeira execução demora alguns minutos (build das imagens). Acompanhe com:

```bash
docker compose -f docker-compose.prod.yml logs -f api
```

Quando aparecer `api_started`, está no ar. O Caddy emite os certificados HTTPS automaticamente na primeira visita (o DNS do Passo 2 precisa já estar propagado).

## Passo 7 — Criar o usuário admin

```bash
docker compose -f docker-compose.prod.yml exec \
  -e SEED_ADMIN_EMAIL=voce@seudominio.com.br \
  -e SEED_ADMIN_PASSWORD='UmaSenhaForteAqui' \
  -e SEED_ADMIN_NAME='Seu Nome' \
  -e SEED_ORG_NAME='Nome do Escritório' \
  api pnpm --filter @azvchat/database seed
```

## Passo 8 — Usar

1. Acesse `https://app.seudominio.com.br` e faça login;
2. Vá em **WhatsApp → Adicionar WhatsApp → Conectar** e escaneie o QR Code;
3. Cadastre os usuários em **Usuários** (cada um com sua senha e papel);
4. Use **Editar** no usuário para ajustar dados, senha, situação e marcar a quais
   números de WhatsApp ele tem acesso (sem marcação = todos os números);
5. As sessões ficam no volume `whatsapp_sessions` — sobrevivem a deploys e reboots.

## Operação do dia a dia

**Atualizar o sistema** (novas versões do código):

```bash
cd ~/Whatsapp
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

As migrations rodam sozinhas no start da API. As sessões do WhatsApp **não caem** — nada de QR de novo.

### Migração única: renomear o banco de `zapdesk` para `azvchat`

Só é necessário em instalações que subiram **antes** da renomeação do sistema para AZVCHAT. Instalação nova já nasce com os nomes corretos e pode pular esta seção.

O Postgres só cria usuário e banco quando o volume está vazio. Num servidor que já rodou, o volume tem `zapdesk` gravado, e as variáveis novas do compose são ignoradas — então a API sobe apontando para um usuário que não existe e não conecta.

O banco pode ser renomeado, mas o **usuário não**: `zapdesk` é o único superusuário do cluster, e o PostgreSQL recusa `ALTER ROLE ... RENAME` quando a role é a da própria sessão (`session user cannot be renamed`). A saída é criar a role nova e transferir a posse dos objetos. Rode o bloco abaixo inteiro — ele é idempotente e pode ser repetido:

```bash
cd ~/Whatsapp
PC="docker compose -f docker-compose.prod.yml exec -T postgres"

# 1. Pare a API (o banco continua no ar)
docker compose -f docker-compose.prod.yml stop api

# 2. Descubra qual superusuário existe no volume
SU=""
for c in zapdesk azvchat postgres; do
  $PC psql -U "$c" -d postgres -tAc "select 1" >/dev/null 2>&1 && { SU="$c"; break; }
done
echo "superusuário = ${SU:?nenhum superusuário encontrado}"

# 3. Renomeie o banco, se ainda estiver com o nome antigo
$PC psql -U "$SU" -d postgres -tAc "select 1 from pg_database where datname='zapdesk'" | grep -q 1 \
  && $PC psql -U "$SU" -d postgres -c "ALTER DATABASE zapdesk RENAME TO azvchat;"

# 4. Crie (ou ajuste) o usuário azvchat com uma senha nova só em hex
NEWPW=$(openssl rand -hex 24)
if $PC psql -U "$SU" -d postgres -tAc "select 1 from pg_roles where rolname='azvchat'" | grep -q 1; then
  $PC psql -U "$SU" -d postgres -c "ALTER ROLE azvchat WITH LOGIN SUPERUSER PASSWORD '$NEWPW';"
else
  $PC psql -U "$SU" -d postgres -c "CREATE ROLE azvchat WITH LOGIN SUPERUSER PASSWORD '$NEWPW';"
fi
$PC psql -U "$SU" -d postgres -c "ALTER DATABASE azvchat OWNER TO azvchat;"
[ "$SU" != "azvchat" ] && $PC psql -U azvchat -d azvchat -c "REASSIGN OWNED BY $SU TO azvchat;"

# 5. Grave a senha nova no .env (o antigo fica em .env.bak)
cp .env .env.bak
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEWPW|" .env

# 6. Confirme a credencial pelo mesmo caminho que o Prisma usa (TCP + senha)
$PC sh -c "PGPASSWORD='$NEWPW' psql -h 127.0.0.1 -U azvchat -d azvchat -tAc \"select current_user||' @ '||current_database()\""

# 7. Suba tudo de novo
docker compose -f docker-compose.prod.yml up -d --build
```

O passo 6 precisa imprimir `azvchat @ azvchat`. Se imprimir, a API conecta; se falhar ali, não adianta subir — o erro está no banco, não na aplicação.

Sobre a senha nova: gerar em hex evita que caracteres como `@`, `#`, `/` ou `:` quebrem a `DATABASE_URL` montada pelo compose. Reaproveitar a senha antiga também funciona, desde que ela seja alfanumérica e você aplique o mesmo valor no `ALTER ROLE` e no `.env` — mas o rename de role em cluster migrado de md5 apaga a senha, então reaplicá-la é obrigatório de qualquer forma.

Nada de dados é perdido: renomear o banco e trocar o dono não toca nas tabelas. As sessões de WhatsApp ficam em volume separado e também não são afetadas — nenhum número precisa reconectar. Depois de confirmar que está tudo no ar, apague o backup do env: `rm .env.bak`.

**Ver logs**:

```bash
docker compose -f docker-compose.prod.yml logs -f api    # backend/WhatsApp
docker compose -f docker-compose.prod.yml logs -f web    # frontend
```

**Reiniciar**:

```bash
docker compose -f docker-compose.prod.yml restart api
```

**Backup** (rode periodicamente — cron ou manual):

```bash
# Banco de dados
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U azvchat azvchat | gzip > backup-$(date +%F).sql.gz

# Sessões do WhatsApp + mídias (volumes)
docker run --rm -v whatsapp_whatsapp_sessions:/s -v whatsapp_media_store:/m -v $(pwd):/out \
  alpine tar czf /out/volumes-$(date +%F).tar.gz /s /m
```

Copie os arquivos de backup para fora da VPS (Google Drive, S3, outro servidor).

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| Site não abre / certificado inválido | DNS ainda não propagou | Aguarde até 1h; teste `ping app.seudominio.com.br` |
| QR Code não aparece | API sem acesso à internet ou firewall de saída | `docker compose ... logs api` e verifique erros de conexão |
| "Erro interno" ao usar | Migration pendente | `docker compose ... restart api` (roda `migrate deploy` no boot) |
| Sessão caiu e não reconecta | Celular ficou muito tempo offline ou sessão revogada | Reconecte pelo QR em /whatsapp |
| Esqueci a senha do admin | — | `docker compose -f docker-compose.prod.yml exec -e RESET_EMAIL=seu@email.com -e RESET_PASSWORD='NovaSenha' api node packages/database/scripts/reset-password.mjs` |

## Segurança — checklist final

- [ ] Senha do admin forte (definida no Passo 7, nunca `admin123`);
- [ ] `.env` da VPS nunca commitado nem compartilhado;
- [ ] Firewall ativo (somente portas 22, 80, 443);
- [ ] Backups automáticos configurados;
- [ ] Cada pessoa com seu próprio usuário (não compartilhe logins);
- [ ] Número de WhatsApp dedicado ao atendimento (integração QR não é oficial — risco de banimento existe).
