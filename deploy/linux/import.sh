#!/usr/bin/env bash
#
# NoteControl - import a Windows export into the Linux container.
#
#   bash deploy/linux/import.sh /root/NoteControl-export-XXXX.zip
#   bash deploy/linux/import.sh /root/NoteControl-export-XXXX.zip --force
#
# The zip comes from deploy/windows/export-windows.ps1. Run as root,
# after deploy/linux/install.sh has installed the service.
#
# What it does:
#   1. Validates the zip (must contain .server/server.db; no absolute
#      paths, no '..', no backslashes in entry names).
#   2. Unpacks into a staging folder next to the DataRoot.
#   3. Cleans .server/config.json for Linux:
#        - Network.ExposeOnLan / Network.Port removed, so
#          /etc/notecontrol/notecontrol.env decides how Kestrel listens
#        - Network.PublicHostnames cleared (Caddy is gone)
#        - a Windows backup target (C:\..., \\nas\...) is cleared and
#          scheduled backups disabled - set a Linux path later
#        - any Storage / Serilog section removed (paths are Linux-side)
#   4. Checks every vault folder in server.db exists with the exact
#      upper/lower case on disk. Windows does not care, Linux does; a
#      folder whose case differs is renamed to match the database.
#   5. Stops the service, swaps the data in (the current DataRoot is
#      moved to /var/lib/notecontrol.pre-import-<time> with --force),
#      fixes ownership, starts the service and checks /health.
#
# Users, passwords, vaults, permissions, notes, assets, templates,
# dashboards, release archives and search indexes all come along.
# Re-running the import is safe: use --force to replace the data again.
#
set -euo pipefail

APP_NAME="notecontrol"
SVC_USER="notecontrol"
DATA_DIR="/var/lib/notecontrol"
ENV_FILE="/etc/notecontrol/notecontrol.env"
UNIT_FILE="/etc/systemd/system/${APP_NAME}.service"

# Danish characters in file names: make sure tools run in a UTF-8 locale
# even when the container has no locales generated.
export LC_ALL=C.UTF-8

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

ZIP=""
FORCE=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)   FORCE=1; shift ;;
        -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*)        die "Unknown option: $1 (see --help)" ;;
        *)         [[ -z "$ZIP" ]] || die "Only one zip file, please."; ZIP="$1"; shift ;;
    esac
done

[[ $EUID -eq 0 ]] || die "Run as root."
[[ -n "$ZIP" ]] || die "Usage: import.sh <export.zip> [--force]"
[[ -f "$ZIP" ]] || die "File not found: $ZIP"
[[ -f "$UNIT_FILE" ]] || die "NoteControl is not installed. Run deploy/linux/install.sh first."
id -u "$SVC_USER" >/dev/null 2>&1 || die "User '$SVC_USER' missing. Run deploy/linux/install.sh first."
command -v node >/dev/null || die "node not found. Run deploy/linux/install.sh first."

need=()
command -v unzip   >/dev/null || need+=(unzip)
command -v sqlite3 >/dev/null || need+=(sqlite3)
if [[ ${#need[@]} -gt 0 ]]; then
    log "Installing ${need[*]}"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi

# ---------------------------------------------------------------------
# 1. Validate the zip
# ---------------------------------------------------------------------
log "Checking $ZIP"
entries="$(unzip -Z1 "$ZIP")" || die "Not a readable zip file."
grep -qx '.server/server.db' <<<"$entries" || die "Zip has no .server/server.db - not a NoteControl export."
if grep -q '\\' <<<"$entries"; then
    die "Zip entry names contain backslashes. Create the zip with export-windows.ps1."
fi
if grep -qE '^/|(^|/)\.\.(/|$)' <<<"$entries"; then
    die "Zip contains absolute or '..' paths - refusing to import."
fi

if grep -qx 'export-manifest.json' <<<"$entries"; then
    unzip -p "$ZIP" export-manifest.json | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
            try {
                const m = JSON.parse(s.replace(/^\uFEFF/, ""));
                console.log(`    exported ${m.exportedAtUtc} from ${m.sourceHost} (${m.sourceDataRoot})`);
                console.log(`    ${m.fileCount} files, ${(m.totalBytes / 1048576).toFixed(1)} MB, ${(m.vaultFolders || []).length} vault folders`);
            } catch { console.log("    (manifest unreadable)"); }
        });'
fi

if [[ -f "${DATA_DIR}/.server/server.db" && $FORCE -eq 0 ]]; then
    die "${DATA_DIR} already holds data. Re-run with --force to replace it (the current data is kept as ${DATA_DIR}.pre-import-<time>)."
fi

# Space: unpacked size (+10%) must fit next to the DataRoot.
raw_bytes="$(unzip -Zt "$ZIP" | grep -oE '[0-9]+ bytes uncompressed' | grep -oE '^[0-9]+' || echo 0)"
parent="$(dirname "$DATA_DIR")"
avail_bytes="$(( $(df --output=avail -k "$parent" | tail -n1) * 1024 ))"
if (( raw_bytes * 11 / 10 > avail_bytes )); then
    die "Not enough disk space: need ~$(( raw_bytes / 1048576 )) MB, have $(( avail_bytes / 1048576 )) MB in ${parent}."
fi

# ---------------------------------------------------------------------
# 2. Unpack into staging
# ---------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="${DATA_DIR}.import-${STAMP}"
BACKUP="${DATA_DIR}.pre-import-${STAMP}"
cleanup() { [[ -n "${STAGE:-}" && -d "$STAGE" ]] && rm -rf "$STAGE"; return 0; }
trap cleanup EXIT

log "Unpacking to ${STAGE}"
mkdir -p "$STAGE"
unzip -q "$ZIP" -d "$STAGE"
if [[ -f "${STAGE}/export-manifest.json" ]]; then
    mv "${STAGE}/export-manifest.json" "${STAGE}/.server/import-manifest.json"
fi
# Machine-local files: regenerated by the server on start.
rm -f "${STAGE}/.server/tray.token" "${STAGE}/.server/server.url"
find "$STAGE" -name '*-shm' -type f -delete

# ---------------------------------------------------------------------
# 3. Clean config.json
# ---------------------------------------------------------------------
CONFIG_JSON="${STAGE}/.server/config.json"
if [[ -f "$CONFIG_JSON" ]]; then
    log "Cleaning config.json for Linux"
    node - "$CONFIG_JSON" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const notes = [];
// Section/property names are matched case-insensitively.
const key = (obj, name) => obj && Object.keys(obj).find(k => k.toLowerCase() === name.toLowerCase());

for (const section of ["Storage", "Serilog"]) {
    const k = key(cfg, section);
    if (k) { delete cfg[k]; notes.push(`removed ${k} section`); }
}

const netK = key(cfg, "Network");
if (netK) {
    const net = cfg[netK];
    for (const p of ["ExposeOnLan", "Port"]) {
        const k = key(net, p);
        if (k) { notes.push(`removed Network.${k} (was ${JSON.stringify(net[k])}; notecontrol.env decides now)`); delete net[k]; }
    }
    const hk = key(net, "PublicHostnames");
    if (hk && Array.isArray(net[hk]) && net[hk].length) {
        notes.push(`cleared Network.PublicHostnames (${net[hk].join(", ")}) - HTTPS is Nginx Proxy Manager's job now`);
        net[hk] = [];
    }
}

const bkK = key(cfg, "Backup");
if (bkK) {
    const bk = cfg[bkK];
    const tk = key(bk, "TargetPath");
    if (tk && typeof bk[tk] === "string" && /^([A-Za-z]:[\\/]|\\\\)/.test(bk[tk])) {
        notes.push(`backup target '${bk[tk]}' is a Windows path: cleared and scheduled backups disabled`);
        bk[tk] = "";
        const ek = key(bk, "Enabled");
        bk[ek || "Enabled"] = false;
    }
}

fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
for (const n of notes) console.log("    " + n);
if (!notes.length) console.log("    nothing to change");
NODE
fi

# ---------------------------------------------------------------------
# 4. Vault folders: exact case on disk
# ---------------------------------------------------------------------
# Rename each path segment that only differs in case so it matches the
# path stored in server.db. Returns 1 if a segment is missing entirely.
fix_case() {
    local rel="$1" cur="$STAGE" seg cand actual
    local -a segs
    IFS='/' read -r -a segs <<<"$rel"
    for seg in "${segs[@]}"; do
        [[ -n "$seg" ]] || continue
        if [[ -d "${cur}/${seg}" ]]; then cur="${cur}/${seg}"; continue; fi
        actual=""
        while IFS= read -r -d '' cand; do
            if [[ "${cand,,}" == "${seg,,}" ]]; then actual="$cand"; break; fi
        done < <(find "$cur" -mindepth 1 -maxdepth 1 -type d -printf '%f\0')
        [[ -n "$actual" ]] || return 1
        mv "${cur}/${actual}" "${cur}/${seg}"
        warn "Renamed '${actual}' -> '${seg}' (case differed from server.db)"
        cur="${cur}/${seg}"
    done
    return 0
}

log "Checking vault folders"
DB="${STAGE}/.server/server.db"
vault_count=0
missing=0
while IFS= read -r vpath; do
    [[ -n "$vpath" ]] || continue
    vault_count=$((vault_count + 1))
    if ! fix_case "$vpath"; then
        warn "Vault folder missing: ${vpath} (the vault row exists, its folder does not)"
        missing=$((missing + 1))
    fi
done < <(sqlite3 "$DB" "SELECT Path FROM Vaults ORDER BY Path;")
user_count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM Users;")"
echo "    ${vault_count} vaults, ${user_count} users$( (( missing )) && echo ", ${missing} vault folder(s) MISSING" )"

# ---------------------------------------------------------------------
# 5. Swap in, fix ownership, start
# ---------------------------------------------------------------------
if systemctl is-active --quiet "$APP_NAME"; then
    log "Stopping ${APP_NAME}"
    systemctl stop "$APP_NAME"
fi

mkdir -p "$DATA_DIR"
# Move contents, not the folder itself, so a bind-mounted DataRoot works.
if [[ -n "$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    log "Keeping current data in ${BACKUP}"
    mkdir -p "$BACKUP"
    find "$DATA_DIR" -mindepth 1 -maxdepth 1 -exec mv -t "$BACKUP" {} +
fi
find "$STAGE" -mindepth 1 -maxdepth 1 -exec mv -t "$DATA_DIR" {} +
rmdir "$STAGE"

chown -R "${SVC_USER}:${SVC_USER}" "$DATA_DIR"
chmod -R u=rwX,g=rX,o= "$DATA_DIR"

PORT="$(sed -n 's/^[[:space:]]*Network__Port=\([0-9]\+\).*/\1/p' "$ENV_FILE" 2>/dev/null | tail -n1)"
PORT="${PORT:-8080}"

log "Starting ${APP_NAME}"
if ! systemctl start "$APP_NAME"; then
    journalctl -u "$APP_NAME" -n 40 --no-pager >&2 || true
    die "Service failed to start after import. Previous data: ${BACKUP:-none}"
fi
ok=0
for _ in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
done
(( ok )) || { journalctl -u "$APP_NAME" -n 40 --no-pager >&2 || true; die "Server did not answer /health on port ${PORT}."; }

log "Import done: ${vault_count} vaults, ${user_count} users. Log in with your Windows accounts."
if [[ -d "$BACKUP" ]]; then
    echo "    Previous data kept in ${BACKUP} (delete it when you're happy)."
fi
exit 0
