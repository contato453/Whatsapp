#!/usr/bin/env bash
# ==============================================================
# Instala o timer do systemd que mantém a VPS atualizada sozinha.
#
# Rode UMA vez, como root, dentro do clone:
#     bash deploy/instalar-atualizacao-automatica.sh
#
# A partir daí, a cada 2 minutos a VPS verifica se a branch padrão
# andou. Se andou, atualiza e sobe os containers; se não, sai em
# silêncio. Nenhum segredo, nenhuma chave, nenhuma porta nova.
#
# Para acompanhar:  journalctl -u azvchat-atualizar -f
# Para desligar:    systemctl disable --now azvchat-atualizar.timer
# ==============================================================
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVALO="${INTERVALO:-2min}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode como root (o timer é do systemd): sudo bash deploy/instalar-atualizacao-automatica.sh" >&2
  exit 1
fi

chmod +x "$RAIZ/deploy/atualizar.sh"

cat > /etc/systemd/system/azvchat-atualizar.service <<UNIDADE
[Unit]
Description=Atualiza o AZVCHAT com a branch padrão do GitHub
# Sem rede não há o que buscar; o timer tenta de novo no próximo ciclo.
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$RAIZ
ExecStart=/usr/bin/env bash $RAIZ/deploy/atualizar.sh
# O build pode demorar; sem isso o systemd mataria no meio e deixaria
# os containers em estado indefinido.
TimeoutStartSec=1800
UNIDADE

cat > /etc/systemd/system/azvchat-atualizar.timer <<UNIDADE
[Unit]
Description=Verifica a cada $INTERVALO se há versão nova do AZVCHAT

[Timer]
OnBootSec=3min
OnUnitActiveSec=$INTERVALO
# Uma verificação por vez: build em cima de build deixaria a VPS
# lenta e o estado imprevisível.
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIDADE

systemctl daemon-reload
systemctl enable --now azvchat-atualizar.timer

echo
echo "Pronto. A VPS passa a se atualizar sozinha a cada $INTERVALO."
echo "  ver quando roda:  systemctl list-timers azvchat-atualizar.timer"
echo "  acompanhar:       journalctl -u azvchat-atualizar -f"
echo "  atualizar agora:  systemctl start azvchat-atualizar.service"
echo "  desligar:         systemctl disable --now azvchat-atualizar.timer"
