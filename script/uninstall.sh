#!/usr/bin/env bash
# Uninstall orbitd (Rust daemon) and orb (Go client) from Linux.
#
# Must be run with sudo:
#   sudo bash uninstall.sh
#   sudo bash uninstall.sh --purge
#   sudo bash uninstall.sh --help

set -euo pipefail

SERVICE_NAME="orbitd"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ORBITD_CONFIG_DIR="/etc/orbitd"
DEFAULT_ORBITD_DIR="/opt/orbit"
DEFAULT_ORB_DIR_REL=".local/bin"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf "${GREEN}[orbit]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[orbit]${NC} %s\n" "$*"; }
die()  { printf "${RED}[orbit]${NC} %s\n" "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: sudo bash $(basename "$0") [OPTIONS]

Uninstall orbitd and orb from Linux.

Options:
      --orbitd-dir DIR    orbitd install directory (default: ${DEFAULT_ORBITD_DIR})
      --orb-dir DIR       orb install directory (default: ~/${DEFAULT_ORB_DIR_REL})
      --install-dir DIR   Legacy: remove both binaries from DIR
      --purge             Also remove config, token, client config, and orbit data
  -h, --help              Show this message

Default removed paths:
  orbitd service : ${SERVICE_FILE}
  orbitd binary  : ${DEFAULT_ORBITD_DIR}/orbitd
  orb binary     : ~/${DEFAULT_ORB_DIR_REL}/orb

Examples:
  sudo bash $(basename "$0")
  sudo bash $(basename "$0") --purge
EOF
}

real_user() {
    if [[ -n "${SUDO_USER:-}" ]]; then
        echo "$SUDO_USER"
    else
        echo "$(id -un)"
    fi
}

real_user_home() {
    sudo -u "$(real_user)" bash -lc 'printf "%s" "$HOME"'
}

default_orbitd_dir() {
    echo "$DEFAULT_ORBITD_DIR"
}

default_orb_dir() {
    echo "$(real_user_home)/${DEFAULT_ORB_DIR_REL}"
}

check_cmd() { command -v "$1" >/dev/null 2>&1; }

stop_existing_processes() {
    local svc_user
    svc_user="$(real_user)"

    if check_cmd pgrep && check_cmd pkill; then
        if pgrep -u "$svc_user" -x orb >/dev/null 2>&1; then
            log "Stopping existing orb client processes..."
            pkill -TERM -u "$svc_user" -x orb || true
            sleep 1
            if pgrep -u "$svc_user" -x orb >/dev/null 2>&1; then
                warn "Force stopping remaining orb client processes..."
                pkill -KILL -u "$svc_user" -x orb || true
            fi
        fi
    else
        warn "pgrep/pkill not found; skipping orb process stop."
    fi

    if check_cmd systemctl; then
        if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
            if systemctl is-active --quiet "$SERVICE_NAME"; then
                log "Stopping existing ${SERVICE_NAME} service..."
                systemctl stop "$SERVICE_NAME"
            fi
            if systemctl is-enabled --quiet "$SERVICE_NAME"; then
                log "Disabling ${SERVICE_NAME} service..."
                systemctl disable "$SERVICE_NAME"
            fi
        fi
    fi

    if check_cmd pgrep && check_cmd pkill; then
        if pgrep -x orbitd >/dev/null 2>&1; then
            log "Stopping remaining orbitd processes..."
            pkill -TERM -x orbitd || true
            sleep 1
            if pgrep -x orbitd >/dev/null 2>&1; then
                warn "Force stopping remaining orbitd processes..."
                pkill -KILL -x orbitd || true
            fi
        fi
    else
        warn "pgrep/pkill not found; skipping remaining orbitd process stop."
    fi
}

remove_file() {
    local path="$1"
    if [[ -e "$path" || -L "$path" ]]; then
        rm -f "$path"
        log "Removed   ${path}"
    fi
}

remove_empty_dir() {
    local path="$1"
    if [[ -d "$path" ]]; then
        rmdir "$path" 2>/dev/null || true
    fi
}

[[ $EUID -eq 0 ]] || die "This script must be run with sudo:  sudo bash $(basename "$0") $*"

ORBITD_DIR=""
ORB_DIR=""
PURGE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --orbitd-dir)     [[ $# -ge 2 ]] || die "--orbitd-dir requires an argument"; ORBITD_DIR="$2"; shift 2 ;;
        --orb-dir)        [[ $# -ge 2 ]] || die "--orb-dir requires an argument"; ORB_DIR="$2"; shift 2 ;;
        --install-dir)    [[ $# -ge 2 ]] || die "--install-dir requires an argument"; ORBITD_DIR="$2"; ORB_DIR="$2"; shift 2 ;;
        --purge)          PURGE=true; shift ;;
        -h|--help)        usage; exit 0 ;;
        *)                die "Unknown option: '$1'. Run with --help for usage." ;;
    esac
done

[[ -z "$ORBITD_DIR" ]] && ORBITD_DIR=$(default_orbitd_dir)
[[ -z "$ORB_DIR" ]] && ORB_DIR=$(default_orb_dir)

log "orbitd path : ${ORBITD_DIR}/orbitd"
log "orb path    : ${ORB_DIR}/orb"
log "Purge       : $( $PURGE && echo "yes" || echo "no" )"
echo

stop_existing_processes

remove_file "$SERVICE_FILE"
remove_file "${ORBITD_DIR}/orbitd"
remove_file "${ORB_DIR}/orb"
remove_empty_dir "$ORBITD_DIR"
remove_empty_dir "$ORB_DIR"

if check_cmd systemctl; then
    log "Reloading systemd daemon..."
    systemctl daemon-reload
    systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

if $PURGE; then
    svc_user="$(real_user)"
    svc_home="$(real_user_home)"
    log "Removing configuration and data..."
    rm -rf "$ORBITD_CONFIG_DIR"
    rm -rf "${svc_home}/.config/orbit/orb"
    rm -rf "${svc_home}/.local/share/orbit"
    sudo -u "$svc_user" rmdir "${svc_home}/.config/orbit" 2>/dev/null || true
    sudo -u "$svc_user" rmdir "${svc_home}/.config" 2>/dev/null || true
    log "Purged orbit configuration and data."
fi

echo
log "Done. orbitd and orb have been uninstalled."
