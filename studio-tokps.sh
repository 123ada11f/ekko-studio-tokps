#!/usr/bin/env bash
# Ekko Studio tokps 补丁的启动/管理入口（macOS / Linux）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${STUDIO_TOKPS_PY:-python3}"
exec "$PY" "$DIR/studio_tokps.py" "$@"
