#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$root/systemd"
target_dir="$HOME/.config/systemd/user"
status=0
for source in "$source_dir"/symphony-*.service "$source_dir"/symphony-*.timer; do
  [ -f "$source" ] || continue
  name=$(basename "$source")
  case "$name" in *.system.*) continue ;; esac
  target="$target_dir/$name"
  if ! cmp -s "$source" "$target"; then
    echo "Deriva detectada: $name"
    diff -u "$source" "$target" || true
    status=1
  fi
done
exit "$status"
