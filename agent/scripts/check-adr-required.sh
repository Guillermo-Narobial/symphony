#!/usr/bin/env bash
set -euo pipefail

changed=$( { git diff --name-only HEAD; git diff --cached --name-only; } | sort -u )
[ -n "$changed" ] || exit 0

requires_adr=0
while IFS= read -r path; do
  case "$path" in
    docs/adr/*) ;;
    src/*|systemd/*|WORKFLOW.md|SETUP.md|package.json|package-lock.json|install.sh|start.sh|agent-manifest.yaml|.github/*) requires_adr=1 ;;
  esac
done <<< "$changed"

[ "$requires_adr" -eq 0 ] && exit 0

if ! grep -Eq "^docs/adr/[0-9]{4}-[^/]+\.md$" <<< "$changed"; then
  echo "ADR requerido: este cambio afecta arquitectura, automatización, seguridad, despliegue o workflow." >&2
  echo "Añade un ADR nuevo en docs/adr/NNNN-titulo.md (y enlázalo en docs/adr/README.md)." >&2
  exit 1
fi
