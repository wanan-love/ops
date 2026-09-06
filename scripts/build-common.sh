#!/usr/bin/env bash
# build-common.sh — OpenPrintShare 打包公共函数（被 build-{web,host,linux,windows,macos,android,ios,all} source）
set -euo pipefail

# 版本号：mini-services/ops-host/src/core/types.ts 为单一来源（POSIX sed，兼容 BSD/GNU）
OPS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ROOT="$OPS_ROOT/mini-services/ops-host"
DIST="$OPS_ROOT/dist"
STAGE="$DIST/.stage"

version() {
  sed -n "s/.*OPS_VERSION = '\([^']*\)'.*/\1/p" "$HOST_ROOT/src/core/types.ts" | head -1
}

PRODUCT="OpenPrintShare"
VERSION="$(version)"

log()  { echo -e "\033[0;32m[ops-build]\033[0m $*"; }
warn() { echo -e "\033[0;33m[ops-build][warn]\033[0m $*" >&2; }
fail() { echo -e "\033[0;31m[ops-build][fail]\033[0m $*" >&2; exit 1; }

require_bun() {
  command -v bun >/dev/null || fail "需要 Bun ≥1.1（https://bun.sh）——打包用 bun build --compile 内嵌运行时"
}

init_stage() {
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
}

# 平台产物命名：OpenPrintShare-{Platform}-{arch}-{version}[.ext]
out_name() { # $1=平台 $2=arch $3=扩展(可空)
  echo "${PRODUCT}-$1-$2-${VERSION}${3:-}"
}
