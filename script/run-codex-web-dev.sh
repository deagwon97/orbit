#!/usr/bin/env bash
set -euo pipefail
orbit_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if systemctl --user is-active --quiet orbitd-codex-web-dev.service; then
  echo 'orbitd-codex-web-dev is already running. Stop it explicitly before upgrading; restarting loses any CLI PTYs on that development instance.'
  exit 1
fi
cargo build --manifest-path "$orbit_root/orbitd/Cargo.toml"
dev_directory="$orbit_root/tmp/codex-web-dev"
mkdir -p "$dev_directory"
printf 'listen: "0.0.0.0:17777"\n' > "$dev_directory/config.yaml"
codex_socket="${ORBIT_CODEX_SOCKET:-${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock}"
systemd-run --user --unit=orbitd-codex-web-dev --collect \
  --property="WorkingDirectory=$orbit_root" --property=Restart=on-failure \
  --setenv="ORBITD_CONFIG=$dev_directory/config.yaml" \
  --setenv="ORBIT_DATA_DIR=$dev_directory/data" \
  --setenv="ORBITD_TOKEN_PATH=${ORBITD_TOKEN_PATH:-/etc/orbitd/token}" \
  --setenv="ORBIT_CODEX_SOCKET=$codex_socket" \
  "$orbit_root/orbitd/target/debug/orbitd"
