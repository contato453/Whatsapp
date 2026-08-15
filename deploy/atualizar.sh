#!/usr/bin/env bash
# ==============================================================
# Atualiza a instalação da VPS com o que está na branch padrão.
#
# É a alternativa ao deploy por SSH: em vez de o GitHub entrar aqui
# (o que exige chave privada guardada como segredo), a própria VPS
# busca o código novo. Nada de segredo, nada de porta a mais aberta.
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
COMPOSE="docker-compose.prod.yml"
# `--force` sobe os containers mesmo sem commit novo (útil depois de
# mexer no .env ou para repetir um deploy que falhou no meio).
FORCAR="${1:-}"

cd "$RAIZ"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

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

log "Subindo os containers"
# As migrations rodam no boot da API; sessões de WhatsApp e mídias
# ficam em volumes nomeados e sobrevivem ao restart.
docker compose -f "$COMPOSE" up -d --build

log "Esperando a API responder"
for _ in $(seq 1 20); do
  if docker compose -f "$COMPOSE" logs --since 5m api 2>/dev/null | grep -q api_started; then
    log "API no ar. Atualização concluída."
    exit 0
  fi
  sleep 5
done

log "ERRO: a API não registrou api_started em 100s. Últimas linhas do log:"
docker compose -f "$COMPOSE" logs --tail=40 api
exit 1
