#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_dir="$root/systemd"
target_dir="$HOME/.config/systemd/user"
mkdir -p "$target_dir"
for source in "$source_dir"/symphony-*.service "$source_dir"/symphony-*.timer; do
  [ -f "$source" ] || continue
  name=$(basename "$source")
  case "$name" in *.system.*) continue ;; esac
  install -m 0644 "$source" "$target_dir/$name"
done
systemctl --user daemon-reload
for timer in "$target_dir"/symphony-*.timer; do
  [ -f "$timer" ] && systemctl --user enable "$(basename "$timer")" >/dev/null
done
echo "Unidades de usuario instaladas desde $source_dir"
