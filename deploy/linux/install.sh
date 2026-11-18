#!/usr/bin/env bash
#
# NoteControl - build and install on Debian (Proxmox LXC).
#
# Run from a git checkout of the repo, as root:
#
#   sudo ./deploy/linux/install.sh            # first install AND every update
#   sudo ./deploy/linux/install.sh --skip-deps
#   ./deploy/linux/install.sh --build-only /tmp/nc-build   # build, don't install
#
# What it does (idempotent):
#   1. Installs build/runtime prerequisites: .NET 8 SDK (via Microsoft's
#      dotnet-install.sh into /usr/share/dotnet), Node.js + npm (apt), ICU.
#   2. Builds the server (self-contained, linux-x64/arm64) and the
#      frontend (npm ci + vite build) into a staging folder.
#   3. Creates the 'notecontrol' system user and the folders:
#        /opt/notecontrol/app      binaries + wwwroot   (replaced each install)
#        /var/lib/notecontrol      DataRoot             (never touched)
#        /var/log/notecontrol      Serilog files
#        /etc/notecontrol          notecontrol.env      (created once)
#   4. Swaps the new build in, restarts the service and checks /health.
#      If the new build fails to start, the previous build is restored.
#
set -euo pipefail

APP_NAME="notecontrol"
SVC_USER="notecontrol"
INSTALL_ROOT="/opt/notecontrol"
APP_DIR="${INSTALL_ROOT}/app"
DATA_DIR="/var/lib/notecontrol"
LOG_DIR="/var/log/notecontrol"
ETC_DIR="/etc/notecontrol"
ENV_FILE="${ETC_DIR}/notecontrol.env"
UNIT_FILE="/etc/systemd/system/${APP_NAME}.service"
DOTNET_DIR="/usr/share/dotnet"
DOTNET_CHANNEL="8.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER_PROJ="${REPO_ROOT}/src/NoteControl.Server/NoteControl.Server.csproj"
FRONTEND_DIR="${REPO_ROOT}/src/NoteControl.Frontend"

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

SKIP_DEPS=0
BUILD_ONLY=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-deps)  SKIP_DEPS=1; shift ;;
        --build-only) BUILD_ONLY="${2:-}"; [[ -n "$BUILD_ONLY" ]] || die "--build-only needs a directory"; shift 2 ;;
        -h|--help)    usage ;;
        *)            die "Unknown option: $1 (see --help)" ;;
    esac
done

[[ -f "$SERVER_PROJ" ]] || die "Not a NoteControl checkout: $SERVER_PROJ missing."
if [[ -z "$BUILD_ONLY" && $EUID -ne 0 ]]; then
    die "Run as root (sudo), or use --build-only DIR."
fi

case "$(uname -m)" in
    x86_64)  RID="linux-x64" ;;
    aarch64) RID="linux-arm64" ;;
    *)       die "Unsupported architecture: $(uname -m)" ;;
esac

# ---------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------
find_dotnet() {
    if [[ -x "${DOTNET_DIR}/dotnet" ]]; then echo "${DOTNET_DIR}/dotnet"; return; fi
    command -v dotnet 2>/dev/null || true
}

has_sdk8() {
    local dn; dn="$(find_dotnet)"
    [[ -n "$dn" ]] && "$dn" --list-sdks 2>/dev/null | grep -q '^8\.'
}

install_deps() {
    [[ $EUID -eq 0 ]] || die "Installing prerequisites needs root (or pass --skip-deps)."
    command -v apt-get >/dev/null || die "apt-get not found - this script targets Debian/Ubuntu."

    log "Installing apt packages (curl, ICU, Node.js, npm)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # ICU package name carries the version (libicu72 on bookworm,
    # libicu76 on trixie) - pick whatever this release ships.
    local icu
    icu="$(apt-cache pkgnames 2>/dev/null | grep -E '^libicu[0-9]+$' | sort -V | tail -n1 || true)"
    [[ -n "$icu" ]] || die "No libicuNN package found in apt."
    apt-get install -y -qq --no-install-recommends \
        ca-certificates curl git "$icu" nodejs npm >/dev/null

    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    (( node_major >= 18 )) || die "Node.js >= 18 required for Vite 5 (found $(node -v))."

    if has_sdk8; then
        log ".NET 8 SDK already present ($(find_dotnet))"
    else
        log "Installing .NET ${DOTNET_CHANNEL} SDK into ${DOTNET_DIR}"
        local tmp; tmp="$(mktemp)"
        curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$tmp"
        bash "$tmp" --channel "$DOTNET_CHANNEL" --install-dir "$DOTNET_DIR" >/dev/null
        rm -f "$tmp"
        ln -sf "${DOTNET_DIR}/dotnet" /usr/local/bin/dotnet
    fi
}

if [[ $SKIP_DEPS -eq 0 && -z "$BUILD_ONLY" ]]; then
    install_deps
fi

DOTNET="$(find_dotnet)"
[[ -n "$DOTNET" ]] || die "dotnet not found. Run without --skip-deps first."
has_sdk8 || die ".NET 8 SDK not found (have: $("$DOTNET" --list-sdks | tr '\n' ' '))."
command -v npm >/dev/null || die "npm not found. Run without --skip-deps first."

# ---------------------------------------------------------------------
# 2. Build into a staging folder
# ---------------------------------------------------------------------
if [[ -n "$BUILD_ONLY" ]]; then
    STAGE_ROOT="$BUILD_ONLY"
    rm -rf "$STAGE_ROOT"
else
    # Same filesystem as APP_DIR so the final swap is a cheap rename.
    mkdir -p "$INSTALL_ROOT"
    STAGE_ROOT="$(mktemp -d "${INSTALL_ROOT}/.stage.XXXXXX")"
    trap 'rm -rf "$STAGE_ROOT"' EXIT
fi
STAGE_APP="${STAGE_ROOT}/app"
mkdir -p "$STAGE_APP"

VERSION="$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo unknown)"
log "Building NoteControl ${VERSION} for ${RID}"

log "Server: dotnet publish (self-contained)"
"$DOTNET" publish "$SERVER_PROJ" \
    -c Release -r "$RID" --self-contained true \
    -p:PublishSingleFile=false \
    -o "$STAGE_APP" --nologo -v quiet

log "Frontend: npm ci + build"
(
    cd "$FRONTEND_DIR"
    npm ci --no-audit --no-fund --loglevel=error
    npm run build --silent
)
[[ -f "${FRONTEND_DIR}/dist/index.html" ]] || die "Frontend build produced no dist/index.html."
rm -rf "${STAGE_APP}/wwwroot"
mkdir -p "${STAGE_APP}/wwwroot"
cp -a "${FRONTEND_DIR}/dist/." "${STAGE_APP}/wwwroot/"

printf '%s\n%s\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STAGE_APP}/VERSION.txt"
chmod 755 "${STAGE_APP}/NoteControl.Server"

if [[ -n "$BUILD_ONLY" ]]; then
    log "Build-only: output in ${STAGE_APP}"
    exit 0
fi

# ---------------------------------------------------------------------
# 3. User, folders, config, unit
# ---------------------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    log "Creating system user '${SVC_USER}'"
    useradd --system --home-dir "$DATA_DIR" --no-create-home \
        --shell /usr/sbin/nologin "$SVC_USER"
fi

install -d -m 755 -o root -g root "$INSTALL_ROOT"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$LOG_DIR"
install -d -m 750 -o root -g "$SVC_USER" "$ETC_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
    log "Creating ${ENV_FILE} (edit it to set the trusted proxy)"
    install -m 640 -o root -g "$SVC_USER" "${SCRIPT_DIR}/notecontrol.env" "$ENV_FILE"
fi

install -m 644 "${SCRIPT_DIR}/notecontrol.service" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1

# ---------------------------------------------------------------------
# 4. Swap in the new build, start, verify, roll back on failure
# ---------------------------------------------------------------------
PORT="$(sed -n 's/^[[:space:]]*Network__Port=\([0-9]\+\).*/\1/p' "$ENV_FILE" | tail -n1)"
CONFIG_JSON="${DATA_DIR}/.server/config.json"
if [[ -f "$CONFIG_JSON" ]]; then
    # config.json (admin UI) wins over the env file.
    cfg_port="$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const p = c && c.Network && c.Network.Port; if (Number.isInteger(p)) process.stdout.write(String(p)); } catch {}' "$CONFIG_JSON" || true)"
    [[ -n "$cfg_port" ]] && PORT="$cfg_port"
fi
PORT="${PORT:-8080}"

health_ok() {
    local i
    for i in $(seq 1 30); do
        if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

chown -R root:root "$STAGE_APP"

if systemctl is-active --quiet "$APP_NAME"; then
    log "Stopping ${APP_NAME}"
    systemctl stop "$APP_NAME"
fi

rm -rf "${INSTALL_ROOT}/app.prev"
[[ -d "$APP_DIR" ]] && mv "$APP_DIR" "${INSTALL_ROOT}/app.prev"
mv "$STAGE_APP" "$APP_DIR"

log "Starting ${APP_NAME}"
if systemctl start "$APP_NAME" && health_ok; then
    log "NoteControl ${VERSION} is running on port ${PORT}"
else
    warn "New build failed to start. Last log lines:"
    journalctl -u "$APP_NAME" -n 40 --no-pager >&2 || true
    if [[ -d "${INSTALL_ROOT}/app.prev" ]]; then
        warn "Rolling back to the previous build"
        systemctl stop "$APP_NAME" || true
        rm -rf "${INSTALL_ROOT}/app.failed"
        mv "$APP_DIR" "${INSTALL_ROOT}/app.failed"
        mv "${INSTALL_ROOT}/app.prev" "$APP_DIR"
        systemctl start "$APP_NAME" || true
        die "Update failed; previous build restored. Failed build kept in ${INSTALL_ROOT}/app.failed"
    fi
    die "Install failed and there is no previous build to roll back to."
fi

if journalctl -u "$APP_NAME" --no-pager 2>/dev/null | grep -q "BOOTSTRAP ADMIN CREATED"; then
    echo
    log "First start: a bootstrap admin was created. Password:"
    echo "    journalctl -u ${APP_NAME} | grep 'BOOTSTRAP ADMIN'"
fi
