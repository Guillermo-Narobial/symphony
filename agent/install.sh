#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📦 Copiando units a /etc/systemd/system/ ..."
sudo cp "$DIR/systemd"/symphony-* /etc/systemd/system/

echo "🔄 Recargando systemd ..."
sudo systemctl daemon-reload

echo "▶️  Habilitando e iniciando symphony-agent (Node.js) ..."
sudo systemctl enable --now symphony-agent.service

echo "▶️  Habilitando e iniciando symphony-elixir (Orquestador) ..."
sudo systemctl enable --now symphony-elixir.service

echo "⏰ Habilitando timers operativos ..."
sudo systemctl enable --now \
  symphony-agent-restart.timer \
  symphony-alerts.timer \
  symphony-audit.timer \
  symphony-changelog.timer \
  symphony-deps.timer \
  symphony-docs.timer \
  symphony-health.timer \
  symphony-mutator.timer \
  symphony-projects-report.timer

echo ""
echo "✅ Instalación completada. Comandos útiles:"
echo "   sudo systemctl status symphony-agent"
echo "   sudo systemctl status symphony-elixir"
echo "   sudo journalctl -u symphony-agent -f"
echo "   sudo journalctl -u symphony-elixir -f"
echo "   systemctl list-timers symphony-agent-restart.timer"
echo "   http://localhost:4040  (dashboard Symphony)"
