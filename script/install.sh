#!/usr/bin/env bash
# Install or upgrade orbitd and orb on Linux.
set -euo pipefail

repo=deagwon97/orbit
service=orbitd
service_file=/etc/systemd/system/orbitd.service
config_dir=/etc/orbitd
default_daemon_dir=/opt/orbit
default_client_dir=.local/bin

log() { printf '[orbit] %s\n' "$*"; }
warn() { log "$*" >&2; }
die() { warn "$*"; exit 1; }

usage() {
    cat <<HELP
Usage: sudo bash ${0##*/} [OPTIONS]

Install or upgrade orbitd and orb on Linux.

  -b, --build             Build from source (default)
  -p, --prebuilt          Download published binaries
  -v, --version TAG       Release tag for --prebuilt (default: latest)
      --orbitd-dir DIR    Daemon directory (default: $default_daemon_dir)
      --orb-dir DIR       Client directory (default: ~/$default_client_dir)
      --install-dir DIR   Set both binary directories
      --no-systemd        Install binaries without contacting systemd
  -h, --help              Show this message
HELP
}

as_user() { sudo -H -u "$owner" "$@"; }
login() { as_user bash -lc 'exec "$@"' bash "$@"; }
build_in() { login bash -c 'cd -- "$1" || exit; shift; exec "$@"' bash "$@"; }

download_binaries() {
    local arch base program
    case "$(uname -m)" in
        x86_64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) die "Unsupported CPU architecture: $(uname -m)" ;;
    esac
    command -v curl >/dev/null || die "Install curl to download binaries."
    if [[ "$version" == latest ]]; then
        version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
            sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p') ||
            die "Could not fetch the latest release. Use --build or specify an existing --version."
        [[ -n "$version" ]] || die "No release tag found. Use --build or specify an existing --version."
    fi

    log "Downloading $version for linux/$arch"
    base="https://github.com/$repo/releases/download/$version"
    for program in orbitd orb; do
        curl -fSL --progress-bar "$base/$program-linux-$arch" -o "$work_dir/$program" ||
            die "Could not download $program for linux/$arch. Check https://github.com/$repo/releases."
    done
    daemon_binary="$work_dir/orbitd"
    client_binary="$work_dir/orb"
}

build_binaries() {
    local source_dir="$PWD" build_dir="$work_dir/build"
    login cargo --version >/dev/null || die "Install Rust/Cargo for $owner (https://rustup.rs)."
    login go version >/dev/null || die "Install Go 1.23+ for $owner (https://go.dev/dl/)."
    chmod 0711 "$work_dir"
    install -d -m 0700 -o "$owner" -g "$group" -- "$build_dir"

    if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
        source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
    fi
    if [[ ! -f "$source_dir/orbitd/Cargo.toml" || ! -f "$source_dir/orb/go.mod" ]]; then
        source_dir="$build_dir/source"
        log "Cloning $repo"
        login git clone --depth 1 "https://github.com/$repo.git" "$source_dir" ||
            die "Could not clone the source. Install Git or use an Orbit checkout."
    fi

    daemon_binary="$build_dir/rust/release/orbitd"
    client_binary="$build_dir/orb"
    log "Building orbitd and orb from $source_dir"
    build_in "$source_dir/orbitd" cargo build --locked -p orbitd --release --target-dir "$build_dir/rust"
    build_in "$source_dir/orb" go build -mod=readonly -o "$client_binary" .
}

find_service() {
    local state start binary
    $use_systemd || return 0
    if ! command -v systemctl >/dev/null; then
        warn "systemctl not found. Installing binaries for manual startup."
        use_systemd=false
        return 0
    fi
    state=$(systemctl show --property=LoadState --value "$service") ||
        die "Cannot contact systemd. Use --no-systemd for a manual installation."
    [[ "$state" != not-found ]] || return 0
    existing_service=true

    start=$(systemctl show --property=ExecStart --value "$service")
    [[ "$start" == "{ path=/"* ]] || die "Cannot identify the orbitd executable in the existing unit."
    binary=${start#\{ path=}
    binary=${binary%% ;*}
    [[ "${binary##*/}" == orbitd ]] || die "The existing unit uses a wrapper. Use --no-systemd."
    daemon_dir="${daemon_dir:-$(dirname -- "$binary")}"
    [[ "$(realpath -m -- "$daemon_dir/orbitd")" == "$(realpath -m -- "$binary")" ]] ||
        die "The existing unit uses $binary. Use that directory or --no-systemd."
}

check_running_daemon() {
    local target="$daemon_dir/orbitd" managed_pid="" exe pid
    [[ -f "$target" ]] || return 0
    if $existing_service; then
        managed_pid=$(systemctl show --property=MainPID --value "$service")
    fi
    # A manually started orbitd can still need this binary to spawn children.
    for exe in /proc/[0-9]*/exe; do
        [[ "$exe" -ef "$target" ]] || continue
        pid=${exe#/proc/}
        [[ "${pid%/exe}" == "$managed_pid" ]] ||
            die "orbitd (PID ${pid%/exe}) is using $target. Stop that instance before reinstalling."
    done
}

install_binaries() {
    local daemon_stage client_stage
    [[ -s "$daemon_binary" && -s "$client_binary" ]] || die "Both binaries are required."
    [[ ! -d "$daemon_dir/orbitd" && ! -d "$client_dir/orb" ]] ||
        die "A binary destination already exists as a directory."
    check_running_daemon
    mkdir -p -- "$daemon_dir"
    as_user mkdir -p -- "$client_dir"
    # Stage in each destination filesystem so replacement is an atomic rename.
    daemon_stage=$(mktemp -d -- "$daemon_dir/.orbit-install.XXXXXX")
    temporary+=("$daemon_stage")
    client_stage=$(mktemp -d -- "$client_dir/.orbit-install.XXXXXX")
    temporary+=("$client_stage")
    install -m 0755 -- "$daemon_binary" "$daemon_stage/orbitd"
    install -o "$owner" -g "$group" -m 0755 -- "$client_binary" "$client_stage/orb"
    mv -fT -- "$daemon_stage/orbitd" "$daemon_dir/orbitd"
    mv -fT -- "$client_stage/orb" "$client_dir/orb"
    log "Installed $daemon_dir/orbitd and $client_dir/orb"
}

runtime_path() {
    local path node dir
    path=$(as_user bash -lc 'printf "%s" "$PATH"' 2>/dev/null || true)
    node=$(as_user bash -lc 'command -v node' 2>/dev/null || true)
    for dir in "$owner_home/.local/bin" /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin \
        "${node%/*}" "$owner_home"/.nvm/versions/node/*/bin; do
        [[ -n "$dir" && -d "$dir" && ":$path:" != *":$dir:"* ]] || continue
        path="${path:+$path:}$dir"
    done
    printf '%s' "$path"
}

start_service() {
    $use_systemd || return 0
    if $existing_service; then
        systemctl restart "$service"
        return
    fi

    local executable path client_config="$owner_home/.config/orbit/orb"
    executable=$(realpath -m -- "$daemon_dir/orbitd")
    executable=${executable//\\/\\\\}
    executable=${executable//\"/\\\"}
    executable=${executable//%/%%}
    path=$(runtime_path)

    if [[ ! -d "$config_dir" ]]; then
        install -d -m 0700 -o "$owner" -g "$group" -- "$config_dir"
    fi
    cat > "$service_file" <<UNIT
[Unit]
Description=AI Agent Orbit
After=network.target

[Service]
Type=simple
User=$owner
Environment=PATH=$path
ExecStart="$executable"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$service_file"
    systemctl daemon-reload
    systemctl start "$service"
    systemctl enable "$service"
    if [[ ! -e "$client_config/token" && ! -L "$client_config/token" &&
          ! -e "$client_config/config.yaml" && ! -L "$client_config/config.yaml" ]]; then
        as_user mkdir -p -- "$client_config"
        as_user ln -sT -- "$config_dir/token" "$client_config/token"
    fi
}

mode=build
version=latest
daemon_dir=""
client_dir=""
use_systemd=true
existing_service=false

while (($#)); do
    case "$1" in
        -b|--build) mode=build; shift ;;
        -p|--prebuilt) mode=prebuilt; shift ;;
        -v|--version|--orbitd-dir|--orb-dir|--install-dir)
            [[ $# -ge 2 ]] || die "$1 requires an argument."
            case "$1" in
                -v|--version) version="$2" ;;
                --orbitd-dir) daemon_dir="$2" ;;
                --orb-dir) client_dir="$2" ;;
                --install-dir) daemon_dir="$2"; client_dir="$2" ;;
            esac
            shift 2 ;;
        --no-systemd) use_systemd=false; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1 (try --help)." ;;
    esac
done

[[ $EUID -eq 0 ]] || die "Run this script with sudo."
owner="${SUDO_USER:-$(id -un)}"
group=$(id -gn "$owner")
owner_home=$(as_user bash -lc 'printf "%s" "$HOME"')
find_service
daemon_dir="${daemon_dir:-$default_daemon_dir}"
client_dir="${client_dir:-$owner_home/$default_client_dir}"

work_dir=$(mktemp -d)
temporary=("$work_dir")
trap 'rm -rf -- "${temporary[@]}"' EXIT

case "$mode" in
    build) build_binaries ;;
    prebuilt) download_binaries ;;
esac
install_binaries
start_service

if [[ ":$PATH:" != *":$client_dir:"* ]]; then
    warn "Add $(printf '%q' "$client_dir") to your shell PATH to run orb."
fi
if $use_systemd; then
    log "Verify the connection with orb ps."
else
    log "See the README for manual startup and token paths."
fi
