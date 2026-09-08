#!/usr/bin/env bash
# ==============================================================
# Atualiza a instalação da VPS com o que está na branch padrão.
#
# É a alternativa ao deploy por SSH: em vez de o GitHub entrar aqui
# (o que exige chave privada guardada como segredo), a própria VPS
# busca o código novo. Nada de segredo, nada de porta a mais aberta.
#
# A STACK É A `azvchat2` (docker-compose.azvchat2.yml + .env.azvchat2),
# NUNCA a `docker-compose.prod.yml` da raiz — a mesma regra do
# .github/workflows/deploy.yml, e pelo mesmo motivo (CLAUDE.md §11,
# achado de 05/09/2026): os domínios reais servem os containers
# azvapi/azvweb/azvpg desta stack, e a `prod` ainda declara um serviço
# `caddy`. O Caddy vivo foi reconfigurado por dentro, pela API admin da
# porta 2019, sem que o Caddyfile em disco acompanhasse — subir a `prod`
# trocaria a configuração em memória pela do disco e derrubaria
# app.azvchat.com.br e api.azvchat.com.br. Não é degradação, é queda.
#
# Rode na mão (`bash deploy/atualizar.sh`) ou deixe o timer do
# systemd chamando sozinho — veja deploy/instalar-atualizacao-automatica.sh
#
# Sem novidade no repositório, sai em silêncio e não mexe nos
# containers: dá para chamar de minuto em minuto sem custo.
# ==============================================================
set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-claude/whatsapp-support-platform-ezyvx0}"
RAIZ="${DEPLOY_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE="${DEPLOY_COMPOSE:-docker-compose.azvchat2.yml}"
ENV_FILE="${DEPLOY_ENV_FILE:-.env.azvchat2}"
# Nesta stack o serviço da API se chama `azvapi`, não `api` — conferido
# contra o `docker compose ps` da azvchat2 (azvapi/azvpg/azvweb).
SERVICO_API="${DEPLOY_API_SERVICE:-azvapi}"
# `--force` sobe os containers mesmo sem commit novo (útil depois de
# mexer no .env ou para repetir um deploy que falhou no meio).
FORCAR="${1:-}"

cd "$RAIZ"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Os dois arquivos da stack viva NÃO estão no Git: vivem só na VPS, dentro
# do clone de trabalho. Faltando qualquer um deles, este não é o clone de
# onde a produção sobe — é provavelmente o /root/Whatsapp, que serve a
# stack morta. Parar aqui é o ponto todo: seguir em frente com um compose
# de outra pasta subiria a stack errada, que é justamente o que derruba os
# domínios. Errar o clone é o modo de falha mais provável deste script, e
# a checagem transforma queda silenciosa em recusa com endereço.
for arquivo in "$COMPOSE" "$ENV_FILE"; do
  if [ ! -f "$arquivo" ]; then
    log "ERRO: $arquivo não existe em $RAIZ."
    log "Este script sobe a stack azvchat2, e os arquivos dela ficam fora do"
    log "Git, no clone de trabalho da VPS. Rode a partir do clone certo —"
    log "confira com 'docker compose ls' e 'docker compose ps' qual stack"
    log "está de pé antes de mexer."
    exit 1
  fi
done

# Atalho para não repetir as duas flags em cada chamada: esquecer o
# --env-file numa delas faria o compose ler variável vazia e subir um
# container com configuração diferente das outras chamadas.
compose() { docker compose -f "$COMPOSE" --env-file "$ENV_FILE" "$@"; }

log "Verificando novidades em $BRANCH"
git fetch --quiet origin "$BRANCH"

atual="$(git rev-parse HEAD)"
remoto="$(git rev-parse "origin/$BRANCH")"

if [ "$atual" = "$remoto" ] && [ "$FORCAR" != "--force" ]; then
  log "Já está na versão mais recente ($(git rev-parse --short HEAD)). Nada a fazer."
  exit 0
fi

if [ "$atual" != "$remoto" ]; then
  log "Atualizando $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/$BRANCH")"
  git checkout --quiet "$BRANCH" 2>/dev/null || git checkout --quiet -b "$BRANCH" "origin/$BRANCH"
  # --ff-only falha em vez de criar merge: se alguém editou arquivo
  # versionado direto na VPS, a atualização para e avisa, em vez de
  # sobrescrever em silêncio.
  git merge --ff-only "origin/$BRANCH"
  log "Commit em produção: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
fi

log "Subindo os containers (stack azvchat2 — nunca a docker-compose.prod.yml)"
# As migrations rodam no boot da API; sessões de WhatsApp e mídias
# ficam em volumes nomeados e sobrevivem ao restart.
compose up -d --build

log "Estado dos containers"
compose ps

log "Esperando a API responder"
for _ in $(seq 1 20); do
  if compose logs --since 5m "$SERVICO_API" 2>/dev/null | grep -q api_started; then
    log "API no ar. Atualização concluída."
    exit 0
  fi
  sleep 5
done

log "ERRO: a API não registrou api_started em 100s. Últimas linhas do log:"
compose logs --tail=40 "$SERVICO_API"
exit 1
