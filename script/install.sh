#!/usr/bin/env bash
# Install orbitd (Rust daemon) and orb (Go client) on Linux,
# then register orbitd as a systemd service.
#
# Must be run with sudo:
#   sudo bash install.sh                    # build from source
#   sudo bash install.sh --prebuilt         # download pre-built binaries
#   sudo bash install.sh --prebuilt -v v0.2.0
#   sudo bash install.sh --no-systemd       # skip systemd registration
#   sudo bash install.sh --help

set -euo pipefail

REPO="deagwon97/orbit"
GITHUB_API="https://api.github.com/repos/${REPO}"
SERVICE_NAME="orbitd"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ORBITD_CONFIG_DIR="/etc/orbitd"
DEFAULT_ORBITD_DIR="/opt/orbit"
DEFAULT_ORB_DIR_REL=".local/bin"

# ── colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf "${GREEN}[orbit]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[orbit]${NC} %s\n" "$*"; }
die()  { printf "${RED}[orbit]${NC} %s\n" "$*" >&2; exit 1; }

# ── usage ────────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: sudo bash $(basename "$0") [OPTIONS]

Install orbitd and orb on Linux, then register orbitd as a systemd service.

Options:
  -p, --prebuilt          Download pre-built binaries from GitHub releases
  -b, --build             Build from source using Rust + Go (default)
  -v, --version VERSION   Release tag to install, e.g. v0.2.0  (default: latest)
      --orbitd-dir DIR    Destination directory for orbitd (default: ${DEFAULT_ORBITD_DIR})
      --orb-dir DIR       Destination directory for orb (default: ~/${DEFAULT_ORB_DIR_REL})
      --install-dir DIR   Legacy: install both orbitd and orb into DIR
      --no-systemd        Skip systemd service registration
  -h, --help              Show this message

Default binary paths:
  orbitd: ${DEFAULT_ORBITD_DIR}/orbitd
  orb   : ~/${DEFAULT_ORB_DIR_REL}/orb

Examples:
  sudo bash $(basename "$0")
  sudo bash $(basename "$0") --prebuilt
  sudo bash $(basename "$0") --prebuilt --version v0.2.0
  sudo bash $(basename "$0") --build --orbitd-dir /opt/orbit --orb-dir ~/.local/bin
  sudo bash $(basename "$0") --prebuilt --no-systemd
EOF
}

# ── helpers ──────────────────────────────────────────────────────────────────
detect_arch() {
    case "$(uname -m)" in
        x86_64)        echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)             die "Unsupported CPU architecture: $(uname -m)" ;;
    esac
}

# Resolve the real invoking user even when run with sudo.
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

append_path_dir() {
    local current="$1" dir="$2"
    [[ -n "$dir" && -d "$dir" ]] || { echo "$current"; return; }
    case ":${current}:" in
        *":${dir}:"*) echo "$current" ;;
        *) echo "${current}:${dir}" ;;
    esac
}

user_runtime_path() {
    local svc_user svc_home shell_path node_path node_dir nvm_bin path
    svc_user="$(real_user)"
    svc_home="$(real_user_home)"
    path="${svc_home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

    shell_path=$(sudo -u "$svc_user" bash -lc 'printf "%s" "$PATH"' 2>/dev/null || true)
    if [[ -n "$shell_path" ]]; then
        path="$shell_path"
        path=$(append_path_dir "$path" "${svc_home}/.local/bin")
        path=$(append_path_dir "$path" "/usr/local/sbin")
        path=$(append_path_dir "$path" "/usr/local/bin")
        path=$(append_path_dir "$path" "/usr/sbin")
        path=$(append_path_dir "$path" "/usr/bin")
        path=$(append_path_dir "$path" "/sbin")
        path=$(append_path_dir "$path" "/bin")
    fi

    node_path=$(sudo -u "$svc_user" bash -lc 'command -v node 2>/dev/null || true' 2>/dev/null || true)
    if [[ -n "$node_path" ]]; then
        node_dir="$(dirname "$node_path")"
        path=$(append_path_dir "$path" "$node_dir")
    fi

    for nvm_bin in "${svc_home}"/.nvm/versions/node/*/bin; do
        path=$(append_path_dir "$path" "$nvm_bin")
    done

    echo "$path"
}

check_cmd() { command -v "$1" >/dev/null 2>&1; }

# Run a command as the original (pre-sudo) user.
# Falls back to the current user when not invoked via sudo.
run_as_user() { sudo -u "$(real_user)" bash -lc "$*"; }

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
        if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME"; then
            log "Stopping existing ${SERVICE_NAME} service..."
            systemctl stop "$SERVICE_NAME"
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

# Install orbitd as root and orb as the invoking user.
place_binaries() {
    local orbitd_bin="$1" orb_bin="$2" orbitd_dir="$3" orb_dir="$4"
    local orb_user
    orb_user="$(real_user)"

    mkdir -p "$orbitd_dir"
    install -d -o "$orb_user" -g "$(id -gn "$orb_user")" -m 0755 "$orb_dir"
    install -m 0755 "$orbitd_bin" "${orbitd_dir}/orbitd"
    install -o "$orb_user" -g "$(id -gn "$orb_user")" -m 0755 "$orb_bin" "${orb_dir}/orb"

    log "Installed  orbitd  →  ${orbitd_dir}/orbitd"
    log "Installed  orb     →  ${orb_dir}/orb"
}

# ── prebuilt install ─────────────────────────────────────────────────────────
install_prebuilt() {
    local version="$1" orbitd_dir="$2" orb_dir="$3"
    local arch; arch=$(detect_arch)

    check_cmd curl || die "'curl' is required for downloading binaries. Please install it."

    if [[ "$version" == "latest" ]]; then
        log "Fetching latest release tag..."
        version=$(curl -fsSL "${GITHUB_API}/releases/latest" \
            | grep '"tag_name"' \
            | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
        [[ -n "$version" ]] || die "Could not determine the latest release. Check your network or try --version."
        log "Latest release: ${version}"
    fi

    local base_url="https://github.com/${REPO}/releases/download/${version}"
    local tmp_dir; tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    log "Downloading orbitd  (${version}, linux/${arch})..."
    curl -fsSL --progress-bar "${base_url}/orbitd-linux-${arch}" -o "${tmp_dir}/orbitd" \
        || die "Download failed. Does release ${version} have orbitd-linux-${arch}? Check: https://github.com/${REPO}/releases"

    log "Downloading orb     (${version}, linux/${arch})..."
    curl -fsSL --progress-bar "${base_url}/orb-linux-${arch}" -o "${tmp_dir}/orb" \
        || die "Download failed. Does release ${version} have orb-linux-${arch}? Check: https://github.com/${REPO}/releases"

    place_binaries "${tmp_dir}/orbitd" "${tmp_dir}/orb" "$orbitd_dir" "$orb_dir"
}

# ── build from source ─────────────────────────────────────────────────────────
install_from_source() {
    local orbitd_dir="$1" orb_dir="$2"

    # cargo and go are installed in user space — check and build as that user.
    run_as_user 'command -v cargo' >/dev/null 2>&1 \
        || die "Rust/cargo not found for user $(real_user). Install from https://rustup.rs"
    run_as_user 'command -v go' >/dev/null 2>&1 \
        || die "Go not found for user $(real_user). Install from https://go.dev/dl/"

    local go_ver
    go_ver=$(run_as_user 'go version')
    local go_major go_minor
    go_major=$(echo "$go_ver" | grep -oP 'go\K\d+' | head -1 || echo "0")
    go_minor=$(echo "$go_ver" | grep -oP 'go\d+\.\K\d+' || echo "0")
    if (( go_major < 1 || ( go_major == 1 && go_minor < 23 ) )); then
        die "Go 1.23+ is required (found: ${go_ver}). Upgrade from https://go.dev/dl/"
    fi

    local script_dir repo_dir clone_dir=""
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [[ -f "${script_dir}/../orbitd/Cargo.toml" && -f "${script_dir}/../orb/go.mod" ]]; then
        repo_dir="$(cd "${script_dir}/.." && pwd)"
        log "Building from local source: ${repo_dir}"
    else
        check_cmd git || die "'git' is required to clone the repository. Please install it."
        clone_dir=$(mktemp -d)
        chown "$(real_user)" "$clone_dir"
        trap 'rm -rf "$clone_dir"' EXIT
        log "Cloning ${REPO}..."
        run_as_user "git clone --depth 1 'https://github.com/${REPO}.git' '${clone_dir}'"
        repo_dir="$clone_dir"
    fi

    log "Building orbitd (cargo release build)..."
    run_as_user "cd '${repo_dir}/orbitd' && cargo build -p orbitd --release"
    local orbitd_bin="${repo_dir}/orbitd/target/release/orbitd"
    [[ -f "$orbitd_bin" ]] || die "orbitd binary not found after build: ${orbitd_bin}"

    log "Building orb (go build)..."
    run_as_user "cd '${repo_dir}/orb' && go build -o orb ."
    local orb_bin="${repo_dir}/orb/orb"
    [[ -f "$orb_bin" ]] || die "orb binary not found after build: ${orb_bin}"

    place_binaries "$orbitd_bin" "$orb_bin" "$orbitd_dir" "$orb_dir"
}

# Pre-create /etc/orbitd so the daemon can write its token there as svc_user.
prepare_orbitd_config_dir() {
    local svc_user="$1"
    mkdir -p "$ORBITD_CONFIG_DIR"
    chown "$svc_user":"$(id -gn "$svc_user")" "$ORBITD_CONFIG_DIR"
    chmod 700 "$ORBITD_CONFIG_DIR"
    log "Prepared  ${ORBITD_CONFIG_DIR}  (owner=${svc_user}, mode=700)"
}

# Make orb (running as svc_user) able to read the daemon's token by linking
# ~/.config/orbit/orb/token → /etc/orbitd/token.
link_orb_token() {
    local svc_user="$1"
    local orb_dir
    orb_dir=$(sudo -u "$svc_user" bash -lc 'echo "$HOME/.config/orbit/orb"')
    sudo -u "$svc_user" mkdir -p "$orb_dir"
    sudo -u "$svc_user" ln -sf "${ORBITD_CONFIG_DIR}/token" "${orb_dir}/token"
    log "Linked    ${orb_dir}/token  →  ${ORBITD_CONFIG_DIR}/token"
}

# ── systemd service ───────────────────────────────────────────────────────────
setup_systemd() {
    local orbitd_path="$1"   # absolute path to the installed orbitd binary

    check_cmd systemctl || { warn "systemd not found — skipping service registration."; return; }

    local svc_user svc_home
    svc_user=$(real_user)
    svc_home=$(real_user_home)

    prepare_orbitd_config_dir "$svc_user"
    link_orb_token "$svc_user"

    local svc_path
    svc_path=$(user_runtime_path)

    log "Installing systemd service: ${SERVICE_FILE}"
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AI Agent Orbit
After=network.target

[Service]
Type=simple
User=${svc_user}
Environment=PATH=${svc_path}
ExecStart=${orbitd_path}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$SERVICE_FILE"

    log "Reloading systemd daemon..."
    systemctl daemon-reload

    log "Enabling ${SERVICE_NAME} service..."
    systemctl enable "$SERVICE_NAME"

    log "Restarting ${SERVICE_NAME} service..."
    systemctl restart "$SERVICE_NAME"

    log "Service status:"
    systemctl status "$SERVICE_NAME" --no-pager -l || true
}

# ── PATH hint ────────────────────────────────────────────────────────────────
orb_path_hint() {
    local orb_dir="$1"
    if [[ ":${PATH}:" != *":${orb_dir}:"* ]]; then
        warn "${orb_dir} is not in your PATH."
        warn "Add the following to your shell config (~/.bashrc, ~/.zshrc, etc.):"
        warn "  export PATH=\"\$PATH:${orb_dir}\""
    fi
}

# ── main ──────────────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "This script must be run with sudo:  sudo bash $(basename "$0") $*"

MODE="build"
VERSION="latest"
ORBITD_DIR=""
ORB_DIR=""
SETUP_SYSTEMD=true

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--prebuilt)    MODE="prebuilt"; shift ;;
        -b|--build)       MODE="build";    shift ;;
        -v|--version)     [[ $# -ge 2 ]] || die "--version requires an argument"; VERSION="$2"; shift 2 ;;
        --orbitd-dir)     [[ $# -ge 2 ]] || die "--orbitd-dir requires an argument"; ORBITD_DIR="$2"; shift 2 ;;
        --orb-dir)        [[ $# -ge 2 ]] || die "--orb-dir requires an argument"; ORB_DIR="$2"; shift 2 ;;
        --install-dir)    [[ $# -ge 2 ]] || die "--install-dir requires an argument"; ORBITD_DIR="$2"; ORB_DIR="$2"; shift 2 ;;
        --no-systemd)     SETUP_SYSTEMD=false; shift ;;
        -h|--help)        usage; exit 0 ;;
        *)                die "Unknown option: '$1'. Run with --help for usage." ;;
    esac
done

[[ -z "$ORBITD_DIR" ]] && ORBITD_DIR=$(default_orbitd_dir)
[[ -z "$ORB_DIR" ]] && ORB_DIR=$(default_orb_dir)

log "Mode        : ${MODE}"
log "orbitd path : ${ORBITD_DIR}/orbitd"
log "orb path    : ${ORB_DIR}/orb"
log "Systemd     : $( $SETUP_SYSTEMD && echo "yes" || echo "no (--no-systemd)" )"
[[ "$MODE" == "prebuilt" ]] && log "Version     : ${VERSION}"
echo

stop_existing_processes
echo

case "$MODE" in
    prebuilt) install_prebuilt "$VERSION" "$ORBITD_DIR" "$ORB_DIR" ;;
    build)    install_from_source "$ORBITD_DIR" "$ORB_DIR" ;;
esac

echo
orb_path_hint "$ORB_DIR"

if $SETUP_SYSTEMD; then
    echo
    setup_systemd "${ORBITD_DIR}/orbitd"
    echo
    log "Done. orbitd is running as a system service."
    log "  sudo systemctl status orbitd    — check status"
    log "  sudo systemctl stop orbitd      — stop the daemon"
    log "  sudo systemctl disable orbitd   — remove from autostart"
    log "  journalctl -u orbitd -f         — follow logs"
    log "Connect with 'orb' to start a session."
else
    echo
    log "Done. Start the daemon with 'orbitd', then connect with 'orb'."
fi
