#!/usr/bin/env bash
# ==============================================================
# Confere se a produção está rodando o código que está no GitHub.
#
# POR QUE ISTO EXISTE: nesta instalação o deploy não tem nenhum sinal
# visível de fora. O workflow `Deploy` do GitHub fecha VERDE com todos os
# passos `skipped`, porque os segredos de SSH nunca foram cadastrados
# (CLAUDE.md §15, incidente de 16/08/2026) — quem publica é o timer do
# systemd chamando o deploy/atualizar.sh aqui dentro. E o `/health` da API
# responde só `{"status":"ok"}`, sem commit nem versão, então nem
# alcançando o domínio se sabe QUAL código está no ar.
#
# Resultado: "o deploy foi?" só se respondia abrindo a tela e procurando o
# recurso novo no olho. Este script responde com evidência: compara o
# commit do clone com o do GitHub, mostra QUANDO cada container foi criado
# (container antigo com commit novo = o código está no disco e não na
# imagem), confirma o api_started no log e bate nos dois domínios reais.
#
# É SOMENTE LEITURA. Não faz fetch destrutivo, não sobe, não derruba e não
# reinicia nada: pode rodar a qualquer hora, com o escritório trabalhando.
# Para de fato publicar, o script é o outro (deploy/atualizar.sh).
#
#   bash deploy/verificar.sh
# ==============================================================
set -uo pipefail

BRANCH="${DEPLOY_BRANCH:-claude/whatsapp-support-platform-ezyvx0}"
RAIZ="${DEPLOY_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE="${DEPLOY_COMPOSE:-docker-compose.azvchat2.yml}"
ENV_FILE="${DEPLOY_ENV_FILE:-.env.azvchat2}"
SERVICO_API="${DEPLOY_API_SERVICE:-azvapi}"
API_URL="${DEPLOY_API_URL:-https://api.azvchat.com.br}"
APP_URL="${DEPLOY_APP_URL:-https://app.azvchat.com.br}"

cd "$RAIZ" || { echo "ERRO: não consegui entrar em $RAIZ"; exit 1; }

titulo() { printf '\n== %s ==\n' "$1"; }
ok()     { printf '  OK    %s\n' "$1"; }
falta()  { printf '  FALTA %s\n' "$1"; PENDENCIAS=$((PENDENCIAS + 1)); }
aviso()  { printf '  nota  %s\n' "$1"; }
PENDENCIAS=0

# Mesma guarda do atualizar.sh, pelo mesmo motivo: os dois arquivos da
# stack viva ficam FORA do Git, só no clone de trabalho da VPS. Faltando
# um, este é o clone errado (provavelmente o /root/Whatsapp, que serve a
# stack morta) e tudo o que vier depois descreveria a máquina errada.
for arquivo in "$COMPOSE" "$ENV_FILE"; do
  if [ ! -f "$arquivo" ]; then
    echo "ERRO: $arquivo não existe em $RAIZ."
    echo "Este é o clone errado: a stack viva é a azvchat2, e os arquivos dela"
    echo "ficam fora do Git, no clone de trabalho. Confira com 'docker compose ls'."
    exit 1
  fi
done

compose() { docker compose -f "$COMPOSE" --env-file "$ENV_FILE" "$@"; }

titulo "Código"
git fetch --quiet origin "$BRANCH" 2>/dev/null || aviso "não consegui buscar do GitHub (rede?); comparando com o que já estava aqui"
local_sha="$(git rev-parse HEAD 2>/dev/null)"
remoto_sha="$(git rev-parse "origin/$BRANCH" 2>/dev/null)"
printf '  clone  %s  %s\n' "${local_sha:0:9}" "$(git log -1 --pretty=%s 2>/dev/null)"
printf '  GitHub %s  (%s)\n' "${remoto_sha:0:9}" "$BRANCH"
if [ -n "$local_sha" ] && [ "$local_sha" = "$remoto_sha" ]; then
  ok "o clone está no commit do GitHub"
else
  falta "o clone está ATRASADO. O timer roda a cada 2 min; se não andar, rode: bash deploy/atualizar.sh"
fi

titulo "Containers"
compose ps 2>/dev/null || falta "docker compose ps não respondeu"
# A data do commit contra a data de criação do container é o que separa
# "o código está no clone" de "o código está rodando": `up -d --build`
# recria o container, então container mais VELHO que o commit significa
# que a imagem em execução não tem a mudança.
commit_em="$(git log -1 --format=%cI 2>/dev/null)"
[ -n "$commit_em" ] && printf '\n  commit datado de: %s\n' "$commit_em"
for servico in "$SERVICO_API" azvweb; do
  cid="$(compose ps -q "$servico" 2>/dev/null | head -1)"
  if [ -z "$cid" ]; then
    falta "o container de $servico não está de pé"
    continue
  fi
  criado="$(docker inspect -f '{{.Created}}' "$cid" 2>/dev/null)"
  estado="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)"
  printf '  %-8s criado em %s  (%s)\n' "$servico" "$criado" "$estado"
  if [ -n "$commit_em" ] && [ -n "$criado" ]; then
    # Compara em segundos desde a época: string de data não se compara.
    c_commit="$(date -d "$commit_em" +%s 2>/dev/null)"
    c_cont="$(date -d "$criado" +%s 2>/dev/null)"
    if [ -n "$c_commit" ] && [ -n "$c_cont" ] && [ "$c_cont" -lt "$c_commit" ]; then
      falta "$servico é mais VELHO que o commit: a imagem no ar não tem a mudança"
    else
      ok "$servico foi recriado depois do commit"
    fi
  fi
done

titulo "API subiu sem erro"
# O log é lido UMA vez e guardado. Ler duas vezes e deixar o grep decidir
# faria log inacessível (docker fora do ar, serviço inexistente) virar
# "nenhum erro encontrado" — log vazio daria o mesmo OK de log limpo, e é
# esse silêncio-parece-sucesso que esconde deploy quebrado.
log_api="$(compose logs --since 30m "$SERVICO_API" 2>/dev/null)"
log_status=$?
if [ "$log_status" -ne 0 ]; then
  falta "não consegui ler o log de $SERVICO_API (o serviço existe? o docker responde?)"
else
  if printf '%s' "$log_api" | grep -q api_started; then
    ok "api_started no log dos últimos 30 min"
  else
    aviso "sem api_started nos últimos 30 min (normal se o deploy foi há mais tempo)"
  fi
  erros="$(printf '%s' "$log_api" | grep -ciE 'migration failed|PrismaClientInitializationError|EADDRINUSE|Cannot find module')"
  if [ "${erros:-0}" -gt 0 ]; then
    falta "$erros linha(s) de erro grave no log da API. Veja: docker compose -f $COMPOSE --env-file $ENV_FILE logs --tail=80 $SERVICO_API"
  else
    ok "nenhum erro de boot nem de migration no log"
  fi
fi

titulo "Domínios reais"
for url in "$API_URL/health" "$APP_URL/login"; do
  codigo="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url" 2>/dev/null)"
  if [ "$codigo" = "200" ]; then
    ok "$url responde 200"
  else
    falta "$url respondeu '$codigo' (esperado 200)"
  fi
done

titulo "Veredito"
if [ "$PENDENCIAS" -eq 0 ]; then
  echo "  Produção está no commit ${local_sha:0:9}, containers recriados depois dele e respondendo."
  echo "  Nada pendente."
else
  echo "  $PENDENCIAS item(ns) pendente(s) acima, marcados com FALTA."
  echo "  Caminho normal: bash deploy/atualizar.sh   (ou --force, se o commit já estiver aqui)"
  exit 1
fi
