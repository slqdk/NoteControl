#!/usr/bin/env bash
#
# NoteControl - reset a user's password from the container shell, for
# when nobody can sign in any more. Run as root:
#
#   bash deploy/linux/reset-admin.sh            # user 'admin', asks for a password
#   bash deploy/linux/reset-admin.sh soren      # another user
#   bash deploy/linux/reset-admin.sh --list     # list users (name, role, status)
#
# Press Enter at the prompt to have a password generated and printed.
# The reset also re-activates a locked/disabled account and ends all of
# the user's sessions. Works while the service is running.
#
set -euo pipefail

APP_DIR="/opt/notecontrol/app"
ENV_FILE="/etc/notecontrol/notecontrol.env"
SVC_USER="notecontrol"

die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."
[[ -x "${APP_DIR}/NoteControl.Server" ]] || die "NoteControl is not installed (${APP_DIR} missing). Run deploy/linux/install.sh first."

# Same environment as the service: env file + Production settings.
# Startup chatter (SPA found, migrations, ...) is hidden; only the
# command's own output and real warnings are shown.
run_cli() {
    (
        cd "$APP_DIR"
        set -a
        # shellcheck disable=SC1090
        [[ -f "$ENV_FILE" ]] && . "$ENV_FILE"
        set +a
        export ASPNETCORE_ENVIRONMENT=Production
        export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
        export Serilog__MinimumLevel__Default=Warning
        export Serilog__MinimumLevel__Override__Microsoft=Warning
        # Run as the service user so files the server touches (DB,
        # logs) keep the right owner.
        setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --init-groups \
            ./NoteControl.Server "$@"
    )
}

case "${1:-}" in
    -h|--help)
        sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    --list)
        run_cli list-users
        exit $?
        ;;
esac

USERNAME="${1:-admin}"
printf 'New password for %s (Enter = generate one): ' "$USERNAME"
read -rs PASSWORD
echo
if [[ -n "$PASSWORD" ]]; then
    printf 'Repeat: '
    read -rs REPEAT
    echo
    [[ "$PASSWORD" == "$REPEAT" ]] || die "The passwords don't match."
fi

# Password goes in on stdin, never on the command line (ps would show it).
printf '%s\n' "$PASSWORD" | run_cli reset-password "$USERNAME"
