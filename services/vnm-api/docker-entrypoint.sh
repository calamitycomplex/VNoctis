#!/bin/sh
set -e

PUID=${PUID:-0}
PGID=${PGID:-0}

if [ "$(id -u)" = "0" ] && [ "$PUID" != "0" ]; then
    # Ensure application-owned writable directories exist.
    # /games is source/archive storage and may be mounted read-only, so it is
    # intentionally left untouched here.
    mkdir -p /data /covers /screenshots /web-builds

    # Set ownership using numeric IDs (no user creation needed)
    # Use -R for small dirs, top-level only for large dirs (web-builds)
    chown -R "$PUID:$PGID" /data /covers /screenshots
    chown "$PUID:$PGID" /web-builds

    # Ensure web build subdirectories are writable (for delete support)
    find /web-builds -maxdepth 1 -mindepth 1 -type d -exec chown -R "$PUID:$PGID" {} + 2>/dev/null || true

    # Use gosu with numeric UID:GID — no passwd entry required
    exec gosu "$PUID:$PGID" "$@"
fi

# Running as root with PUID=0, or already non-root
exec "$@"
